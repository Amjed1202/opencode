import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { CodexAdapter } from "@harness/adapters/codex"
import { ClaudeAdapter } from "@harness/adapters/claude"
import type { AgentAdapter } from "@harness/adapters"
import type { AgentEvent, AgentSession, RuntimeDescriptor, SessionIntent } from "@harness/protocol"
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
  private adapter: NativeAdapter | undefined
  private descriptor: RuntimeDescriptor | undefined
  private manager: LocalRuntimeManager | undefined
  private admission: AdmissionController | undefined
  private session?: AgentSession
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
    notices: [],
  }

  private constructor(
    private readonly options: BackendOptions,
    private readonly artifacts: EncryptedArtifactStore,
  ) {
    this.workspaces.reservePrivateRoot(options.directory)
    this.journal = new SQLiteJournal(join(options.directory, "journal.sqlite"))
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
        if (this.session) throw new Error("Restart before changing an attached session's runtime")
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
    if (this.session) throw new Error("Restart the desktop before changing an attached session's configuration")
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
    this.adapter = claude
      ? (this.options.claudeAdapterFactory ?? ((options) => new ClaudeAdapter(options)))(options)
      : (this.options.adapterFactory ?? ((options) => new CodexAdapter(options)))(options)
    try {
      this.descriptor = (await this.adapter.discover({ target, allowedExecutablePaths: [config.executable] }))[0]
      if (!this.descriptor) throw new Error("Pinned native runtime is unavailable")
      const observed = await this.adapter.status?.(this.descriptor)
      if (!observed) throw new Error("Native status is unsupported")
      const auth = observed.auth
      this.state = {
        ...this.state,
        connection: {
          status:
            !claude &&
            auth.status === "authenticated" &&
            auth.mode === "subscription" &&
            observed.billing.route === "subscription"
              ? "ready"
              : "blocked",
          runtimeName,
          ...(this.descriptor.version ? { runtimeVersion: this.descriptor.version } : {}),
          authentication: claude
            ? auth.status === "authenticated"
              ? "authenticated"
              : auth.status === "unauthenticated"
                ? "unauthenticated"
                : "unknown"
            : auth.mode === "subscription" && auth.status === "authenticated"
              ? "subscription"
              : "unknown",
          billing: observed.billing.route === "subscription" ? "subscription" : "unknown",
          providerOverage: "unknown",
          reason: claude
            ? "Claude connection checks are available. Execution and native Skills activation are blocked until effective billing, managed settings and permission policy can be verified before dispatch."
            : "The billing route and native policy are checked again when starting a session.",
        },
      }
    } catch {
      this.state = {
        ...this.state,
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
    if (this.state.configuration.runtime === "claude" || !this.adapter?.models || !this.descriptor) {
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
          model.providerId !== "openai" ||
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
    return {
      workspaceId: this.state.configuration.workspace!.id,
      mode: "chat",
      requiredCapabilities: ["chat", "streaming"],
      selection: {
        runtimeId: this.descriptor!.id,
        targetId: "local",
        model: { providerId: "openai", modelId: input.modelId },
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
        filesystem: input.allowFileChanges ? "workspace-write" : "read-only",
        shell: "sandboxed",
        network: "denied",
        allowedMcpServers: [],
        approval: input.allowFileChanges ? "ask" : "deny",
        requireEnforcedBoundary: false,
      },
    }
  }

  private async start(input: StartSessionInput) {
    if (this.state.configuration.runtime === "claude")
      throw new Error("Claude execution is unavailable until billing and native policy verification are implemented")
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
    const intent = this.intent(input)
    if (this.state.models.status !== "ready" || !this.state.models.items.some((model) => model.id === input.modelId))
      throw new Error("Choose a model from the current native catalog")
    // A displayed choice can disappear or change accounts before Start is pressed.
    // Recheck listing before the separate billing/policy admission and native thread creation.
    await this.loadModels()
    await this.publish()
    if (this.state.models.status !== "ready" || !this.state.models.items.some((model) => model.id === input.modelId))
      throw new Error("The selected model is no longer available; check the connection and choose again")
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
    const ready = await this.admission.preflight({ operation: "create", intent })
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
      this.session = await this.manager.createSession(ready.admissionId, randomUUID())
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

  private async follow(sessionId: string, signal: AbortSignal) {
    try {
      for await (const delivery of this.manager!.events(sessionId, undefined, signal)) {
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
    if (event.type === "assistant.text.delta" || event.type === "assistant.text.completed") {
      const existing = this.state.messages.find((message) => message.id === event.data.messageId)
      const text =
        event.type === "assistant.text.completed" ? event.data.text : (existing?.text ?? "") + event.data.delta
      this.state = {
        ...this.state,
        messages: existing
          ? this.state.messages.map((message) => (message.id === existing.id ? { ...message, text } : message))
          : [...this.state.messages, { id: event.data.messageId, role: "assistant", text }],
      }
    }
    if (event.type !== "assistant.text.delta")
      this.state = {
        ...this.state,
        activity: [...this.state.activity, { id: event.id, kind: event.type, label: event.type }].slice(-100),
      }
  }

  private async snapshot(): Promise<DesktopState> {
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
