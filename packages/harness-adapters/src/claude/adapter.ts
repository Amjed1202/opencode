import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import type { CanUseTool, PermissionResult, SDKAssistantMessageError, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type {
  AdapterPreflight,
  AdapterPreflightRequest,
  AdmittedSessionRequest,
  AgentCapabilities,
  AgentEventDraft,
  AgentEventPayload,
  AgentInput,
  AgentSession,
  CommandReceipt,
  ExecutionTarget,
  ModelDescriptor,
  PermissionDecision,
  PermissionRequest,
  PermissionReviewContent,
  ProtocolError,
  RuntimeDescriptor,
  RuntimePreflight,
  SessionIntent,
  UsageSnapshot,
  WorkspaceDescriptor,
} from "@harness/protocol"
import type { AdapterPermissionContext, AdapterSessionContext, AgentAdapter, DiscoveryContext } from "../index"
import { NativeClaudeInspector, PINNED_CLAUDE_VERSION } from "./inspect"
import type { ClaudeSubscriptionObservation } from "./inspect"
import {
  claudeFile,
  claudePatch,
  claudeWorkspacePath,
  hashClaude,
  ordinaryClaudePath,
  sameClaudePath,
  verifyClaudeFileNow,
} from "./files"
import {
  NativeClaudeRuntime,
  PINNED_CLAUDE_SDK_VERSION,
  claudeSettings,
  requireUnmanagedClaude,
  verifyClaudeInitialization,
} from "./runtime"
import type { ClaudeRuntime, ClaudeRuntimeOptions } from "./runtime"
import { claudePrompt, stageClaudeSkills, verifyClaudeSkills } from "./skills"
import type { ClaudeSkillSource, StagedClaudeSkill } from "./skills"

export interface ClaudeInspector {
  version(): Promise<string>
  authStatus(): Promise<{ readonly loggedIn: boolean }>
  subscriptionStatus?(): Promise<ClaudeSubscriptionObservation>
  dispose(): Promise<void>
}
export interface ClaudeAdapterOptions {
  readonly executable: string
  /** Private host inspection directory; never the selected repository. */
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly target: ExecutionTarget
  readonly workspace?: WorkspaceDescriptor
  readonly skillSources?: readonly ClaudeSkillSource[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** Privileged fixture seams, never accepted from renderer or remote requests. */
  readonly inspectorFactory?: (options: ConstructorParameters<typeof NativeClaudeInspector>[0]) => ClaudeInspector
  readonly runtimeFactory?: (options: ClaudeRuntimeOptions) => ClaudeRuntime
  readonly policyCheck?: (environment: Readonly<Record<string, string>>) => Promise<void>
}
type Owned = {
  session: AgentSession
  runtime: ClaudeRuntime
  stream: EventStream
  skills: readonly StagedClaudeSkill[]
  leaseGeneration: number
  leaseExpiresAt: string
  busy: boolean
  closed: boolean
  turn?: string
  command?: string
  ack?: ReturnType<typeof Promise.withResolvers<void>> | undefined
  commands: Set<string>
  messages: Set<string>
  usage: UsageSnapshot[]
  epoch: number
  messageId?: string
  files: Map<string, string>
  texts: Map<string, Map<string, string>>
}
type Pending = {
  owned: Owned
  request: PermissionRequest
  patch: Awaited<ReturnType<typeof claudePatch>>
  tool: string
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal
  abort: () => void
  epoch: number
  deciding: boolean
}
const unavailable =
  "Claude execution requires verified personal subscription, unmanaged native policy and bounded permissions."
const allCapabilities = [
  "chat",
  "coding",
  "reasoning",
  "filesystem",
  "terminal",
  "diff",
  "git",
  "mcp",
  "subagents",
  "skills",
  "hooks",
  "web",
  "image-input",
  "structured-output",
  "permissions",
  "session-resume",
  "context-telemetry",
  "token-telemetry",
  "cost-telemetry",
  "quota-telemetry",
  "remote-execution",
  "review-mode",
  "streaming",
  "human-input",
]
const supported = new Set([
  "chat",
  "coding",
  "filesystem",
  "diff",
  "skills",
  "permissions",
  "session-resume",
  "token-telemetry",
  "streaming",
])

/** Uses the official SDK with the selected unmodified native binary and its existing native login. */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude-code"
  readonly version = "0.1.0"
  private readonly options: ClaudeAdapterOptions
  private readonly inspector: ClaudeInspector
  private disposed = false
  private readonly sessions = new Map<string, Owned>()
  private readonly approvals = new Map<string, Pending>()
  constructor(options: ClaudeAdapterOptions) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.cwd) ||
      options.target.kind !== "local" ||
      !options.target.id ||
      options.target.nodeId !== undefined
    )
      throw new Error("Claude requires an explicit absolute local executable and inspection directory")
    if (
      options.workspace &&
      (!isAbsolute(options.workspace.rootPath) || options.workspace.targetId !== options.target.id)
    )
      throw new Error("Invalid Claude workspace binding")
    this.options = {
      ...options,
      environment: Object.freeze({ ...options.environment }),
      target: Object.freeze({ ...options.target }),
      ...(options.workspace ? { workspace: Object.freeze({ ...options.workspace }) } : {}),
      ...(options.skillSources
        ? { skillSources: Object.freeze(options.skillSources.map((source) => Object.freeze({ ...source }))) }
        : {}),
    }
    this.inspector = (options.inspectorFactory ?? ((input) => new NativeClaudeInspector(input)))({
      executable: options.executable,
      cwd: options.cwd,
      environment: this.options.environment,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    })
  }
  async discover(context: DiscoveryContext): Promise<readonly RuntimeDescriptor[]> {
    if (
      this.disposed ||
      !this.sameTarget(context.target) ||
      !context.allowedExecutablePaths.some((path) => sameClaudePath(path, this.options.executable))
    )
      return []
    try {
      await this.verifyVersion()
    } catch {
      return []
    }
    return [
      {
        id: "claude-local",
        adapterId: this.id,
        name: "Claude Code",
        kind: "native-agent",
        providers: [{ id: "anthropic", name: "Anthropic" }],
        target: this.options.target,
        version: PINNED_CLAUDE_VERSION,
        executable: this.options.executable,
        // Declared access support; account and billing still require native preflight evidence.
        authModes: this.options.workspace && this.inspector.subscriptionStatus ? ["subscription"] : ["unknown"],
        billingModes: this.options.workspace && this.inspector.subscriptionStatus ? ["subscription"] : ["unknown"],
        capabilities: this.capabilities(),
        integration: "conditional",
      },
    ]
  }
  capabilities(): AgentCapabilities {
    return this.capabilitySet(false)
  }
  private capabilitySet(ready: boolean): AgentCapabilities {
    return Object.fromEntries(
      allCapabilities.map((name) => [
        name,
        ready && supported.has(name)
          ? {
              status: "supported",
              verification: "verified",
              evidence: { source: "local-observation", observedAt: now(), runtimeVersion: PINNED_CLAUDE_VERSION },
              limitations: [
                "Pinned personal Pro/Max path; Read/Edit/Write only, no shell or network tools; standalone selected Skills only.",
                "Adapter/control support verified with SDK 0.3.251 fixtures and native initialization; live provider task, Skill invocation and resume validation remain pending.",
              ],
            }
          : { status: "unsupported", reason: unavailable },
      ]),
    )
  }
  async status(runtime: RuntimeDescriptor): Promise<RuntimePreflight> {
    this.requireRuntime(runtime)
    if (this.options.workspace && this.inspector.subscriptionStatus) return (await this.observe()).effective
    try {
      await this.verifyVersion()
      const auth = await this.inspector.authStatus()
      if (this.disposed || typeof auth.loggedIn !== "boolean") throw new Error("Invalid status")
      const checkedAt = now()
      return {
        auth: {
          runtimeId: "claude-local",
          targetId: this.options.target.id,
          status: auth.loggedIn ? "authenticated" : "unauthenticated",
          mode: "unknown",
          evidence: { source: "native-status", observedAt: checkedAt, runtimeVersion: PINNED_CLAUDE_VERSION },
        },
        billing: { route: "unknown", providerOverage: "unknown" },
        capabilities: this.capabilities(),
        enforcement: { mechanism: "none", filesystem: false, shell: false, network: false, limitations: [unavailable] },
        checkedAt,
        expiresAt: checkedAt,
        configurationFingerprint: "claude-native-status-only:unverified",
      }
    } catch {
      throw new Error("Claude native status is unavailable")
    }
  }
  async models(runtime: RuntimeDescriptor): Promise<readonly ModelDescriptor[]> {
    this.requireRuntime(runtime)
    return (await this.observe()).models
  }
  async preflight(request: AdapterPreflightRequest): Promise<AdapterPreflight> {
    try {
      const observed = await this.observe()
      this.requireIntent(request.intent, observed.models)
      if (request.operation === "resume") {
        // Host permissionGuard rechecks admission through this operation for an already owned turn.
        // Actual resume() independently requires a clean saved conversation.
        if (this.sessions.has(request.existingSession.id)) {
          const owned = this.owned(request.existingSession)
          this.live(owned)
          if (
            hashClaude(owned.session.intent) !== hashClaude(request.intent) ||
            observed.effective.configurationFingerprint !== owned.session.effective.configurationFingerprint
          )
            throw new Error("Claude active admission changed")
          await verifyClaudeSkills(owned.skills)
        } else this.requireResume(request.existingSession, request.intent, observed.effective)
      }
      if (request.operation === "turn") {
        const owned = this.owned(request.existingSession)
        if (
          owned.busy ||
          hashClaude(owned.session.intent) !== hashClaude(request.intent) ||
          observed.effective.configurationFingerprint !== owned.session.effective.configurationFingerprint
        )
          throw new Error("Claude turn binding changed")
        await verifyClaudeSkills(owned.skills)
      }
      return { status: "ready", effective: observed.effective }
    } catch {
      return { status: "blocked", errors: [{ code: "unsupported", message: unavailable, retryable: false }] }
    }
  }
  async createSession(request: AdmittedSessionRequest): Promise<AgentSession> {
    if (request.operation !== "create") throw new Error("Invalid Claude create operation")
    return this.openSession(request)
  }
  async resume(request: AdmittedSessionRequest, existing: AgentSession): Promise<AgentSession> {
    if (request.operation !== "resume" || request.sessionId !== existing.id)
      throw new Error("Invalid Claude resume operation")
    this.requireResume(existing, request.intent, request.effective)
    return this.openSession(request, existing)
  }
  private async openSession(request: AdmittedSessionRequest, existing?: AgentSession): Promise<AgentSession> {
    if (!this.options.workspace || !this.inspector.subscriptionStatus) throw new Error(unavailable)
    if (
      this.sessions.has(request.sessionId) ||
      !request.admissionId ||
      !request.sessionId ||
      hashClaude(request.workspace) !== hashClaude(this.options.workspace) ||
      request.lease.workspaceId !== request.workspace.id ||
      request.lease.targetId !== this.options.target.id ||
      !Number.isSafeInteger(request.lease.generation) ||
      request.lease.generation < 1 ||
      !(Date.parse(request.lease.expiresAt) > Date.now()) ||
      !(Date.parse(request.effective.expiresAt) > Date.now()) ||
      (request.intent.policy.filesystem === "workspace-write" && request.lease.mode !== "write")
    )
      throw new Error("Invalid Claude session admission")
    const observed = await this.observe()
    this.requireIntent(request.intent, observed.models)
    if (request.effective.configurationFingerprint !== observed.effective.configurationFingerprint)
      throw new Error("Claude admission evidence changed")
    if (existing) this.requireResume(existing, request.intent, observed.effective)
    await ordinaryClaudePath(request.workspace.rootPath, true)
    const skills = await stageClaudeSkills({
      workspace: request.workspace,
      directory: this.options.cwd,
      sources: this.options.skillSources ?? [],
      intent: request.intent,
    })
    const nativeSessionId = existing?.binding.nativeSessionId ?? randomUUID()
    let owned: Owned | undefined
    const runtime = this.runtime({
      cwd: request.workspace.rootPath,
      ...(existing ? { resume: nativeSessionId } : { sessionId: nativeSessionId }),
      model: request.intent.selection.model.modelId,
      pluginPaths: skills.map((skill) => skill.pluginPath),
      modelSkills: skills.filter((skill) => skill.model).map((skill) => skill.nativeCommand),
      tools: [
        "Read",
        ...(request.intent.policy.filesystem === "workspace-write" ? ["Edit", "Write"] : []),
        ...(skills.some((skill) => skill.model) ? ["Skill"] : []),
      ],
      canUseTool: (...args) => (owned ? this.permission(owned, ...args) : Promise.resolve(denial())),
    })
    try {
      const initialized = await runtime.initialize()
      verifyClaudeInitialization(initialized, observed.auth)
      for (const skill of skills)
        if (!initialized.commands.some((command) => command.name === skill.nativeCommand))
          throw new Error("Admitted native Claude Skill was not loaded")
      if (
        initialized.commands.some(
          (command) => command.name.includes(":") && !skills.some((skill) => skill.nativeCommand === command.name),
        )
      )
        throw new Error("Unexpected native Claude Skill loaded")
      await this.recheck(observed.auth.accountId)
      await verifyClaudeSkills(skills)
      const session: AgentSession = {
        id: request.sessionId,
        workspaceId: request.workspace.id,
        intent: structuredClone(request.intent),
        binding: {
          runtimeId: "claude-local",
          adapterId: this.id,
          targetId: this.options.target.id,
          nativeSessionId,
          nativeProtocolVersion: PINNED_CLAUDE_VERSION,
        },
        effective: structuredClone(request.effective),
        status: "idle",
        createdAt: existing?.createdAt ?? now(),
        revision: (existing?.revision ?? 0) + 1,
      }
      owned = {
        session,
        runtime,
        stream: new EventStream(),
        skills,
        leaseGeneration: request.lease.generation,
        leaseExpiresAt: request.lease.expiresAt,
        busy: false,
        closed: false,
        commands: new Set(),
        messages: new Set(),
        usage: [],
        epoch: 0,
        files: new Map(),
        texts: new Map(),
      }
      this.sessions.set(session.id, owned)
      void this.pump(owned)
      return structuredClone(session)
    } catch {
      await runtime.close()
      throw new Error("Claude session initialization failed")
    }
  }
  async send(context: AdapterSessionContext, input: AgentInput): Promise<CommandReceipt> {
    const owned = this.context(context)
    if (
      owned.busy ||
      input.delivery !== "when-idle" ||
      !input.commandId ||
      owned.commands.has(input.commandId) ||
      owned.messages.has(input.messageId) ||
      owned.commands.size >= 1024 ||
      !uuid(input.messageId) ||
      !input.parts.length ||
      input.parts.some((part) => part.type !== "text")
    )
      throw new Error("Invalid Claude input")
    const text = input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    if (!text.trim() || Buffer.byteLength(text) > 256 * 1024) throw new Error("Claude input exceeds bounds")
    await this.recheck(owned.session.effective.auth.accountId!)
    await verifyClaudeSkills(owned.skills)
    this.context(context)
    if (
      owned.busy ||
      owned.commands.has(input.commandId) ||
      owned.messages.has(input.messageId) ||
      owned.commands.size >= 1024
    )
      throw new Error("Claude input is no longer admissible")
    const prompt = claudePrompt(text, owned.skills)
    owned.texts.clear()
    delete owned.messageId
    owned.busy = true
    owned.turn = input.messageId
    owned.command = input.commandId
    owned.commands.add(input.commandId)
    owned.messages.add(input.messageId)
    owned.epoch++
    const ack = Promise.withResolvers<void>()
    owned.ack = ack
    const timer = setTimeout(
      () => ack.reject(new Error("Claude input acknowledgement timed out")),
      this.options.timeoutMs ?? 15000,
    )
    try {
      owned.runtime.send({
        type: "user",
        uuid: input.messageId as `${string}-${string}-${string}-${string}-${string}`,
        session_id: owned.session.binding.nativeSessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: prompt },
      })
      await ack.promise
      return {
        commandId: input.commandId,
        sessionId: owned.session.id,
        state: "dispatched",
        nativeTurnId: input.messageId,
        recordedAt: now(),
      }
    } catch {
      this.denyAll(owned)
      await owned.runtime.close()
      owned.closed = true
      this.update(owned, "uncertain")
      return {
        commandId: input.commandId,
        sessionId: owned.session.id,
        state: "uncertain",
        recordedAt: now(),
        error: {
          code: "native-error",
          message: "Claude input was not acknowledged; it will not be replayed.",
          retryable: false,
        },
      }
    } finally {
      clearTimeout(timer)
      owned.ack = undefined
    }
  }
  events(session: AgentSession) {
    return this.owned(session).stream
  }
  async interrupt(context: AdapterSessionContext) {
    const owned = this.context(context)
    this.denyAll(owned)
    await owned.runtime.interrupt()
  }
  async close(session: AgentSession) {
    const owned = this.sessions.get(session.id)
    if (!owned) return
    this.denyAll(owned)
    owned.closed = true
    await owned.runtime.close()
    owned.stream.close()
    this.sessions.delete(session.id)
  }
  async dispose() {
    this.disposed = true
    for (const owned of this.sessions.values()) await this.close(owned.session)
    await this.inspector.dispose()
  }
  async usage(session: AgentSession) {
    return [...this.owned(session).usage]
  }
  async reviewPermission(context: AdapterSessionContext, requestId: string): Promise<PermissionReviewContent> {
    const pending = this.pending(context, requestId)
    await this.patchCurrent(pending)
    return {
      kind: "patch",
      requestId,
      operationSha256: pending.request.operationSha256,
      changes: [pending.patch.change],
    }
  }
  async resolvePermission(context: AdapterPermissionContext, decision: PermissionDecision) {
    const pending = this.pending(context, decision.requestId)
    if (pending.deciding || !["allow-once", "deny-once"].includes(decision.choiceId))
      throw new Error("Invalid Claude permission choice")
    for (const key of [
      "sessionId",
      "runtimeId",
      "nativeSessionId",
      "nativeTurnId",
      "nativeRequestId",
      "targetId",
      "workspaceId",
      "policyId",
      "policyVersion",
      "leaseGeneration",
      "operationSha256",
    ] as const)
      if (decision[key] !== pending.request[key]) throw new Error("Claude permission binding mismatch")
    pending.deciding = true
    if (decision.choiceId === "deny-once") {
      this.finishPending(pending, denial())
      return
    }
    try {
      if (!context.authorizeReply) throw new Error("Claude allow requires host authorization")
      await this.recheck(pending.owned.session.effective.auth.accountId!)
      await verifyClaudeSkills(pending.owned.skills)
      await this.patchCurrent(pending)
      const delivered = pending.owned.runtime.authorizePermission(pending.request.nativeRequestId, () => {
        this.pending(context, decision.requestId)
        verifyClaudeFileNow(pending.patch.path, pending.patch.beforeSha256)
        context.authorizeReply!()
      })
      pending.resolve({ behavior: "allow", updatedInput: pending.input, toolUseID: pending.request.toolCallId! })
      await delivered
      pending.owned.files.set(pending.request.toolCallId!, pending.patch.change.path)
      this.removePending(pending)
    } catch {
      this.finishPending(pending, denial())
      throw new Error("Claude permission authorization is no longer valid")
    }
  }
  private async permission(
    owned: Owned,
    tool: Parameters<CanUseTool>[0],
    input: Parameters<CanUseTool>[1],
    native: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    try {
      this.live(owned)
      if (
        !owned.busy ||
        !owned.turn ||
        native.agentID ||
        native.signal.aborted ||
        !native.requestId ||
        !native.toolUseID
      )
        return denial()
      const epoch = owned.epoch
      const turn = owned.turn
      const current = () => {
        this.live(owned)
        if (!owned.busy || owned.epoch !== epoch || owned.turn !== turn || native.signal.aborted)
          throw new Error("Stale Claude tool request")
      }
      if (tool === "Read") {
        if (Object.keys(input).some((key) => !["file_path", "offset", "limit"].includes(key))) return denial()
        await claudeFile(claudeWorkspacePath(this.options.workspace!.rootPath, input.file_path).path)
        current()
        void owned.runtime.authorizePermission(native.requestId, current).catch(() => this.fail(owned))
        return { behavior: "allow", updatedInput: input, toolUseID: native.toolUseID }
      }
      if (tool === "Skill") {
        if (
          Object.keys(input).some((key) => !["skill", "args"].includes(key)) ||
          typeof input.skill !== "string" ||
          !owned.skills.some((skill) => skill.model && skill.nativeCommand === input.skill)
        )
          return denial()
        await verifyClaudeSkills(owned.skills)
        current()
        void owned.runtime.authorizePermission(native.requestId, current).catch(() => this.fail(owned))
        return { behavior: "allow", updatedInput: input, toolUseID: native.toolUseID }
      }
      if (
        !["Write", "Edit"].includes(tool) ||
        owned.session.intent.policy.filesystem !== "workspace-write" ||
        owned.session.intent.policy.approval !== "ask" ||
        this.approvals.size >= 32
      )
        return denial()
      const patch = await claudePatch(this.options.workspace!.rootPath, tool, input)
      current()
      const request: PermissionRequest = {
        requestId: randomUUID(),
        sessionId: owned.session.id,
        runtimeId: "claude-local",
        nativeSessionId: owned.session.binding.nativeSessionId,
        nativeTurnId: owned.turn,
        nativeRequestId: native.requestId,
        targetId: this.options.target.id,
        workspaceId: owned.session.workspaceId,
        policyId: owned.session.intent.policy.id,
        policyVersion: owned.session.intent.policy.version,
        leaseGeneration: owned.leaseGeneration,
        operationSha256: patch.operationSha256,
        toolCallId: native.toolUseID,
        action: "file.change",
        resources: [patch.change.path],
        details: { tool, operation: patch.change.kind },
        choices: [
          { id: "allow-once", action: "allow", scope: "once", label: "Allow this change" },
          { id: "deny-once", action: "deny", scope: "once", label: "Deny this change" },
        ],
        expiresAt: new Date(Math.min(Date.now() + 60000, Date.parse(owned.leaseExpiresAt))).toISOString(),
      }
      return await new Promise<PermissionResult>((resolve) => {
        const pending: Pending = {
          owned,
          request,
          patch,
          tool,
          input: structuredClone(input),
          resolve,
          epoch,
          deciding: false,
          signal: native.signal,
          abort: () => this.finishPending(pending, denial()),
          timer: setTimeout(
            () => this.finishPending(pending, denial()),
            Math.max(1, Date.parse(request.expiresAt) - Date.now()),
          ),
        }
        this.approvals.set(request.requestId, pending)
        native.signal.addEventListener("abort", pending.abort, { once: true })
        if (native.signal.aborted) {
          this.finishPending(pending, denial())
          return
        }
        this.emit(owned, { type: "permission.requested", data: request })
      })
    } catch {
      return denial()
    }
  }
  private async pump(owned: Owned) {
    try {
      for await (const message of owned.runtime.events()) {
        if (owned.closed) break
        if (message.session_id !== owned.session.binding.nativeSessionId)
          throw new Error("Native Claude session changed")
        this.project(owned, message)
      }
      if (!owned.closed) this.fail(owned)
    } catch {
      if (!owned.closed) this.fail(owned)
    }
  }
  private project(owned: Owned, message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init") this.requireModel(owned, message.model)
    if (message.type === "user" && "isReplay" in message && message.isReplay === true) {
      if (message.parent_tool_use_id !== null || message.message.role !== "user")
        throw new Error("Invalid Claude main input acknowledgment")
      if (!owned.busy || message.uuid !== owned.turn || !owned.ack)
        throw new Error("Unexpected Claude input acknowledgement")
      owned.ack.resolve()
      this.update(owned, "running")
      this.emit(owned, { type: "agent.started", data: { nativeTurnId: owned.turn! } })
      return
    }
    if (!owned.busy || !owned.turn) return
    if (
      "user_message_uuid" in message &&
      message.user_message_uuid !== undefined &&
      message.user_message_uuid !== owned.turn
    )
      throw new Error("Claude event belongs to another input")
    if ("parent_tool_use_id" in message && message.parent_tool_use_id !== null)
      throw new Error("Unexpected Claude subagent event")
    if (message.type === "stream_event") {
      const event = message.event
      if (event.type === "message_start") {
        this.requireModel(owned, event.message.model)
        owned.messageId = event.message.id
      }
      if (event.type === "message_stop") delete owned.messageId
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (!owned.messageId) throw new Error("Claude stream has no message identity")
        this.emit(owned, {
          type: "assistant.text.delta",
          data: { messageId: owned.messageId, partId: "text", delta: bounded(event.delta.text) },
        })
      }
    } else if (message.type === "assistant") {
      if (message.message.model === "<synthetic>") {
        const error = knownClaudeError(message.error)
        if (message.parent_tool_use_id !== null || message.message.role !== "assistant" || !error)
          throw new Error("Unknown Claude synthetic message")
        // Native API failures are diagnostics, not responses from the selected model.
        // Their stop_reason is not a result: close conservatively without declaring completion.
        this.fail(owned, error)
        return
      }
      this.requireModel(owned, message.message.model)
      const text = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
      if (text) {
        const frames = owned.texts.get(message.message.id) ?? new Map<string, string>()
        if (owned.texts.size >= 128 || frames.size >= 256) throw new Error("Claude text history exceeds turn bounds")
        if (message.supersedes?.length) throw new Error("Claude replacement frames require a separate projection")
        frames.set(message.uuid, text)
        owned.texts.set(message.message.id, frames)
        this.emit(owned, {
          type: "assistant.text.completed",
          data: { messageId: message.message.id, partId: "text", text: bounded([...frames.values()].join("\n\n")) },
        })
      }
      for (const block of message.message.content) {
        if (block.type === "tool_use")
          this.emit(owned, {
            type: "tool.started",
            data: { callId: block.id, name: block.name, input: { nativeTool: block.name } },
          })
      }
    } else if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content)
        if (typeof block === "object" && block.type === "tool_result") {
          this.emit(owned, {
            type: "tool.completed",
            data: { callId: block.tool_use_id, outcome: block.is_error ? "failed" : "succeeded" },
          })
          const path = owned.files.get(block.tool_use_id)
          if (path) {
            this.emit(owned, {
              type: "file.changed",
              data: { path, source: "native-reported", state: block.is_error ? "unknown" : "applied" },
            })
            owned.files.delete(block.tool_use_id)
          }
        }
    } else if (message.type === "result") {
      const id = randomUUID()
      const usage: UsageSnapshot = {
        id,
        sourceEventId: id,
        scope: this.scope(owned),
        providerId: "anthropic",
        modelId: owned.session.intent.selection.model.modelId,
        accountingScope: "turn",
        accountingId: owned.turn,
        epoch: owned.turn,
        basis: "cumulative",
        includesSubagents: "no",
        completeness: "final",
        evidence: { source: "native-event", observedAt: now(), runtimeVersion: PINNED_CLAUDE_VERSION },
        tokens: {
          input: count(message.usage.input_tokens),
          output: count(message.usage.output_tokens),
          cacheRead: count(message.usage.cache_read_input_tokens),
          cacheWrite: count(message.usage.cache_creation_input_tokens),
          reasoning: null,
          cacheRelation: "separate",
          reasoningRelation: "unknown",
        },
        billing: owned.session.effective.billing,
      }
      owned.usage.push(usage)
      if (owned.usage.length > 128) owned.usage.shift()
      this.emit(owned, { type: "usage.updated", data: usage }, id)
      this.emit(owned, {
        type: "agent.completed",
        data: {
          nativeTurnId: owned.turn,
          outcome:
            message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools"
              ? "interrupted"
              : message.is_error
                ? "failed"
                : "succeeded",
        },
      })
      this.denyAll(owned)
      owned.busy = false
      this.update(
        owned,
        message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools"
          ? "interrupted"
          : message.is_error
            ? "failed"
            : "idle",
      )
    }
  }
  private fail(
    owned: Owned,
    error: ProtocolError = {
      code: "native-error",
      message: "Claude native execution stopped; unacknowledged input is never replayed.",
      retryable: false,
    },
  ) {
    if (owned.closed) return
    this.denyAll(owned)
    owned.closed = true
    owned.ack?.reject(new Error("Claude native stream ended"))
    this.emit(owned, {
      type: "agent.error",
      data: {
        error,
        ...(owned.turn ? { nativeTurnId: owned.turn } : {}),
      },
    })
    this.update(owned, owned.busy ? "uncertain" : "failed")
    void owned.runtime.close().catch(() => {})
    owned.stream.close()
  }
  private emit(owned: Owned, event: AgentEventPayload, id = randomUUID()) {
    owned.stream.push({
      ...event,
      origin: {
        streamId: `claude:${owned.session.binding.nativeSessionId}`,
        epoch: owned.session.createdAt,
        eventId: id,
        identityStrategy: "adapter-assigned",
      },
      scope: this.scope(owned),
      observedAt: now(),
    })
  }
  private scope(owned: Owned) {
    return {
      targetId: this.options.target.id,
      runtimeId: "claude-local",
      workspaceId: owned.session.workspaceId,
      sessionId: owned.session.id,
      ...(owned.turn ? { turnId: owned.turn } : {}),
      ...(owned.command ? { commandId: owned.command } : {}),
    }
  }
  private update(owned: Owned, status: AgentSession["status"]) {
    owned.session = { ...owned.session, status, revision: owned.session.revision + 1 }
    // Host state is derived from bound agent/permission events; adapters cannot replace it.
  }
  private pending(context: AdapterSessionContext, id: string) {
    const owned = this.context(context)
    const pending = this.approvals.get(id)
    if (
      !pending ||
      pending.owned !== owned ||
      !owned.busy ||
      pending.epoch !== owned.epoch ||
      pending.signal.aborted ||
      Date.parse(pending.request.expiresAt) <= Date.now()
    )
      throw new Error("Claude permission expired")
    return pending
  }
  private async patchCurrent(pending: Pending) {
    if (
      (await claudePatch(this.options.workspace!.rootPath, pending.tool, pending.input)).operationSha256 !==
      pending.patch.operationSha256
    )
      throw new Error("Claude file changed after review")
  }
  private removePending(pending: Pending) {
    clearTimeout(pending.timer)
    pending.signal.removeEventListener("abort", pending.abort)
    this.approvals.delete(pending.request.requestId)
  }
  private finishPending(pending: Pending, result: PermissionResult) {
    this.removePending(pending)
    pending.resolve(result)
  }
  private denyAll(owned: Owned) {
    owned.epoch++
    for (const pending of this.approvals.values()) if (pending.owned === owned) this.finishPending(pending, denial())
  }
  private context(context: AdapterSessionContext) {
    const owned = this.owned(context.session)
    this.live(owned)
    if (!context.admissionId || context.leaseGeneration !== owned.leaseGeneration)
      throw new Error("Claude lease binding mismatch")
    return owned
  }
  private owned(session: AgentSession) {
    const owned = this.sessions.get(session.id)
    if (
      !owned ||
      hashClaude(session.binding) !== hashClaude(owned.session.binding) ||
      session.workspaceId !== owned.session.workspaceId ||
      hashClaude(session.intent) !== hashClaude(owned.session.intent)
    )
      throw new Error("Claude session is not owned")
    return owned
  }
  private live(owned: Owned) {
    if (this.disposed || owned.closed || Date.parse(owned.leaseExpiresAt) <= Date.now())
      throw new Error("Claude session lease expired")
  }
  private runtime(input: Omit<ClaudeRuntimeOptions, "executable" | "environment">) {
    return (this.options.runtimeFactory ?? ((options) => new NativeClaudeRuntime(options)))({
      ...input,
      executable: this.options.executable,
      environment: this.options.environment,
    })
  }
  private async recheck(accountId: string) {
    await this.verifyVersion()
    await (this.options.policyCheck ?? requireUnmanagedClaude)(this.options.environment)
    if (!this.inspector.subscriptionStatus || (await this.inspector.subscriptionStatus()).accountId !== accountId)
      throw new Error("Claude native account changed")
  }
  private async observe() {
    if (!this.options.workspace || !this.inspector.subscriptionStatus) throw new Error(unavailable)
    await this.verifyVersion()
    await (this.options.policyCheck ?? requireUnmanagedClaude)(this.options.environment)
    const auth = await this.inspector.subscriptionStatus()
    const runtime = this.runtime({ cwd: this.options.cwd, tools: [], canUseTool: async () => denial() })
    try {
      const initialized = await runtime.initialize()
      verifyClaudeInitialization(initialized, auth)
      await this.recheck(auth.accountId)
      const models: ModelDescriptor[] = []
      for (const model of initialized.models) {
        if (model.value === "default") continue
        if (
          !["sonnet", "haiku", "opus"].includes(model.value) &&
          !/^claude-[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(model.value)
        )
          continue
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.value) ||
          typeof model.displayName !== "string" ||
          !model.displayName ||
          model.displayName.length > 128 ||
          /[\x00-\x1f]/.test(model.displayName) ||
          models.some((entry) => entry.id === model.value)
        )
          throw new Error("Unknown Claude model inventory")
        models.push({
          id: model.value,
          name: model.displayName,
          providerId: "anthropic",
          capabilities: this.capabilitySet(true),
        })
      }
      if (!models.length) throw new Error("Claude has no explicit model selection")
      const checkedAt = now()
      const evidence = {
        source: "native-status" as const,
        observedAt: checkedAt,
        runtimeVersion: PINNED_CLAUDE_VERSION,
      }
      const effective: RuntimePreflight = {
        auth: {
          runtimeId: "claude-local",
          targetId: this.options.target.id,
          status: "authenticated",
          mode: "subscription",
          method: "claude-code-subscription",
          accountId: auth.accountId,
          evidence,
        },
        billing: { route: "subscription", providerId: "anthropic", providerOverage: "unknown", evidence },
        capabilities: this.capabilitySet(true),
        enforcement: {
          mechanism: "mediated-tools",
          filesystem: false,
          shell: false,
          network: false,
          limitations: [
            "Native restricted mode plus host tool mediation; no OS sandbox is attested.",
            "Only ordinary repository text files and standalone selected Skills are supported.",
            "Personal Pro/Max native billing observation; provider extra usage remains unknown.",
          ],
        },
        checkedAt,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        configurationFingerprint: hashClaude({
          native: PINNED_CLAUDE_VERSION,
          sdk: PINNED_CLAUDE_SDK_VERSION,
          accountId: auth.accountId,
          workspace: this.options.workspace,
          environment: this.options.environment,
          settings: claudeSettings,
          models: models.map((model) => model.id),
        }),
      }
      return { auth, models, effective }
    } finally {
      await runtime.close()
    }
  }
  private requireIntent(intent: SessionIntent, models: readonly ModelDescriptor[]) {
    const access = intent.selection.access
    const policy = intent.policy
    if (
      intent.workspaceId !== this.options.workspace?.id ||
      intent.selection.runtimeId !== "claude-local" ||
      intent.selection.targetId !== this.options.target.id ||
      intent.selection.model.providerId !== "anthropic" ||
      !models.some((model) => model.id === intent.selection.model.modelId) ||
      access.mode !== "subscription" ||
      access.method !== "claude-code-subscription" ||
      access.billing !== "subscription" ||
      access.overagePolicy !== "acknowledge-provider-settings" ||
      intent.selection.fallback.automatic ||
      intent.selection.extensions?.length ||
      policy.shell !== "disabled" ||
      policy.network !== "denied" ||
      policy.allowedMcpServers.length ||
      policy.requireEnforcedBoundary ||
      !["read-only", "workspace-write"].includes(policy.filesystem) ||
      !["ask", "deny"].includes(policy.approval) ||
      intent.requiredCapabilities.some((name) => !supported.has(name))
    )
      throw new Error("Unsupported Claude execution intent")
  }
  private requireResume(existing: AgentSession, intent: SessionIntent, effective: RuntimePreflight) {
    if (
      !["idle", "closed"].includes(existing.status) ||
      !uuid(existing.binding.nativeSessionId) ||
      existing.binding.runtimeId !== "claude-local" ||
      existing.binding.adapterId !== this.id ||
      existing.binding.targetId !== this.options.target.id ||
      existing.binding.nativeProtocolVersion !== PINNED_CLAUDE_VERSION ||
      existing.workspaceId !== this.options.workspace?.id ||
      hashClaude(existing.intent) !== hashClaude(intent) ||
      existing.effective.configurationFingerprint !== effective.configurationFingerprint
    )
      throw new Error("Only a clean, unchanged Claude conversation can resume")
  }
  private requireModel(owned: Owned, observed: string) {
    const selected = owned.session.intent.selection.model.modelId
    if (observed === selected) return
    if (
      (selected === "sonnet" || selected === "haiku" || selected === "opus") &&
      new RegExp(`^claude-${selected}-[0-9][a-zA-Z0-9.-]*$`).test(observed)
    )
      return
    throw new Error("Claude effective model changed from the explicit selection")
  }
  private requireRuntime(runtime: RuntimeDescriptor) {
    if (
      runtime.id !== "claude-local" ||
      runtime.adapterId !== this.id ||
      runtime.kind !== "native-agent" ||
      runtime.version !== PINNED_CLAUDE_VERSION ||
      runtime.nativeProtocolVersion !== undefined ||
      !runtime.executable ||
      !sameClaudePath(runtime.executable, this.options.executable) ||
      !this.sameTarget(runtime.target) ||
      runtime.providers.length !== 1 ||
      runtime.providers[0]?.id !== "anthropic"
    )
      throw new Error("Invalid Claude native status binding")
  }
  private sameTarget(target: ExecutionTarget) {
    return (
      target.id === this.options.target.id &&
      target.kind === "local" &&
      target.name === this.options.target.name &&
      target.nodeId === undefined
    )
  }
  private async verifyVersion() {
    if (this.disposed || (await this.inspector.version()) !== PINNED_CLAUDE_VERSION || this.disposed)
      throw new Error("Unsupported Claude native version")
  }
}
function now() {
  return new Date().toISOString()
}
function denial(): PermissionResult {
  return { behavior: "deny", message: "This operation is outside the current Harness authorization." }
}
function knownClaudeError(value: unknown): ProtocolError | undefined {
  const errors = {
    authentication_failed: { code: "auth-required", message: "Claude authentication failed." },
    oauth_org_not_allowed: { code: "auth-required", message: "Claude rejected the native account organization." },
    account_on_hold: { code: "billing-conflict", message: "Claude reported that the account is on hold." },
    billing_error: { code: "billing-conflict", message: "Claude reported a billing error." },
    rate_limit: { code: "capacity-limited", message: "Claude reported a native rate limit." },
    overloaded: { code: "capacity-limited", message: "Claude reported provider overload." },
    invalid_request: { code: "invalid-input", message: "Claude rejected the native request." },
    model_not_found: { code: "unavailable", message: "Claude reported that the selected model is unavailable." },
    server_error: { code: "unavailable", message: "Claude reported a provider server error." },
    unknown: { code: "native-error", message: "Claude reported an unclassified native error." },
    max_output_tokens: { code: "capacity-limited", message: "Claude reached the native output-token limit." },
  } as const satisfies Record<SDKAssistantMessageError, Pick<ProtocolError, "code" | "message">>
  if (typeof value !== "string" || !Object.hasOwn(errors, value)) return undefined
  const error = errors[value as SDKAssistantMessageError]
  return {
    ...error,
    message: `${error.message} Native execution stopped without automatic retry.`,
    nativeCode: value,
    retryable: false,
  }
}
function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
function bounded(value: string) {
  if (Buffer.byteLength(value) > 512 * 1024) throw new Error("Claude output exceeds bounds")
  return value
}
function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

class EventStream implements AsyncIterable<AgentEventDraft> {
  private readonly queue: AgentEventDraft[] = []
  private ended = false
  private wake: (() => void) | undefined
  private bytes = 0
  push(event: AgentEventDraft) {
    if (this.ended) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.queue.length >= 1024 || this.bytes + bytes > 8 * 1024 * 1024)
      throw new Error("Claude event queue overflow")
    this.queue.push(event)
    this.bytes += bytes
    this.wake?.()
  }
  close() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const event = this.queue.shift()
      if (event) {
        this.bytes -= Buffer.byteLength(JSON.stringify(event))
        yield event
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}
