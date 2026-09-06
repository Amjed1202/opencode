import { afterEach, expect, test } from "bun:test"
import { dirname } from "node:path"
import type { AdmittedSessionRequest, AgentEventDraft, SessionIntent } from "@harness/protocol"
import { CodexAdapter } from "../../src/codex/adapter"
import { StdioJsonRpc } from "../../src/codex/stdio"

const active: CodexAdapter[] = []
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
    id: "policy",
    version: "1",
    filesystem: "read-only",
    shell: "sandboxed",
    network: "denied",
    allowedMcpServers: [],
    approval: "deny",
    requireEnforcedBoundary: false,
  },
}
function fixture(
  scenario = "normal",
  environment = { PATH: dirname(process.execPath), HOME: import.meta.dir, USERPROFILE: import.meta.dir },
) {
  let transport: StdioJsonRpc | undefined
  const adapter = new CodexAdapter({
    executable: process.execPath,
    cwd: import.meta.dir,
    environment,
    target: { id: "local", kind: "local", name: "Local" },
    runtimeId: "codex-local",
    requestTimeoutMs: 1000,
    transportFactory: (options) =>
      (transport = new StdioJsonRpc({
        ...options,
        command: [process.execPath, `${import.meta.dir}/app-server-peer.ts`, scenario, ...options.command.slice(1)],
      })),
  })
  active.push(adapter)
  return {
    adapter,
    state: async () =>
      (await transport!.request("fixture/state", {})) as {
        requests: string[]
        turns: number
        approvals: { id: string | number; result: unknown }[]
      },
    transport: () => transport!,
  }
}
async function admission(adapter: CodexAdapter): Promise<AdmittedSessionRequest> {
  const result = await adapter.preflight({ operation: "create", intent })
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  return {
    operation: "create",
    admissionId: "admission-1",
    sessionId: "session-1",
    intent,
    workspace: {
      id: "workspace",
      projectId: "project",
      targetId: "local",
      rootPath: import.meta.dir,
      kind: "repository",
    },
    lease: {
      id: "lease",
      workspaceId: "workspace",
      targetId: "local",
      ownerId: "host",
      mode: "write",
      generation: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    effective: result.effective,
  }
}
const input = {
  commandId: "command-1",
  messageId: "message-1",
  delivery: "when-idle",
  parts: [{ type: "text", text: "fixture only" }],
} as const
afterEach(async () => {
  await Promise.all(active.splice(0).map((adapter) => adapter.dispose()))
})

test.each([
  { PATH: "" },
  { PATH: "." },
  { HOME: "relative" },
  { HOME: import.meta.dir, USERPROFILE: dirname(import.meta.dir) },
  { OPENAI_API_KEY: "fixture-not-secret" },
])("adapter rejects invalid native process environment %j before spawning", (override) => {
  expect(() =>
    fixture("normal", {
      PATH: dirname(process.execPath),
      HOME: import.meta.dir,
      USERPROFILE: import.meta.dir,
      ...override,
    }),
  ).toThrow()
})

test("preflight verifies managed ChatGPT status without claiming overage is disabled", async () => {
  const peer = fixture()
  const result = await peer.adapter.preflight({ operation: "create", intent })
  expect(result.status).toBe("ready")
  if (result.status !== "ready") return
  expect(result.effective.auth.mode).toBe("subscription")
  expect(result.effective.billing.providerOverage).toBe("unknown")
  expect(result.effective.auth.accountId).not.toContain("@")
  expect((await peer.state()).turns).toBe(0)
})

test("native nullable extension defaults and managed credential-store settings are observationally safe", async () => {
  expect((await fixture("native-defaults").adapter.preflight({ operation: "create", intent })).status).toBe("ready")
})

test.each(["api", "provider", "helper", "profile", "wrong-version", "mcp", "ignored-overrides", "shell-injection"])(
  "preflight blocks %s without creating a native thread or turn",
  async (scenario) => {
    const peer = fixture(scenario)
    expect((await peer.adapter.preflight({ operation: "create", intent })).status).toBe("blocked")
  },
)

test("missing or non-finite workspace lease expiry cannot create a thread", async () => {
  const peer = fixture()
  const admitted = await admission(peer.adapter)
  const result = await peer.adapter
    .createSession({ ...admitted, lease: { ...admitted.lease, expiresAt: "invalid" } })
    .catch((error: Error) => error)
  expect(result).toBeInstanceOf(Error)
  expect((await peer.state()).requests).not.toContain("thread/start")
})

test("conflicting native account updates block further admission even if account/read lags", async () => {
  const peer = fixture()
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  await peer.transport().request("fixture/account-updated", {})
  expect((await peer.adapter.preflight({ operation: "turn", intent, existingSession: session })).status).toBe("blocked")
  expect((await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)).state).toBe(
    "rejected",
  )
  expect((await peer.state()).turns).toBe(0)
})

