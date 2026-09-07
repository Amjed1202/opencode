import { afterEach, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { dirname } from "node:path"
import type { AdmittedSessionRequest, AgentEventDraft, SessionIntent } from "@harness/protocol"
import { CodexAdapter } from "../../src/codex/adapter"
import { StdioJsonRpc } from "../../src/codex/stdio"
import type { NativeReply } from "../../src/codex/stdio"
import { codexTelemetry } from "../../src/codex/telemetry"

const active: CodexAdapter[] = []

test("token telemetry rejects malformed counters and foreign threads without estimating occupancy or cost", async () => {
  const peer = fixture()
  const session = await peer.adapter.createSession(await admission(peer.adapter))
  const counts = {
    totalTokens: 100,
    inputTokens: 60,
    cachedInputTokens: 15,
    cacheWriteInputTokens: 0,
    outputTokens: 40,
    reasoningOutputTokens: 5,
  }
  const observation = {
    threadId: session.binding.nativeSessionId,
    turnId: "turn-1",
    tokenUsage: { total: counts, last: counts, modelContextWindow: null },
  }
  const result = codexTelemetry(observation, session, "epoch")
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({
    type: "usage.updated",
    data: {
      accountingScope: "session",
      basis: "cumulative",
      tokens: { input: 60, output: 40, cacheRelation: "unknown" },
    },
  })
  expect(result[1]).toMatchObject({ type: "context.updated", data: { usedTokens: null, capacityTokens: null } })
  expect(JSON.stringify(result)).not.toContain('"costs"')
  for (const key of Object.keys(counts))
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "1", undefined]) {
      expect(
        codexTelemetry(
          { ...observation, tokenUsage: { ...observation.tokenUsage, total: { ...counts, [key]: value } } },
          session,
          "epoch",
        ),
      ).toEqual([])
    }
  for (const value of [0, -1, 1.5, "200000", Number.POSITIVE_INFINITY])
    expect(
      codexTelemetry(
        { ...observation, tokenUsage: { ...observation.tokenUsage, modelContextWindow: value } },
        session,
        "epoch",
      ),
    ).toEqual([])
  expect(codexTelemetry({ ...observation, threadId: "foreign-thread" }, session, "epoch")).toEqual([])
  expect(codexTelemetry({ ...observation, turnId: "invalid\n" }, session, "epoch")).toEqual([])
})
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
  beforeNativeReply?: () => Promise<void>,
) {
  let transport: StdioJsonRpc | undefined
  const commands: string[][] = []
  const requests: string[] = []
  const nativeReplies: { method: string; reply: NativeReply }[] = []
  class FixtureTransport extends StdioJsonRpc {
    override request(method: string, params: unknown): Promise<unknown> {
      requests.push(method)
      return super.request(method, params)
    }
  }
  const adapter = new CodexAdapter({
    executable: process.execPath,
    cwd: import.meta.dir,
    environment,
    target: { id: "local", kind: "local", name: "Local" },
    runtimeId: "codex-local",
    requestTimeoutMs: 1000,
    approvalTimeoutMs,
    transportFactory: (options) => {
      commands.push([...options.command])
      return (transport = new FixtureTransport({
        ...options,
        command: [process.execPath, `${import.meta.dir}/app-server-peer.ts`, scenario, ...options.command.slice(1)],
        ...(beforeNativeReply || scenario === "isolation-early-callbacks"
          ? {
              onRequest: async (message, signal, delivered) => {
                const reply = await options.onRequest!(message, signal, delivered)
                nativeReplies.push({ method: message.method, reply })
                if (beforeNativeReply) await beforeNativeReply()
                return reply
              },
            }
          : {}),
      }))
    },
  })
  active.push(adapter)
  return {
    adapter,
    commands,
    requests,
    nativeReplies,
    state: async () =>
      (await transport!.request("fixture/state", {})) as {
        requests: string[]
        turns: number
        approvals: { id: string | number; result?: unknown; error?: { code: number; message: string } }[]
        executionSettings: { method: string; approval: string; sandbox: string }[]
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

async function permissionFixture(
  policy: Partial<SessionIntent["policy"]> = {},
  timeout = 1000,
  beforeNativeReply?: () => Promise<void>,
  scenario = "hold",
) {
  const peer = fixture(scenario, undefined, timeout, beforeNativeReply)
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
  return { ...peer, context, session, request, next, events }
}

test("native file writes wait for host review; denial preserves bytes and allow-once cannot authorize the next write", async () => {
  const path = `${import.meta.dir}/gate-${crypto.randomUUID()}.txt`
  await Bun.write(path, "before\n")
  try {
    const peer = await permissionFixture({}, 1000, undefined, "write-gate")
    for (const [id, content, choiceId, expected] of [
      ["denied-patch", "denied\n", "deny-once", "before\n"],
      ["accepted-patch", "accepted\n", "allow-once", "accepted\n"],
      ["next-patch", "not-authorized\n", "deny-once", "accepted\n"],
      ["shell-write", "shell-not-authorized\n", "deny-once", "accepted\n"],
    ] as const) {
      const before = await Bun.file(path).text()
      const proposed = await peer
        .transport()
        .request("fixture/propose-write", { id, path, content, shell: id === "shell-write" })
      expect(await Bun.file(path).text()).toBe(before)
      expect(proposed).toEqual({ outcome: "pending" })
      const event = await peer.next("permission.requested")
      if (event.type !== "permission.requested") throw new Error("Missing host permission")
      if (id === "shell-write") expect(event.data.choices.map((choice) => choice.id)).toEqual(["deny-once"])
      await peer.adapter.resolvePermission(peer.context, { ...event.data, choiceId })
      const state = await peer.state()
      expect(state.approvals.at(-1)).toMatchObject({
        id,
        result: { decision: choiceId === "allow-once" ? "accept" : "decline" },
      })
      expect(await Bun.file(path).text()).toBe(expected)
    }
    expect((await peer.state()).executionSettings).toEqual([
      { method: "thread/start", approval: "untrusted", sandbox: "read-only" },
      { method: "turn/start", approval: "untrusted", sandbox: "readOnly" },
    ])
  } finally {
    await unlink(path)
  }
})

test("deny policy never grants a broad native writable workspace", async () => {
  const path = `${import.meta.dir}/gate-${crypto.randomUUID()}.txt`
  await Bun.write(path, "before\n")
  try {
    const peer = await permissionFixture({ approval: "deny" }, 1000, undefined, "write-gate")
    expect(
      await peer.transport().request("fixture/propose-write", { id: "blocked-patch", path, content: "unauthorized\n" }),
    ).toEqual({ outcome: "blocked" })
    expect(await Bun.file(path).text()).toBe("before\n")
    expect((await peer.state()).executionSettings).toEqual([
      { method: "thread/start", approval: "never", sandbox: "read-only" },
      { method: "turn/start", approval: "never", sandbox: "readOnly" },
    ])
  } finally {
    await unlink(path)
  }
})

const nativeChoices = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-choice",
  isBlocking: true,
  autoResolutionMs: null,
  questions: [
    {
      id: "native-storage",
      header: "Storage",
      question: "Which storage should this use?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Local", description: "Keep data on this device." },
        { label: "Remote", description: "Store data remotely." },
      ],
    },
  ],
}
async function choiceFixture(timeout = 1000) {
  const peer = await permissionFixture({}, timeout)
  await peer.transport().request("fixture/native-request", {
    request: { id: "native-input", method: "item/tool/requestUserInput", params: nativeChoices },
  })
  const event = await peer.next("input.requested")
  if (event.type !== "input.requested") throw new Error("Wrong event")
  return { ...peer, request: event.data, event }
}

