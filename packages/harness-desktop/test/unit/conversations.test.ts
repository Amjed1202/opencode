import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { CodexAdapter } from "@harness/adapters/codex"
import type { AgentEventDraft, SessionIntent } from "@harness/protocol"
import {
  AdmissionController,
  LocalRuntimeManager,
  LocalWorkspaceRegistry,
  SQLiteJournal,
  buildNativeEnvironment,
} from "@harness/control-plane/host"
import { StdioJsonRpc } from "../../../harness-adapters/src/codex/stdio"
import { removeFixtureDirectory } from "../../../harness-control-plane/test/support"
import { DesktopConversations } from "../../src/host/conversations"

async function fixture(scenario = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "harness-conversation-history-"))
  const workspace = join(directory, "workspace")
  const nativeHome = join(directory, "native-home")
  await mkdir(workspace)
  await mkdir(nativeHome)
  const configuration = {
    workspace: { id: "workspace", name: "Fixture", path: workspace },
    executable: process.execPath,
    nativeHome,
  }
  const intent: SessionIntent = {
    workspaceId: "workspace",
    mode: "chat",
    requiredCapabilities: ["chat", "streaming"],
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
      id: "desktop-local",
      version: "1",
      filesystem: "read-only",
      shell: "sandboxed",
      network: "denied",
      allowedMcpServers: [],
      approval: "deny",
      requireEnforcedBoundary: false,
    },
  }
  async function open(mode: string) {
    const workspaces = new LocalWorkspaceRegistry()
    await workspaces.register({
      id: "workspace",
      projectId: "fixture",
      targetId: "local",
      rootPath: workspace,
      kind: "repository",
    })
    const journal = new SQLiteJournal(join(directory, "journal.sqlite"))
    const transports: StdioJsonRpc[] = []
    const target = { id: "local", kind: "local" as const, name: "Local fixture" }
    const adapter = new CodexAdapter({
      executable: process.execPath,
      cwd: workspace,
      target,
      environment: buildNativeEnvironment({ inherited: {}, home: nativeHome, path: dirname(process.execPath) }),
      requestTimeoutMs: 2000,
      transportFactory(options) {
        const transport = new StdioJsonRpc({
          ...options,
          command: [
            process.execPath,
            resolve(import.meta.dir, "../../../harness-adapters/test/codex/app-server-peer.ts"),
            mode,
            ...options.command.slice(1),
          ],
        })
        transports.push(transport)
        return transport
      },
    })
    const descriptor = (await adapter.discover({ target, allowedExecutablePaths: [process.execPath] }))[0]!
    const runtime = () => ({ adapter, descriptor })
    const admission = new AdmissionController({ runtime, session: (id) => journal.get(id), workspaces })
    const manager = new LocalRuntimeManager({ admission, journal, runtime, workspaces })
    const conversations = new DesktopConversations(journal)
    await manager.recover()
    return {
      journal,
      adapter,
      admission,
      manager,
      conversations,
      async nativeState() {
        return (await transports.at(-1)!.request("fixture/state", {})) as { requests: string[]; turns: number }
      },
      async create() {
        const ready = await admission.preflight({ operation: "create", intent })
        if (ready.status !== "ready") throw new Error("Fixture admission failed")
        const session = await manager.createSession(ready.admissionId, randomUUID())
        await conversations.bind(session.id, configuration)
        return session
      },
      async send(sessionId: string, text: string) {
        const ready = await admission.preflight({ operation: "turn", sessionId, intent })
        if (ready.status !== "ready") throw new Error("Fixture turn admission failed")
        const id = randomUUID()
        await conversations.recordUser(sessionId, { commandId: id, messageId: id, text })
        return manager.send(sessionId, ready.admissionId, {
          commandId: id,
          messageId: id,
          delivery: "when-idle",
          parts: [{ type: "text", text }],
        })
      },
      async close() {
        try {
          await manager.dispose().catch(() => {})
          await adapter.dispose()
        } finally {
          journal.close()
        }
      },
    }
  }
  let host = await open(scenario)
  return {
    directory,
    configuration,
    intent,
    host: () => host,
    async reopen(mode = "normal") {
      await host.close()
      host = await open(mode)
      return host
    },
    async close() {
      await host.close()
      await removeFixtureDirectory(directory)
    },
  }
}

async function idle(journal: SQLiteJournal, sessionId: string) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if ((await journal.get(sessionId))?.status === "idle") return
    await Bun.sleep(5)
  }
  throw new Error("Fixture did not become idle")
}

