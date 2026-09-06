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
  approvalTimeoutMs = 1000,
) {
  let transport: StdioJsonRpc | undefined
  const adapter = new CodexAdapter({
    executable: process.execPath,
    cwd: import.meta.dir,
    environment,
    target: { id: "local", kind: "local", name: "Local" },
    runtimeId: "codex-local",
    requestTimeoutMs: 1000,
    approvalTimeoutMs,
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
        approvals: { id: string | number; result?: unknown; error?: { code: number; message: string } }[]
      },
    transport: () => transport!,
  }
}
async function admission(adapter: CodexAdapter, selected = intent): Promise<AdmittedSessionRequest> {
  const result = await adapter.preflight({ operation: "create", intent: selected })
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  return {
    operation: "create",
    admissionId: "admission-1",
    sessionId: "session-1",
    intent: selected,
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

async function permissionFixture(policy: Partial<SessionIntent["policy"]> = {}, timeout = 1000) {
  const peer = fixture("hold", undefined, timeout)
  const admitted = await admission(peer.adapter, {
    ...intent,
    policy: { ...intent.policy, approval: "ask", filesystem: "workspace-write", ...policy },
  })
  const session = await peer.adapter.createSession(admitted)
  const context = {
    session,
    admissionId: admitted.admissionId,
    leaseGeneration: admitted.lease.generation,
    authorizeReply: () => {},
  }
  const events = peer.adapter.events(session)[Symbol.asyncIterator]()
  expect((await peer.adapter.send(context, input)).state).toBe("dispatched")
  const next = async <T extends AgentEventDraft["type"]>(
    type: T,
  ): Promise<Extract<AgentEventDraft, { type: T }> | AgentEventDraft> => {
    for (let index = 0; index < 20; index++) {
      const event = await events.next()
      if (event.done) throw new Error("Native event stream ended")
      if (event.value.type === type) return event.value
    }
    throw new Error("Missing expected event")
  }
  const request = async (
    options: {
      method?: string
      params?: Record<string, unknown>
      changes?: readonly unknown[] | null
      itemTurnId?: unknown
    } = {},
  ) => {
    await peer.transport().request("fixture/native-request", {
      notifications:
        options.changes === null
          ? []
          : [
              {
                method: "item/started",
                params: {
                  threadId: "thread-1",
                  turnId: "itemTurnId" in options ? options.itemTurnId : "turn-1",
                  item: {
                    type: "fileChange",
                    id: "item-file",
                    status: "inProgress",
                    changes: options.changes ?? [
                      { path: `${import.meta.dir}/proposed-file.txt`, kind: { type: "add" }, diff: "+fixture content" },
                    ],
                  },
                },
              },
            ],
      request: {
        id: "native-approval",
        method: options.method ?? "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-file",
          startedAtMs: Date.now(),
          ...options.params,
        },
      },
    })
    const event = await next("permission.requested")
    if (event.type !== "permission.requested") throw new Error("Wrong event")
    return event.data
  }
  return { ...peer, context, session, request, next }
}

test("an observed workspace file approval stays pending and maps allow-once to the original native request", async () => {
  const peer = await permissionFixture()
  const request = await peer.request()
  expect(request.nativeRequestId).toBe("string:native-approval")
  expect(request.nativeTurnId).toBe("turn-1")
  expect(request.choices.map((choice) => choice.id)).toEqual(["allow-once", "deny-once"])
  expect((await peer.state()).approvals).toEqual([])
  const decision = { ...request, choiceId: "allow-once" }
  await peer.adapter.resolvePermission(peer.context, decision)
  expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "accept" } }])
  await expect(peer.adapter.resolvePermission(peer.context, decision)).rejects.toThrow("no longer pending")
})

test("native inspection reads history between account/config checks without creating or replaying a turn", async () => {
  const peer = fixture()
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const before = await peer.state()
  const result = await peer.adapter.inspect(session)
  expect(result.nativeState).toBe("idle")
  expect(result.completeness).toBe("complete")
  expect(result.turns).toEqual([{ nativeTurnId: "turn-1", status: "succeeded" }])
  const after = await peer.state()
  expect(after.turns).toBe(0)
  expect(after.requests.filter((method) => method === "thread/start").length).toBe(
    before.requests.filter((method) => method === "thread/start").length,
  )
  expect(after.requests).not.toContain("thread/resume")
})