test("native choice input journals only opaque metadata and writes exact reviewed labels once", async () => {
  const peer = await choiceFixture()
  expect(JSON.stringify(peer.event)).not.toContain("Storage")
  expect(JSON.stringify(peer.event)).not.toContain("Local")
  expect(JSON.stringify(peer.event)).not.toContain("native-storage")
  expect(peer.request.questions).toEqual([{ id: "q1", optionIds: ["o1", "o2"] }])
  const review = await peer.adapter.reviewInput(peer.context, peer.request.requestId)
  expect(review.questions[0]?.options[1]).toEqual({ id: "o2", label: "Remote", description: "Store data remotely." })
  expect((await peer.state()).approvals).toEqual([])
  const response = { ...peer.request, action: "answer" as const, selections: [{ questionId: "q1", optionId: "o2" }] }
  await peer.adapter.resolveInput(peer.context, response)
  expect((await peer.state()).approvals).toEqual([
    { id: "native-input", result: { answers: { "native-storage": { answers: ["Remote"] } } } },
  ])
  await expect(peer.adapter.resolveInput(peer.context, response)).rejects.toThrow("no longer pending")
  await expect(peer.adapter.reviewInput(peer.context, peer.request.requestId)).rejects.toThrow("no longer pending")
})

test("native input final host guard prevents answer bytes at the actual reply boundary", async () => {
  const peer = await choiceFixture()
  const rejected = await peer.adapter
    .resolveInput(
      {
        ...peer.context,
        authorizeReply: () => {
          throw new Error("revoked")
        },
      },
      { ...peer.request, action: "answer", selections: [{ questionId: "q1", optionId: "o1" }] },
    )
    .catch((error: Error) => error)
  expect(String(rejected)).toContain("authorization changed")
  const state = await peer.state()
  expect(state.approvals[0]?.error?.code).toBe(-32000)
  expect(JSON.stringify(state.approvals)).not.toContain("Local")
})

