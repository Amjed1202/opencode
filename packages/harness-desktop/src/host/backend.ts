import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { CodexAdapter } from "@harness/adapters/codex"
import { ClaudeAdapter } from "@harness/adapters/claude"
import type { AgentAdapter } from "@harness/adapters"
import type { AgentEvent, AgentSession, RuntimeDescriptor, SessionIntent, EventCursor } from "@harness/protocol"
import {
  AdmissionController,
  EncryptedArtifactStore,
  LocalRuntimeManager,
  LocalWorkspaceRegistry,
  SQLiteJournal,
  buildNativeEnvironment,
  discoverClaudeSkills,
} from "@harness/control-plane/host"
import type {
  ChoiceReplyInput,
  DesktopConfiguration,
  DesktopOperation,
  DesktopState,
  PermissionReplyInput,
  StartSessionInput,
} from "../shared/contracts"
import { decodeDesktopRequest } from "../shared/requests"
import { DesktopConversations } from "./conversations"
import { WorkspaceFiles } from "./workspace-files"

type NativeAdapter = AgentAdapter & { dispose(): Promise<void> }
export interface BackendOptions {
  readonly directory: string
  readonly key: Uint8Array
  readonly environment: Readonly<Record<string, string>>
  readonly toolPath: string
  readonly changed: (state: DesktopState) => void
  readonly adapterFactory?: (options: ConstructorParameters<typeof CodexAdapter>[0]) => NativeAdapter
  readonly claudeAdapterFactory?: (options: ConstructorParameters<typeof ClaudeAdapter>[0]) => NativeAdapter
}

/** Privileged Bun child. One session at a time; no native thread or turn before explicit start/send requests. */
export class DesktopBackend {
  private readonly workspaces = new LocalWorkspaceRegistry({ leaseMilliseconds: 60 * 60 * 1000 })
  private readonly journal: SQLiteJournal
  private readonly conversations: DesktopConversations
  private files: WorkspaceFiles | undefined
  private readonly stoppedOwners = new Set<string>()
  private readonly nativeOwners = new Set<string>()
  private adapter: NativeAdapter | undefined
  private descriptor: RuntimeDescriptor | undefined
  private manager: LocalRuntimeManager | undefined
  private admission: AdmissionController | undefined
  private session: AgentSession | undefined
  private eventAbort: AbortController | undefined
  private eventTask: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private state: DesktopState = {
    revision: 0,
    configuration: {},
    connection: {
      status: "not-configured",
      runtimeName: "Codex",
      authentication: "unknown",
      billing: "unknown",
      providerOverage: "unknown",
    },
    messages: [],
    activity: [],
    permissions: [],
    inputs: [],
    skills: null,
    models: { status: "not-loaded", items: [] },
    runtimeFeatures: { resume: false, inspection: false },
    notices: [],
  }

  private constructor(
    private readonly options: BackendOptions,
    private readonly artifacts: EncryptedArtifactStore,
  ) {
    this.workspaces.reservePrivateRoot(options.directory)
    this.journal = new SQLiteJournal(join(options.directory, "journal.sqlite"))
    this.conversations = new DesktopConversations(this.journal)
  }