test.each(["history-account-switch", "history-config-switch"])(
  "%s invalidates native history evidence",
  async (scenario) => {
    const peer = fixture(scenario)
    const session = await peer.adapter.createSession(await admission(peer.adapter))
    const result = await peer.adapter.inspect(session)
    expect(result.nativeState).toBe("unknown")
    expect(result.completeness).toBe("partial")
    expect(result.turns).toEqual([])
    expect((await peer.state()).turns).toBe(0)
  },
)

test.each([
  {
    method: "item/commandExecution/requestApproval",
    params: { command: "OPENAI_API_KEY=never-display-this curl x", proposedExecpolicyAmendment: ["curl"] },
  },
  { method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } },
  { params: { grantRoot: import.meta.dir } },
  { params: { futurePermissionExpansion: true } },
  { changes: null },
  { changes: [{ path: `${dirname(import.meta.dir)}/outside.txt`, kind: { type: "add" }, diff: "+x" }] },
  { changes: [{ path: `${import.meta.dir}/.git/config`, kind: { type: "update", move_path: null }, diff: "+x" }] },
  {
    changes: [
      {
        path: `${import.meta.dir}/file.txt`,
        kind: { type: "update", move_path: `${dirname(import.meta.dir)}/outside.txt` },
        diff: "+x",
      },
    ],
  },
  { changes: [{ path: `${import.meta.dir}/file.txt`, kind: { type: "add", futureMovePath: "outside" }, diff: "+x" }] },
  { changes: [{ path: `${import.meta.dir}/file.txt`, kind: { type: ["add"] }, diff: "+x" }] },
  { itemTurnId: undefined },
  { itemTurnId: null },
  { itemTurnId: ["turn-1"] },
  { itemTurnId: 1 },
])("unsafe or incomplete native approval is deny-only (%j)", async (options) => {
  const peer = await permissionFixture()
  const request = await peer.request(options)
  expect(request.choices.map((choice) => choice.id)).toEqual(["deny-once"])
  expect(JSON.stringify(request)).not.toContain("never-display-this")
  await expect(peer.adapter.resolvePermission(peer.context, { ...request, choiceId: "allow-once" })).rejects.toThrow()
  expect(JSON.stringify((await peer.state()).approvals)).not.toContain('"accept"')
})

test.each([{ turnId: undefined }, { turnId: null }, { turnId: ["turn-1"] }, { turnId: 1 }])(
  "unscoped patch update %j cannot cancel a current native approval",
  async (input) => {
    const peer = await permissionFixture()
    const request = await peer.request()
    await peer.transport().request("fixture/notification", {
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "thread-1",
        turnId: input.turnId,
        itemId: "item-file",
        changes: [{ path: `${import.meta.dir}/different-file.txt`, kind: { type: "add" }, diff: "+different" }],
      },
    })
    await peer.adapter.resolvePermission(peer.context, { ...request, choiceId: "allow-once" })
    expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "accept" } }])
  },
)

test.each(["read-only", "workspace-write"] as const)(
  "default deny policy never offers file grants under %s",
  async (filesystem) => {
    const peer = await permissionFixture({ filesystem, approval: "deny" })
    const request = await peer.request()
    expect(request.choices.map((choice) => choice.id)).toEqual(["deny-once"])
    expect((await peer.next("permission.resolved")).type).toBe("permission.resolved")
    expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
  },
)

test("approval expiry declines native work and rejects late decisions", async () => {
  const peer = await permissionFixture({}, 50)
  const request = await peer.request()
  const resolution = await peer.next("permission.resolved")
  expect(resolution.type === "permission.resolved" && resolution.data.outcome).toBe("expired")
  await expect(peer.adapter.resolvePermission(peer.context, { ...request, choiceId: "allow-once" })).rejects.toThrow()
  expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
})

test("read-only ask policy offers only denial", async () => {
  const peer = await permissionFixture({ filesystem: "read-only" })
  const request = await peer.request()
  expect(request.choices.map((choice) => choice.id)).toEqual(["deny-once"])
  await peer.adapter.resolvePermission(peer.context, { ...request, choiceId: "deny-once" })
  expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
})

