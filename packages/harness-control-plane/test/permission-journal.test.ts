import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentEventDraft,
  EventDelivery,
  PermissionBinding,
  PermissionDecision,
  PermissionRequest,
  PermissionResolution,
} from "@harness/protocol"
import { SQLiteJournal } from "../src/journal"

const directories: string[] = []
const journals: SQLiteJournal[] = []
const now = Date.parse("2026-09-06T12:00:00.000Z")

afterEach(() => {
  journals.splice(0).forEach((journal) => journal.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function database() {
  const directory = mkdtempSync(join(tmpdir(), "harness-permissions-"))
  directories.push(directory)
  return join(directory, "journal.sqlite")
}

function open(path: string) {
  const journal = new SQLiteJournal(path)
  journals.push(journal)
  return journal
}

function binding(requestId = "permission-1"): PermissionBinding {
  return {
    requestId,
    sessionId: "session-1",
    targetId: "local",
    workspaceId: "workspace-1",
    runtimeId: "runtime-1",
    nativeSessionId: "native-session-1",
    nativeTurnId: "native-turn-1",
    nativeRequestId: "native-request-1",
    policyId: "policy-1",
    policyVersion: "1",
    leaseGeneration: 4,
    operationSha256: "a".repeat(64),
  }
}

function request(requestId = "permission-1"): PermissionRequest {
  return {
    ...binding(requestId),
    toolCallId: "tool-1",
    action: "command",
    resources: ["workspace:file.txt"],
    details: { command: "read file.txt", cwd: "workspace" },
    choices: [
      { id: "allow-once", action: "allow", scope: "once", label: "Allow once" },
      { id: "deny-once", action: "deny", scope: "once", label: "Deny" },
      { id: "allow-session", action: "allow", scope: "session", label: "Allow session" },
    ],
    expiresAt: new Date(now + 60_000).toISOString(),
  }
}

function decision(requestId = "permission-1", choiceId = "allow-once"): PermissionDecision {
  return { ...binding(requestId), choiceId }
}

function requested(
  value = request(),
  eventId = "requested",
): Extract<AgentEventDraft, { type: "permission.requested" }> {
  return {
    type: "permission.requested",
    data: value,
    scope: {
      targetId: value.targetId,
      runtimeId: value.runtimeId,
      sessionId: value.sessionId,
      workspaceId: value.workspaceId,
      commandId: "command-1",
    },
    origin: { streamId: "native-stream", epoch: "native-epoch", eventId, identityStrategy: "native" },
    observedAt: new Date(now).toISOString(),
  }
}

function resolved(
  resolution: PermissionResolution,
  eventId = "resolved",
): Extract<AgentEventDraft, { type: "permission.resolved" }> {
  return { ...requested(request(), eventId), type: "permission.resolved", data: resolution }
}

function expired(): PermissionResolution {
  return { ...binding(), outcome: "expired", actorId: "host:runtime", decidedAt: new Date(now + 60_000).toISOString() }
}

async function replay(journal: SQLiteJournal, streamId = "session-1") {
  const deliveries: EventDelivery[] = []
  for await (const delivery of journal.read(streamId)) deliveries.push(delivery)
  return deliveries
}

test("request and replay survive SQLite restart without recreating a resolved approval", async () => {
  const path = database()
  const original = open(path)
  expect((await original.append("session-1", [requested()]))[0]!.sequence).toBe(1)
  expect(await original.pendingPermissions("session-1")).toEqual([{ request: request(), state: "pending" }])
  expect(await original.pendingPermissions("other-session")).toEqual([])
  original.close()
  const restarted = open(path)
  expect(await restarted.append("session-1", [requested()])).toEqual([])
  expect(
    await restarted.recordPermission({ ...request(), details: { cwd: "workspace", command: "read file.txt" } }),
  ).toEqual({ created: false, record: { request: request(), state: "pending" } })
  await restarted.append("session-1", [resolved(expired())])
  await restarted.append("session-1", [requested(request(), "repeated-request")])
  expect((await restarted.permission("permission-1"))!.state).toBe("resolved")
  expect(await restarted.pendingPermissions("session-1")).toEqual([])
})

test("the exact original request is immutable, including operation details and offered choices", async () => {
  const journal = open(database())
  await journal.recordPermission(request())
  for (const value of [
    { ...request(), details: { command: "write file.txt" } },
    { ...request(), nativeRequestId: "replacement-handle" },
    { ...request(), resources: ["other:file.txt"] },
    { ...request(), expiresAt: new Date(now + 120_000).toISOString() },
    { ...request(), choices: request().choices.slice(1) },
  ]) {
    await expect(journal.recordPermission(value)).rejects.toThrow("Permission conflict")
  }
  expect((await journal.permission("permission-1"))!.request).toEqual(request())
})

test("every scope, policy, native identity, lease and operation digest must match before a claim", async () => {
  const journal = open(database())
  await journal.recordPermission(request())
  for (const key of Object.keys(binding()) as (keyof PermissionBinding)[]) {
    const changed = key === "leaseGeneration" ? 5 : key === "operationSha256" ? "b".repeat(64) : "other"
    await expect(journal.claimPermission({ ...decision(), [key]: changed }, "host:alice", now)).rejects.toThrow()
    expect((await journal.permission("permission-1"))!.state).toBe("pending")
  }
})

test("only offered once choices may be claimed and expiry blocks a fresh grant", async () => {
  const journal = open(database())
  await journal.recordPermission(request())
  await expect(journal.claimPermission(decision("permission-1", "unknown"), "host:alice", now)).rejects.toThrow(
    "once choice",
  )
  await expect(journal.claimPermission(decision("permission-1", "allow-session"), "host:alice", now)).rejects.toThrow(
    "once choice",
  )
  await expect(journal.claimPermission(decision(), "host:alice", now + 60_000)).rejects.toThrow("expired")
  expect((await journal.permission("permission-1"))!.state).toBe("pending")
  expect(await journal.pendingPermissions("session-1")).toHaveLength(1)
})

test("invalid request identities, choices, expiry and audit inputs cannot enter the permission ledger", async () => {
  const journal = open(database())
  for (const value of [
    { ...request(), policyId: "" },
    { ...request(), operationSha256: "not-a-digest" },
    { ...request(), leaseGeneration: -1 },
    { ...request(), expiresAt: "invalid" },
    { ...request(), choices: [] },
    { ...request(), choices: [request().choices[0]!, request().choices[0]!] },
  ])
    await expect(journal.recordPermission(value)).rejects.toThrow("Invalid permission request")
  expect(await journal.permission("permission-1")).toBeUndefined()
  await journal.recordPermission(request())
  await expect(journal.claimPermission(decision(), " ", now)).rejects.toThrow("trusted permission actor")
  await expect(journal.claimPermission(decision(), "host:alice", Number.NaN)).rejects.toThrow("decision time")
  expect((await journal.permission("permission-1"))!.state).toBe("pending")
})

test("claim durably assigns the trusted actor and time, ignoring renderer audit fields", async () => {
  const path = database()
  const journal = open(path)
  await journal.recordPermission(request())
  const submitted = { ...decision(), actorId: "renderer:forged", decidedAt: "1900-01-01T00:00:00Z" }
  const claimed = await journal.claimPermission(submitted, "host:alice", now)
  expect(claimed.created).toBe(true)
  expect(claimed.record.state).toBe("claimed")
  expect(claimed.record.resolution).toBeUndefined()
  expect(claimed.record.intent).toEqual({
    ...decision(),
    outcome: "allowed",
    actorId: "host:alice",
    decidedAt: new Date(now).toISOString(),
  })
  expect(claimed.record.decision).toEqual(decision())
  journal.close()
  const restarted = open(path)
  expect(await restarted.permission("permission-1")).toEqual(claimed.record)
  expect(await restarted.claimPermission(decision(), "host:bob", now + 120_000)).toEqual({
    created: false,
    record: claimed.record,
  })
  await expect(restarted.claimPermission(decision("permission-1", "deny-once"), "host:bob", now)).rejects.toThrow(
    "different decision",
  )
})

test("request persistence rolls back with event origin conflicts and command receipt updates", async () => {
  const journal = open(database())
  const command = {
    id: "command-1",
    requestSha256: "c".repeat(64),
    admissionId: "admission-1",
    sessionId: "session-1",
    receipt: {
      commandId: "command-1",
      sessionId: "session-1",
      state: "admitted" as const,
      recordedAt: new Date(now).toISOString(),
    },
  }
  await journal.reserve(command)
  await journal.append("session-1", [requested()])
  await expect(
    journal.append(
      "session-1",
      [
        requested(request("permission-2"), "second-request"),
        { ...requested(), data: { ...request(), action: "changed action" } },
      ],
      { ...command, receipt: { ...command.receipt, state: "dispatched" } },
    ),
  ).rejects.toThrow("Origin conflict")
  expect(await journal.permission("permission-2")).toBeUndefined()
  expect((await journal.command("command-1"))!.receipt.state).toBe("admitted")
  expect(await replay(journal)).toHaveLength(1)
  expect((await journal.append("session-1", [requested(request("permission-2"), "second-request")]))[0]!.sequence).toBe(
    2,
  )
  expect(await journal.commands("session-1")).toEqual([command])
  expect(await journal.commands("other")).toEqual([])
})

test("an unclaimed or cross-scope native grant cannot become authority or enter the event stream", async () => {
  const journal = open(database())
  await journal.append("session-1", [requested()])
  const grant: PermissionResolution = {
    ...decision(),
    outcome: "allowed",
    actorId: "native:forged",
    decidedAt: new Date(now).toISOString(),
  }
  await expect(journal.append("session-1", [resolved(grant)])).rejects.toThrow("host intent")
  await expect(
    journal.append("session-1", [{ ...resolved(expired()), scope: { targetId: "other", sessionId: "session-1" } }]),
  ).rejects.toThrow("scope mismatch")
  await expect(
    journal.append("session-1", [resolved({ ...expired(), operationSha256: "b".repeat(64) })]),
  ).rejects.toThrow("binding mismatch")
  for (const scope of [
    { ...resolved(expired()).scope, commandId: "other-command" },
    { ...resolved(expired()).scope, turnId: "other-turn" },
    { ...resolved(expired()).scope, runtimeId: "other-runtime" },
    { ...resolved(expired()).scope, workspaceId: "other-workspace" },
  ]) {
    await expect(journal.append("session-1", [{ ...resolved(expired()), scope }])).rejects.toThrow("scope mismatch")
  }
  expect((await journal.permission("permission-1"))!.state).toBe("pending")
  expect(await replay(journal)).toHaveLength(1)
})

test("acknowledgement and resolution event commit atomically and retain the original host audit actor", async () => {
  const path = database()
  const journal = open(path)
  await journal.append("session-1", [requested()])
  const claim = await journal.claimPermission(decision(), "host:alice", now)
  await expect(
    journal.finishPermission("permission-1", resolved({ ...claim.record.intent!, actorId: "native:changed" })),
  ).rejects.toThrow("host intent")
  await expect(
    journal.append("session-1", [
      resolved(claim.record.intent!),
      { ...requested(), data: { ...request(), action: "conflicting replay" } },
    ]),
  ).rejects.toThrow("Origin conflict")
  expect((await journal.permission("permission-1"))!.state).toBe("claimed")
  expect(await replay(journal)).toHaveLength(1)
  const finished = await journal.finishPermission("permission-1", resolved(claim.record.intent!))
  expect(finished.state).toBe("resolved")
  journal.close()
  const restarted = open(path)
  expect((await replay(restarted))[1]).toMatchObject({
    kind: "event",
    event: { type: "permission.resolved", data: claim.record.intent },
  })
  expect(await restarted.recoverPermissions(now)).toEqual([])
  expect(await restarted.claimPermission(decision(), "host:other", now)).toEqual({ created: false, record: finished })
})

test("a native expiry wins a grant race permanently while retaining the attempted decision audit", async () => {
  const path = database()
  const journal = open(path)
  await journal.append("session-1", [requested()])
  const claim = await journal.claimPermission(decision(), "host:alice", now)
  await journal.append("session-1", [resolved(expired(), "native-timeout")])
  await expect(journal.finishPermission("permission-1", resolved(claim.record.intent!, "late-grant"))).rejects.toThrow(
    "host intent",
  )
  const final = (await journal.permission("permission-1"))!
  expect(final).toMatchObject({
    state: "resolved",
    resolution: expired(),
    intent: claim.record.intent,
    decision: decision(),
  })
  expect(await journal.markPermissionUncertain("permission-1")).toEqual(final)
  journal.close()
  const restarted = open(path)
  expect(await restarted.claimPermission(decision(), "host:alice", now)).toEqual({ created: false, record: final })
  expect((await replay(restarted)).length).toBe(2)
})

test("autonomous denial or expiry is terminal even when no user decision was claimed", async () => {
  const journal = open(database())
  await journal.append("session-1", [requested(), resolved(expired())])
  await expect(journal.claimPermission(decision(), "host:alice", now)).rejects.toThrow("no longer pending")
  await expect(
    journal.append("session-1", [resolved({ ...expired(), outcome: "denied" }, "replacement")]),
  ).rejects.toThrow("cannot be replaced")
  expect((await journal.permission("permission-1"))!.resolution).toEqual(expired())
})

test("two SQLite connections reserve at most one reply and an ambiguous result cannot be retried", async () => {
  const path = database()
  const first = open(path)
  const second = open(path)
  await first.recordPermission(request())
  const claims = await Promise.all([
    first.claimPermission(decision(), "host:first", now),
    second.claimPermission(decision(), "host:second", now),
  ])
  expect(claims.filter((claim) => claim.created)).toHaveLength(1)
  expect(claims[0]!.record).toEqual(claims[1]!.record)
  const uncertain = await second.markPermissionUncertain("permission-1")
  expect(uncertain.state).toBe("uncertain")
  expect(uncertain.resolution).toBeUndefined()
  expect(await first.claimPermission(decision(), "host:first", now)).toEqual({ created: false, record: uncertain })
  expect(await first.pendingPermissions("session-1")).toEqual([])
  await expect(first.claimPermission(decision("permission-1", "deny-once"), "host:first", now)).rejects.toThrow(
    "different decision",
  )
})

test("competing grant and denial decisions leave exactly one original durable intent", async () => {
  const path = database()
  const first = open(path)
  const second = open(path)
  await first.recordPermission(request())
  const choices = await Promise.allSettled([
    first.claimPermission(decision("permission-1", "deny-once"), "host:first", now),
    second.claimPermission(decision(), "host:second", now),
  ])
  expect(choices.filter((choice) => choice.status === "fulfilled")).toHaveLength(1)
  expect(choices.filter((choice) => choice.status === "rejected")).toHaveLength(1)
  expect((await first.permission("permission-1"))!.intent).toMatchObject({
    outcome: "denied",
    actorId: "host:first",
  })
})

test("exclusive restart recovery expires lost pending handles and makes claimed grants uncertain", async () => {
  const path = database()
  const journal = open(path)
  await journal.recordPermission(request("before-claim"))
  await journal.recordPermission(request("after-claim"))
  const claimed = await journal.claimPermission(decision("after-claim"), "host:alice", now)
  journal.close()
  const restarted = open(path)
  expect(await restarted.recoverPermissions(now + 1, "host:restart")).toEqual([
    { ...claimed.record, state: "uncertain" },
    {
      request: request("before-claim"),
      state: "resolved",
      resolution: {
        ...binding("before-claim"),
        outcome: "expired",
        actorId: "host:restart",
        decidedAt: new Date(now + 1).toISOString(),
      },
    },
  ])
  await expect(restarted.claimPermission(decision("before-claim"), "host:alice", now)).rejects.toThrow(
    "no longer pending",
  )
  expect((await restarted.claimPermission(decision("after-claim"), "host:alice", now)).created).toBe(false)
  expect(await restarted.recoverPermissions(now + 2)).toEqual([])
  expect(await restarted.pendingPermissions("session-1")).toEqual([])
  expect(await replay(restarted)).toEqual([
    expect.objectContaining({
      kind: "event",
      event: expect.objectContaining({
        type: "permission.resolved",
        data: expect.objectContaining({ requestId: "before-claim", outcome: "expired", actorId: "host:restart" }),
      }),
    }),
  ])
})

test.each(["pending", "claimed", "resolved"] as const)(
  "recovers a %s permission after terminating the writer without a clean SQLite close",
  async (state) => {
    const path = database()
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { SQLiteJournal } from ${JSON.stringify(new URL("../src/journal.ts", import.meta.url).href)};
      const journal = new SQLiteJournal(${JSON.stringify(path)});
      await journal.append("session-1", [${JSON.stringify(requested())}]);
      ${state !== "pending" ? `const claimed = await journal.claimPermission(${JSON.stringify(decision())}, "host:alice", ${now});` : ""}
      ${state === "resolved" ? `await journal.finishPermission("permission-1", {...${JSON.stringify(resolved(expired()))}, data: claimed.record.intent});` : ""}
      console.log("durable");
      setInterval(() => {}, 1000);`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    try {
      const output = await child.stdout.getReader().read()
      expect(new TextDecoder().decode(output.value)).toContain("durable")
    } finally {
      child.kill()
      await child.exited
    }
    const restarted = open(path)
    expect((await restarted.permission("permission-1"))!.state).toBe(state)
    await restarted.recoverPermissions(now + 1)
    expect((await restarted.permission("permission-1"))!.state).toBe(state === "claimed" ? "uncertain" : "resolved")
    if (state === "pending") {
      await expect(restarted.claimPermission(decision(), "host:alice", now)).rejects.toThrow("no longer pending")
    }
    if (state !== "pending")
      expect((await restarted.claimPermission(decision(), "host:alice", now)).created).toBe(false)
    expect(await restarted.append("session-1", [requested()])).toEqual([])
    expect(await replay(restarted)).toHaveLength(state === "claimed" ? 1 : 2)
    if (state === "pending")
      expect((await replay(restarted))[1]).toMatchObject({
        kind: "event",
        event: {
          type: "permission.resolved",
          data: { outcome: "expired", actorId: "host:recovery", decidedAt: new Date(now + 1).toISOString() },
          scope: { ...requested().scope, turnId: "native-turn-1" },
        },
      })
  },
)

test("recovery commits the expiry audit to the original request stream once, preserving command scope", async () => {
  const path = database()
  const journal = open(path)
  await journal.append("original-host-stream", [requested()])
  journal.close()
  const restarted = open(path)
  const recovered = await restarted.recoverPermissions(now + 1)
  const replayed = await replay(restarted, "original-host-stream")
  expect(replayed).toHaveLength(2)
  expect(replayed[1]).toMatchObject({
    kind: "event",
    event: {
      type: "permission.resolved",
      sequence: 2,
      streamId: "original-host-stream",
      data: recovered[0]!.resolution,
      scope: { ...requested().scope, turnId: "native-turn-1" },
    },
  })
  expect(await replay(restarted)).toEqual([])
  expect(await restarted.recoverPermissions(now + 2)).toEqual([])
  expect(await replay(restarted, "original-host-stream")).toEqual(replayed)
})

test("a rejected expiry event rolls back pending and claimed recovery transitions together", async () => {
  const path = database()
  const journal = open(path)
  await journal.append("session-1", [
    requested(request("a-claimed"), "claimed-request"),
    requested(request("z-pending"), "pending-request"),
  ])
  const claim = await journal.claimPermission(decision("a-claimed"), "host:alice", now)
  const failure = new Database(path)
  failure.exec(`CREATE TRIGGER reject_expiry BEFORE INSERT ON journal_events
    WHEN json_extract(NEW.event, '$.type') = 'permission.resolved'
    BEGIN SELECT RAISE(ABORT, 'fixture expiry append failed'); END`)
  failure.close()
  await expect(journal.recoverPermissions(now + 1)).rejects.toThrow("fixture expiry append failed")
  expect(await journal.permission("a-claimed")).toEqual(claim.record)
  expect((await journal.permission("z-pending"))!.state).toBe("pending")
  expect(await replay(journal)).toHaveLength(2)
  const repaired = new Database(path)
  repaired.exec("DROP TRIGGER reject_expiry")
  repaired.close()
  expect(await journal.recoverPermissions(now + 2)).toHaveLength(2)
  expect((await journal.permission("a-claimed"))!.state).toBe("uncertain")
  expect((await journal.permission("a-claimed"))!.resolution).toBeUndefined()
  expect((await journal.permission("z-pending"))!.resolution?.outcome).toBe("expired")
  expect(await replay(journal)).toHaveLength(3)
})

test("a killed recovery writer leaves both the expired permission and its replay event durably committed", async () => {
  const path = database()
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { SQLiteJournal } from ${JSON.stringify(new URL("../src/journal.ts", import.meta.url).href)};
    const journal = new SQLiteJournal(${JSON.stringify(path)});
    await journal.append("session-1", [${JSON.stringify(requested())}]);
    await journal.recoverPermissions(${now + 1});
    console.log("recovered");
    setInterval(() => {}, 1000);`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  try {
    const output = await child.stdout.getReader().read()
    expect(new TextDecoder().decode(output.value)).toContain("recovered")
  } finally {
    child.kill()
    await child.exited
  }
  const restarted = open(path)
  const record = (await restarted.permission("permission-1"))!
  expect(record.state).toBe("resolved")
  expect(record.resolution?.outcome).toBe("expired")
  const replayed = await replay(restarted)
  expect(replayed).toHaveLength(2)
  expect(replayed[1]).toMatchObject({ kind: "event", event: { type: "permission.resolved", data: record.resolution } })
  expect(await restarted.recoverPermissions(now + 2)).toEqual([])
  expect(await replay(restarted)).toEqual(replayed)
  await expect(restarted.claimPermission(decision(), "host:alice", now + 2)).rejects.toThrow("no longer pending")
})

test("independent processes cannot both claim the same native reply handle", async () => {
  const path = database()
  const journal = open(path)
  await journal.recordPermission(request())
  const children = ["host:alice", "host:bob"].map((actorId) =>
    Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { SQLiteJournal } from ${JSON.stringify(new URL("../src/journal.ts", import.meta.url).href)};
    const journal = new SQLiteJournal(${JSON.stringify(path)});
    console.log(JSON.stringify(await journal.claimPermission(${JSON.stringify(decision())}, ${JSON.stringify(actorId)}, ${now})));
    journal.close();`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ),
  )
  const results = await Promise.all(
    children.map(async (child) => ({
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
      exitCode: await child.exited,
    })),
  )
  expect(results.map((result) => ({ stderr: result.stderr, exitCode: result.exitCode }))).toEqual([
    { stderr: "", exitCode: 0 },
    { stderr: "", exitCode: 0 },
  ])
  expect(results.map((result) => JSON.parse(result.stdout).created).sort()).toEqual([false, true])
  expect((await journal.permission("permission-1"))!.state).toBe("claimed")
})

test.each([
  JSON.stringify({ protocolVersion: "0.1", type: "permission.requested", data: { requestId: "legacy-unbound" } }),
  JSON.stringify({ protocolVersion: "0.2", type: "input.requested", data: { requestId: "legacy-input" } }),
  JSON.stringify({ protocolVersion: "9.9", type: "native.event" }),
  JSON.stringify({ protocolVersion: null }),
  JSON.stringify({}),
  "{invalid JSON",
])("incompatible stored event %s requires migration without changing the legacy database", (event) => {
  const path = database()
  const legacy = new Database(path)
  legacy.exec("CREATE TABLE journal_events (id TEXT PRIMARY KEY, event TEXT NOT NULL)")
  legacy.query("INSERT INTO journal_events (id, event) VALUES (?, ?)").run("legacy-event", event)
  legacy.close()
  const preserved = readFileSync(path)
  expect(() => new SQLiteJournal(path)).toThrow("explicit migration to protocol 0.3")
  expect(readFileSync(path)).toEqual(preserved)
  const reopened = new Database(path)
  try {
    expect(reopened.query("SELECT event FROM journal_events WHERE id = ?").get("legacy-event")).toEqual({ event })
    expect(reopened.query("SELECT name FROM sqlite_master WHERE name = 'journal_permissions'").get()).toBeNull()
    expect(reopened.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
  } finally {
    reopened.close()
  }
})

test("an old command-only journal remains compatible and appends new protocol 0.3 events", async () => {
  const path = database()
  const legacy = new Database(path)
  const command = {
    id: "legacy-command",
    requestSha256: "d".repeat(64),
    admissionId: "legacy-admission",
    sessionId: "session-1",
    receipt: {
      commandId: "legacy-command",
      sessionId: "session-1",
      state: "admitted" as const,
      recordedAt: new Date(now).toISOString(),
    },
  }
  legacy.exec(
    "CREATE TABLE journal_commands (id TEXT PRIMARY KEY, record TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0)",
  )
  legacy.query("INSERT INTO journal_commands (id, record) VALUES (?, ?)").run(command.id, JSON.stringify(command))
  legacy.close()
  const journal = open(path)
  expect(await journal.command(command.id)).toEqual(command)
  expect((await journal.append("session-1", [requested()]))[0]!.protocolVersion).toBe("0.3")
})