test("bounded local history survives restart, preserves separate conversations and never discovers native history", async () => {
  const state = await fixture()
  try {
    const first = await state.host().create()
    await state.host().send(first.id, "First user message")
    await idle(state.host().journal, first.id)
    await state.host().manager.closeSession(first.id)
    const second = await state.host().create()
    await state.host().send(second.id, "Second user message")
    await idle(state.host().journal, second.id)
    const reopened = await state.reopen()
    const before = await reopened.nativeState()
    const catalog = await reopened.conversations.list(state.configuration)
    expect(catalog.items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(catalog.items.every((item) => item.compatible && item.status === "closed")).toBe(true)
    const history = await reopened.conversations.hydrate(first.id, "workspace")
    expect(history.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: "user", text: "First user message" },
      { role: "assistant", text: "Hello" },
    ])
    expect(history.completeness).toBe("partial")
    expect(history.unconfirmedMessages).toBe(0)
    expect(JSON.stringify(history)).not.toContain("unknown-sensitive-body")
    expect(JSON.stringify(catalog)).not.toContain("accountId")
    expect(JSON.stringify(catalog)).not.toContain(state.configuration.nativeHome)
    expect((await reopened.nativeState()).requests).toEqual(before.requests.concat("fixture/state"))
  } finally {
    await state.close()
  }
})

test("native actions require immutable original host selections while incompatible history remains readable", async () => {
  const state = await fixture()
  try {
    const session = await state.host().create()
    await state.host().conversations.recordUser(session.id, {
      commandId: "attempt",
      messageId: "attempt",
      text: "Unsent draft attempt",
    })
    const otherHome = join(state.directory, "another-home")
    await mkdir(otherHome)
    const otherExecutable = join(state.directory, "another-executable.exe")
    await copyFile(process.execPath, otherExecutable)
    for (const configuration of [
      { ...state.configuration, nativeHome: otherHome },
      { ...state.configuration, executable: otherExecutable },
      { ...state.configuration, runtime: "claude" as const },
    ]) {
      expect((await state.host().conversations.list(configuration)).items[0]?.compatible).toBe(false)
      await expect(state.host().conversations.requireSession(session.id, configuration, "codex-local")).rejects.toThrow(
        "original",
      )
      await expect(state.host().conversations.bind(session.id, configuration)).rejects.toThrow("conflict")
    }
    await expect(state.host().conversations.hydrate(session.id, "another-workspace")).rejects.toThrow("repository")
    await expect(
      state.host().conversations.requireSession(session.id, state.configuration, "another-runtime"),
    ).rejects.toThrow("original")
    expect((await state.host().conversations.hydrate(session.id, "workspace")).unconfirmedMessages).toBe(1)
    await expect(
      state.host().conversations.recordUser(session.id, {
        commandId: "attempt",
        messageId: "attempt",
        text: "Conflicting content",
      }),
    ).rejects.toThrow("conflict")
  } finally {
    await state.close()
  }
})

test("detached exact acknowledged work can reconcile, then only explicit fresh admission resumes its native thread", async () => {
  const state = await fixture("hold")
  try {
    const session = await state.host().create()
    const receipt = await state.host().send(session.id, "Interrupted user text")
    expect(receipt.nativeTurnId).toBe("turn-1")
    const reopened = await state.reopen()
    expect((await reopened.journal.get(session.id))?.status).toBe("uncertain")
    const inspection = await reopened.conversations.inspect(
      reopened.manager,
      session.id,
      state.configuration,
      "codex-local",
    )
    expect(inspection).toMatchObject({ nativeState: "idle", completeness: "complete", turnCount: 1, terminalTurns: 1 })
    expect(JSON.stringify(inspection)).not.toContain("turn-1")
    expect((await reopened.journal.get(session.id))?.status).toBe("uncertain")
    expect(
      (await reopened.conversations.reconcile(reopened.manager, session.id, state.configuration, "codex-local")).status,
    ).toBe("idle")
    expect(
      (await reopened.nativeState()).requests.some((method) => method === "thread/resume" || method === "turn/start"),
    ).toBe(false)
    const existing = await reopened.conversations.requireSession(session.id, state.configuration, "codex-local")
    const ready = await reopened.admission.preflight({
      operation: "resume",
      sessionId: session.id,
      intent: existing.intent,
    })
    if (ready.status !== "ready") throw new Error("Fixture resume admission failed")
    const resumed = await reopened.manager.resumeSession(session.id, ready.admissionId, randomUUID())
    expect(resumed.binding.nativeSessionId).toBe(session.binding.nativeSessionId)
    expect((await reopened.nativeState()).requests.filter((method) => method === "thread/resume")).toHaveLength(1)
    expect((await reopened.nativeState()).turns).toBe(0)
  } finally {
    await state.close()
  }
})

