import { createHash, randomUUID } from "node:crypto"
import { delimiter, isAbsolute, resolve } from "node:path"
import type {
  AdmittedSessionRequest,
  AdapterPreflightRequest,
  AdapterPreflight,
  AgentCapabilities,
  AgentInput,
  AgentSession,
  AgentEventDraft,
  AgentEventPayload,
  CommandReceipt,
  ExecutionTarget,
  JsonValue,
  RuntimeDescriptor,
  RuntimePreflight,
  SessionIntent,
} from "@harness/protocol"
import type { AdapterSessionContext, AgentAdapter, DiscoveryContext } from "../index"
import { StdioJsonRpc, isRecord } from "./stdio"
import type { NativeNotification, NativeReply, NativeRequest, StdioJsonRpcOptions } from "./stdio"
import type { InitializeParams } from "./generated/0.153.4/InitializeParams"
import type { ConfigReadParams } from "./generated/0.153.4/v2/ConfigReadParams"
import type { GetAccountParams } from "./generated/0.153.4/v2/GetAccountParams"
import type { ThreadStartParams } from "./generated/0.153.4/v2/ThreadStartParams"
import type { ThreadResumeParams } from "./generated/0.153.4/v2/ThreadResumeParams"
import type { TurnStartParams } from "./generated/0.153.4/v2/TurnStartParams"
import type { TurnInterruptParams } from "./generated/0.153.4/v2/TurnInterruptParams"
import type { CommandExecutionRequestApprovalResponse } from "./generated/0.153.4/v2/CommandExecutionRequestApprovalResponse"
import type { FileChangeRequestApprovalResponse } from "./generated/0.153.4/v2/FileChangeRequestApprovalResponse"
import type { PermissionsRequestApprovalResponse } from "./generated/0.153.4/v2/PermissionsRequestApprovalResponse"
import type { McpServerElicitationRequestResponse } from "./generated/0.153.4/v2/McpServerElicitationRequestResponse"
export interface CodexAdapterOptions {
  readonly executable: string
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly target: ExecutionTarget
  readonly runtimeId?: string
  readonly requestTimeoutMs?: number
  readonly maxMessageBytes?: number
  readonly transportFactory?: (options: StdioJsonRpcOptions) => StdioJsonRpc
}
type OwnedSession = {
  session: AgentSession
  leaseGeneration: number
  stream: EventStream
  busy: boolean
  commandId?: string
  turnId?: string
  completedTurnId?: string
  seenCommands: Set<string>
  awaitingAck: boolean
  buffered: NativeNotification[]
}

// Verified against the pinned official config.schema.json; these never edit config.toml.
const isolatedConfiguration = {
  "features.hooks": false,
  "features.codex_hooks": false,
  "features.plugin_hooks": false,
  "features.plugins": false,
  "features.remote_plugin": false,
  "features.recommended_plugins": false,
  "features.apps": false,
  "features.connectors": false,
  "features.enable_mcp_apps": false,
  "features.shell_snapshot": false,
  "features.shell_snapshot_v2": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.skill_mcp_dependency_install": false,
  "features.skip_host_skill_discovery": true,
  "skills.include_instructions": false,
  "skills.bundled.enabled": false,
  "agents.enabled": false,
  allow_login_shell: false,
  "shell_environment_policy.experimental_use_profile": false,
  "analytics.enabled": false,
  "feedback.enabled": false,
  "otel.exporter": "none",
  "otel.trace_exporter": "none",
  "otel.metrics_exporter": "none",
  "orchestrator.mcp.enabled": false,
  "orchestrator.skills.enabled": false,
  "features.respect_system_proxy": false,
  "features.network_proxy": false,
} as const

