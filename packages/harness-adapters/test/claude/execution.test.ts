import { afterEach, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type {
  PermissionResult,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentEventDraft, AgentSession, PermissionRequest, SessionIntent } from "@harness/protocol"
import { ClaudeAdapter } from "../../src/claude/adapter"
import { claudePatch, claudeWorkspacePath } from "../../src/claude/files"
import type { ClaudeRuntime, ClaudeRuntimeOptions } from "../../src/claude/runtime"
import { claudePrompt, stageClaudeSkills, verifyClaudeSkills } from "../../src/claude/skills"

const roots: string[] = []
const adapters: ClaudeAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const target = { id: "local", kind: "local", name: "Local" } as const
const email = "fixture@example.invalid"
const auth = {
  accountId: "a".repeat(64),
  emailHash: createHash("sha256").update(email).digest("hex"),
  personalSubscription: true,
} as const
const intent: SessionIntent = {
  workspaceId: "workspace",
  mode: "code",
  requiredCapabilities: ["chat", "coding", "permissions"],
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
function initialization(): SDKControlInitializeResponse {
  return {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [
      { value: "default", displayName: "Default", description: "Default" },
      { value: "sonnet", displayName: "Sonnet", description: "Sonnet" },
    ],
    account: { apiProvider: "firstParty", subscriptionType: "Pro", email },
    hooks_applied: true,
    fast_mode_state: "off",
  }
}
class FixtureRuntime implements ClaudeRuntime {
  readonly messages: SDKUserMessage[] = []
  closed = false
  ack = true
  readonly queue: SDKMessage[] = []
  wake: (() => void) | undefined
  readonly grants = new Map<string, { guard: () => void; delivered: ReturnType<typeof Promise.withResolvers<void>> }>()
  constructor(
    readonly options: ClaudeRuntimeOptions,
    readonly init = initialization(),
  ) {}
  async initialize() {
    return this.init
  }
  send(message: SDKUserMessage) {
    this.messages.push(message)
    if (this.ack) this.emit({ ...message, uuid: message.uuid!, session_id: this.id(), isReplay: true })
  }
  id() {
    return this.options.sessionId ?? this.options.resume ?? "diagnostic"
  }
  emit(message: SDKMessage) {
    this.queue.push(message)
    this.wake?.()
  }
  async *events() {
    while (!this.closed) {
      const message = this.queue.shift()
      if (message) {
        yield message
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
  async interrupt() {}
  authorizePermission(id: string, guard: () => void) {
    const delivered = Promise.withResolvers<void>()
    this.grants.set(id, { guard, delivered })
    return delivered.promise
  }
  async close() {
    this.closed = true
    for (const grant of this.grants.values()) grant.delivered.reject(new Error("closed"))
    this.grants.clear()
    this.wake?.()
  }
  async tool(name: string, input: Record<string, unknown>, controller = new AbortController()) {
    const requestId = randomUUID()
    const result = await this.options.canUseTool(name, input, {
      signal: controller.signal,
      toolUseID: requestId,
      requestId,
    })
    const grant = this.grants.get(requestId)
    if (result?.behavior === "allow") {
      if (!grant) throw new Error("Unbound fixture allowance")
      try {
        grant.guard()
        grant.delivered.resolve()
      } catch (error) {
        grant.delivered.reject(error)
        throw error
      }
      this.grants.delete(requestId)
    }
    return result
  }
  finish() {
    this.emit({
      type: "result",
      subtype: "success",
      session_id: this.id(),
      uuid: randomUUID(),
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "Done",
      total_cost_usd: 0.1,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        service_tier: "standard",
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: "global",
        iterations: [],
        speed: "standard",
      },
      modelUsage: {},
      permission_denials: [],
    })
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-claude-execution-"))
  roots.push(root)
  await writeFile(join(root, "note.txt"), "before\n")
  const workspace = {
    id: "workspace",
    projectId: "project",
    targetId: "local",
    rootPath: root,
    kind: "repository",
  } as const
  const runtimes: FixtureRuntime[] = []
  let personal = true
  let managed = false
  const adapter = new ClaudeAdapter({
    executable: process.execPath,
    cwd: root,
    environment: { HOME: root, USERPROFILE: root },
    target,
    workspace,
    timeoutMs: 50,
    inspectorFactory: () => ({
      version: async () => "2.1.251",
      authStatus: async () => ({ loggedIn: true }),
      subscriptionStatus: async () => {
        if (!personal) throw new Error("unsupported account")
        return auth
      },
      dispose: async () => {},
    }),
    policyCheck: async () => {
      if (managed) throw new Error("managed")
    },
    runtimeFactory: (options) => {
      const runtime = new FixtureRuntime(options)
      runtimes.push(runtime)
      return runtime
    },
  })
  adapters.push(adapter)
  const [runtime] = await adapter.discover({ target, allowedExecutablePaths: [process.execPath] })
  const effective = await adapter.status(runtime!)
  const request = {
    operation: "create",
    admissionId: "admission",
    sessionId: randomUUID(),
    intent,
    workspace,
    lease: {
      id: "lease",
      workspaceId: workspace.id,
      targetId: "local",
      ownerId: "host",
      mode: "write",
      generation: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    effective,
  } as const
  const create = async () => {
    const session = await adapter.createSession(request)
    return {
      session,
      context: { session, admissionId: request.admissionId, leaseGeneration: 1 },
      native: runtimes.at(-1)!,
    }
  }
  return {
    adapter,
    runtime: runtime!,
    effective,
    request,
    create,
    root,
    runtimes,
    personal: (value: boolean) => {
      personal = value
    },
    managed: (value: boolean) => {
      managed = value
    },
  }
}
async function nextPermission(events: AsyncIterator<AgentEventDraft>): Promise<PermissionRequest> {
  for (let index = 0; index < 20; index++) {
    const event = await events.next()
    if (event.value?.type === "permission.requested") return event.value.data
  }
  throw new Error("Missing permission")
}
async function dispatch(adapter: ClaudeAdapter, session: AgentSession) {
  return adapter.send(
    { session, admissionId: "admission", leaseGeneration: 1 },
    {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ type: "text", text: "Read and edit note.txt." }],
      delivery: "when-idle",
    },
  )
}

test("personal SDK evidence exposes explicit models and preserves unknown overage without account fields", async () => {
  const item = await fixture()
  expect(item.effective).toMatchObject({
    auth: { mode: "subscription", accountId: auth.accountId },
    billing: { route: "subscription", providerOverage: "unknown" },
    capabilities: {
      chat: { status: "supported" },
      terminal: { status: "unsupported" },
      "cost-telemetry": { status: "unsupported" },
    },
  })
  expect(JSON.stringify(item.effective)).not.toContain(email)
  expect((await item.adapter.models(item.runtime)).map((model) => model.id)).toEqual(["sonnet"])
  expect(item.runtimes.every((runtime) => runtime.messages.length === 0)).toBe(true)
  item.managed(true)
  expect((await item.adapter.preflight({ operation: "create", intent })).status).toBe("blocked")
})
test("unacknowledged unknown overage, API fallback, implicit models and OS-boundary requests fail closed", async () => {
  const item = await fixture()
  for (const changed of [
    {
      ...intent,
      selection: { ...intent.selection, access: { ...intent.selection.access, overagePolicy: "require-disabled" } },
    },
    { ...intent, selection: { ...intent.selection, model: { providerId: "anthropic", modelId: "default" } } },
    { ...intent, policy: { ...intent.policy, requireEnforcedBoundary: true } },
  ] as SessionIntent[])
    expect((await item.adapter.preflight({ operation: "create", intent: changed })).status).toBe("blocked")
})
test("acknowledged input streams distinct assistant response IDs and per-turn tokens without cumulative costs", async () => {
  const item = await fixture()
  const current = await item.create()
  expect((await dispatch(item.adapter, current.session)).state).toBe("dispatched")
  const events = item.adapter.events(current.session)[Symbol.asyncIterator]()
  current.native.emit({
    type: "assistant",
    session_id: current.native.id(),
    uuid: randomUUID(),
    parent_tool_use_id: null,
    message: {
      id: "response-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "First", citations: null },
        { type: "text", text: " second", citations: null },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
        iterations: null,
        speed: null,
      },
      container: null,
      context_management: null,
      stop_details: null,
    },
  })
  current.native.finish()
  const seen: AgentEventDraft[] = []
  while (!seen.some((event) => event.type === "agent.completed")) seen.push((await events.next()).value!)
  expect(seen.find((event) => event.type === "assistant.text.completed")).toMatchObject({
    data: { messageId: "response-1", text: "First second" },
  })
  expect((await item.adapter.usage(current.session))[0]).toMatchObject({
    tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, cacheRelation: "separate" },
  })
  expect((await item.adapter.usage(current.session))[0]?.costs).toBeUndefined()
})
test("write review binds exact preimage and invokes host authorization only on delivery", async () => {
  const item = await fixture()
  const current = await item.create()
  await dispatch(item.adapter, current.session)
  const events = item.adapter.events(current.session)[Symbol.asyncIterator]()
  const tool = current.native.tool("Edit", {
    file_path: join(item.root, "note.txt"),
    old_string: "before",
    new_string: "after",
  })
  const request = await nextPermission(events)
  expect((await item.adapter.reviewPermission(current.context, request.requestId)).changes[0]?.diff).toContain("+after")
  let authorized = 0
  await item.adapter.resolvePermission(
    {
      ...current.context,
      authorizeReply: () => {
        authorized++
      },
    },
    { ...request, choiceId: "allow-once" },
  )
  expect((await tool)?.behavior).toBe("allow")
  expect(authorized).toBe(1)
  await expect(
    item.adapter.resolvePermission(current.context, { ...request, choiceId: "allow-once" }),
  ).rejects.toThrow()
})
test("changed files, missing host authorization and interrupted approvals cannot allow writes", async () => {
  for (const reason of ["changed", "no-authority", "interrupt"] as const) {
    const item = await fixture()
    const current = await item.create()
    await dispatch(item.adapter, current.session)
    const events = item.adapter.events(current.session)[Symbol.asyncIterator]()
    const tool = current.native.tool("Write", { file_path: join(item.root, "note.txt"), content: "replacement" })
    const request = await nextPermission(events)
    if (reason === "changed") await writeFile(join(item.root, "note.txt"), "concurrent change")
    if (reason === "interrupt") await item.adapter.interrupt(current.context)
    await expect(
      item.adapter.resolvePermission(
        { ...current.context, ...(reason !== "no-authority" ? { authorizeReply: () => {} } : {}) },
        { ...request, choiceId: "allow-once" },
      ),
    ).rejects.toThrow()
    expect((await tool)?.behavior).toBe("deny")
  }
})
test("shell, network, unknown Skills, metadata paths and native slash commands are denied", async () => {
  const item = await fixture()
  const current = await item.create()
  await expect(
    item.adapter.send(current.context, {
      commandId: "slash",
      messageId: randomUUID(),
      parts: [{ type: "text", text: "/compact" }],
      delivery: "when-idle",
    }),
  ).rejects.toThrow()
  await dispatch(item.adapter, current.session)
  for (const [tool, input] of [
    ["Bash", { command: "echo unsafe" }],
    ["WebFetch", { url: "https://example.invalid" }],
    ["Skill", { skill: "unselected" }],
    ["Read", { file_path: join(item.root, ".git", "config") }],
    ["Read", { file_path: join(item.root, "..", "outside.txt") }],
  ] as const)
    expect((await current.native.tool(tool, input))?.behavior).toBe("deny")
})
test("lost acknowledgement becomes uncertain and cannot be replayed", async () => {
  const item = await fixture()
  const current = await item.create()
  current.native.ack = false
  expect((await dispatch(item.adapter, current.session)).state).toBe("uncertain")
  expect(current.native.messages).toHaveLength(1)
  await expect(dispatch(item.adapter, current.session)).rejects.toThrow()
})
test("clean resume uses the exact native UUID and rechecks account/policy; uncertain sessions are blocked", async () => {
  const item = await fixture()
  const current = await item.create()
  await item.adapter.close(current.session)
  const request = { ...item.request, operation: "resume" as const }
  const resumed = await item.adapter.resume(request, { ...current.session, status: "closed" })
  expect(resumed.binding.nativeSessionId).toBe(current.session.binding.nativeSessionId)
  expect(item.runtimes.at(-1)?.options.resume).toBe(current.session.binding.nativeSessionId)
  expect(item.runtimes.at(-1)?.options.sessionId).toBeUndefined()
  await item.adapter.close(resumed)
  await expect(item.adapter.resume(request, { ...current.session, status: "uncertain" })).rejects.toThrow()
  item.personal(false)
  await expect(item.adapter.resume(request, current.session)).rejects.toThrow()
})
test("file review rejects traversal, metadata writes, ambiguous replacements and unknown input", async () => {
  const item = await fixture()
  for (const path of ["../outside", ".git/config", ".claude/settings.json", ""])
    expect(() => claudeWorkspacePath(item.root, path)).toThrow()
  await expect(
    claudePatch(item.root, "Edit", { file_path: "note.txt", old_string: "missing", new_string: "after" }),
  ).rejects.toThrow()
  await expect(
    claudePatch(item.root, "Write", { file_path: "note.txt", content: "after", extra: true }),
  ).rejects.toThrow()
})
test("standalone Skills retain exact bytes, model/user bindings and reject changed plugin manifests", async () => {
  const item = await fixture()
  const source = join(item.root, "source")
  await mkdir(join(source, "brief"), { recursive: true })
  const text = "---\nname: brief\ndescription: Reply briefly\n---\nReply in one sentence.\n"
  await writeFile(join(source, "brief", "SKILL.md"), text)
  const id = createHash("sha256")
    .update(`workspace\0${item.request.workspace.id}\0${resolve(source)}\0brief`)
    .digest("hex")
  const sha256 = createHash("sha256").update(text).digest("hex")
  const selected = {
    ...intent,
    skills: ["user", "model"].map((invocation) => ({
      skillId: id,
      sha256,
      invocation: invocation as "user" | "model",
      workspaceId: "workspace",
      runtimeId: "claude-local",
      targetId: "local",
      policyId: "policy",
      policyVersion: "1",
    })),
  }
  const skills = await stageClaudeSkills({
    workspace: item.request.workspace,
    directory: item.root,
    sources: [
      { root: join(item.root, "absent"), scope: "workspace" },
      { root: source, scope: "workspace" },
    ],
    intent: selected,
  })
  expect(skills).toHaveLength(1)
  expect(skills[0]).toMatchObject({ sha256, user: true, model: true })
  expect(claudePrompt("/brief\nhello", skills)).toBe(`/${skills[0]!.nativeCommand}\nhello`)
  for (const prompt of ["/other", "/brief /compact", "!echo unsafe"])
    expect(() => claudePrompt(prompt, skills)).toThrow()
  await verifyClaudeSkills(skills)
  await writeFile(join(skills[0]!.pluginPath, ".claude-plugin", "plugin.json"), "{}")
  await expect(verifyClaudeSkills(skills)).rejects.toThrow()
})