test("missing native acknowledgements remain uncertain and an unmatched create still blocks every workspace", async () => {
  const state = await fixture("lost-dispatch")
  try {
    const session = await state.host().create()
    expect(await state.host().send(session.id, "Never replay this")).toMatchObject({ state: "uncertain" })
    const reopened = await state.reopen()
    expect(
      (await reopened.conversations.reconcile(reopened.manager, session.id, state.configuration, "codex-local")).status,
    ).toBe("uncertain")
    expect((await reopened.conversations.hydrate(session.id, "workspace")).unconfirmedMessages).toBe(1)
    await reopened.journal.reserve({
      id: "lost-create",
      sessionId: "unknown-native-create",
      admissionId: "lost-admission",
      requestSha256: "a".repeat(64),
      receipt: {
        commandId: "lost-create",
        sessionId: "unknown-native-create",
        state: "admitted",
        recordedAt: new Date().toISOString(),
      },
    })
    await reopened.journal.recoverPending()
    expect(await reopened.journal.hasUnsettledWork("unrelated-workspace")).toBe(true)
    expect((await reopened.nativeState()).requests).not.toContain("thread/resume")
    expect((await reopened.nativeState()).turns).toBe(0)
  } finally {
    await state.close()
  }
})

test("changed native account or configuration inspection remains partial and cannot settle uncertain work", async () => {
  for (const scenario of ["history-account-switch", "history-config-switch"]) {
    const state = await fixture("hold")
    try {
      const session = await state.host().create()
      await state.host().send(session.id, "Bound account message")
      const reopened = await state.reopen(scenario)
      const inspection = await reopened.conversations.inspect(
        reopened.manager,
        session.id,
        state.configuration,
        "codex-local",
      )
      expect(inspection).toMatchObject({ nativeState: "unknown", completeness: "partial", turnCount: 0 })
      expect(
        (await reopened.conversations.reconcile(reopened.manager, session.id, state.configuration, "codex-local"))
          .status,
      ).toBe("uncertain")
    } finally {
      await state.close()
    }
  }
})

test("history budgets and pruning are explicit and raw tool or thinking content is omitted", async () => {
  const state = await fixture()
  try {
    const session = await state.host().create()
    const draft = (eventId: string): AgentEventDraft => ({
      type: "assistant.text.delta",
      data: { messageId: "assistant", partId: "part", delta: eventId },
      observedAt: new Date().toISOString(),
      scope: { sessionId: session.id, targetId: "local" },
      origin: { streamId: "local-fixture", epoch: "1", eventId, identityStrategy: "native" },
    })
    await state.host().journal.append(
      session.id,
      Array.from({ length: 1001 }, (_value, index) => draft(`delta-${index}`)),
    )
    await state.host().journal.append(session.id, [
      {
        ...draft("thinking"),
        type: "assistant.thinking",
        data: { messageId: "private", partId: "private", text: "restricted-thinking", phase: "completed" },
      },
      {
        ...draft("tool"),
        type: "tool.started",
        data: { callId: "private-call", name: "private-command", input: { token: "restricted-tool-input" } },
      },
      {
        ...draft("complete"),
        type: "assistant.text.completed",
        data: { messageId: "assistant", partId: "part", text: "Authoritative final" },
      },
    ])
    const history = await state.host().conversations.hydrate(session.id, "workspace")
    expect(history.truncated).toBe(true)
    expect(history.messages).toEqual([{ id: "assistant", role: "assistant", text: "Authoritative final" }])
    expect(JSON.stringify(history)).not.toContain("restricted-")
    expect(JSON.stringify(history)).not.toContain("private-command")
    const cursor = await state.host().journal.cursor(session.id)
    if (!cursor) throw new Error("Missing cursor")
    await state.host().journal.prune(session.id, cursor, {
      id: "restricted-snapshot",
      sha256: "a".repeat(64),
      sizeBytes: 0,
      mediaType: "application/json",
      sensitivity: "restricted",
    })
    const pruned = await state.host().conversations.hydrate(session.id, "workspace")
    expect(pruned.truncated).toBe(true)
    expect(pruned.messages).toEqual([])
    expect(JSON.stringify(pruned)).not.toContain("restricted-snapshot")
    await expect(state.host().journal.preview(session.id, 2001)).rejects.toThrow("limit")
  } finally {
    await state.close()
  }
})