test("native server cleanup retires input without a late response", async () => {
  const peer = await choiceFixture()
  await peer.transport().request("fixture/notification", {
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "native-input" },
  })
  expect((await peer.next("input.resolved")).data).toMatchObject({ outcome: "cancelled" })
  expect((await peer.state()).approvals).toEqual([])
  await expect(
    peer.adapter.resolveInput(peer.context, {
      ...peer.request,
      action: "answer",
      selections: [{ questionId: "q1", optionId: "o1" }],
    }),
  ).rejects.toThrow("no longer pending")
})

test.each([42, "42"])("native retirement preserves number versus string callback identity: %j", async (retiredId) => {
  const peer = await permissionFixture()
  const requests = []
  for (const id of [42, "42"]) {
    await peer.transport().request("fixture/native-request", {
      request: { id, method: "item/tool/requestUserInput", params: nativeChoices },
    })
    const event = await peer.next("input.requested")
    if (event.type !== "input.requested") throw new Error("Wrong event")
    requests.push(event.data)
  }
  expect(requests.map((request) => request.nativeRequestId)).toEqual(["number:42", "string:42"])
  await peer.transport().request("fixture/notification", {
    method: "serverRequest/resolved",
    params: { threadId: "foreign-thread", requestId: retiredId },
  })
  for (const request of requests)
    expect((await peer.adapter.reviewInput(peer.context, request.requestId)).requestId).toBe(request.requestId)
  await peer.transport().request("fixture/notification", {
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: retiredId },
  })
  const retiredIndex = typeof retiredId === "number" ? 0 : 1
  const retired = requests[retiredIndex]!
  const retained = requests[1 - retiredIndex]!
  expect((await peer.next("input.resolved")).data).toMatchObject({ requestId: retired.requestId, outcome: "cancelled" })
  const rejected = await peer.adapter.reviewInput(peer.context, retired.requestId).catch((error: Error) => error)
  expect(String(rejected)).toContain("no longer pending")
  await peer.adapter.resolveInput(peer.context, {
    ...retained,
    action: "answer",
    selections: [{ questionId: "q1", optionId: "o1" }],
  })
  expect((await peer.state()).approvals).toEqual([
    {
      id: typeof retiredId === "number" ? "42" : 42,
      result: { answers: { "native-storage": { answers: ["Local"] } } },
    },
  ])
})