/** Host-only, subscription-first adapter. This release exposes no login, token or API inference route. */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex-app-server"
  readonly version = "0.1.0"
  private readonly options: CodexAdapterOptions
  private readonly runtimeId: string
  private transport: StdioJsonRpc | undefined
  private connecting: Promise<StdioJsonRpc> | undefined
  private disposed = false
  private accountEpoch = 0
  private accountMode: unknown = "chatgpt"
  private versionVerifiedAt = new Date().toISOString()
  private readonly sessions = new Map<string, OwnedSession>()

  constructor(options: CodexAdapterOptions) {
    if (!absolute(options.executable) || !absolute(options.cwd) || options.target.kind !== "local")
      throw new Error("Codex requires an explicit absolute local executable and workspace")
    requireEnvironment(options.environment)
    this.options = { ...options, environment: Object.freeze({ ...options.environment }), target: { ...options.target } }
    this.runtimeId = options.runtimeId ?? "codex-local"
  }

  async discover(context: DiscoveryContext): Promise<readonly RuntimeDescriptor[]> {
    if (
      context.target.id !== this.options.target.id ||
      !context.allowedExecutablePaths.some((path) => samePath(path, this.options.executable))
    )
      return []
    try {
      await this.connect()
    } catch {
      return []
    }
    return [
      {
        id: this.runtimeId,
        adapterId: this.id,
        name: "Codex App Server",
        kind: "native-agent",
        providers: [{ id: "openai", name: "OpenAI" }],
        target: this.options.target,
        version: "0.153.4",
        executable: this.options.executable,
        nativeProtocolVersion: "0.153.4",
        authModes: ["subscription"],
        billingModes: ["subscription"],
        capabilities: this.capabilities(),
        integration: "conditional",
      },
    ]
  }

  capabilities(): AgentCapabilities {
    const support = {
      status: "supported",
      verification: "verified",
      evidence: { source: "local-observation", observedAt: this.versionVerifiedAt, runtimeVersion: "0.153.4" },
      limitations: ["Pinned wire schema and local process fixtures; live model execution has not been tested."],
    } as const
    return {
      chat: support,
      streaming: support,
      "session-resume": {
        ...support,
        limitations: [
          "Native ID resume only; historical event hydration and uncertain-turn reconciliation are not implemented.",
        ],
      },
      permissions: {
        ...support,
        limitations: ["All native approval requests are denied; interactive permission grants are unsupported."],
      },
      coding: { status: "unknown", reason: "Native tool mappings and OS enforcement are not verified." },
      "human-input": { status: "unsupported", reason: "Human input requests are declined." },
    }
  }

  async preflight(request: AdapterPreflightRequest): Promise<AdapterPreflight> {
    try {
      this.requireIntent(request.intent)
      const effective = await this.observe()
      if (
        request.operation !== "create" &&
        request.existingSession.effective.auth.accountId !== effective.auth.accountId
      )
        throw new Error("The effective native account changed")
      return { status: "ready", effective }
    } catch {
      return {
        status: "blocked",
        errors: [
          {
            code: "billing-conflict",
            message:
              "Codex subscription route, pinned protocol, account or requested policy could not be verified. No native turn was sent.",
            retryable: false,
          },
        ],
      }
    }
  }

  async createSession(request: AdmittedSessionRequest): Promise<AgentSession> {
    if (request.operation !== "create") throw new Error("Create requires a create admission")
    return this.open(request)
  }

  async resume(request: AdmittedSessionRequest, existing: AgentSession): Promise<AgentSession> {
    if (
      request.operation !== "resume" ||
      existing.id !== request.sessionId ||
      existing.workspaceId !== request.workspace.id ||
      existing.binding.adapterId !== this.id ||
      existing.binding.runtimeId !== this.runtimeId ||
      existing.binding.targetId !== this.options.target.id ||
      existing.effective.auth.accountId !== request.effective.auth.accountId
    )
      throw new Error("Invalid native resume binding")
    return this.open(request, nativeId(existing.binding.nativeSessionId))
  }

  async send(context: AdapterSessionContext, input: AgentInput): Promise<CommandReceipt> {
    const receipt = (state: CommandReceipt["state"], message?: string): CommandReceipt => ({
      commandId: input.commandId,
      sessionId: context.session.id,
      state,
      recordedAt: new Date().toISOString(),
      ...(message ? { error: { code: "native-error", message, retryable: false } } : {}),
    })
    let owned: OwnedSession
    let reserved = false
    try {
      owned = this.owned(context)
      if (owned.busy || owned.seenCommands.has(input.commandId) || owned.seenCommands.size >= 1024)
        throw new Error("Session is busy or the command was already attempted")
      if (
        input.delivery !== "when-idle" ||
        !input.parts.length ||
        input.parts.some((part) => part.type !== "text") ||
        !input.commandId ||
        !input.messageId
      )
        throw new Error("Only idle text inputs are supported")
      owned.busy = true
      reserved = true
      owned.seenCommands.add(input.commandId)
      owned.commandId = input.commandId
      await this.revalidate(context.session.intent, context.session.effective)
      if (owned.session.effective.auth.accountId !== context.session.effective.auth.accountId)
        throw new Error("Session account changed")
    } catch {
      const current = this.sessions.get(context.session.id)
      if (reserved && current?.commandId === input.commandId) current.busy = false
      return receipt(
        "rejected",
        "Native turn was not dispatched: input, admission, account or configuration is invalid",
      )
    }
    try {
      const params = {
        threadId: owned.session.binding.nativeSessionId,
        clientUserMessageId: input.messageId,
        input: input.parts.flatMap((part) =>
          part.type === "text" ? [{ type: "text" as const, text: part.text, text_elements: [] }] : [],
        ),
        model: context.session.intent.selection.model.modelId,
        cwd: this.options.cwd,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy:
          context.session.intent.policy.filesystem === "read-only"
            ? { type: "readOnly", networkAccess: false }
            : {
                type: "workspaceWrite",
                writableRoots: [this.options.cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
        serviceTierForTurn: "default",
      } satisfies TurnStartParams
      owned.awaitingAck = true
      const result = await (await this.connect()).request("turn/start", params)
      if (!isRecord(result) || !isRecord(result.turn)) throw new Error("Invalid turn response")
      const id = nativeId(result.turn.id)
      owned.turnId = id
      owned.awaitingAck = false
      for (const event of owned.buffered.splice(0)) this.notification(event)
      return { ...receipt("dispatched"), nativeTurnId: id }
    } catch {
      // Dispatch may already have happened. The host journal owns reconciliation and must not replay this command.
      owned.busy = true
      owned.awaitingAck = false
      owned.buffered.length = 0
      return receipt("uncertain", "Native turn acknowledgement was lost or invalid; do not retry automatically")
    }
  }

  events(session: AgentSession): AsyncIterable<AgentEventDraft> {
    const owned = this.sessions.get(session.id)
    if (!owned || owned.session.binding.nativeSessionId !== session.binding.nativeSessionId)
      throw new Error("Unknown native session")
    return owned.stream
  }

  async interrupt(context: AdapterSessionContext): Promise<void> {
    const owned = this.owned(context)
    if (!owned.turnId) return
    await (
      await this.connect()
    ).request("turn/interrupt", {
      threadId: owned.session.binding.nativeSessionId,
      turnId: owned.turnId,
    } satisfies TurnInterruptParams)
  }

  async close(session: AgentSession): Promise<void> {
    const owned = this.sessions.get(session.id)
    if (!owned) return
    if (owned.session.binding.nativeSessionId !== session.binding.nativeSessionId)
      throw new Error("Session binding mismatch")
    if (owned.turnId)
      await this.interrupt({ session: owned.session, admissionId: "close", leaseGeneration: owned.leaseGeneration })
    try {
      await this.transport?.request("thread/unsubscribe", { threadId: owned.session.binding.nativeSessionId })
    } finally {
      owned.stream.finish()
      this.sessions.delete(session.id)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.transport?.close()
    for (const owned of this.sessions.values()) owned.stream.finish()
    this.sessions.clear()
  }

  private async connect(): Promise<StdioJsonRpc> {
    if (this.disposed) throw new Error("Codex adapter is closed")
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const options: StdioJsonRpcOptions = {
        command: [
          this.options.executable,
          "app-server",
          "--listen",
          "stdio://",
          ...Object.entries(isolatedConfiguration).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
        ],
        cwd: this.options.cwd,
        environment: this.options.environment,
        ...(this.options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.requestTimeoutMs }),
        ...(this.options.maxMessageBytes === undefined ? {} : { maxMessageBytes: this.options.maxMessageBytes }),
        onNotification: (message) => this.notification(message),
        onRequest: (message) => this.serverRequest(message),
        onClose: () => {
          this.disposed = true
          for (const owned of this.sessions.values()) owned.stream.finish()
        },
      }
      this.transport = this.options.transportFactory?.(options) ?? new StdioJsonRpc(options)
      const result = await this.transport.request("initialize", {
        clientInfo: { name: "harness", title: "Harness", version: this.version },
        capabilities: { experimentalApi: false, requestAttestation: false },
      } satisfies InitializeParams)
      if (
        !isRecord(result) ||
        typeof result.userAgent !== "string" ||
        !/^harness\/0\.153\.4(?:\s|$)/.test(result.userAgent)
      ) {
        await this.transport.close()
        throw new Error("Unsupported Codex version")
      }
      this.versionVerifiedAt = new Date().toISOString()
      this.transport.notify("initialized")
      return this.transport
    })()
    return this.connecting
  }

  private requireIntent(intent: SessionIntent): void {
    const selection = intent.selection
    const policy = intent.policy
    if (
      selection.runtimeId !== this.runtimeId ||
      selection.targetId !== this.options.target.id ||
      selection.model.providerId !== "openai" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(selection.model.modelId) ||
      selection.access.mode !== "subscription" ||
      selection.access.method !== "chatgpt-subscription" ||
      selection.access.overagePolicy !== "acknowledge-provider-settings" ||
      selection.fallback.automatic ||
      selection.extensions?.length
    )
      throw new Error("Only explicit subscription selection with acknowledged provider settings is supported")
    if (
      policy.approval !== "deny" ||
      policy.shell !== "sandboxed" ||
      policy.network !== "denied" ||
      policy.allowedMcpServers.length ||
      policy.requireEnforcedBoundary ||
      !["read-only", "workspace-write"].includes(policy.filesystem)
    )
      throw new Error("Unsupported native execution policy")
    if (intent.requiredCapabilities.some((capability) => this.capabilities()[capability]?.status !== "supported"))
      throw new Error("Required capability is unverified")
  }

  private async observe(): Promise<RuntimePreflight> {
    const transport = await this.connect()
    if (this.accountMode !== "chatgpt") throw new Error("Native account event conflicts with subscription")
    const epoch = this.accountEpoch
    const account = accountStatus(
      await transport.request("account/read", { refreshToken: false } satisfies GetAccountParams),
    )
    const result = await transport.request("config/read", {
      includeLayers: false,
      cwd: this.options.cwd,
    } satisfies ConfigReadParams)
    if (!isRecord(result) || !isRecord(result.config)) throw new Error("Unknown native configuration")
    requireConfiguration(result.config)
    const after = accountStatus(
      await transport.request("account/read", { refreshToken: false } satisfies GetAccountParams),
    )
    if (hash(account) !== hash(after) || epoch !== this.accountEpoch)
      throw new Error("Native account changed during observation")
    const checkedAt = new Date().toISOString()
    this.versionVerifiedAt = checkedAt
    const expiresAt = new Date(Date.now() + 30_000).toISOString()
    const evidence = { source: "native-status", observedAt: checkedAt, runtimeVersion: "0.153.4", expiresAt } as const
    return {
      auth: {
        runtimeId: this.runtimeId,
        targetId: this.options.target.id,
        status: "authenticated",
        mode: "subscription",
        method: "chatgpt-subscription",
        accountId: hash(account),
        plan: account.planType,
        evidence,
      },
      billing: { route: "subscription", providerId: "openai", providerOverage: "unknown", evidence },
      capabilities: this.capabilities(),
      enforcement: {
        mechanism: "native-enforcement",
        filesystem: false,
        shell: false,
        network: false,
        limitations: [
          "Sandbox settings are requested and checked, but OS enforcement is not attested.",
          "Account/configuration checks are observational; native billing cannot be atomically locked.",
          "Provider overage is unknown. Native account schema identifies email and plan, not workspace/account ID.",
        ],
      },
      checkedAt,
      expiresAt,
      configurationFingerprint: hash({
        config: result.config,
        cwd: resolve(this.options.cwd),
        environment: this.options.environment,
        account,
        epoch,
        protocol: "0.153.4",
      }),
    }
  }

  private async revalidate(intent: SessionIntent, admitted: RuntimePreflight): Promise<void> {
    this.requireIntent(intent)
    if (!Number.isFinite(Date.parse(admitted.expiresAt)) || Date.parse(admitted.expiresAt) <= Date.now())
      throw new Error("Admission expired")
    const current = await this.observe()
    if (
      current.configurationFingerprint !== admitted.configurationFingerprint ||
      current.auth.accountId !== admitted.auth.accountId ||
      admitted.auth.mode !== "subscription" ||
      admitted.billing.route !== "subscription" ||
      admitted.billing.providerId !== "openai"
    )
      throw new Error("Account or configuration changed after admission")
  }

  private async open(request: AdmittedSessionRequest, existingId?: string): Promise<AgentSession> {
    if (
      this.sessions.has(request.sessionId) ||
      !request.admissionId ||
      request.workspace.id !== request.intent.workspaceId ||
      request.workspace.targetId !== this.options.target.id ||
      !samePath(request.workspace.rootPath, this.options.cwd) ||
      request.lease.workspaceId !== request.workspace.id ||
      request.lease.targetId !== this.options.target.id ||
      !Number.isSafeInteger(request.lease.generation) ||
      request.lease.generation < 1 ||
      !Number.isFinite(Date.parse(request.lease.expiresAt)) ||
      Date.parse(request.lease.expiresAt) <= Date.now()
    )
      throw new Error("Invalid workspace or lease binding")
    await this.revalidate(request.intent, request.effective)
    const params = {
      model: request.intent.selection.model.modelId,
      modelProvider: "openai",
      cwd: this.options.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: request.intent.policy.filesystem,
      serviceTier: "default",
      config: {
        sandbox_workspace_write: {
          network_access: false,
          writable_roots: [],
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true,
        },
      },
    } satisfies ThreadStartParams
    const response = await (
      await this.connect()
    ).request(
      existingId ? "thread/resume" : "thread/start",
      existingId ? ({ ...params, threadId: existingId, excludeTurns: true } satisfies ThreadResumeParams) : params,
    )
    if (!isRecord(response) || !isRecord(response.thread)) throw new Error("Unknown thread response")
    const id = nativeId(response.thread.id)
    if (!isRecord(response.thread.status) || response.thread.status.type !== "idle") {
      await this.transport?.request("thread/unsubscribe", { threadId: id })
      throw new Error("Only an idle native thread may be adopted")
    }
    if (
      (existingId && existingId !== id) ||
      response.modelProvider !== "openai" ||
      response.model !== params.model ||
      typeof response.cwd !== "string" ||
      !samePath(response.cwd, this.options.cwd) ||
      response.approvalPolicy !== "never" ||
      response.approvalsReviewer !== "user" ||
      !isRecord(response.sandbox) ||
      response.sandbox.networkAccess !== false ||
      response.sandbox.type !== (params.sandbox === "read-only" ? "readOnly" : "workspaceWrite")
    )
      throw new Error("Native effective thread settings differ from admission")
    if (
      response.sandbox.type === "workspaceWrite" &&
      (!Array.isArray(response.sandbox.writableRoots) ||
        response.sandbox.writableRoots.some((root) => typeof root !== "string" || !samePath(root, this.options.cwd)) ||
        response.sandbox.excludeTmpdirEnvVar !== true ||
        response.sandbox.excludeSlashTmp !== true)
    )
      throw new Error("Native writable roots exceed requested workspace")
    const session: AgentSession = {
      id: request.sessionId,
      workspaceId: request.workspace.id,
      intent: structuredClone(request.intent),
      binding: {
        runtimeId: this.runtimeId,
        adapterId: this.id,
        targetId: this.options.target.id,
        nativeSessionId: id,
        nativeProtocolVersion: "0.153.4",
      },
      effective: structuredClone(request.effective),
      status: "idle",
      createdAt: new Date().toISOString(),
      revision: 1,
    }
    this.sessions.set(session.id, {
      session: structuredClone(session),
      leaseGeneration: request.lease.generation,
      stream: new EventStream(),
      busy: false,
      seenCommands: new Set(),
      awaitingAck: false,
      buffered: [],
    })
    return session
  }

  private owned(context: AdapterSessionContext): OwnedSession {
    const owned = this.sessions.get(context.session.id)
    if (
      !owned ||
      !context.admissionId ||
      owned.leaseGeneration !== context.leaseGeneration ||
      hash(owned.session.binding) !== hash(context.session.binding) ||
      hash(owned.session.intent) !== hash(context.session.intent) ||
      owned.session.workspaceId !== context.session.workspaceId
    )
      throw new Error("Invalid adapter session binding")
    return owned
  }

  private notification(message: NativeNotification): void {
    if (
      message.method === "account/updated" ||
      message.method === "account/login/completed" ||
      message.method.startsWith("config/")
    ) {
      if (message.method === "account/updated")
        this.accountMode = isRecord(message.params) ? message.params.authMode : null
      this.accountEpoch++
      for (const owned of this.sessions.values())
        if (owned.turnId)
          void this.transport
            ?.request("turn/interrupt", { threadId: owned.session.binding.nativeSessionId, turnId: owned.turnId })
            .catch(() => undefined)
      return
    }
    if (message.method.startsWith("account/")) return
    const params = message.params
    if (!isRecord(params)) return
    const owned = [...this.sessions.values()].find((item) => item.session.binding.nativeSessionId === params.threadId)
    if (!owned) return
    if (owned.awaitingAck) {
      if (
        owned.buffered.length >= 128 ||
        Buffer.byteLength(JSON.stringify(owned.buffered)) + Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024
      )
        throw new Error("Native pre-ack event backlog exceeded")
      owned.buffered.push(message)
      return
    }
    const eventTurnId = isRecord(params.turn)
      ? nativeId(params.turn.id)
      : typeof params.turnId === "string"
        ? nativeId(params.turnId)
        : undefined
    if (eventTurnId !== undefined && (eventTurnId !== owned.turnId || !owned.busy)) {
      this.emit(
        owned,
        message,
        { type: "native.event", data: { namespace: "codex", nativeType: safeMethod(message.method) } },
        eventTurnId,
        false,
      )
      return
    }
    if ((message.method === "turn/started" || message.method === "turn/completed") && isRecord(params.turn)) {
      const id = nativeId(params.turn.id)
      if (message.method === "turn/started") {
        this.emit(owned, message, { type: "agent.started", data: { nativeTurnId: id } }, id)
        return
      }
      if (owned.completedTurnId === id) return
      if (!["completed", "failed", "interrupted"].includes(String(params.turn.status)))
        throw new Error("Unknown terminal turn status")
      if (params.turn.status === "failed")
        this.emit(
          owned,
          message,
          {
            type: "agent.error",
            data: {
              error: { code: "native-error", message: "Codex reported a failed turn", retryable: false },
              nativeTurnId: id,
            },
          },
          id,
        )
      this.emit(
        owned,
        message,
        {
          type: "agent.completed",
          data: {
            nativeTurnId: id,
            outcome:
              params.turn.status === "completed"
                ? "succeeded"
                : params.turn.status === "interrupted"
                  ? "interrupted"
                  : "failed",
          },
        },
        id,
      )
      owned.completedTurnId = id
      delete owned.turnId
      owned.busy = false
      return
    }
    const turnId = typeof params.turnId === "string" ? nativeId(params.turnId) : undefined
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const id = nativeId(params.itemId)
      this.emit(
        owned,
        message,
        { type: "assistant.text.delta", data: { messageId: id, partId: id, delta: params.delta } },
        turnId,
      )
      return
    }
    if (
      message.method === "item/completed" &&
      isRecord(params.item) &&
      params.item.type === "agentMessage" &&
      typeof params.item.text === "string"
    ) {
      const id = nativeId(params.item.id)
      this.emit(
        owned,
        message,
        { type: "assistant.text.completed", data: { messageId: id, partId: id, text: params.item.text } },
        turnId,
      )
      return
    }
    this.emit(
      owned,
      message,
      { type: "native.event", data: { namespace: "codex", nativeType: safeMethod(message.method) } },
      turnId,
    )
  }

  private serverRequest(message: NativeRequest): NativeReply {
    // Never retain authentication exchanges, external tokens, command bodies or unknown request payloads.
    if (message.method.startsWith("account/"))
      return { error: { code: -32601, message: "External authentication is unsupported" } }
    if (isRecord(message.params)) {
      const params = message.params
      const owned = [...this.sessions.values()].find((item) => item.session.binding.nativeSessionId === params.threadId)
      if (owned)
        this.emit(
          owned,
          { method: message.method, params: { ...params, requestId: message.id } },
          { type: "native.event", data: { namespace: "codex", nativeType: safeMethod(message.method) } },
          typeof params.turnId === "string" ? nativeId(params.turnId) : undefined,
        )
    }
    if (message.method === "item/commandExecution/requestApproval")
      return { result: { decision: "decline" } satisfies CommandExecutionRequestApprovalResponse }
    if (message.method === "item/fileChange/requestApproval")
      return { result: { decision: "decline" } satisfies FileChangeRequestApprovalResponse }
    if (message.method === "item/permissions/requestApproval")
      return { result: { permissions: {}, scope: "turn" } satisfies PermissionsRequestApprovalResponse }
    if (message.method === "mcpServer/elicitation/request")
      return { result: { action: "decline", content: null, _meta: null } satisfies McpServerElicitationRequestResponse }
    if (message.method === "applyPatchApproval" || message.method === "execCommandApproval")
      return { result: { decision: "abort" } }
    return { error: { code: -32601, message: "Native request is unsupported and was not approved" } }
  }

  private emit(
    owned: OwnedSession,
    message: NativeNotification,
    payload: AgentEventPayload,
    turnId?: string,
    correlate = true,
  ): void {
    const native: Record<string, JsonValue> = {}
    if (isRecord(message.params)) {
      for (const key of ["threadId", "turnId", "itemId", "approvalId", "requestId"]) {
        const value = message.params[key]
        if (typeof value === "number" && Number.isSafeInteger(value)) native[key] = value
        if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) native[key] = value
      }
      if (isRecord(message.params.item) && typeof message.params.item.id === "string")
        native.itemId = nativeId(message.params.item.id)
    }
    const event: AgentEventDraft = {
      ...payload,
      observedAt: new Date().toISOString(),
      origin: {
        streamId: owned.stream.id,
        epoch: owned.stream.id,
        eventId: randomUUID(),
        identityStrategy: "adapter-assigned",
      },
      scope: {
        targetId: this.options.target.id,
        runtimeId: this.runtimeId,
        workspaceId: owned.session.workspaceId,
        sessionId: owned.session.id,
        ...(turnId ? { turnId } : {}),
        ...(correlate && turnId === owned.turnId && owned.commandId ? { commandId: owned.commandId } : {}),
      },
      native: {
        namespace: "codex",
        nativeType: safeMethod(message.method),
        nativeVersion: "0.153.4",
        redaction: "sanitized",
        storage: "inline",
        payload: native,
      },
    }
    if (!owned.stream.push(event)) {
      owned.stream.fail({
        ...event,
        type: "stream.gap",
        data: { sourceStreamId: owned.stream.id, reason: "Native event backlog exceeded; native process was stopped" },
      })
      void this.transport?.close()
      throw new Error("Native event consumer exceeded bounded backlog")
    }
  }
}