  static async open(options: BackendOptions) {
    const directory = await realpath(options.directory)
    if (directory !== options.directory) throw new Error("Application storage must be canonical")
    for (const name of ["journal.sqlite", "journal.sqlite-wal", "journal.sqlite-shm", "journal.sqlite-journal"]) {
      const path = join(directory, name)
      const identity = await lstat(path).catch((error) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (identity && (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1))
        throw new Error("Unsafe journal storage")
    }
    await mkdir(join(directory, "artifacts"), { recursive: true, mode: 0o700 })
    const artifacts = await EncryptedArtifactStore.open({ rootPath: join(directory, "artifacts"), key: options.key })
    let backend: DesktopBackend | undefined
    try {
      backend = new DesktopBackend(options, artifacts)
      await backend.journal.recoverPending()
      await backend.journal.recoverActiveSessions()
      await backend.journal.recoverPermissions()
      await backend.journal.recoverInputs()
      return backend
    } catch (error) {
      try {
        backend?.journal.close()
      } finally {
        artifacts.close()
      }
      throw error
    }
  }

  dispatch(operation: DesktopOperation, raw?: unknown): Promise<unknown> {
    const input = decodeDesktopRequest(operation, raw)
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error("Desktop host is closed")
      if (operation === "shutdown") {
        await this.close()
        return null
      }
      if (operation === "getState") return this.snapshot()
      if (operation === "selectRuntime") {
        if (this.session) throw new Error("Close the attached conversation before changing its runtime")
        if ((this.state.configuration.runtime ?? "codex") === input.runtime) return this.publish()
        const previous = this.state.configuration
        return this.configure({
          runtime: input.runtime as "codex" | "claude",
          ...(previous.workspace ? { workspace: previous.workspace } : {}),
          ...(previous.userSkillsRoot ? { userSkillsRoot: previous.userSkillsRoot } : {}),
        })
      }
      if (operation === "configure") return this.configure(input as DesktopConfiguration)
      if (operation === "refresh") return this.refresh()
      if (operation === "listFiles") {
        if (!this.files) throw new Error("Choose a repository first")
        return this.files.list()
      }
      if (operation === "previewFile") {
        if (!this.files) throw new Error("Choose a repository first")
        return this.files.preview(input.fileId as string)
      }
      if (operation === "detachConversation") return this.detachConversation()
      if (operation === "viewConversation") return this.viewConversation(input.sessionId as string)
      if (operation === "inspectConversation" || operation === "reconcileConversation") {
        if (this.session) throw new Error("Detach the conversation before native inspection")
        if (!this.state.runtimeFeatures?.inspection)
          throw new Error("This runtime cannot verify uncertain native history")
        this.prepareManager()
        const id = input.sessionId as string
        if (operation === "reconcileConversation") {
          if (this.state.inspection?.sessionId !== id)
            throw new Error("Inspect this conversation before reconciliation")
          const reconciled = await this.conversations.reconcile(
            this.manager!,
            id,
            this.state.configuration,
            this.descriptor!.id,
          )
          if (reconciled.status === "idle" && this.stoppedOwners.has(id)) {
            await this.workspaces.releaseStoppedOwner(reconciled.workspaceId, id)
            this.stoppedOwners.delete(id)
          }
        }
        const inspection = await this.conversations.inspect(
          this.manager!,
          id,
          this.state.configuration,
          this.descriptor!.id,
        )
        this.state = { ...this.state, inspection }
        return this.publish()
      }
      if (operation === "resumeConversation") return this.resumeConversation(input)
      if (operation === "start") return this.start(input as unknown as StartSessionInput)
      if (operation === "send") return this.send(input.text as string)
      if (operation === "interrupt") {
        if (!this.session || !this.manager) throw new Error("No attached session")
        await this.manager.interrupt(this.session.id, randomUUID())
        return this.publish()
      }
      if (!this.session || !this.manager) throw new Error("No attached session")
      if (operation === "review")
        return input.kind === "permission"
          ? this.manager.reviewPermission(input.requestId as string)
          : this.manager.reviewInput(input.requestId as string)
      if (operation === "resolvePermission") {
        const value = input as unknown as PermissionReplyInput
        const record = await this.journal.permission(value.requestId)
        if (!record || record.request.sessionId !== this.session.id) throw new Error("Unknown session permission")
        await this.manager.resolvePermission({ ...record.request, ...value })
      } else if (operation === "resolveInput") {
        const value = input as unknown as ChoiceReplyInput
        const record = await this.journal.input(value.requestId)
        if (!record || record.request.sessionId !== this.session.id) throw new Error("Unknown session question")
        await this.manager.resolveInput({ ...record.request, ...value })
      }
      return this.publish()
    })
    this.queue = task.catch(() => undefined)
    return task
  }

  private async configure(configuration: DesktopConfiguration) {
    if (this.session) throw new Error("Detach the conversation before changing its configuration")
    await this.detach()
    let selected = configuration
    let recovery = false
    if (configuration.workspace) {
      const path = await realpath(configuration.workspace.path)
      const id = createHash("sha256")
        .update(process.platform === "win32" ? path.toLowerCase() : path)
        .digest("hex")
      selected = { ...configuration, workspace: { ...configuration.workspace, id, path } }
      await this.workspaces.register({ id, projectId: id, targetId: "local", rootPath: path, kind: "repository" })
      recovery = await this.needsRecovery(id)
    }
    this.state = {
      ...this.state,
      configuration: structuredClone(selected),
      runtimeFeatures: { resume: false, inspection: false },
      history: undefined,
      inspection: undefined,
      usage: undefined,
      context: undefined,
      messages: [],
      activity: [],
      connection: {
        runtimeName: selected.runtime === "claude" ? "Claude Code" : "Codex",
        status: "not-checked",
        authentication: "unknown",
        billing: "unknown",
        providerOverage: "unknown",
      },
      skills: null,
      models: { status: selected.runtime === "claude" ? "unsupported" : "not-loaded", items: [] },
      notices: recovery
        ? ["Previous native work needs native inspection. Automatic recovery and new sessions are blocked."]
        : [],
    }
    this.files = selected.workspace ? new WorkspaceFiles(selected.workspace.path) : undefined
    await this.scanSkills()
    return this.publish()
  }

  private async scanSkills() {
    const config = this.state.configuration
    if (!config.workspace) return
    const workspace = await this.workspaces.get(config.workspace.id)
    if (!workspace) return
    const skills = await discoverClaudeSkills({
      workspace,
      ...(config.userSkillsRoot ? { userSkillsRoot: config.userSkillsRoot } : {}),
    })
    this.state = { ...this.state, skills }
  }

  private async refresh() {
    if (this.session) {
      await this.scanSkills()
      return this.publish()
    }
    const config = this.state.configuration
    if (!config.workspace || !config.executable || !config.nativeHome)
      throw new Error("Choose a repository, native runtime executable and account home")
    await this.detach()
    this.state = {
      ...this.state,
      models: { status: config.runtime === "claude" ? "unsupported" : "not-loaded", items: [] },
    }
    const target = { id: "local", kind: "local" as const, name: "This computer" }
    const claude = config.runtime === "claude"
    const runtimeName = claude ? "Claude Code" : "Codex"
    const options = {
      executable: config.executable,
      cwd: claude ? this.options.directory : config.workspace.path,
      target,
      environment: buildNativeEnvironment({
        inherited: this.options.environment,
        home: config.nativeHome,
        path: this.options.toolPath,
      }),
    }
    const workspace = await this.workspaces.get(config.workspace.id)
    if (!workspace) throw new Error("Selected repository is no longer registered")
    const claudeOptions = {
      ...options,
      workspace,
      skillSources: [
        { root: join(workspace.rootPath, ".claude", "skills"), scope: "workspace" as const },
        ...(config.userSkillsRoot ? [{ root: config.userSkillsRoot, scope: "user" as const }] : []),
      ],
    }
    this.adapter = claude
      ? (this.options.claudeAdapterFactory ?? ((options) => new ClaudeAdapter(options)))(claudeOptions)
      : (this.options.adapterFactory ?? ((options) => new CodexAdapter(options)))(options)
    try {
      this.descriptor = (await this.adapter.discover({ target, allowedExecutablePaths: [config.executable] }))[0]
      if (!this.descriptor) throw new Error("Pinned native runtime is unavailable")
      const observed = await this.adapter.status?.(this.descriptor)
      if (!observed) throw new Error("Native status is unsupported")
      const auth = observed.auth
      this.state = {
        ...this.state,
        runtimeFeatures: {
          resume:
            observed.capabilities["session-resume"]?.status === "supported" &&
            typeof this.adapter.resume === "function",
          inspection: typeof this.adapter.inspect === "function",
        },
        connection: {
          status:
            auth.status === "authenticated" &&
            auth.mode === "subscription" &&
            observed.billing.route === "subscription" &&
            observed.capabilities.chat?.status === "supported"
              ? "ready"
              : "blocked",
          runtimeName,
          ...(this.descriptor.version ? { runtimeVersion: this.descriptor.version } : {}),
          authentication:
            auth.mode === "subscription" && auth.status === "authenticated"
              ? "subscription"
              : auth.status === "authenticated" && claude
                ? "authenticated"
                : auth.status === "unauthenticated" && claude
                  ? "unauthenticated"
                  : "unknown",
          billing: observed.billing.route === "subscription" ? "subscription" : "unknown",
          providerOverage: "unknown",
          reason: claude
            ? auth.mode === "subscription" && observed.capabilities.chat?.status === "supported"
              ? "Claude uses the observed native subscription. Shell and network tools are disabled; file changes require review."
              : "Claude connection checks are available. Execution is blocked until subscription and native policy checks succeed."
            : "The billing route and native policy are checked again when starting a session.",
        },
      }
    } catch {
      this.state = {
        ...this.state,
        runtimeFeatures: { resume: false, inspection: false },
        connection: {
          status: "blocked",
          runtimeName,
          authentication: "unknown",
          billing: "unknown",
          providerOverage: "unknown",
          reason: "Could not verify the pinned native runtime and account status. Check your native setup.",
        },
      }
    }
    if (this.state.connection.status === "ready") await this.loadModels()
    await this.scanSkills()
    return this.publish()
  }

  private async loadModels() {
    if (!this.adapter?.models || !this.descriptor) {
      this.state = { ...this.state, models: { status: "unsupported", items: [] } }
      return
    }
    try {
      const models = await this.adapter.models(this.descriptor)
      if (!Array.isArray(models) || models.length === 0 || models.length > 256) throw new Error("Invalid model list")
      const ids = new Set<string>()
      const items = models.map((model) => {
        if (
          !model ||
          model.providerId !== (this.state.configuration.runtime === "claude" ? "anthropic" : "openai") ||
          typeof model.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.id) ||
          ids.has(model.id) ||
          typeof model.name !== "string" ||
          !model.name.length ||
          model.name.trim() !== model.name ||
          model.name.length > 256 ||
          /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(model.name)
        )
          throw new Error("Invalid model list")
        ids.add(model.id)
        return { id: model.id, name: model.name }
      })
      if (Buffer.byteLength(JSON.stringify(items)) > 128 * 1024 || this.closed)
        throw new Error("Model list is unavailable")
      this.state = { ...this.state, models: { status: "ready", items, checkedAt: new Date().toISOString() } }
    } catch {
      this.state = { ...this.state, models: { status: "unavailable", items: [] } }
    }
  }

  private intent(input: StartSessionInput): SessionIntent {
    if (!input.acknowledgeOverage || !input.acknowledgeUnverifiedBoundary)
      throw new Error("Review the native billing and isolation conditions before starting")
    const claude = this.state.configuration.runtime === "claude"
    if (!claude && input.skills?.length) throw new Error("Claude Skills require Claude Code")
    const skills = input.skills?.map((selected) => {
      const skill = this.state.skills?.skills.find(
        (skill) => skill.id === selected.skillId && skill.sha256 === selected.sha256,
      )
      if (!skill || skill.workspaceId !== this.state.configuration.workspace!.id)
        throw new Error("Selected skill changed; refresh Skills and choose again")
      return {
        ...selected,
        workspaceId: skill.workspaceId,
        runtimeId: this.descriptor!.id,
        targetId: "local",
        policyId: "desktop-local",
        policyVersion: "1",
      }
    })
    return {
      workspaceId: this.state.configuration.workspace!.id,
      mode: "chat",
      requiredCapabilities: ["chat", "streaming"],
      ...(skills?.length ? { skills } : {}),
      selection: {
        runtimeId: this.descriptor!.id,
        targetId: "local",
        model: { providerId: claude ? "anthropic" : "openai", modelId: input.modelId },
        access: {
          mode: "subscription",
          method: claude ? "claude-code-subscription" : "chatgpt-subscription",
          billing: "subscription",
          overagePolicy: "acknowledge-provider-settings",
        },
        fallback: { automatic: false },
      },
      policy: {
        id: "desktop-local",
        version: "1",
        filesystem: input.allowFileChanges ? "workspace-write" : "read-only",
        shell: claude ? "disabled" : "sandboxed",
        network: "denied",
        allowedMcpServers: [],
        approval: input.allowFileChanges ? "ask" : "deny",
        requireEnforcedBoundary: false,
      },
    }
  }

  private async start(input: StartSessionInput) {
    if (this.session) throw new Error("A session is already attached")
    if (
      !this.adapter ||
      !this.descriptor ||
      this.state.connection.status !== "ready" ||
      !this.state.configuration.workspace
    )
      throw new Error("Check the native connection first")
    if (await this.needsRecovery(this.state.configuration.workspace.id))
      throw new Error("Previous work needs native inspection before a new session can start")
    await this.scanSkills()
    const intent = this.intent(input)
    if (this.state.models.status !== "ready" || !this.state.models.items.some((model) => model.id === input.modelId))
      throw new Error("Choose a model from the current native catalog")
    // A displayed choice can disappear or change accounts before Start is pressed.
    // Recheck listing before the separate billing/policy admission and native thread creation.
    await this.loadModels()
    await this.publish()
    if (this.state.models.status !== "ready" || !this.state.models.items.some((model) => model.id === input.modelId))
      throw new Error("The selected model is no longer available; check the connection and choose again")
    this.prepareManager()
    const ready = await this.admission!.preflight({ operation: "create", intent })
    if (ready.status !== "ready") {
      this.state = {
        ...this.state,
        connection: {
          ...this.state.connection,
          status: "blocked",
          reason: "Native account, provider configuration, billing or execution policy could not be verified.",
        },
      }
      await this.publish()
      throw new Error("Session admission was blocked; check native account and configuration")
    }
    try {
      await this.files?.begin()
      this.session = await this.manager!.createSession(ready.admissionId, randomUUID())
      this.nativeOwners.add(this.session.id)
      await this.conversations.bind(this.session.id, this.state.configuration)
    } catch {
      this.state = {
        ...this.state,
        connection: { ...this.state.connection, status: "blocked" },
        notices: ["Native session creation is uncertain. Inspect the native runtime before starting more work."],
      }
      await this.publish()
      throw new Error("Native session creation is uncertain; automatic retry is disabled")
    }
    this.state = {
      ...this.state,
      connection: { ...this.state.connection, billing: "subscription" },
      messages: [],
      activity: [],
      history: undefined,
      inspection: undefined,
      usage: undefined,
      context: undefined,
      notices: [],
    }
    const signal = new AbortController()
    this.eventAbort = signal
    this.eventTask = this.follow(this.session.id, signal.signal)
    return this.publish()
  }

  private async send(text: string) {
    if (!this.session || !this.manager || !this.admission) throw new Error("Start a session first")
    const ready = await this.admission.preflight({
      operation: "turn",
      sessionId: this.session.id,
      intent: this.session.intent,
    })
    if (ready.status !== "ready") throw new Error("Current account, billing or session policy blocked this message")
    const id = randomUUID()
    await this.conversations.recordUser(this.session.id, { commandId: id, messageId: id, text })
    this.state = { ...this.state, messages: [...this.state.messages, { id, role: "user", text }] }
    const receipt = await this.manager.send(this.session.id, ready.admissionId, {
      commandId: id,
      messageId: id,
      delivery: "when-idle",
      parts: [{ type: "text", text }],
    })
    if (receipt.state === "uncertain")
      this.state = {
        ...this.state,
        notices: ["The native reply is uncertain. This message will not be sent again automatically."],
      }
    return this.publish()
  }

  private async follow(sessionId: string, signal: AbortSignal, cursor?: EventCursor) {
    try {
      for await (const delivery of this.manager!.events(sessionId, cursor, signal)) {
        if (delivery.kind !== "event") {
          this.state = {
            ...this.state,
            notices: ["Some activity is unavailable. Inspect native state before continuing."],
          }
          continue
        }
        this.project(delivery.event)
        await this.publish()
      }
      if (!signal.aborted && !this.closed) {
        this.state = { ...this.state, notices: ["The native stream detached. Automatic replay is disabled."] }
        await this.publish()
      }
    } catch {
      if (!this.closed) {
        this.state = {
          ...this.state,
          notices: ["The native stream could not continue. Inspect native state before restarting."],
        }
        await this.publish()
      }
    }
  }

  private project(event: AgentEvent) {
    if (event.type === "usage.updated") this.state = { ...this.state, usage: event.data }
    if (event.type === "context.updated") this.state = { ...this.state, context: event.data }
    if (event.type === "assistant.text.delta" || event.type === "assistant.text.completed") {
      const existing = this.state.messages.find(
        (message) => message.role === "assistant" && message.id === event.data.messageId,
      )
      const text =
        event.type === "assistant.text.completed" ? event.data.text : (existing?.text ?? "") + event.data.delta
      this.state = {
        ...this.state,
        messages: existing
          ? this.state.messages.map((message) =>
              message.role === "assistant" && message.id === existing.id ? { ...message, text } : message,
            )
          : [...this.state.messages, { id: event.data.messageId, role: "assistant", text }],
      }
    }
    if (event.type !== "assistant.text.delta")
      this.state = {
        ...this.state,
        activity: [
          ...this.state.activity,
          {
            id: event.id,
            kind: event.type,
            label:
              event.type === "tool.started"
                ? `Started ${event.data.name}`
                : event.type === "tool.completed"
                  ? `Tool ${event.data.outcome}`
                  : event.type,
          },
        ].slice(-100),
      }
  }

  private async snapshot(): Promise<DesktopState> {
    const conversations = await this.conversations.list(this.state.configuration)
    this.state = { ...this.state, conversations }
    if (this.session) {
      const [current, permissions, inputs] = await Promise.all([
        this.journal.get(this.session.id),
        this.journal.pendingPermissions(this.session.id),
        this.journal.pendingInputs(this.session.id),
      ])
      if (current) this.session = current
      this.state = {
        ...this.state,
        session: {
          id: this.session.id,
          status: this.session.status,
          modelId: this.session.intent.selection.model.modelId,
        },
        permissions: permissions.map((record) => record.request),
        inputs: inputs.map((record) => record.request),
      }
    }
    this.state = boundedSnapshot(this.state)
    return structuredClone(this.state)
  }

  private async publish() {
    await this.snapshot()
    // Preserve deltas projected while journal reads were in flight instead of restoring an earlier clone.
    this.state = { ...boundedSnapshot(this.state), revision: this.state.revision + 1 }
    const result = structuredClone(this.state)
    this.options.changed(result)
    return result
  }

  private async detach() {
    this.eventAbort?.abort()
    // Manager cleanup can fail after native EOF. Always stop the owning adapter before clearing its reference.
    await this.manager?.dispose().catch(() => {
      this.state = {
        ...this.state,
        notices: ["Native cleanup was incomplete. Uncertain work remains blocked until inspection."],
      }
    })
    try {
      await this.adapter?.dispose()
      for (const id of this.nativeOwners) {
        if ((await this.journal.get(id))?.status === "uncertain") this.stoppedOwners.add(id)
        else this.stoppedOwners.delete(id)
      }
      this.nativeOwners.clear()
    } finally {
      await this.eventTask
    }
    this.manager = undefined
    this.admission = undefined
    this.adapter = undefined
    this.descriptor = undefined
    this.eventAbort = undefined
    this.eventTask = undefined
  }

  private prepareManager() {
    if (!this.adapter || !this.descriptor || this.state.connection.status !== "ready")
      throw new Error("Check the native connection first")
    if (this.manager && this.admission) return
    const runtime = () =>
      this.adapter && this.descriptor ? { adapter: this.adapter, descriptor: this.descriptor } : undefined
    this.admission = new AdmissionController({
      runtime,
      session: (id) => this.journal.get(id),
      workspaces: this.workspaces,
    })
    this.manager = new LocalRuntimeManager({
      admission: this.admission,
      journal: this.journal,
      runtime,
      workspaces: this.workspaces,
      artifacts: this.artifacts,
      actorId: "desktop:local-user",
    })
  }

  private async viewConversation(id: string) {
    if (this.session) throw new Error("Detach the conversation before opening history")
    const workspace = this.state.configuration.workspace
    if (!workspace) throw new Error("Choose a repository first")
    const preview = await this.conversations.hydrate(id, workspace.id)
    this.files = new WorkspaceFiles(workspace.path)
    this.state = {
      ...this.state,
      messages: preview.messages,
      activity: preview.activity,
      usage: undefined,
      context: undefined,
      inspection: undefined,
      history: { id, partial: true, unconfirmedMessages: preview.unconfirmedMessages },
      notices: [
        "Local history is a partial preview. Opening it does not resume native work.",
        ...(preview.truncated ? ["Older history was omitted by the local preview limit."] : []),
        ...(preview.unconfirmedMessages
          ? ["Some attempted messages have no confirmed native outcome. They will not be resent."]
          : []),
      ],
    }
    return this.publish()
  }

  private async resumeConversation(input: Record<string, unknown>) {
    if (this.session) throw new Error("Detach the conversation before resuming another")
    if (!this.state.runtimeFeatures?.resume) throw new Error("This runtime cannot resume saved conversations")
    if (!input.acknowledgeOverage || !input.acknowledgeUnverifiedBoundary)
      throw new Error("Review billing and isolation conditions before resuming")
    this.prepareManager()
    const saved = await this.conversations.requireSession(
      input.sessionId as string,
      this.state.configuration,
      this.descriptor!.id,
    )
    if (["uncertain", "running", "awaiting-permission", "awaiting-input"].includes(saved.status))
      throw new Error("Inspect and reconcile native work before resuming")
    await this.loadModels()
    await this.publish()
    if (
      this.state.models.status !== "ready" ||
      !this.state.models.items.some((model) => model.id === saved.intent.selection.model.modelId)
    )
      throw new Error("The original model is no longer offered by the native runtime")
    const ready = await this.admission!.preflight({ operation: "resume", sessionId: saved.id, intent: saved.intent })
    if (ready.status !== "ready") throw new Error("Native account, billing or policy blocked resume")
    const preview = await this.conversations.hydrate(saved.id, saved.workspaceId)
    this.stoppedOwners.delete(saved.id)
    this.nativeOwners.add(saved.id)
    this.session = await this.manager!.resumeSession(saved.id, ready.admissionId, randomUUID())
    // Resume cannot reconstruct a session-start file baseline after process restart.
    this.files = new WorkspaceFiles(this.state.configuration.workspace!.path)
    this.state = {
      ...this.state,
      messages: preview.messages,
      activity: preview.activity,
      history: { id: saved.id, partial: true, unconfirmedMessages: preview.unconfirmedMessages },
      inspection: undefined,
      usage: undefined,
      context: undefined,
      notices: [
        "Resumed the native conversation. Prior local history is partial; no messages were resent.",
        ...(preview.truncated ? ["Older history was omitted by the local preview limit."] : []),
      ],
    }
    const signal = new AbortController()
    this.eventAbort = signal
    this.eventTask = this.follow(saved.id, signal.signal, preview.cursor)
    return this.publish()
  }

  private async detachConversation() {
    let uncertain = false
    if (this.session && this.manager) {
      try {
        await this.manager.closeSession(this.session.id)
      } catch {
        uncertain = true
        const current = await this.journal.get(this.session.id)
        if (current && current.status !== "uncertain")
          await this.journal.save({ ...current, status: "uncertain", revision: current.revision + 1 }, current.revision)
      }
    }
    await this.detach()
    this.session = undefined
    this.files = this.state.configuration.workspace
      ? new WorkspaceFiles(this.state.configuration.workspace.path)
      : undefined
    this.state = {
      ...this.state,
      session: undefined,
      history: undefined,
      inspection: undefined,
      usage: undefined,
      context: undefined,
      messages: [],
      activity: [],
      permissions: [],
      inputs: [],
      connection: { ...this.state.connection, status: "not-checked" },
      runtimeFeatures: { resume: false, inspection: false },
      models: { status: "not-loaded", items: [] },
      notices: uncertain
        ? [
            "Native close was incomplete. The owning adapter was stopped; inspect and reconcile the saved conversation before continuing.",
          ]
        : [],
    }
    return this.publish()
  }

  private async needsRecovery(workspaceId: string) {
    return (
      (await this.journal.hasUnsettledWork(workspaceId)) ||
      (await this.journal.list(workspaceId)).some((session) => session.status === "uncertain")
    )
  }

  async close() {
    if (this.closed) return
    this.closed = true
    try {
      await this.detach()
    } finally {
      this.journal.close()
      this.artifacts.close()
    }
  }
}