test("native retirement after the adapter removes a decided handle sends no late response", async () => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const peer = await permissionFixture({}, 1000, async () => {
    reached.resolve()
    await release.promise
  })
  await peer.transport().request("fixture/native-request", {
    request: { id: "gated-input", method: "item/tool/requestUserInput", params: nativeChoices },
  })
  const event = await peer.next("input.requested")
  if (event.type !== "input.requested") throw new Error("Wrong event")
  const deciding = peer.adapter
    .resolveInput(peer.context, { ...event.data, action: "answer", selections: [{ questionId: "q1", optionId: "o1" }] })
    .catch((error: Error) => error)
  try {
    await reached.promise
    const removed = await peer.adapter.reviewInput(peer.context, event.data.requestId).catch((error: Error) => error)
    expect(String(removed)).toContain("no longer pending")
    await peer.transport().request("fixture/notification", {
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "gated-input" },
    })
    expect(String(await deciding)).toContain("resolved without this reply")
    release.resolve()
    expect((await peer.state()).approvals).toEqual([])
  } finally {
    release.resolve()
  }
})

test.each(["account", "config", "terminal", "expiry"])(
  "native %s change after handle removal blocks answer bytes at beforeWrite",
  async (change) => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const peer = await permissionFixture({}, change === "expiry" ? 100 : 1000, async () => {
      reached.resolve()
      await release.promise
    })
    await peer.transport().request("fixture/native-request", {
      request: { id: "gated-input", method: "item/tool/requestUserInput", params: nativeChoices },
    })
    const event = await peer.next("input.requested")
    if (event.type !== "input.requested") throw new Error("Wrong event")
    const deciding = peer.adapter
      .resolveInput(peer.context, {
        ...event.data,
        action: "answer",
        selections: [{ questionId: "q1", optionId: "o1" }],
      })
      .catch((error: Error) => error)
    try {
      await reached.promise
      if (change === "account") await peer.transport().request("fixture/account-updated", {})
      if (change === "config")
        await peer.transport().request("fixture/notification", { method: "config/updated", params: {} })
      if (change === "terminal")
        await peer.transport().request("fixture/terminal-notification", { status: "completed" })
      if (change === "expiry") await Bun.sleep(110)
      release.resolve()
      expect(String(await deciding)).toContain("authorization changed")
      const state = await peer.state()
      expect(state.approvals).toEqual([
        { id: "gated-input", error: { code: -32000, message: "Native permission is no longer authorized" } },
      ])
      expect(JSON.stringify(state.approvals)).not.toContain("Local")
    } finally {
      release.resolve()
    }
  },
)

test("protected patch review returns the bound diff only while pending", async () => {
  const peer = await permissionFixture()
  const request = await peer.request()
  expect(await peer.adapter.reviewPermission(peer.context, request.requestId)).toEqual({
    kind: "patch",
    requestId: request.requestId,
    operationSha256: request.operationSha256,
    changes: [{ path: `${import.meta.dir}/proposed-file.txt`, kind: "add", diff: "+fixture content" }],
  })
  await peer.adapter.resolvePermission(peer.context, { ...request, choiceId: "deny-once" })
  await expect(peer.adapter.reviewPermission(peer.context, request.requestId)).rejects.toThrow("no longer pending")
})

test.each(["cancel", "expiry", "interrupt", "close", "dispose", "account", "config", "terminal"])(
  "native input %s closes its original callback without an answer",
  async (action) => {
    const peer = await choiceFixture(action === "expiry" ? 80 : 1000)
    if (action === "cancel")
      await peer.adapter.resolveInput(peer.context, { ...peer.request, action: "cancel", selections: [] })
    if (action === "expiry") expect((await peer.next("input.resolved")).data).toMatchObject({ outcome: "expired" })
    if (action === "interrupt") await peer.adapter.interrupt(peer.context)
    if (action === "close") await peer.adapter.close(peer.session)
    if (action === "dispose") await peer.adapter.dispose()
    if (action === "account") await peer.transport().request("fixture/account-updated", {})
    if (action === "config")
      await peer.transport().request("fixture/notification", { method: "config/updated", params: {} })
    if (action === "terminal") await peer.transport().request("fixture/terminal-notification", { status: "completed" })
    const rejected = await peer.adapter
      .resolveInput(peer.context, {
        ...peer.request,
        action: "answer",
        selections: [{ questionId: "q1", optionId: "o1" }],
      })
      .catch((error: Error) => error)
    expect(String(rejected)).toContain("no longer pending")
    if (action !== "dispose")
      expect((await peer.state()).approvals).toContainEqual({ id: "native-input", result: { answers: {} } })
  },
)

