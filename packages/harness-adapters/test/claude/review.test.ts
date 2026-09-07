import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKControlInitializeResponse, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AdmittedSessionRequest, AgentEventDraft, SessionIntent } from "@harness/protocol"
import { ClaudeAdapter } from "../../src/claude/adapter"
import type { ClaudeRuntime, ClaudeRuntimeOptions } from "../../src/claude/runtime"

class ReviewRuntime implements ClaudeRuntime {
  readonly queue: SDKMessage[] = []
  readonly sent: SDKUserMessage[] = []
  replayParent: string | null = null
  ended = false
  wake: (() => void) | undefined
  interruptGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
  constructor(readonly options: ClaudeRuntimeOptions) {}
  async initialize() {
    return {
      account: {
        email: "fixture@example.invalid",
        subscriptionType: "max",
        apiProvider: "firstParty",
        apiKeySource: "none",
      },
      commands: [],
      models: [{ value: "sonnet", displayName: "Sonnet", description: "Fixture" }],
      hooks_applied: true,
      fast_mode_state: "off",
    } as unknown as SDKControlInitializeResponse
  }
  send(message: SDKUserMessage) {
    this.sent.push(message)
    this.push({
      type: "system",
      subtype: "init",
      session_id: message.session_id,
      uuid: randomUUID(),
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      apiKeySource: "none",
      cwd: this.options.cwd,
      claude_code_version: "2.1.251",
      tools: [...this.options.tools],
      mcp_servers: [],
      slash_commands: [],
      plugins: [],
      skills: [],
      agents: [],
    })
    this.push({ ...message, parent_tool_use_id: this.replayParent, isReplay: true })
  }
  push(message: unknown) {
    this.queue.push(message as SDKMessage)
    this.wake?.()
  }
  async *events() {
    while (true) {
      const message = this.queue.shift()
      if (message) {
        yield message
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
  async interrupt() {
    await this.interruptGate?.promise
  }
  async authorizePermission(_requestId: string, authorize: () => void) {
    authorize()
  }
  async close() {
    this.ended = true
    this.wake?.()
  }
  result(messageId: string, cost = 1, terminalReason?: string) {
    this.push({
      type: "result",
      subtype: "success",
      uuid: randomUUID(),
      session_id: this.options.sessionId ?? this.options.resume,
      user_message_uuid: messageId,
      is_error: false,
      ...(terminalReason ? { terminal_reason: terminalReason } : {}),
      result: "Done",
      total_cost_usd: cost,
      usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: cost,
          contextWindow: 200000,
          maxOutputTokens: 64000,
          webSearchRequests: 0,
        },
      },
      queued_turn_count: 0,
      permission_denials: [],
    })
  }
}

test("interrupt review: the control acknowledgment alone cannot complete the active turn", async () => {
  const state = await fixture()
  try {
    await state.send()
    await state.adapter.interrupt(state.context)
    await state.settle()
    expect(state.events.filter((event) => event.type === "agent.completed")).toHaveLength(0)
    await expect(state.send()).rejects.toThrow()
  } finally {
    await state.close()
  }
})

test("interrupt review: only native terminal abort reasons attest an interrupted turn", async () => {
  for (const reason of ["aborted_streaming", "aborted_tools"]) {
    const state = await fixture()
    try {
      const id = randomUUID()
      await state.send(id)
      await state.adapter.interrupt(state.context)
      state.runtime.result(id, 1, reason)
      await state.settle()
      expect(
        state.events.filter((event) => event.type === "agent.completed").map((event) => event.data.outcome),
      ).toEqual(["interrupted"])
      expect((await state.send()).state).toBe("dispatched")
    } finally {
      await state.close()
    }
  }
})

test("interrupt review: natural completion before a delayed interrupt acknowledgment stays succeeded", async () => {
  const state = await fixture()
  try {
    const id = randomUUID()
    await state.send(id)
    const gate = Promise.withResolvers<void>()
    state.runtime.interruptGate = gate
    const interrupt = state.adapter.interrupt(state.context)
    state.runtime.result(id, 1, "completed")
    await state.settle()
    expect(state.events.filter((event) => event.type === "agent.completed").map((event) => event.data.outcome)).toEqual(
      ["succeeded"],
    )
    gate.resolve()
    await interrupt
    const next = randomUUID()
    await state.send(next)
    state.runtime.result(next, 2, "completed")
    await state.settle()
    expect(state.events.filter((event) => event.type === "agent.completed").map((event) => event.data.outcome)).toEqual(
      ["succeeded", "succeeded"],
    )
  } finally {
    state.runtime.interruptGate?.resolve()
    await state.close()
  }
})

test("interrupt review: an acknowledgment cannot relabel native success after it arrives", async () => {
  for (const reason of ["completed", undefined]) {
    const state = await fixture()
    try {
      const id = randomUUID()
      await state.send(id)
      await state.adapter.interrupt(state.context)
      state.runtime.result(id, 1, reason)
      await state.settle()
      expect(
        state.events.filter((event) => event.type === "agent.completed").map((event) => event.data.outcome),
      ).toEqual(["succeeded"])
    } finally {
      await state.close()
    }
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-claude-review-"))
  const target = { id: "local", name: "Local", kind: "local" } as const
  const workspace = {
    id: "workspace",
    projectId: "project",
    targetId: "local",
    kind: "repository",
    rootPath: directory,
  } as const
  const runtimes: ReviewRuntime[] = []
  const intent: SessionIntent = {
    workspaceId: workspace.id,
    mode: "chat",
    requiredCapabilities: ["chat"],
    selection: {
      runtimeId: "claude-local",
      targetId: "local",
      model: { providerId: "anthropic", modelId: "sonnet" },
      access: {
        mode: "subscription",
        method: "claude-code-subscription",
        billing: "subscription",
        overagePolicy: "acknowledge-provider-settings",
      },
      fallback: { automatic: false },
    },
    policy: {
      id: "policy",
      version: "1",
      filesystem: "workspace-write",
      shell: "disabled",
      network: "denied",
      allowedMcpServers: [],
      approval: "ask",
      requireEnforcedBoundary: false,
    },
  }
  const adapter = new ClaudeAdapter({
    executable: process.execPath,
    cwd: directory,
    environment: { HOME: directory, USERPROFILE: directory },
    target,
    workspace,
    inspectorFactory: () => ({
      version: async () => "2.1.251",
      authStatus: async () => ({ loggedIn: true }),
      subscriptionStatus: async () => ({
        accountId: "fixture-account",
        emailHash: createHash("sha256").update("fixture@example.invalid").digest("hex"),
        personalSubscription: true,
      }),
      dispose: async () => {},
    }),
    policyCheck: async () => {},
    runtimeFactory: (options) => {
      const runtime = new ReviewRuntime(options)
      runtimes.push(runtime)
      return runtime
    },
  })
  const preflight = await adapter.preflight({ operation: "create", intent })
  if (preflight.status !== "ready") throw new Error("Fixture admission blocked")
  const request: AdmittedSessionRequest = {
    operation: "create",
    admissionId: "admission",
    sessionId: "session",
    intent,
    workspace,
    effective: preflight.effective,
    lease: {
      id: "lease",
      workspaceId: workspace.id,
      targetId: "local",
      ownerId: "host",
      mode: "write",
      generation: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  }
  const session = await adapter.createSession(request)
  const context = { session, admissionId: "admission", leaseGeneration: 1 }
  const runtime = runtimes.find((runtime) => runtime.options.sessionId)!
  const events: AgentEventDraft[] = []
  const consuming = (async () => {
    for await (const event of adapter.events(session)) events.push(event)
  })()
  return {
    adapter,
    context,
    runtime,
    events,
    directory,
    send: (messageId = randomUUID(), commandId = randomUUID()) =>
      adapter.send(context, {
        commandId,
        messageId,
        delivery: "when-idle",
        parts: [{ type: "text", text: "Fixture input" }],
      }),
    settle: async () => {
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
    },
    close: async () => {
      await adapter.dispose()
      await consuming
      if (!resolve(directory).startsWith(resolve(tmpdir()) + "\\") && process.platform === "win32")
        throw new Error("Unexpected fixture cleanup path")
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("review: native Read cannot inherit an interrupt epoch while its file check awaits", async () => {
  const state = await fixture()
  try {
    await writeFile(join(state.directory, "file.txt"), "fixture")
    await state.send()
    const permission = state.runtime.options.canUseTool(
      "Read",
      { file_path: join(state.directory, "file.txt") },
      { signal: new AbortController().signal, toolUseID: "read-call", requestId: "read-request" },
    )
    await state.adapter.interrupt(state.context)
    expect((await permission)?.behavior).toBe("deny")
  } finally {
    await state.close()
  }
})

test("review: native Edit cannot become a new approval after interrupt during preimage read", async () => {
  const state = await fixture()
  try {
    await writeFile(join(state.directory, "file.txt"), "before")
    await state.send()
    const cancel = new AbortController()
    const permission = state.runtime.options.canUseTool(
      "Edit",
      { file_path: join(state.directory, "file.txt"), old_string: "before", new_string: "after" },
      { signal: cancel.signal, toolUseID: "edit-call", requestId: "edit-request" },
    )
    await state.adapter.interrupt(state.context)
    const outcome = await Promise.race([
      permission,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ])
    cancel.abort()
    expect(outcome).not.toBe("pending")
    if (outcome !== "pending") expect(outcome?.behavior).toBe("deny")
    expect(state.events.filter((event) => event.type === "permission.requested")).toHaveLength(0)
  } finally {
    await state.close()
  }
})

test("review: a second command cannot reuse a previously acknowledged native user UUID", async () => {
  const state = await fixture()
  try {
    const id = randomUUID()
    await state.send(id)
    state.runtime.result(id)
    await state.settle()
    await expect(state.send(id)).rejects.toThrow()
    expect(state.runtime.sent).toHaveLength(1)
  } finally {
    await state.close()
  }
})

test("review: a same-session result for another input never settles the active turn", async () => {
  const state = await fixture()
  try {
    await state.send()
    state.runtime.result(randomUUID())
    await state.settle()
    expect(state.events.some((event) => event.type === "agent.completed" && event.data.outcome === "succeeded")).toBe(
      false,
    )
    expect(state.events.some((event) => event.type === "agent.error")).toBe(true)
  } finally {
    await state.close()
  }
})

test("review: a different native model cannot be presented as the admitted model", async () => {
  const state = await fixture()
  try {
    const id = randomUUID()
    await state.send(id)
    state.runtime.push({
      type: "assistant",
      session_id: state.runtime.options.sessionId,
      uuid: randomUUID(),
      user_message_uuid: id,
      parent_tool_use_id: null,
      message: {
        id: "message-foreign-model",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "Should not display" }],
      },
    })
    await state.settle()
    expect(state.events.some((event) => event.type === "assistant.text.completed")).toBe(false)
    expect(state.events.some((event) => event.type === "agent.error")).toBe(true)
  } finally {
    await state.close()
  }
})

test("review: a child-role replay cannot acknowledge a main conversation input", async () => {
  const state = await fixture()
  try {
    state.runtime.replayParent = "another-agent-tool"
    expect((await state.send()).state).toBe("uncertain")
    expect(state.events.some((event) => event.type === "agent.started")).toBe(false)
  } finally {
    await state.close()
  }
})

test("review: an unstarted response stream cannot reuse the prior turn response identity", async () => {
  const state = await fixture()
  try {
    const first = randomUUID()
    await state.send(first)
    state.runtime.push({
      type: "stream_event",
      session_id: state.runtime.options.sessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      user_message_uuid: first,
      event: { type: "message_start", message: { id: "previous-response", model: "claude-sonnet-4-6" } },
    })
    state.runtime.result(first)
    await state.settle()
    const next = randomUUID()
    await state.send(next)
    state.runtime.push({
      type: "stream_event",
      session_id: state.runtime.options.sessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      user_message_uuid: next,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Late stale text" } },
    })
    await state.settle()
    expect(
      state.events.some(
        (event) => event.type === "assistant.text.delta" && event.data.messageId === "previous-response",
      ),
    ).toBe(false)
    expect(state.events.some((event) => event.type === "agent.error")).toBe(true)
  } finally {
    await state.close()
  }
})

test("review: multiple completed blocks sharing a native response ID retain all text", async () => {
  const state = await fixture()
  try {
    const id = randomUUID()
    await state.send(id)
    for (const text of ["First", "Second"])
      state.runtime.push({
        type: "assistant",
        session_id: state.runtime.options.sessionId,
        uuid: randomUUID(),
        user_message_uuid: id,
        parent_tool_use_id: null,
        message: {
          id: "message-one",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text }],
        },
      })
    state.runtime.push({
      type: "assistant",
      session_id: state.runtime.options.sessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        id: "message-two",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Third" }],
      },
    })
    await state.settle()
    const completed = state.events.filter((event) => event.type === "assistant.text.completed")
    const projection = new Map(
      completed.map((event) => [`${event.data.messageId}/${event.data.partId}`, event.data.text]),
    )
    expect([...projection.values()].join(" ").replace(/\s+/g, " ")).toBe("First Second Third")
  } finally {
    await state.close()
  }
})
