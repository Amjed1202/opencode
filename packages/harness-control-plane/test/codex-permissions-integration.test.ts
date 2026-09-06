import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AgentEvent, AgentSession, PermissionDecision, PermissionRequest, SessionIntent } from "@harness/protocol"
import { CodexAdapter } from "@harness/adapters/codex"
import { StdioJsonRpc } from "../../harness-adapters/src/codex/stdio"
import { AdmissionController } from "../src/admission"
import { EncryptedArtifactStore } from "../src/artifacts"
import { SQLiteJournal } from "../src/journal"
import { LocalRuntimeManager } from "../src/runtime-manager"
import { LocalWorkspaceRegistry } from "../src/workspaces"
import { removeFixtureDirectory } from "./support"

const directories: string[] = []
const journals: SQLiteJournal[] = []
const managers: LocalRuntimeManager[] = []
const adapters: CodexAdapter[] = []
const artifactStores: EncryptedArtifactStore[] = []

afterEach(async () => {
  const cleanup = await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()))
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
  journals.splice(0).forEach((journal) => journal.close())
  artifactStores.splice(0).forEach((store) => store.close())
  for (const directory of directories.splice(0)) await removeFixtureDirectory(directory)
  for (const result of cleanup) if (result.status === "rejected") throw result.reason
})

