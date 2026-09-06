import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentEventDraft,
  AgentSession,
  ArtifactReference,
  EventDelivery,
  HumanInputRequest,
  HumanInputResponse,
  HumanInputResolution,
  PermissionBinding,
  PermissionRequest,
} from "@harness/protocol"
import { SQLiteJournal } from "../src/journal"

const now = Date.parse("2026-09-06T12:00:00.000Z")
const directories: string[] = []
const journals: SQLiteJournal[] = []

afterEach(() => {
  journals.splice(0).forEach((journal) => journal.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function path() {
  const directory = mkdtempSync(join(tmpdir(), "harness-input-journal-"))
  directories.push(directory)
  return join(directory, "journal.sqlite")
}

function open(file: string) {
  const journal = new SQLiteJournal(file)
  journals.push(journal)
  return journal
}

function binding(requestId = "input-1"): PermissionBinding {
  return {
    requestId,
    sessionId: "session",
    targetId: "local",
    runtimeId: "codex",
    workspaceId: "workspace",
    nativeSessionId: "native-session",
    nativeTurnId: "native-turn",
    nativeRequestId: `string:${requestId}`,
    policyId: "policy",
    policyVersion: "1",
    leaseGeneration: 3,
    operationSha256: "a".repeat(64),
  }
}

function request(requestId = "input-1"): HumanInputRequest {
  return {
    ...binding(requestId),
    sourceRequestSha256: "c".repeat(64),
    prompt: "Choose one option for each question.",
    schemaId: "harness.choice-input.v1",
    questions: [
      { id: "q1", optionIds: ["o1", "o2"] },
      { id: "q2", optionIds: ["o3", "o4"] },
    ],
    expiresAt: new Date(now + 60_000).toISOString(),
  }
}

function response(requestId = "input-1"): HumanInputResponse {
  return {
    ...binding(requestId),
    action: "answer",
    selections: [
      { questionId: "q1", optionId: "o1" },
      { questionId: "q2", optionId: "o3" },
    ],
  }
}

function requested(
  value = request(),
  eventId = value.requestId,
): Extract<AgentEventDraft, { type: "input.requested" }> {
  return {
    type: "input.requested",
    data: value,
    scope: {
      sessionId: value.sessionId,
      targetId: value.targetId,
      workspaceId: value.workspaceId,
      runtimeId: value.runtimeId,
      turnId: value.nativeTurnId,
      commandId: "command",
    },
    origin: { streamId: "native", epoch: "epoch", eventId, identityStrategy: "native" },
    observedAt: new Date(now).toISOString(),
  }
}

function resolved(
  value: HumanInputResolution,
  eventId = "resolution",
): Extract<AgentEventDraft, { type: "input.resolved" }> {
  return { ...requested(), type: "input.resolved", data: value, origin: { ...requested().origin, eventId } }
}

function artifact(): ArtifactReference {
  return {
    id: "review-1",
    sha256: "b".repeat(64),
    sizeBytes: 100,
    mediaType: "application/json",
    sensitivity: "restricted",
  }
}

async function replay(journal: SQLiteJournal, stream = "session") {
  const events: EventDelivery[] = []
  for await (const event of journal.read(stream)) events.push(event)
  return events
}

test("input requests are durable, immutable and deduplicated with their event", async () => {
  const file = path()
  const first = open(file)
  const draft = requested()
  await first.append("session", [draft])
  first.close()
  const journal = open(file)
  expect(await journal.input("input-1")).toEqual({ state: "pending", request: request() })
  expect(await journal.pendingInputs("session")).toHaveLength(1)
  expect(await journal.pendingInputs("other")).toEqual([])
  expect(await journal.append("session", [draft])).toEqual([])
  await expect(
    journal.append("session", [
      requested({ ...request(), questions: [{ id: "q1", optionIds: ["other", "o2"] }] }, "changed"),
    ]),
  ).rejects.toThrow("Input conflict")
  expect(await replay(journal)).toHaveLength(1)
})

test("request display text, labels, malformed IDs and duplicate options never enter ordinary storage", async () => {
  const journal = open(path())
  for (const invalid of [
    { ...request(), prompt: "private question text" },
    { ...request(), schemaId: "free-text" },
    { ...request(), rawQuestion: "private question" },
    { ...request(), questions: [{ id: "q1", optionIds: ["o1"], question: "private" }] },
    { ...request(), questions: [{ id: "q1", optionIds: ["o1"], label: "private" }] },
    { ...request(), questions: [{ id: "q1", optionIds: ["o1", "o1"] }] },
    { ...request(), questions: [{ id: "q1", optionIds: [] }] },
    { ...request(), questions: new Array(1) },
    { ...request(), questions: [{ id: "q1", optionIds: new Array(1) }] },
    { ...request(), questions: [{ id: "q1", optionIds: ["raw option label"] }] },
    { ...request(), questions: [request().questions[0], request().questions[0]] },
    { ...request(), leaseGeneration: -1 },
    { ...request(), expiresAt: "not-a-time" },
    { ...request(), operationSha256: "bad-hash" },
    { ...request(), sourceRequestSha256: "C".repeat(64) },
    { ...request(), sourceRequestSha256: "bad-hash" },
  ])
    await expect(journal.append("session", [requested(invalid as HumanInputRequest)])).rejects.toThrow(
      "Invalid option-only",
    )
  expect(await journal.input("input-1")).toBeUndefined()
  expect(await replay(journal)).toEqual([])
})

test("answer and cancellation validate every original native, workspace, policy, lease and operation binding", async () => {
  const journal = open(path())
  await journal.append("session", [requested()])
  for (const key of Object.keys(binding()) as (keyof PermissionBinding)[]) {
    await expect(
      journal.claimInput({ ...response(), [key]: key === "leaseGeneration" ? 4 : "different" }, "host:alice", now),
    ).rejects.toThrow()
    expect((await journal.input("input-1"))!.state).toBe("pending")
  }
})

test("answers require exactly one offered option per question and cancellation requires no selections", async () => {
  const journal = open(path())
  await journal.append("session", [requested()])
  for (const invalid of [
    { ...response(), selections: [] },
    { ...response(), selections: new Array(2) },
    { ...response(), selections: [response().selections[0]] },
    { ...response(), selections: [response().selections[0], response().selections[0]] },
    {
      ...response(),
      selections: [
        { questionId: "q1", optionId: "o1" },
        { questionId: "q2", optionId: "o1" },
      ],
    },
    {
      ...response(),
      selections: [{ questionId: "q1", optionId: "o1", label: "private answer" }, response().selections[1]],
    },
    { ...response(), action: "cancel" },
    { ...response(), action: "free-text", selections: [] },
  ])
    await expect(journal.claimInput(invalid as HumanInputResponse, "host:alice", now)).rejects.toThrow(
      "exactly one offered",
    )
  await expect(journal.claimInput(response(), "host:alice", now + 60_000)).rejects.toThrow("expired")
  const cancelled = await journal.claimInput({ ...response(), action: "cancel", selections: [] }, "host:alice", now)
  expect(cancelled.record.intent).toMatchObject({ outcome: "cancelled", actorId: "host:alice" })
  expect(cancelled.record.intent?.answerSha256).toBeUndefined()
})

test("claimed option IDs are normalized, audit identity is host-owned, and review tokens never persist", async () => {
  const file = path()
  const journal = open(file)
  await journal.append("session", [requested()])
  const claimed = await journal.claimInput(
    {
      ...response(),
      selections: [...response().selections].reverse(),
      reviewToken: "ephemeral-secret",
      actorId: "forged",
      value: "raw-answer-secret",
    } as HumanInputResponse,
    "host:alice",
    now,
  )
  expect(claimed.record.response).toEqual(response())
  expect(claimed.record.intent).toMatchObject({
    actorId: "host:alice",
    decidedAt: new Date(now).toISOString(),
    outcome: "answered",
  })
  expect(claimed.record.intent?.answerSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(claimed.record.resolution).toBeUndefined()
  expect(JSON.stringify(claimed.record)).not.toMatch(/ephemeral-secret|forged|raw-answer-secret/)
  journal.close()
  const reopened = open(file)
  expect(await reopened.claimInput(response(), "host:bob", now + 120_000)).toEqual({
    created: false,
    record: claimed.record,
  })
  await expect(
    reopened.claimInput({ ...response(), action: "cancel", selections: [] }, "host:bob", now),
  ).rejects.toThrow("different response")
})

test("reviewed artifacts bind answer and permission grant intents without persisting review tokens", async () => {
  const journal = open(path())
  await journal.append("session", [requested({ ...request(), reviewArtifact: artifact() })])
  await expect(journal.claimInput(response(), "host:alice", now)).rejects.toThrow("Reviewed artifact")
  await expect(journal.claimInput(response(), "host:alice", now, "c".repeat(64))).rejects.toThrow("Reviewed artifact")
  const answer = await journal.claimInput(
    { ...response(), reviewToken: "input-review-secret" },
    "host:alice",
    now,
    artifact().sha256,
  )
  expect(answer.record.intent?.reviewArtifactSha256).toBe(artifact().sha256)
  const permission: PermissionRequest = {
    ...binding("permission"),
    action: "file-change",
    resources: ["file.txt"],
    details: {},
    choices: [
      { id: "allow", action: "allow", scope: "once", label: "Allow" },
      { id: "deny", action: "deny", scope: "once", label: "Deny" },
    ],
    expiresAt: request().expiresAt,
    reviewArtifact: artifact(),
  }
  await journal.append("session", [
    {
      ...requested(),
      type: "permission.requested",
      data: permission,
      origin: { ...requested().origin, eventId: "permission" },
    },
  ])
  const grant = { ...binding("permission"), choiceId: "allow", reviewToken: "permission-review-secret" }
  await expect(journal.claimPermission(grant, "host:alice", now)).rejects.toThrow("Reviewed artifact")
  const approved = await journal.claimPermission(grant, "host:alice", now, artifact().sha256)
  expect(approved.record.intent?.reviewArtifactSha256).toBe(artifact().sha256)
  expect(approved.record.decision).toEqual({ ...binding("permission"), choiceId: "allow" })
  expect(JSON.stringify([answer.record, approved.record, await replay(journal)])).not.toMatch(
    /input-review-secret|permission-review-secret/,
  )
})

test("closing a mixed command and interaction journal releases SQLite files synchronously", async () => {
  const file = path()
  const journal = open(file)
  await journal.reserve({
    id: "command",
    sessionId: "session",
    admissionId: "admission",
    requestSha256: "a".repeat(64),
    receipt: { commandId: "command", sessionId: "session", state: "admitted", recordedAt: new Date(now).toISOString() },
  })
  await journal.markDispatched("command", "native-turn")
  await journal.complete("command")
  await journal.append("session", [
    requested(),
    {
      ...requested(),
      type: "permission.requested",
      data: {
        ...binding("permission"),
        action: "file-change",
        resources: ["example.txt"],
        details: {},
        choices: [{ id: "deny", action: "deny", scope: "once", label: "Deny" }],
        expiresAt: request().expiresAt,
      },
      origin: { ...requested().origin, eventId: "permission" },
    },
  ])
  expect(await journal.pendingPermissions("session")).toHaveLength(1)
  expect(await journal.pendingInputs("session")).toHaveLength(1)
  await journal.recoverPermissions(now)
  await journal.recoverInputs(now)
  const events = await replay(journal)
  expect(events).toHaveLength(4)
  // This public workload prepares more than Bun 1.3.14's twenty cached queries. Closing must
  // finalize evicted statements immediately, without a GC, delay, retry or a process exit.
  journal.close()
  journal.close()
  expect(existsSync(`${file}-wal`)).toBe(false)
  expect(existsSync(`${file}-shm`)).toBe(false)
  renameSync(file, `${file}.closed`)
  const reopened = open(`${file}.closed`)
  expect(await replay(reopened)).toEqual(events)
  expect((await reopened.input("input-1"))?.resolution?.outcome).toBe("expired")
  expect((await reopened.permission("permission"))?.resolution?.outcome).toBe("expired")
  expect(await reopened.isComplete("command")).toBe(true)
})

test("only exact host answer acknowledgments settle; raw answers cannot enter resolution events", async () => {
  const journal = open(path())
  await journal.append("session", [requested()])
  await expect(
    journal.append("session", [
      resolved({
        ...binding(),
        outcome: "answered",
        actorId: "native:forged",
        decidedAt: new Date(now).toISOString(),
        answerSha256: "d".repeat(64),
      }),
    ]),
  ).rejects.toThrow("host intent")
  const claim = await journal.claimInput(response(), "host:alice", now)
  await expect(
    journal.append("session", [resolved({ ...claim.record.intent!, answerSha256: "e".repeat(64) })]),
  ).rejects.toThrow("host intent")
  await expect(
    journal.append("session", [resolved({ ...claim.record.intent!, answer: "private" } as HumanInputResolution)]),
  ).rejects.toThrow("Invalid input resolution")
  await journal.append("session", [resolved(claim.record.intent!)])
  expect((await journal.input("input-1"))!.resolution).toEqual(claim.record.intent)
  expect((await journal.claimInput(response(), "host:alice", now)).created).toBe(false)
  expect(await replay(journal)).toHaveLength(2)
})

test("native cancellation wins an in-flight answer and an ambiguous reply never authorizes another send", async () => {
  const journal = open(path())
  await journal.append("session", [requested()])
  const claim = await journal.claimInput(response(), "host:alice", now)
  const uncertain = await journal.markInputUncertain("input-1")
  expect(uncertain.state).toBe("uncertain")
  expect(uncertain.resolution).toBeUndefined()
  expect((await journal.claimInput(response(), "host:alice", now)).created).toBe(false)
  const cancel: HumanInputResolution = {
    ...binding(),
    outcome: "cancelled",
    actorId: "host:native",
    decidedAt: new Date(now + 1).toISOString(),
  }
  await journal.append("session", [resolved(cancel, "native-cancel")])
  await expect(journal.append("session", [resolved(claim.record.intent!, "late-answer")])).rejects.toThrow(
    "host intent",
  )
  expect(await journal.input("input-1")).toMatchObject({
    state: "resolved",
    intent: claim.record.intent,
    resolution: cancel,
  })
  expect((await journal.claimInput(response(), "host:alice", now)).created).toBe(false)
})

test("cross-scope events and a failed append cannot partially persist inputs or resolutions", async () => {
  const journal = open(path())
  await expect(
    journal.append("session", [{ ...requested(), scope: { ...requested().scope, turnId: "wrong-turn" } }]),
  ).rejects.toThrow("scope mismatch")
  expect(await journal.input("input-1")).toBeUndefined()
  await journal.append("session", [requested()])
  const claim = await journal.claimInput(response(), "host:alice", now)
  await expect(
    journal.append("session", [
      resolved(claim.record.intent!),
      { ...requested(), data: { ...request(), expiresAt: new Date(now + 1).toISOString() } },
    ]),
  ).rejects.toThrow("Origin conflict")
  expect((await journal.input("input-1"))!.state).toBe("claimed")
  expect(await replay(journal)).toHaveLength(1)
  await expect(
    journal.append("session", [
      { ...resolved(claim.record.intent!), scope: { ...requested().scope, commandId: "other" } },
    ]),
  ).rejects.toThrow("scope mismatch")
})

test("recovery expires pending input with one original-stream replay event and keeps claims uncertain", async () => {
  const file = path()
  const journal = open(file)
  await journal.append("original", [requested(request("a-claimed")), requested(request("z-pending"))])
  const claim = await journal.claimInput(response("a-claimed"), "host:alice", now)
  journal.close()
  const reopened = open(file)
  const recovered = await reopened.recoverInputs(now + 1)
  expect(recovered[0]).toEqual({ ...claim.record, state: "uncertain" })
  expect(recovered[1]).toMatchObject({
    state: "resolved",
    resolution: { outcome: "expired", actorId: "host:recovery" },
  })
  const replayed = await replay(reopened, "original")
  expect(replayed).toHaveLength(3)
  expect(replayed[2]).toMatchObject({
    kind: "event",
    event: { type: "input.resolved", data: recovered[1]!.resolution, scope: requested().scope },
  })
  expect(await reopened.recoverInputs(now + 2)).toEqual([])
  expect(await replay(reopened, "original")).toEqual(replayed)
  expect(await reopened.pendingInputs("session")).toEqual([])
  expect((await reopened.claimInput(response("a-claimed"), "host:alice", now)).created).toBe(false)
  await expect(reopened.claimInput(response("z-pending"), "host:alice", now)).rejects.toThrow("no longer pending")
})

test("a SQLite expiry insert failure rolls back all recovery records and events", async () => {
  const file = path()
  const journal = open(file)
  await journal.append("session", [requested(request("a-claimed")), requested(request("z-pending"))])
  const claim = await journal.claimInput(response("a-claimed"), "host:alice", now)
  const connection = new Database(file)
  try {
    connection.exec(
      `CREATE TRIGGER reject_input_expiry BEFORE INSERT ON journal_events WHEN json_extract(NEW.event, '$.type') = 'input.resolved' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
    )
    await expect(journal.recoverInputs(now + 1)).rejects.toThrow("fixture failure")
    expect(await journal.input("a-claimed")).toEqual(claim.record)
    expect((await journal.input("z-pending"))!.state).toBe("pending")
    expect(await replay(journal)).toHaveLength(2)
  } finally {
    connection.close()
  }
})

test("separate SQLite connections cannot reserve competing answer and cancel intents", async () => {
  const file = path()
  const first = open(file)
  const second = open(file)
  await first.append("session", [requested()])
  const results = await Promise.allSettled([
    first.claimInput(response(), "host:a", now),
    second.claimInput({ ...response(), action: "cancel", selections: [] }, "host:b", now),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  expect((await second.input("input-1"))!.intent?.actorId).toBe("host:a")
})

test("restart marks an awaiting-input session uncertain instead of leaving its projection active", async () => {
  const file = path()
  const journal = open(file)
  const session: AgentSession = {
    id: "session",
    workspaceId: "workspace",
    status: "awaiting-input",
    revision: 0,
    createdAt: new Date(now).toISOString(),
    binding: {
      runtimeId: "codex",
      adapterId: "codex-app-server",
      targetId: "local",
      nativeSessionId: "native-session",
    },
    intent: {
      workspaceId: "workspace",
      mode: "chat",
      requiredCapabilities: [],
      selection: {
        runtimeId: "codex",
        targetId: "local",
        model: { providerId: "local", modelId: "fixture" },
        access: { mode: "local", method: "local", billing: "local" },
        fallback: { automatic: false },
      },
      policy: {
        id: "policy",
        version: "1",
        filesystem: "read-only",
        shell: "disabled",
        network: "denied",
        allowedMcpServers: [],
        approval: "deny",
        requireEnforcedBoundary: false,
      },
    },
    effective: {
      auth: { runtimeId: "codex", targetId: "local", status: "authenticated", mode: "local" },
      billing: { route: "local", providerOverage: "not-applicable" },
      capabilities: {},
      enforcement: { mechanism: "none", filesystem: false, shell: false, network: false, limitations: [] },
      checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      configurationFingerprint: "fixture",
    },
  }
  await journal.save(session, null)
  journal.close()
  const reopened = open(file)
  expect(await reopened.recoverActiveSessions()).toEqual([{ ...session, status: "uncertain", revision: 1 }])
  expect(await reopened.recoverActiveSessions()).toEqual([])
})

test.each(["pending", "claimed", "resolved", "recovered"] as const)(
  "a killed %s input writer is recovered without replaying an answer",
  async (state) => {
    const file = path()
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import { SQLiteJournal } from ${JSON.stringify(new URL("../src/journal.ts", import.meta.url).href)};
    const journal = new SQLiteJournal(${JSON.stringify(file)});
    await journal.append("session", [${JSON.stringify(requested())}]);
    ${state === "claimed" || state === "resolved" ? `const claim = await journal.claimInput(${JSON.stringify(response())}, "host:alice", ${now});` : ""}
    ${state === "resolved" ? `await journal.append("session", [{...${JSON.stringify(resolved({ ...binding(), outcome: "expired", actorId: "host", decidedAt: new Date(now).toISOString() }))}, data: claim.record.intent}]);` : ""}
    ${state === "recovered" ? `await journal.recoverInputs(${now + 1});` : ""}
    console.log("durable"); setInterval(() => {}, 1000);
  `,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    try {
      expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("durable")
    } finally {
      child.kill()
      await child.exited
    }
    const journal = open(file)
    await journal.recoverInputs(now + 2)
    expect((await journal.input("input-1"))!.state).toBe(state === "claimed" ? "uncertain" : "resolved")
    expect(await replay(journal)).toHaveLength(state === "claimed" ? 1 : 2)
    expect(await journal.recoverInputs(now + 3)).toEqual([])
    if (state === "claimed" || state === "resolved")
      expect((await journal.claimInput(response(), "host:alice", now)).created).toBe(false)
    if (state === "pending" || state === "recovered")
      await expect(journal.claimInput(response(), "host:alice", now)).rejects.toThrow("no longer pending")
  },
)