test("duplicate pending command cannot release another send's reservation", async () => {
  const peer = fixture("hold")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const context = { session, admissionId: "admission-1", leaseGeneration: 1 }
  const first = peer.adapter.send(context, input)
  expect((await peer.adapter.send(context, input)).state).toBe("rejected")
  expect((await peer.adapter.send(context, { ...input, commandId: "other" })).state).toBe("rejected")
  expect((await first).state).toBe("dispatched")
  expect((await peer.state()).turns).toBe(1)
})

test("stale native lifecycle/text cannot release or contaminate the active command", async () => {
  const peer = fixture("hold")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const context = { session, admissionId: "admission-1", leaseGeneration: 1 }
  await peer.adapter.send(context, input)
  const events: AgentEventDraft[] = []
  const consume = (async () => {
    for await (const event of peer.adapter.events(session)) {
      events.push(event)
      if (event.type === "agent.completed" && event.data.nativeTurnId === "turn-1") break
    }
  })()
  await peer.transport().request("fixture/stale-events", {})
  expect((await peer.adapter.send(context, { ...input, commandId: "second" })).state).toBe("rejected")
  await peer.adapter.interrupt(context)
  await consume
  expect(events.filter((event) => event.type === "agent.completed").map((event) => event.data.nativeTurnId)).toEqual([
    "turn-1",
  ])
  expect(JSON.stringify(events)).not.toContain("wrong-turn-content")
  expect(
    events.filter((event) => event.scope.turnId === "stale-turn").every((event) => event.scope.commandId === undefined),
  ).toBe(true)
})

test("an unsupported server request cannot masquerade as a turn completion notification", async () => {
  const peer = fixture("hold")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const context = { session, admissionId: "admission-1", leaseGeneration: 1 }
  await peer.adapter.send(context, input)
  await peer.transport().request("fixture/request-spoof", {})
  expect((await peer.adapter.send(context, { ...input, commandId: "second" })).state).toBe("rejected")
})

test("native error is normalized without retaining potentially sensitive error bodies", async () => {
  const peer = fixture("failed")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const events: AgentEventDraft[] = []
  const consume = (async () => {
    for await (const event of peer.adapter.events(session)) {
      events.push(event)
      if (event.type === "agent.completed") break
    }
  })()
  await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)
  await consume
  expect(events.some((event) => event.type === "agent.error")).toBe(true)
  expect(events.at(-1)?.type === "agent.completed" && events.at(-1)?.data).toEqual({
    nativeTurnId: "turn-1",
    outcome: "failed",
  })
  expect(JSON.stringify(events)).not.toContain("native error must be sanitized")
})

test("routine account quota updates do not invalidate or interrupt an active turn", async () => {
  const peer = fixture("hold")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)
  await peer.transport().request("fixture/rate-limits", {})
  expect((await peer.state()).requests).not.toContain("turn/interrupt")
  expect((await peer.adapter.preflight({ operation: "turn", intent, existingSession: session })).status).toBe("ready")
})

test("slow event consumers receive an explicit gap and the owned native process stops", async () => {
  const peer = fixture("hold")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)
  await peer
    .transport()
    .request("fixture/flood", {})
    .catch(() => undefined)
  const events: AgentEventDraft[] = []
  for await (const event of peer.adapter.events(session)) events.push(event)
  expect(events.some((event) => event.type === "stream.gap")).toBe(true)
})