/** Actual native JSON-RPC over stdio, with local fixture content and no provider process or account. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-codex-permissions-integration-"))
  directories.push(directory)
  const artifactDirectory = await mkdtemp(join(tmpdir(), "harness-codex-permissions-artifacts-"))
  directories.push(artifactDirectory)
  const artifacts = await EncryptedArtifactStore.open({ rootPath: artifactDirectory, key: randomBytes(32) })
  artifactStores.push(artifacts)
  const target = { id: "local", kind: "local" as const, name: "Local fixture" }
  const intent: SessionIntent = {
    workspaceId: "workspace",
    mode: "chat",
    requiredCapabilities: ["chat", "streaming", "permissions"],
    selection: {
      runtimeId: "codex-local",
      targetId: "local",
      model: { providerId: "openai", modelId: "gpt-5.4" },
      access: {
        mode: "subscription",
        method: "chatgpt-subscription",
        billing: "subscription",
        overagePolicy: "acknowledge-provider-settings",
      },
      fallback: { automatic: false },
    },
    policy: {
      id: "fixture-policy",
      version: "1",
      filesystem: "workspace-write",
      shell: "sandboxed",
      network: "denied",
      allowedMcpServers: [],
      approval: "ask",
      requireEnforcedBoundary: false,
    },
  }
  const workspaces = new LocalWorkspaceRegistry()
  await workspaces.register({
    id: "workspace",
    projectId: "project",
    targetId: "local",
    rootPath: directory,
    kind: "repository",
  })
  const journal = new SQLiteJournal(join(directory, "journal.sqlite"))
  journals.push(journal)
  const peer = resolve(import.meta.dir, "../../harness-adapters/test/codex/app-server-peer.ts")
  let transport: StdioJsonRpc | undefined
  const adapter = new CodexAdapter({
    executable: process.execPath,
    cwd: directory,
    environment: { PATH: dirname(process.execPath), HOME: directory, USERPROFILE: directory },
    target,
    runtimeId: "codex-local",
    requestTimeoutMs: 2000,
    approvalTimeoutMs: 5000,
    transportFactory: (options) =>
      (transport = new StdioJsonRpc({
        ...options,
        command: [process.execPath, peer, "hold", ...options.command.slice(1)],
      })),
  })
  adapters.push(adapter)
  const descriptor = (await adapter.discover({ target, allowedExecutablePaths: [process.execPath] }))[0]
  if (!descriptor) throw new Error("Local fixture runtime was not discovered")
  const runtime = () => ({ descriptor, adapter })
  const admission = new AdmissionController({ runtime, session: (id) => journal.get(id), workspaces })
  const manager = new LocalRuntimeManager({
    admission,
    journal,
    runtime,
    workspaces,
    artifacts,
    actorId: "host:integration-user",
  })
  managers.push(manager)
  const ready = await admission.preflight({ operation: "create", intent })
  if (ready.status !== "ready") throw new Error(JSON.stringify(ready))
  const session = await manager.createSession(ready.admissionId, "create")
  const turn = await admission.preflight({ operation: "turn", sessionId: session.id, intent })
  if (turn.status !== "ready") throw new Error(JSON.stringify(turn))
  const input = {
    commandId: "turn",
    messageId: "message",
    delivery: "when-idle",
    parts: [{ type: "text", text: "Local protocol fixture only" }],
  } as const
  expect((await manager.send(session.id, turn.admissionId, input)).nativeTurnId).toBe("turn-1")
  return {
    directory,
    journal,
    manager,
    adapter,
    admission,
    session,
    intent,
    input,
    turn,
    transport: () => transport!,
    state: async () =>
      (await transport!.request("fixture/state", {})) as {
        requests: string[]
        turns: number
        approvals: { id: string | number; result: unknown }[]
      },
  }
}

async function waitUntil(predicate: () => Promise<boolean>) {
  const expires = Date.now() + 3000
  while (!(await predicate())) {
    if (Date.now() >= expires) throw new Error("Timed out waiting for the durable native event")
    await Bun.sleep(5)
  }
}

async function events(journal: SQLiteJournal, session: AgentSession) {
  const result: AgentEvent[] = []
  for await (const delivery of journal.read(session.id)) if (delivery.kind === "event") result.push(delivery.event)
  return result
}

async function request(state: Awaited<ReturnType<typeof fixture>>, action: "file" | "command") {
  await state.transport().request("fixture/native-request", {
    notifications:
      action === "file"
        ? [
            {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  type: "fileChange",
                  id: "item-file",
                  status: "inProgress",
                  changes: [
                    {
                      path: join(state.directory, "proposed.txt"),
                      kind: { type: "add" },
                      diff: "+private-fixture-diff",
                    },
                  ],
                },
              },
            },
          ]
        : [],
    request: {
      id: action === "file" ? "native-file-request" : 42,
      method: action === "file" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: action === "file" ? "item-file" : "item-command",
        startedAtMs: Date.now(),
        ...(action === "command"
          ? { command: "private-fixture-command --token=never-persist", cwd: state.directory }
          : {}),
      },
    },
  })
  await waitUntil(async () => (await state.journal.pendingPermissions(state.session.id)).length === 1)
  const pending = (await state.journal.pendingPermissions(state.session.id))[0]!
  await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "awaiting-permission")
  expect(pending.state).toBe("pending")
  expect(pending.intent).toBeUndefined()
  expect(pending.resolution).toBeUndefined()
  expect((await state.state()).approvals).toEqual([])
  return pending.request
}

function decision(request: PermissionRequest, choiceId: string): PermissionDecision {
  return { ...request, choiceId }
}

async function complete(state: Awaited<ReturnType<typeof fixture>>) {
  await state.transport().request("fixture/notification", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: null,
      },
    },
  })
  await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "idle")
}

test("a native file approval passes through admission, durable pending state, host once grant and completion", async () => {
  const state = await fixture()
  const pending = await request(state, "file")
  expect(pending.choices.map((choice) => choice.id)).toEqual(["allow-once", "deny-once"])
  expect(pending.resources).toEqual([join(state.directory, "proposed.txt")])
  expect(pending).toMatchObject({
    sessionId: state.session.id,
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-1",
    nativeRequestId: "string:native-file-request",
    workspaceId: "workspace",
    targetId: "local",
    runtimeId: "codex-local",
    policyId: "fixture-policy",
    policyVersion: "1",
  })
  const delivered = (await events(state.journal, state.session)).find((event) => event.type === "permission.requested")
  expect(delivered).toMatchObject({
    data: pending,
    scope: { commandId: "turn", turnId: "turn-1", sessionId: state.session.id },
  })
  expect(delivered?.sequence).toBeGreaterThan(0)
  await expect(state.manager.resolvePermission(decision(pending, "allow-once"))).rejects.toThrow("review")
  const review = await state.manager.reviewPermission(pending.requestId)
  expect(review.content).toMatchObject({
    kind: "patch",
    requestId: pending.requestId,
    operationSha256: pending.operationSha256,
  })
  expect(JSON.stringify(review.content)).toContain("private-fixture-diff")
  const submitted = { ...decision(pending, "allow-once"), actorId: "renderer:forged", reviewToken: review.reviewToken }
  await state.manager.resolvePermission(submitted)
  await state.manager.resolvePermission(submitted)
  expect((await state.state()).approvals).toEqual([{ id: "native-file-request", result: { decision: "accept" } }])
  const record = (await state.journal.permission(pending.requestId))!
  expect(record.state).toBe("resolved")
  expect(record.intent?.actorId).toBe("host:integration-user")
  expect(record.resolution).toEqual(record.intent)
  expect(record.resolution?.outcome).toBe("allowed")
  expect(record.resolution?.reviewArtifactSha256).toBe(review.artifact.sha256)
  expect((await state.journal.get(state.session.id))?.status).toBe("running")
  await complete(state)
  const audit = await events(state.journal, state.session)
  expect(audit.filter((event) => event.type === "permission.resolved")).toHaveLength(1)
  expect(audit.find((event) => event.type === "permission.resolved")?.data).toEqual(record.resolution)
  expect(audit.at(-1)?.type).toBe("agent.completed")
  expect(await state.journal.isComplete("turn")).toBe(true)
  expect(JSON.stringify(audit)).not.toContain("private-fixture-diff")
  expect(JSON.stringify(audit)).not.toContain("renderer:forged")
  expect(JSON.stringify(audit)).not.toContain(review.reviewToken)
  expect(audit.filter((event) => event.type === "interaction.reviewed")).toHaveLength(1)
  expect((await state.state()).turns).toBe(1)
}, 15_000)

test("a native command expansion is durably deny-only and cannot be promoted to a host grant", async () => {
  const state = await fixture()
  const pending = await request(state, "command")
  expect(pending.choices).toEqual([{ id: "deny-once", action: "deny", scope: "once", label: "Deny" }])
  await expect(state.manager.resolvePermission(decision(pending, "allow-once"))).rejects.toThrow()
  expect((await state.journal.permission(pending.requestId))?.state).toBe("pending")
  expect((await state.state()).approvals).toEqual([])
  await state.manager.resolvePermission(decision(pending, "deny-once"))
  await state.manager.resolvePermission(decision(pending, "deny-once"))
  expect((await state.state()).approvals).toEqual([{ id: 42, result: { decision: "decline" } }])
  expect((await state.journal.permission(pending.requestId))?.resolution).toMatchObject({
    outcome: "denied",
    actorId: "host:integration-user",
  })
  await complete(state)
  const audit = await events(state.journal, state.session)
  expect(audit.filter((event) => event.type === "permission.resolved")).toHaveLength(1)
  expect(JSON.stringify(audit)).not.toContain("private-fixture-command")
  expect(JSON.stringify(audit)).not.toContain("never-persist")
  expect((await state.state()).turns).toBe(1)
}, 15_000)

test("read-only native history reconciles a detached known turn without prompt replay or native resume", async () => {
  const state = await fixture()
  await state.manager.closeSession(state.session.id)
  expect((await state.journal.get(state.session.id))?.status).toBe("uncertain")
  expect((await state.journal.command("turn"))?.receipt).toMatchObject({ state: "uncertain", nativeTurnId: "turn-1" })
  const before = await state.state()
  const cursor = await state.journal.cursor(state.session.id)
  const observed = await state.manager.inspectSession(state.session.id)
  expect(observed).toMatchObject({
    nativeState: "idle",
    completeness: "complete",
    turns: [{ nativeTurnId: "turn-1", status: "succeeded" }],
  })
  expect(observed.binding).toEqual(state.session.binding)
  expect(await state.journal.cursor(state.session.id)).toEqual(cursor)
  expect((await state.journal.command("turn"))?.receipt.state).toBe("uncertain")
  expect((await state.manager.reconcileSession(state.session.id)).status).toBe("idle")
  expect(await state.journal.isComplete("turn")).toBe(true)
  const after = await state.state()
  const inspectionRequests = after.requests.slice(before.requests.length)
  expect(inspectionRequests).toContain("thread/read")
  expect(inspectionRequests).toContain("thread/turns/list")
  expect(
    inspectionRequests.every((method) =>
      ["account/read", "config/read", "thread/read", "thread/turns/list", "fixture/state"].includes(method),
    ),
  ).toBe(true)
  expect(after.turns).toBe(before.turns)
  expect(after.requests.filter((method) => method === "thread/start")).toHaveLength(1)
  expect(after.requests).not.toContain("thread/resume")
  expect(after.approvals).toEqual([])
  const completions = (await events(state.journal, state.session)).filter((event) => event.type === "agent.completed")
  expect(completions).toHaveLength(1)
  expect(completions[0]).toMatchObject({
    data: { nativeTurnId: "turn-1", outcome: "succeeded" },
    scope: { commandId: "turn" },
    origin: { streamId: `host:recovery:${state.session.id}` },
  })
  expect((await state.manager.send(state.session.id, state.turn.admissionId, state.input)).nativeTurnId).toBe("turn-1")
  expect((await state.state()).turns).toBe(1)
}, 15_000)