function requireEnvironment(environment: Readonly<Record<string, string>>): void {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ])
  const entries = Object.entries(environment).map(
    ([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value] as const,
  )
  const keys = entries.map(([key]) => key)
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !allowed.has(key)) ||
    !keys.includes("PATH") ||
    (!keys.includes("HOME") && !keys.includes("USERPROFILE"))
  )
    throw new Error("Codex requires a compiled explicit OS environment without provider overrides")
  const normalized = Object.fromEntries(entries)
  if (
    !normalized.PATH?.split(delimiter).every(absolute) ||
    entries.some(
      ([key, value]) =>
        value.includes("\0") ||
        (["HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].includes(key) && !absolute(value)),
    )
  )
    throw new Error("Native environment paths must be fully absolute")
  if (
    process.platform === "win32" &&
    normalized.HOME &&
    normalized.USERPROFILE &&
    !samePath(normalized.HOME, normalized.USERPROFILE)
  )
    throw new Error("Conflicting native home directories")
}

function absolute(value: string): boolean {
  return (
    !!value &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    (process.platform !== "win32" || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value))
  )
}

function requireConfiguration(config: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries(isolatedConfiguration)) {
    const actual = key.split(".").reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), config)
    if (actual !== expected) throw new Error("Native extension isolation settings could not be verified")
  }
  if (isRecord(config.shell_environment_policy) && enabled(config.shell_environment_policy.set))
    throw new Error("Native shell environment injects unverified values")
  if (config.model_provider !== null && config.model_provider !== "openai") throw new Error("Unknown native provider")
  if (
    config.forced_login_method !== undefined &&
    config.forced_login_method !== null &&
    config.forced_login_method !== "chatgpt"
  )
    throw new Error("Native login override conflicts with subscription")
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined || value === false || value === "") continue
    if (
      (key === "cli_auth_credentials_store" || key === "mcp_oauth_credentials_store") &&
      typeof value === "string" &&
      ["file", "keyring", "auto", "ephemeral"].includes(value)
    )
      continue
    if (
      /api.?key|base.?url|api.?base|endpoint|bearer|credential|auth.?helper|profile|model_providers|chatgpt_base_url|access_token|refresh_token/i.test(
        key,
      )
    ) {
      if (isRecord(value) && !Object.keys(value).length) continue
      throw new Error("Native configuration contains an unverified billing override")
    }
    if (
      (key === "skills" &&
        isRecord(value) &&
        Object.entries(value).some(
          ([item, setting]) => !["include_instructions", "bundled"].includes(item) && enabled(setting),
        )) ||
      (key === "agents" &&
        isRecord(value) &&
        Object.entries(value).some(([item, setting]) => item !== "enabled" && enabled(setting)))
    )
      throw new Error("Native configuration contains unverified skill or agent settings")
    if (/^(mcp_servers|hooks|plugins|apps|notify)$/i.test(key) && enabled(value))
      throw new Error("Native configuration enables unverified extensions")
  }
}