test.each([
  "operationSha256",
  "nativeRequestId",
  "nativeTurnId",
  "nativeSessionId",
  "sessionId",
  "workspaceId",
  "targetId",
  "runtimeId",
  "policyId",
  "policyVersion",
  "leaseGeneration",
])("native input rejects mismatched %s and consumes pending callback", async (key) => {
  const peer = await choiceFixture()
  const rejected = await peer.adapter
    .resolveInput(peer.context, {
      ...peer.request,
      [key]: key === "leaseGeneration" ? 2 : "wrong",
      action: "answer",
      selections: [{ questionId: "q1", optionId: "o1" }],
    })
    .catch((error: Error) => error)
  expect(String(rejected)).toContain("binding mismatch")
  expect((await peer.state()).approvals).toEqual([{ id: "native-input", result: { answers: {} } }])
})

test.each(
  [
    [],
    [{ questionId: "q1", optionId: "unknown" }],
    [{ questionId: "unknown", optionId: "o1" }],
    [
      { questionId: "q1", optionId: "o1" },
      { questionId: "q1", optionId: "o2" },
    ],
    [{ questionId: "q1", optionId: "o1", label: "do not accept text" }],
  ].map((selections) => ({ selections })),
)("native input rejects invalid selections %#", async ({ selections }) => {
  const peer = await choiceFixture()
  const rejected = await peer.adapter
    .resolveInput(peer.context, { ...peer.request, action: "answer", selections })
    .catch((error: Error) => error)
  expect(String(rejected)).toContain("selection mismatch")
  expect((await peer.state()).approvals).toEqual([{ id: "native-input", result: { answers: {} } }])
})

test("native answers require a host callback and correct review context", async () => {
  const peer = await choiceFixture()
  const context = {
    session: peer.context.session,
    admissionId: peer.context.admissionId,
    leaseGeneration: peer.context.leaseGeneration,
  }
  const reviewError = await peer.adapter
    .reviewInput({ ...peer.context, leaseGeneration: 2 }, peer.request.requestId)
    .catch((error: Error) => error)
  expect(String(reviewError)).toContain("binding")
  const rejected = await peer.adapter
    .resolveInput(context, { ...peer.request, action: "answer", selections: [{ questionId: "q1", optionId: "o1" }] })
    .catch((error: Error) => error)
  expect(String(rejected)).toContain("host write-boundary")
  expect((await peer.state()).approvals).toEqual([{ id: "native-input", result: { answers: {} } }])
})

test("question and option display review is cloned and cannot alter native answers", async () => {
  const peer = await choiceFixture()
  const review = await peer.adapter.reviewInput(peer.context, peer.request.requestId)
  Object.assign(review.questions[0]!.options[0]!, { label: "changed" })
  expect((await peer.adapter.reviewInput(peer.context, peer.request.requestId)).questions[0]!.options[0]!.label).toBe(
    "Local",
  )
  await peer.adapter.resolveInput(peer.context, {
    ...peer.request,
    action: "answer",
    selections: [{ questionId: "q1", optionId: "o1" }],
  })
  expect((await peer.state()).approvals).toEqual([
    { id: "native-input", result: { answers: { "native-storage": { answers: ["Local"] } } } },
  ])
})

test("simultaneous duplicate native answers consume the request without answering", async () => {
  const peer = await choiceFixture()
  const response = { ...peer.request, action: "answer" as const, selections: [{ questionId: "q1", optionId: "o1" }] }
  const outcomes = await Promise.allSettled([
    peer.adapter.resolveInput(peer.context, response),
    peer.adapter.resolveInput(peer.context, response),
  ])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"])
  expect((await peer.state()).approvals).toEqual([{ id: "native-input", result: { answers: {} } }])
})

