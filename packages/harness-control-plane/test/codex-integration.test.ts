import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AgentEvent, SessionIntent } from "@harness/protocol"
import { CodexAdapter } from "@harness/adapters/codex"
import { StdioJsonRpc } from "../../harness-adapters/src/codex/stdio"
import { AdmissionController } from "../src/admission"
import { LocalWorkspaceRegistry } from "../src/workspaces"
import { SQLiteJournal } from "../src/journal"
import { LocalRuntimeManager } from "../src/runtime-manager"

/** The spawned peer speaks native JSON-RPC. No provider executable or account is contacted. */
test("Codex peer flows through admission, durable orchestration, streaming and native resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-codex-integration-"))
  const target = { id: "local", kind: "local" as const, name: "Local fixture" }
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
      id: "fixture-policy",
      version: "1",
      filesystem: "read-only",
      shell: "sandboxed",
      network: "denied",
      allowedMcpServers: [],
      approval: "deny",
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
  const peer = resolve(import.meta.dir, "../../harness-adapters/test/codex/app-server-peer.ts")
  const adapter = new CodexAdapter({
    executable: process.execPath,
    cwd: directory,
    environment: { PATH: dirname(process.execPath), HOME: directory, USERPROFILE: directory },
    target,
    runtimeId: "codex-local",
    requestTimeoutMs: 2000,
    transportFactory: (options) =>
      new StdioJsonRpc({ ...options, command: [process.execPath, peer, "normal", ...options.command.slice(1)] }),
  })
  const descriptors = await adapter.discover({ target, allowedExecutablePaths: [process.execPath] })
  const descriptor = descriptors[0]
  if (!descriptor) throw new Error("Fixture runtime was not discovered")
  const runtime = () => ({ descriptor, adapter })
  const admission = new AdmissionController({ runtime, session: (id) => journal.get(id), workspaces })
  const manager = new LocalRuntimeManager({ admission, journal, runtime, workspaces })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const ready = await admission.preflight({ operation: "create", intent })
    if (ready.status !== "ready") throw new Error(JSON.stringify(ready))
    const session = await manager.createSession(ready.admissionId, "create")
    const events: AgentEvent[] = []
    const consume = (async () => {
      for await (const delivery of manager.events(session.id, undefined, controller.signal)) {
        if (delivery.kind !== "event") continue
        events.push(delivery.event)
        if (delivery.event.type === "agent.completed") break
      }
    })()
    const turn = await admission.preflight({ operation: "turn", sessionId: session.id, intent })
    if (turn.status !== "ready") throw new Error(JSON.stringify(turn))
    const input = {
      commandId: "turn",
      messageId: "message",
      delivery: "when-idle",
      parts: [{ type: "text", text: "Local protocol fixture only" }],
    } as const
    const receipt = await manager.send(session.id, turn.admissionId, input)
    expect(receipt.state).toBe("dispatched")
    await consume
    expect(events.map((event) => event.type)).toContain("assistant.text.delta")
    expect(events.at(-1)?.type).toBe("agent.completed")
    expect(events.every((event) => event.scope.sessionId === session.id && event.scope.commandId === "turn")).toBe(true)
    expect((await journal.get(session.id))?.status).toBe("idle")
    expect(await journal.recoverPending()).toEqual([])
    await manager.closeSession(session.id)
    const resume = await admission.preflight({ operation: "resume", sessionId: session.id, intent })
    if (resume.status !== "ready") throw new Error(JSON.stringify(resume))
    const resumed = await manager.resumeSession(session.id, resume.admissionId, "resume")
    expect(resumed.binding.nativeSessionId).toBe("thread-1")
    expect((await manager.send(session.id, turn.admissionId, input)).nativeTurnId).toBe("turn-1")
    expect(JSON.stringify(events)).not.toContain("never-retain-this")
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await manager.dispose()
    await adapter.dispose()
    journal.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