function enabled(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false
  if (isRecord(value)) return Object.values(value).some(enabled)
  if (Array.isArray(value)) return value.some(enabled)
  return true
}

function accountStatus(value: unknown): { type: "chatgpt"; email: string; planType: string } {
  if (
    !isRecord(value) ||
    value.requiresOpenaiAuth !== true ||
    !isRecord(value.account) ||
    value.account.type !== "chatgpt" ||
    typeof value.account.email !== "string" ||
    !value.account.email ||
    value.account.email.length > 320 ||
    typeof value.account.planType !== "string" ||
    !["plus", "pro", "prolite", "team", "business", "enterprise", "edu", "edu_plus", "edu_pro"].includes(
      value.account.planType,
    )
  )
    throw new Error("Managed subscription account could not be verified")
  return { type: "chatgpt", email: value.account.email, planType: value.account.planType }
}

function nativeId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value))
    throw new Error("Invalid native identifier")
  return value
}

function safeMethod(value: string): string {
  return /^[A-Za-z0-9/_.-]{1,160}$/.test(value) ? value : "unknown"
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        isRecord(item)
          ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
          : item,
      ),
    )
    .digest("hex")
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

class EventStream implements AsyncIterable<AgentEventDraft> {
  readonly id = randomUUID()
  private readonly queue: { event: AgentEventDraft; bytes: number }[] = []
  private bytes = 0
  private ended = false
  private subscribed = false
  private wake: (() => void) | undefined
  push(event: AgentEventDraft): boolean {
    if (this.ended) return false
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.queue.length >= 1024 || this.bytes + bytes > 4 * 1024 * 1024) {
      this.finish()
      return false
    }
    this.queue.push({ event, bytes })
    this.bytes += bytes
    this.wake?.()
    return true
  }
  finish(): void {
    this.ended = true
    this.wake?.()
  }
  fail(event: AgentEventDraft): void {
    this.queue.length = 0
    this.bytes = 0
    this.queue.push({ event, bytes: 0 })
    this.finish()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEventDraft> {
    if (this.subscribed) throw new Error("Native events support one durable consumer")
    this.subscribed = true
    while (true) {
      const next = this.queue.shift()
      if (next) {
        this.bytes -= next.bytes
        yield next.event
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