test("included-only policy blocks unknown provider overage", async () => {
  const peer = fixture()
  expect(
    (
      await peer.adapter.preflight({
        operation: "create",
        intent: {
          ...intent,
          selection: {
            ...intent.selection,
            access: {
              mode: "subscription",
              method: "chatgpt-subscription",
              billing: "subscription",
              overagePolicy: "require-disabled",
            },
          },
        },
      })
    ).status,
  ).toBe("blocked")
})

test.each(["account-switch", "config-switch", "thread-provider", "thread-network", "active-thread"])(
  "create revalidates %s before allowing turns",
  async (scenario) => {
    const peer = fixture(scenario)
    const admitted = await admission(peer.adapter)
    const result = await peer.adapter.createSession(admitted).catch((error: Error) => error)
    expect(result).toBeInstanceOf(Error)
    expect((await peer.state()).turns).toBe(0)
  },
)

test("native text/completion mapping preserves correlation and omits unknown sensitive bodies", async () => {
  const peer = fixture()
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const events: AgentEventDraft[] = []
  const consume = (async () => {
    for await (const event of peer.adapter.events(session)) {
      events.push(event)
      if (event.type === "agent.completed") break
    }
  })()
  const receipt = await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)
  await consume
  expect(receipt.state).toBe("dispatched")
  expect(receipt.nativeTurnId).toBe("turn-1")
  expect(events.map((event) => event.type)).toEqual([
    "agent.started",
    "assistant.text.delta",
    "assistant.text.completed",
    "native.event",
    "agent.completed",
  ])
  expect(events.every((event) => event.scope.commandId === "command-1")).toBe(true)
  expect(JSON.stringify(events)).toContain("native-safe-id")
  expect(JSON.stringify(events)).not.toContain("never-retain-this")
  expect(JSON.stringify(events)).not.toContain("unknown-sensitive-body")
})

test("approval requests retain native request IDs and are denied without exposing command bodies", async () => {
  const peer = fixture("approval")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const events: AgentEventDraft[] = []
  const consume = (async () => {
    for await (const event of peer.adapter.events(session)) {
      events.push(event)
      if (event.type === "agent.completed") break
    }
  })()
  await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)
  await consume
  expect((await peer.state()).approvals).toEqual([
    { id: 42, result: { decision: "decline" } },
    { id: "file-approval", result: { decision: "decline" } },
    { id: "permissions-approval", result: { permissions: {}, scope: "turn" } },
  ])
  expect(JSON.stringify(events)).toContain('"requestId":42')
  expect(JSON.stringify(events)).not.toContain("untrusted-content")
})

test("lost turn acknowledgement is uncertain and never automatically retried", async () => {
  const peer = fixture("lost-dispatch")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  expect((await peer.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)).state).toBe(
    "uncertain",
  )
})

test("concurrent sends cannot accidentally steer a running turn", async () => {
  const peer = fixture("hold")
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const context = { session, admissionId: "admission-1", leaseGeneration: 1 }
  const receipts = await Promise.all([
    peer.adapter.send(context, input),
    peer.adapter.send(context, { ...input, commandId: "command-2" }),
  ])
  expect(receipts.map((receipt) => receipt.state).sort()).toEqual(["dispatched", "rejected"])
  expect((await peer.state()).turns).toBe(1)
  await peer.adapter.interrupt(context)
})

test("resume uses an existing native thread ID and close only unsubscribes", async () => {
  const peer = fixture()
  const admitted = await admission(peer.adapter)
  const session = await peer.adapter.createSession(admitted)
  await peer.adapter.close(session)
  const resumed = await peer.adapter.resume({ ...admitted, operation: "resume" }, session)
  expect(resumed.binding.nativeSessionId).toBe("thread-1")
  expect((await peer.state()).requests).toContain("thread/unsubscribe")
  expect((await peer.state()).requests).toContain("thread/resume")
})