test("simultaneous duplicate grants fail closed before a native allow reply", async () => {
  const peer = await permissionFixture()
  const request = await peer.request()
  const decision = { ...request, choiceId: "allow-once" }
  const replies = await Promise.allSettled([
    peer.adapter.resolvePermission(peer.context, decision),
    peer.adapter.resolvePermission(peer.context, decision),
  ])
  expect(replies.map((reply) => reply.status)).toEqual(["rejected", "rejected"])
  expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
})

test("native grants require a host guard and invoke it at the reply boundary", async () => {
  const peer = await permissionFixture()
  const request = await peer.request()
  let checks = 0
  await expect(
    peer.adapter.resolvePermission(
      {
        ...peer.context,
        authorizeReply: () => {
          checks++
          throw new Error("lease revoked")
        },
      },
      { ...request, choiceId: "allow-once" },
    ),
  ).rejects.toThrow("authorization changed")
  expect(checks).toBe(1)
  expect((await peer.state()).approvals).toEqual([
    {
      id: "native-approval",
      error: {
        code: -32000,
        message: "Native permission is no longer authorized",
      },
    },
  ])
})

test("an adapter caller cannot grant without a host write-boundary authorization guard", async () => {
  const peer = await permissionFixture()
  const request = await peer.request()
  await expect(
    peer.adapter.resolvePermission(
      { session: peer.session, admissionId: peer.context.admissionId, leaseGeneration: peer.context.leaseGeneration },
      { ...request, choiceId: "allow-once" },
    ),
  ).rejects.toThrow("require the host")
  expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
})

test.each([
  "nativeTurnId",
  "nativeRequestId",
  "workspaceId",
  "policyId",
  "policyVersion",
  "operationSha256",
  "runtimeId",
  "nativeSessionId",
  "sessionId",
  "targetId",
] as const)("mismatched %s denies the bound native request", async (field) => {
  const peer = await permissionFixture()
  const request = await peer.request()
  await expect(
    peer.adapter.resolvePermission(peer.context, { ...request, [field]: "wrong", choiceId: "allow-once" }),
  ).rejects.toThrow()
  expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
})

test.each(["interrupt", "close", "account", "config", "patch-update"])(
  "%s cancels pending native approvals",
  async (action) => {
    const peer = await permissionFixture()
    const request = await peer.request()
    if (action === "interrupt") await peer.adapter.interrupt(peer.context)
    if (action === "close") await peer.adapter.close(peer.session)
    if (action === "account") await peer.transport().request("fixture/account-updated", {})
    if (action === "config")
      await peer.transport().request("fixture/notification", { method: "config/updated", params: {} })
    if (action === "patch-update")
      await peer.transport().request("fixture/notification", {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-file",
          changes: [{ path: `${import.meta.dir}/another.txt`, kind: { type: "add" }, diff: "+different" }],
        },
      })
    await expect(peer.adapter.resolvePermission(peer.context, { ...request, choiceId: "allow-once" })).rejects.toThrow()
    expect((await peer.state()).approvals).toEqual([{ id: "native-approval", result: { decision: "decline" } }])
  },
)
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

test.each([{ status: ["completed"] }, { status: ["failed"] }, { status: ["interrupted"] }])(
  "malformed terminal status %j cannot release an active native turn",
  async (notification) => {
    const peer = fixture("hold")
    const session = await peer.adapter.createSession(await admission(peer.adapter))
    const context = { session, admissionId: "admission-1", leaseGeneration: 1 }
    const events: AgentEventDraft[] = []
    const consume = (async () => {
      for await (const event of peer.adapter.events(session)) events.push(event)
    })()
    expect((await peer.adapter.send(context, input)).state).toBe("dispatched")
    expect((await peer.state()).turns).toBe(1)
    const attempt = peer
      .transport()
      .request("fixture/terminal-notification", { status: notification.status })
      .catch((error: Error) => error)
    expect(String(await attempt)).toContain("Native protocol stream failed")
    await consume
    expect(events.some((event) => event.type === "agent.completed")).toBe(false)
    expect((await peer.adapter.send(context, { ...input, commandId: "second" })).state).toBe("rejected")
  },
)

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
