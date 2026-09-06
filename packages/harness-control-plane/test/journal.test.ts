import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEventDraft, AgentSession, ArtifactReference, EventDelivery } from "@harness/protocol"
import type { CommandRecord } from "../src/index"
import { SQLiteJournal } from "../src/journal"

const directories: string[] = []
const journals: SQLiteJournal[] = []

afterEach(() => {
  journals.splice(0).forEach((journal) => journal.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function database() {
  const directory = mkdtempSync(join(tmpdir(), "harness-journal-"))
  directories.push(directory)
  return join(directory, "journal.sqlite")
}

function open(path: string) {
  const journal = new SQLiteJournal(path)
  journals.push(journal)
  return journal
}

function command(id = "command-1"): CommandRecord {
  return {
    id,
    requestSha256: "a".repeat(64),
    admissionId: "admission-1",
    sessionId: "session-1",
    receipt: {
      commandId: id,
      sessionId: "session-1",
      state: "admitted",
      recordedAt: "2026-09-06T12:00:00.000Z",
    },
  }
}

test("reserves one durable command and returns its recorded receipt on exact retry after restart", async () => {
  const path = database()
  const original = open(path)
  expect(await original.reserve(command())).toEqual({ created: true, record: command() })
  original.close()
  const restarted = open(path)
  const retry = { ...command(), receipt: { ...command().receipt, recordedAt: "2026-09-06T12:01:00.000Z" } }
  expect(await restarted.reserve(retry)).toEqual({ created: false, record: command() })
  expect(await restarted.command("command-1")).toEqual(command())
})

test("rejects conflicting command content or admission bindings without replacing the admitted command", async () => {
  const journal = open(database())
  await journal.reserve(command())
  await expect(journal.reserve({ ...command(), requestSha256: "b".repeat(64) })).rejects.toThrow("Command conflict")
  await expect(journal.reserve({ ...command(), admissionId: "other-admission" })).rejects.toThrow("Command conflict")
  await expect(journal.reserve({ ...command(), sessionId: "other-session" })).rejects.toThrow()
  expect(await journal.command("command-1")).toEqual(command())
})

function draft(eventId: string): Extract<AgentEventDraft, { type: "assistant.text.delta" }> {
  return {
    type: "assistant.text.delta",
    data: { messageId: "message-1", partId: "part-1", delta: eventId },
    origin: { streamId: "native-stream", epoch: "native-epoch", eventId, identityStrategy: "native" },
    scope: { targetId: "local", sessionId: "session-1", commandId: "command-1" },
    observedAt: "2026-09-06T12:00:00.000Z",
  }
}

async function replay(journal: SQLiteJournal, ...args: Parameters<SQLiteJournal["read"]>) {
  const result: EventDelivery[] = []
  for await (const delivery of journal.read(...args)) result.push(delivery)
  return result
}

test("durably deduplicates full source identities before assigning contiguous host sequence numbers", async () => {
  const path = database()
  const original = open(path)
  const first = await original.append("host-stream", [draft("one"), draft("one"), draft("two")])
  expect(first.map((event) => event.sequence)).toEqual([1, 2])
  expect(first[0]!.origin.sequence).toBeUndefined()
  expect(first[0]!.id).not.toEqual("one")
  original.close()
  const restarted = open(path)
  expect(await restarted.append("host-stream", [draft("one")])).toEqual([])
  const third = await restarted.append("host-stream", [draft("three")])
  expect(third[0]!.epoch).toEqual(first[0]!.epoch)
  expect(third[0]!.sequence).toEqual(3)
  const cursor = { streamId: "host-stream", epoch: first[0]!.epoch, sequence: 1 }
  expect(await replay(restarted, "host-stream", cursor)).toEqual([
    { kind: "event", event: first[1]! },
    { kind: "event", event: third[0]! },
  ])
  expect(await restarted.cursor("host-stream")).toEqual({ ...cursor, sequence: 3 })
})

test("same event ID is independent across source streams and epochs", async () => {
  const journal = open(database())
  const one = draft("same")
  const result = await journal.append("host", [
    one,
    { ...one, origin: { ...one.origin, epoch: "second-epoch" } },
    { ...one, origin: { ...one.origin, streamId: "second-stream" } },
  ])
  expect(result.map((event) => event.sequence)).toEqual([1, 2, 3])
  const independent = await journal.append("other-host", [
    { ...one, origin: { ...one.origin, eventId: "independent" } },
  ])
  expect(independent[0]!.sequence).toEqual(1)
  await expect(journal.append("other-host", [one])).rejects.toThrow("Origin conflict")
})

test("conflicting source identity rolls back the entire append and its command receipt", async () => {
  const journal = open(database())
  await journal.reserve(command())
  await journal.append("host", [draft("one")])
  const conflicting: AgentEventDraft = {
    ...draft("one"),
    data: { messageId: "message-1", partId: "part-1", delta: "changed" },
  }
  await expect(
    journal.append("host", [draft("two"), conflicting], {
      ...command(),
      receipt: { ...command().receipt, state: "dispatched", nativeTurnId: "turn-1" },
    }),
  ).rejects.toThrow("Origin conflict")
  expect((await journal.command("command-1"))!.receipt.state).toEqual("admitted")
  expect((await replay(journal, "host")).length).toEqual(1)
  expect((await journal.append("host", [draft("two")]))[0]!.sequence).toEqual(2)
})

test("rejects foreign, stale-epoch and future cursors instead of silently replaying unrelated history", async () => {
  const journal = open(database())
  const first = (await journal.append("host", [draft("one")]))[0]!
  const cursor = { streamId: "host", epoch: first.epoch, sequence: 0 }
  await expect(replay(journal, "host", { ...cursor, streamId: "other" })).rejects.toThrow("Cursor")
  await expect(replay(journal, "host", { ...cursor, epoch: "stale" })).rejects.toThrow("Cursor")
  await expect(replay(journal, "host", { ...cursor, sequence: 2 })).rejects.toThrow("Cursor")
  await expect(replay(journal, "host", { ...cursor, sequence: -1 })).rejects.toThrow("Cursor")
  await expect(replay(journal, "missing", cursor)).rejects.toThrow("Cursor")
})

function session(revision = 0): AgentSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "idle",
    revision,
    createdAt: "2026-09-06T12:00:00.000Z",
    binding: { runtimeId: "runtime-1", adapterId: "adapter-1", targetId: "local", nativeSessionId: "native-session-1" },
    intent: {
      workspaceId: "workspace-1",
      mode: "chat",
      requiredCapabilities: [],
      selection: {
        runtimeId: "runtime-1",
        targetId: "local",
        model: { providerId: "local", modelId: "fixture" },
        access: { mode: "local", method: "local", billing: "local" },
        fallback: { automatic: false },
      },
      policy: {
        id: "policy-1",
        version: "1",
        filesystem: "read-only",
        shell: "disabled",
        network: "denied",
        allowedMcpServers: [],
        approval: "deny",
        requireEnforcedBoundary: true,
      },
    },
    effective: {
      auth: { runtimeId: "runtime-1", targetId: "local", status: "authenticated", mode: "local" },
      billing: { route: "local", providerOverage: "not-applicable" },
      capabilities: {},
      enforcement: { mechanism: "os-sandbox", filesystem: true, shell: true, network: true, limitations: [] },
      checkedAt: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-06T13:00:00.000Z",
      configurationFingerprint: "fixture",
    },
  }
}

test("persists sessions and rejects lost updates from a second SQLite connection", async () => {
  const path = database()
  const first = open(path)
  await first.save(session(), null)
  const second = open(path)
  expect(await second.get("session-1")).toEqual(session())
  await first.save({ ...session(1), status: "running" }, 0)
  await expect(second.save({ ...session(1), status: "closed" }, 0)).rejects.toThrow("Session revision conflict")
  await expect(second.save(session(), null)).rejects.toThrow("Session revision conflict")
  await expect(second.save(session(3), 1)).rejects.toThrow("Session revision")
  first.close()
  second.close()
  const restarted = open(path)
  expect(await restarted.list("workspace-1")).toEqual([{ ...session(1), status: "running" }])
  expect(await restarted.list("other")).toEqual([])
  expect(await restarted.get("missing")).toBeUndefined()
})

test("explicit recovery marks commands from both dispatch crash windows uncertain without replaying events", async () => {
  const path = database()
  const original = open(path)
  await original.reserve(command("before-dispatch"))
  await original.reserve(command("after-dispatch"))
  await original.markDispatched("after-dispatch", "turn-1")
  original.close()
  const restarted = open(path)
  const recovered = await restarted.recoverPending()
  expect(recovered.map((record) => record.id).sort()).toEqual(["after-dispatch", "before-dispatch"])
  expect(recovered.every((record) => record.receipt.state === "uncertain")).toBe(true)
  expect((await restarted.command("after-dispatch"))!.receipt.nativeTurnId).toEqual("turn-1")
  expect((await restarted.reserve(command("before-dispatch"))).created).toBe(false)
  expect(await restarted.recoverPending()).toEqual([])
  expect(await replay(restarted, "session-1")).toEqual([])
})

test("a durably correlated native completion reconciles uncertainty and survives later restart", async () => {
  const path = database()
  const journal = open(path)
  await journal.reserve(command())
  await journal.markDispatched("command-1", "turn-1")
  await journal.recoverPending()
  const completed: AgentEventDraft = {
    ...draft("completed"),
    type: "agent.completed",
    data: { nativeTurnId: "turn-1", outcome: "succeeded" },
  }
  await journal.append("host", [completed], {
    ...command(),
    receipt: { ...command().receipt, state: "dispatched", nativeTurnId: "turn-1" },
  })
  journal.close()
  const restarted = open(path)
  expect(await restarted.recoverPending()).toEqual([])
  expect((await restarted.command("command-1"))!.receipt.state).toEqual("dispatched")
})

test("explicit completion of create or resume commands requires an acknowledged dispatch", async () => {
  const journal = open(database())
  await journal.reserve(command())
  await expect(journal.complete("command-1")).rejects.toThrow("dispatched")
  await journal.markDispatched("command-1")
  await journal.complete("command-1")
  expect(await journal.recoverPending()).toEqual([])
})

test("retention emits a durable snapshot gap and keeps source deduplication after payload removal", async () => {
  const path = database()
  const original = open(path)
  const events = await original.append("host", [draft("one"), draft("two"), draft("three")])
  const through = { streamId: "host", epoch: events[0]!.epoch, sequence: 2 }
  const snapshot: ArtifactReference = {
    id: "snapshot-1",
    sha256: "c".repeat(64),
    mediaType: "application/json",
    sizeBytes: 100,
    sensitivity: "content",
  }
  await original.prune("host", through, snapshot)
  original.close()
  const restarted = open(path)
  const recovery = await replay(restarted, "host", { ...through, sequence: 1 })
  expect(recovery).toEqual([
    {
      kind: "gap",
      recovery: { status: "gap", reason: "Requested events have been pruned", snapshot, cursor: through },
    },
  ])
  expect(await replay(restarted, "host")).toEqual(recovery)
  expect(await replay(restarted, "host", through)).toEqual([{ kind: "event", event: events[2]! }])
  expect(await restarted.append("host", [draft("one")])).toEqual([])
  expect((await restarted.append("host", [draft("four")]))[0]!.sequence).toEqual(4)
  await expect(restarted.prune("host", { ...through, epoch: "other" }, snapshot)).rejects.toThrow("Cursor")
  await expect(restarted.prune("host", { ...through, sequence: 1 }, snapshot)).rejects.toThrow("Retention")
})

test("a completion from another native turn cannot settle an uncertain command", async () => {
  const journal = open(database())
  await journal.reserve(command())
  await journal.markDispatched("command-1", "turn-1")
  await journal.recoverPending()
  const completed: AgentEventDraft = {
    ...draft("foreign-completion"),
    type: "agent.completed",
    data: { nativeTurnId: "turn-other", outcome: "succeeded" },
  }
  await journal.append("host", [completed])
  expect((await journal.command("command-1"))!.receipt.state).toEqual("uncertain")
  await expect(journal.markDispatched("command-1")).rejects.toThrow()
  await expect(
    journal.append("host", [], {
      ...command(),
      receipt: { ...command().receipt, state: "dispatched", nativeTurnId: "turn-1" },
    }),
  ).rejects.toThrow("transition")
})

test("a settled native completion cannot regress to uncertain through a late receipt", async () => {
  const journal = open(database())
  await journal.reserve(command())
  await journal.markDispatched("command-1", "turn-1")
  await journal.append("host", [
    {
      ...draft("completed"),
      type: "agent.completed",
      data: { nativeTurnId: "turn-1", outcome: "succeeded" },
    },
  ])
  await expect(
    journal.append("host", [], {
      ...command(),
      receipt: { ...command().receipt, state: "uncertain", nativeTurnId: "turn-1" },
    }),
  ).rejects.toThrow("settled")
  expect((await journal.command("command-1"))!.receipt.state).toEqual("dispatched")
})

test("origin content comparison accepts reordered JSON keys and rejects changed source sequences", async () => {
  const journal = open(database())
  await journal.append("host", [draft("one")])
  expect(
    await journal.append("host", [
      {
        ...draft("one"),
        data: { delta: "one", partId: "part-1", messageId: "message-1" },
      },
    ]),
  ).toEqual([])
  await expect(
    journal.append("host", [{ ...draft("one"), origin: { ...draft("one").origin, sequence: 1 } }]),
  ).rejects.toThrow("Origin conflict")
})

test.each(["admitted", "dispatched"] as const)(
  "recovers a %s command after forcibly terminating its writer process",
  async (state) => {
    const path = database()
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import { SQLiteJournal } from ${JSON.stringify(new URL("../src/journal.ts", import.meta.url).href)};
    const journal = new SQLiteJournal(${JSON.stringify(path)});
    await journal.reserve(${JSON.stringify(command())});
    ${state === "dispatched" ? 'await journal.markDispatched("command-1", "turn-1");' : ""}
    await journal.append("host", [${JSON.stringify(draft("persisted"))}]);
    console.log("persisted");
    setInterval(() => {}, 1000);
  `,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    try {
      const output = await child.stdout.getReader().read()
      expect(new TextDecoder().decode(output.value)).toContain("persisted")
    } finally {
      child.kill()
      await child.exited
    }
    const recovered = open(path)
    expect((await recovered.command("command-1"))!.receipt.state).toEqual(state)
    expect((await recovered.recoverPending())[0]!.receipt.state).toEqual("uncertain")
    expect((await recovered.reserve(command())).created).toBe(false)
    expect((await replay(recovered, "host")).length).toEqual(1)
    expect(await recovered.append("host", [draft("persisted")])).toEqual([])
  },
)