test("multiple native questions map opaque selections by identity regardless of response order", async () => {
  const peer = await permissionFixture()
  await peer.transport().request("fixture/native-request", {
    request: {
      id: "two-questions",
      method: "item/tool/requestUserInput",
      params: {
        ...nativeChoices,
        questions: [nativeChoices.questions[0], { ...nativeChoices.questions[0], id: "constructor" }],
      },
    },
  })
  const event = await peer.next("input.requested")
  if (event.type !== "input.requested") throw new Error("Wrong event")
  await peer.adapter.resolveInput(peer.context, {
    ...event.data,
    action: "answer",
    selections: [
      { questionId: "q2", optionId: "o2" },
      { questionId: "q1", optionId: "o1" },
    ],
  })
  expect((await peer.state()).approvals).toEqual([
    {
      id: "two-questions",
      result: { answers: { "native-storage": { answers: ["Local"] }, constructor: { answers: ["Remote"] } } },
    },
  ])
})

test("a replied native input ID cannot be replayed as a fresh question", async () => {
  const peer = await choiceFixture()
  await peer.adapter.resolveInput(peer.context, { ...peer.request, action: "cancel", selections: [] })
  const repeated = await peer
    .transport()
    .request("fixture/native-request", {
      request: { id: "native-input", method: "item/tool/requestUserInput", params: nativeChoices },
    })
    .catch((error: Error) => error)
  expect(repeated).toBeInstanceOf(Error)
  const closed = await peer.adapter.reviewInput(peer.context, peer.request.requestId).catch((error: Error) => error)
  expect(String(closed)).toContain("no longer pending")
})

test.each(["secret", "freeform", "nonblocking", "stale", "malformed"])(
  "native input %s is cancelled without retaining question display",
  async (kind) => {
    const peer = await permissionFixture()
    const params = {
      ...nativeChoices,
      questions: [
        {
          ...nativeChoices.questions[0],
          question: "sensitive-display-canary",
          ...(kind === "secret" ? { isSecret: true } : {}),
          ...(kind === "freeform" ? { isOther: true } : {}),
          ...(kind === "malformed" ? { isSecret: "false" } : {}),
        },
      ],
      ...(kind === "nonblocking" ? { isBlocking: false } : {}),
      ...(kind === "stale" ? { turnId: "stale-turn" } : {}),
    }
    await peer.transport().request("fixture/native-request", {
      request: { id: "invalid-input", method: "item/tool/requestUserInput", params },
    })
    await peer.transport().request("fixture/notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "marker", delta: "marker" },
    })
    const events: AgentEventDraft[] = []
    for (let index = 0; index < 20; index++) {
      const event = await peer.events.next()
      if (event.done) throw new Error("Missing marker")
      events.push(event.value)
      if (event.value.type === "assistant.text.delta") break
    }
    expect(events.some((event) => event.type === "input.requested")).toBe(false)
    expect(JSON.stringify(events)).not.toContain("sensitive-display-canary")
    expect((await peer.state()).approvals).toEqual([{ id: "invalid-input", result: { answers: {} } }])
  },
)

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