/** Leave room for the private IPC envelope beneath its 4 MiB wire ceiling. Never truncate authority objects. */
function boundedSnapshot(state: DesktopState): DesktopState {
  let truncated = false
  const shortened = state.messages.map((message) => {
    if (Buffer.byteLength(JSON.stringify(message)) <= 256 * 1024) return message
    let low = 0
    let high = message.text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify({ ...message, text: message.text.slice(0, middle) })) <= 256 * 1024)
        low = middle
      else high = middle - 1
    }
    truncated = true
    return { ...message, text: message.text.slice(0, low).replace(/[\ud800-\udbff]$/, "") }
  })
  const messages = boundedItems(shortened, 512 * 1024, true)
  const permissions = boundedItems(state.permissions, 1024 * 1024)
  const inputs = boundedItems(state.inputs, 256 * 1024)
  const skills = state.skills ? boundedItems(state.skills.skills, 512 * 1024) : undefined
  truncated ||= messages.truncated || permissions.truncated || inputs.truncated || Boolean(skills?.truncated)
  return {
    ...state,
    messages: messages.items,
    permissions: permissions.items,
    inputs: inputs.items,
    skills:
      state.skills && skills
        ? {
            ...state.skills,
            skills: skills.items,
            ...(skills.truncated
              ? {
                  roots: state.skills.roots.map((root) =>
                    root.status === "scanned" ? { ...root, status: "limit-reached" as const } : root,
                  ),
                  diagnostics: [
                    ...state.skills.diagnostics,
                    { scope: "workspace" as const, code: "limit-reached" as const },
                  ],
                }
              : {}),
          }
        : null,
    notices: truncated
      ? [
          ...new Set([
            ...state.notices,
            "The desktop preview was truncated to its display limit. Native work and pending decisions were not replayed.",
          ]),
        ].slice(-4)
      : state.notices,
  }
}

function boundedItems<T>(values: readonly T[], maxBytes: number, recent = false) {
  const items: T[] = []
  let bytes = 2
  for (const item of recent ? values.toReversed() : values) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1
    if (bytes + size > maxBytes) continue
    items.push(item)
    bytes += size
  }
  return { items: recent ? items.reverse() : items, truncated: items.length !== values.length }
}
