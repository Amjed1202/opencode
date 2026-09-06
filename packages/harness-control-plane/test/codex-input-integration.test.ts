import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AgentEvent, HumanInputRequest, HumanInputResponse, SessionIntent } from "@harness/protocol"
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
const privateQuestion = "Private choice fixture: which storage should this use?"
const privateLabel = "Private remote storage"

afterEach(async () => {
  const cleanup = await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()))
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
  journals.splice(0).forEach((journal) => journal.close())
  artifactStores.splice(0).forEach((store) => store.close())
  for (const directory of directories.splice(0)) await removeFixtureDirectory(directory)
  for (const result of cleanup) if (result.status === "rejected") throw result.reason
})

/** Actual native request/reply over stdio using synthetic choices and an isolated local peer. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-codex-input-integration-"))
  const artifactDirectory = await mkdtemp(join(tmpdir(), "harness-codex-input-artifacts-"))
  directories.push(directory, artifactDirectory)
  const artifacts = await EncryptedArtifactStore.open({ rootPath: artifactDirectory, key: randomBytes(32) })
  artifactStores.push(artifacts)
  const target = { id: "local", kind: "local" as const, name: "Local fixture" }
  const intent: SessionIntent = {
    workspaceId: "workspace",
    mode: "chat",
    requiredCapabilities: ["chat", "streaming", "human-input"],
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
  expect(
    (
      await manager.send(session.id, turn.admissionId, {
        commandId: "turn",
        messageId: "message",
        delivery: "when-idle",
        parts: [{ type: "text", text: "Local protocol fixture only" }],
      })
    ).nativeTurnId,
  ).toBe("turn-1")
  return {
    journal,
    manager,
    admission,
    session,
    transport: () => transport!,
    state: async () =>
      (await transport!.request("fixture/state", {})) as {
        requests: string[]
        turns: number
        approvals: { id: string | number; result?: unknown; error?: unknown }[]
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

async function events(state: Awaited<ReturnType<typeof fixture>>) {
  const result: AgentEvent[] = []
  for await (const delivery of state.journal.read(state.session.id))
    if (delivery.kind === "event") result.push(delivery.event)
  return result
}

async function request(state: Awaited<ReturnType<typeof fixture>>) {
  await state.transport().request("fixture/native-request", {
    request: {
      id: "native-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-choice",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "native-storage",
            header: "Private storage header",
            question: privateQuestion,
            isOther: false,
            isSecret: false,
            options: [
              { label: "Private local storage", description: "Private local description" },
              { label: privateLabel, description: "Private remote description" },
            ],
          },
        ],
      },
    },
  })
  await waitUntil(async () => (await state.journal.pendingInputs(state.session.id)).length === 1)
  await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "awaiting-input")
  const pending = (await state.journal.pendingInputs(state.session.id))[0]!
  expect(pending.state).toBe("pending")
  expect(pending.intent).toBeUndefined()
  expect(pending.resolution).toBeUndefined()
  expect((await state.state()).approvals).toEqual([])
  return pending.request
}

function answer(request: HumanInputRequest): HumanInputResponse {
  return { ...request, action: "answer", selections: [{ questionId: "q1", optionId: "o2" }] }
}

test("protected native choice input is reviewed, bound, flushed once and excluded from journal content", async () => {
  const state = await fixture()
  const pending = await request(state)
  expect(pending.questions).toEqual([{ id: "q1", optionIds: ["o1", "o2"] }])
  expect(pending.reviewArtifact?.sensitivity).toBe("restricted")
  const initial = await events(state)
  expect(initial.find((event) => event.type === "input.requested")).toMatchObject({
    data: pending,
    scope: { commandId: "turn", turnId: "turn-1", sessionId: state.session.id },
  })
  expect(JSON.stringify(initial)).not.toContain(privateQuestion)
  expect(JSON.stringify(initial)).not.toContain(privateLabel)
  expect(JSON.stringify(initial)).not.toContain("native-storage")
  await expect(state.manager.resolveInput(answer(pending))).rejects.toThrow("review")
  const review = await state.manager.reviewInput(pending.requestId)
  expect(review.content).toMatchObject({
    kind: "choice-input",
    requestId: pending.requestId,
    operationSha256: pending.operationSha256,
  })
  expect(JSON.stringify(review.content)).toContain(privateQuestion)
  expect(JSON.stringify(review.content)).toContain(privateLabel)
  const response = { ...answer(pending), reviewToken: review.reviewToken, actorId: "renderer:forged" }
  await expect(state.manager.resolveInput({ ...response, operationSha256: "f".repeat(64) })).rejects.toThrow()
  expect((await state.state()).approvals).toEqual([])
  await state.manager.resolveInput(response)
  await state.manager.resolveInput(response)
  expect((await state.state()).approvals).toEqual([
    { id: "native-input", result: { answers: { "native-storage": { answers: [privateLabel] } } } },
  ])
  const record = (await state.journal.input(pending.requestId))!
  expect(record.state).toBe("resolved")
  expect(record.resolution).toMatchObject({
    outcome: "answered",
    actorId: "host:integration-user",
    reviewArtifactSha256: review.artifact.sha256,
    answerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(record.resolution).toEqual(record.intent)
  expect((await state.journal.get(state.session.id))?.status).toBe("running")
  const audit = await events(state)
  expect(audit.filter((event) => event.type === "input.resolved")).toHaveLength(1)
  expect(audit.filter((event) => event.type === "interaction.reviewed")).toHaveLength(1)
  for (const data of [JSON.stringify(audit), JSON.stringify(record)]) {
    expect(data).not.toContain(privateQuestion)
    expect(data).not.toContain(privateLabel)
    expect(data).not.toContain("Private remote description")
    expect(data).not.toContain("native-storage")
    expect(data).not.toContain(review.reviewToken)
    expect(data).not.toContain("renderer:forged")
  }
  expect((await state.state()).turns).toBe(1)
}, 15_000)

test("native choice cancellation needs no review and repeated cancellation sends no second reply", async () => {
  const state = await fixture()
  const pending = await request(state)
  const response: HumanInputResponse = { ...pending, action: "cancel", selections: [] }
  await state.manager.resolveInput(response)
  await state.manager.resolveInput(response)
  expect((await state.state()).approvals).toEqual([{ id: "native-input", result: { answers: {} } }])
  expect((await state.journal.input(pending.requestId))?.resolution).toMatchObject({
    outcome: "cancelled",
    actorId: "host:integration-user",
  })
  await expect(state.manager.resolveInput(answer(pending))).rejects.toThrow()
  expect((await state.state()).approvals).toHaveLength(1)
  expect((await events(state)).filter((event) => event.type === "input.resolved")).toHaveLength(1)
}, 15_000)

test("native cancellation retires a reviewed choice without a late answer or a replay", async () => {
  const state = await fixture()
  const pending = await request(state)
  const review = await state.manager.reviewInput(pending.requestId)
  await state.transport().request("fixture/notification", {
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "native-input" },
  })
  await waitUntil(async () => (await state.journal.input(pending.requestId))?.state === "resolved")
  expect((await state.journal.input(pending.requestId))?.resolution?.outcome).toBe("cancelled")
  const response = { ...answer(pending), reviewToken: review.reviewToken }
  await expect(state.manager.resolveInput(response)).rejects.toThrow()
  await expect(state.manager.resolveInput(response)).rejects.toThrow()
  expect((await state.state()).approvals).toEqual([])
  expect((await events(state)).filter((event) => event.type === "input.resolved")).toHaveLength(1)
}, 15_000)

test("closing the host session retires reviewed input and cannot send the selected answer", async () => {
  const state = await fixture()
  const pending = await request(state)
  const review = await state.manager.reviewInput(pending.requestId)
  await state.manager.closeSession(state.session.id)
  expect((await state.journal.input(pending.requestId))?.resolution?.outcome).toBe("expired")
  expect((await state.journal.get(state.session.id))?.status).toBe("uncertain")
  await expect(state.manager.resolveInput({ ...answer(pending), reviewToken: review.reviewToken })).rejects.toThrow()
  expect((await state.state()).approvals).toEqual([{ id: "native-input", result: { answers: {} } }])
  expect(JSON.stringify(await events(state))).not.toContain(privateLabel)
}, 15_000)