test("read-only native status observes account/configuration without model intent or native work", async () => {
  const peer = fixture()
  const runtime = (
    await peer.adapter.discover({
      target: { id: "local", kind: "local", name: "Local" },
      allowedExecutablePaths: [process.execPath],
    })
  )[0]!
  const status = await peer.adapter.status(runtime)
  expect(status.auth).toMatchObject({
    runtimeId: "codex-local",
    targetId: "local",
    status: "authenticated",
    mode: "subscription",
  })
  expect(status.billing).toMatchObject({ route: "subscription", providerOverage: "unknown" })
  expect(status.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(status.enforcement.filesystem).toBe(false)
  const snapshot = await peer.state()
  expect(snapshot.turns).toBe(0)
  expect(
    snapshot.requests.filter(
      (method) => !["fixture/state", "initialize", "initialized", "account/read", "config/read"].includes(method),
    ),
  ).toEqual([])
  expect(JSON.stringify(status)).not.toContain("first@example.invalid")
})

test("read-only status rejects a foreign runtime binding before observing it", async () => {
  const peer = fixture()
  const runtime = (
    await peer.adapter.discover({
      target: { id: "local", kind: "local", name: "Local" },
      allowedExecutablePaths: [process.execPath],
    })
  )[0]!
  for (const changed of [
    { ...runtime, id: "other" },
    { ...runtime, adapterId: "other" },
    { ...runtime, target: { ...runtime.target, id: "other" } },
    { ...runtime, target: { ...runtime.target, kind: "remote-node" as const, nodeId: "other" } },
  ])
    await expect(peer.adapter.status(changed)).rejects.toThrow("Invalid native status binding")
  expect((await peer.state()).requests).not.toContain("account/read")
})

test("initial native isolation restarts once with empty shell values and disabled entries before any native task", async () => {
  const peer = fixture("isolation-honored")
  const results = await Promise.all(
    Array.from({ length: 4 }, () => peer.adapter.preflight({ operation: "create", intent })),
  )
  expect(results.every((result) => result.status === "ready")).toBe(true)
  expect(peer.commands).toHaveLength(2)
  expect(peer.commands[1]).toContain('shell_environment_policy.set.FIXTURE_ENV=""')
  expect(peer.commands[1]).toContain('mcp_servers={"fixture.server"={enabled=false}}')
  expect(peer.commands[1]).toContain('plugins={"fixture.plugin@market"={enabled=false}}')
  expect(JSON.stringify(peer.commands)).not.toContain("fixture-do-not-forward")
  expect(JSON.stringify(peer.commands)).not.toContain("fixture-must-not-start")
  expect(peer.requests.filter((method) => !["initialize", "account/read", "config/read"].includes(method))).toEqual([])
  const admitted = await admission(peer.adapter)
  const session = await peer.adapter.createSession(admitted)
  expect(
    (await peer.adapter.send({ session, admissionId: admitted.admissionId, leaseGeneration: 1 }, input)).state,
  ).toBe("dispatched")
  expect(peer.commands).toHaveLength(2)
  expect(JSON.stringify(admitted.effective)).not.toContain("fixture-do-not-forward")
  expect(JSON.stringify(admitted.effective)).not.toContain("fixture.plugin@market")
})

test.each(["isolation-ignored", "isolation-new-key", "isolation-wrong-version"])(
  "%s remains blocked after the single isolation attempt",
  async (scenario) => {
    const peer = fixture(scenario)
    for (let index = 0; index < 3; index++)
      expect((await peer.adapter.preflight({ operation: "create", intent })).status).toBe("blocked")
    expect(peer.commands).toHaveLength(2)
    expect(peer.requests).not.toContain("thread/start")
    expect(peer.requests).not.toContain("turn/start")
  },
)

test("callbacks received during initial isolation never receive credentials or an execution grant", async () => {
  const peer = fixture("isolation-early-callbacks")
  expect((await peer.adapter.preflight({ operation: "create", intent })).status).toBe("ready")
  expect(peer.commands).toHaveLength(2)
  expect(peer.nativeReplies.length).toBeGreaterThanOrEqual(2)
  for (const entry of peer.nativeReplies) {
    if (entry.method === "account/chatgptAuthTokens/refresh") expect(entry.reply).toHaveProperty("error")
    if (entry.method === "item/commandExecution/requestApproval")
      expect(entry.reply).toEqual({ result: { decision: "decline" } })
  }
  expect(peer.requests).not.toContain("thread/start")
  expect(peer.requests).not.toContain("turn/start")
})

test("unrepresentable initial isolation remains blocked without a replacement process", async () => {
  const peer = fixture("isolation-malformed")
  for (let index = 0; index < 3; index++)
    expect((await peer.adapter.preflight({ operation: "create", intent })).status).toBe("blocked")
  expect(peer.commands).toHaveLength(1)
  expect(peer.requests).not.toContain("thread/start")
})

test.each(["isolation-env-change", "isolation-plugin-change", "isolation-mcp-addition", "isolation-notify-change"])(
  "%s blocks an existing session without restarting or dispatching",
  async (scenario) => {
    const peer = fixture(scenario)
    const admitted = await admission(peer.adapter)
    const session = await peer.adapter.createSession(admitted)
    expect(
      (await peer.adapter.send({ session, admissionId: admitted.admissionId, leaseGeneration: 1 }, input)).state,
    ).toBe("rejected")
    expect(peer.commands).toHaveLength(2)
    expect(peer.requests).not.toContain("turn/start")
  },
)

test("disposing during initial isolation observation prevents a replacement process and any native task", async () => {
  const peer = fixture("isolation-delay-config")
  const pending = peer.adapter.preflight({ operation: "create", intent })
  for (let index = 0; index < 100 && !peer.requests.includes("config/read"); index++)
    await new Promise((resolve) => setTimeout(resolve, 2))
  expect(peer.requests).toContain("config/read")
  await peer.adapter.dispose()
  expect((await pending).status).toBe("blocked")
  expect(peer.commands).toHaveLength(1)
  expect(peer.requests).not.toContain("thread/start")
})

test.each([
  "api",
  "provider",
  "helper",
  "profile",
  "mcp",
  "ignored-overrides",
  "shell-injection",
  "custom-endpoint",
  "endpoint-suffix",
  "endpoint-path",
])("read-only status blocks conflicting native %s configuration without running a task", async (scenario) => {
  const peer = fixture(scenario)
  const runtime = (
    await peer.adapter.discover({
      target: { id: "local", kind: "local", name: "Local" },
      allowedExecutablePaths: [process.execPath],
    })
  )[0]!
  const error: unknown = await peer.adapter.status(runtime).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  const snapshot = await peer.state()
  expect(snapshot.turns).toBe(0)
  expect(snapshot.requests).not.toContain("thread/start")
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

test.each([
  "account-switch",
  "config-switch",
  "thread-provider",
  "thread-network",
  "thread-writable",
  "thread-extra-root",
  "thread-reviewer",
  "thread-approval-fallback",
  "active-thread",
])("create revalidates %s before allowing turns", async (scenario) => {
  const peer = fixture(scenario)
  const admitted = await admission(peer.adapter)
  const result = await peer.adapter.createSession(admitted).catch((error: Error) => error)
  expect(result).toBeInstanceOf(Error)
  expect((await peer.state()).turns).toBe(0)
})

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
  const admitted = await admission(peer.adapter, {
    ...intent,
    policy: { ...intent.policy, approval: "ask", filesystem: "workspace-write" },
  })
  const session = await peer.adapter.createSession(admitted)
  await peer.adapter.close(session)
  const resumed = await peer.adapter.resume({ ...admitted, operation: "resume" }, session)
  expect(resumed.binding.nativeSessionId).toBe("thread-1")
  expect((await peer.state()).requests).toContain("thread/unsubscribe")
  expect((await peer.state()).requests).toContain("thread/resume")
  expect((await peer.state()).executionSettings).toEqual([
    { method: "thread/start", approval: "untrusted", sandbox: "read-only" },
    { method: "thread/resume", approval: "untrusted", sandbox: "read-only" },
  ])
})

test("ignored native shell isolation blocks admission and later changes block dispatch", async () => {
  const ignored = fixture("shell-tool-ignored")
  expect((await ignored.adapter.preflight({ operation: "create", intent })).status).toBe("blocked")
  expect((await ignored.state()).requests).not.toContain("thread/start")
  const changed = fixture("shell-tool-change")
  const session = await changed.adapter.createSession(await admission(changed.adapter))
  expect((await changed.adapter.send({ session, admissionId: "admission-1", leaseGeneration: 1 }, input)).state).toBe(
    "rejected",
  )
  expect((await changed.state()).turns).toBe(0)
})
