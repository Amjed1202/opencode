import { randomUUID } from "node:crypto"
import type { AgentAdapter } from "@harness/adapters"
import type {
  AdmittedSessionRequest,
  AdapterPreflightRequest,
  AgentSession,
  Evidence,
  PreflightRequest,
  PreflightResult,
  ProtocolError,
  RuntimeDescriptor,
  RuntimePreflight,
  SessionIntent,
  WorkspaceDescriptor,
  WorkspaceLease,
} from "@harness/protocol"
import type { AdmissionService } from "./index"
import { hashConfiguration } from "./environment"

export class AdmissionError extends Error {
  constructor(readonly error: ProtocolError) {
    super(error.message)
    this.name = "AdmissionError"
  }
}

function fail(code: ProtocolError["code"], message: string): never {
  throw new AdmissionError({ code, message, retryable: false })
}

export interface ScopedBillingConsent {
  readonly id: string
  readonly workspaceId: string
  readonly runtimeId: string
  readonly targetId: string
  readonly providerId: string
  readonly billing: "api-payg" | "provider-specific"
  readonly expiresAt: string
}

export interface AdmissionWorkspaces {
  get(id: string): Promise<WorkspaceDescriptor | undefined>
  lease(workspaceId: string, ownerId: string, mode: "read" | "write"): Promise<WorkspaceLease>
  valid(lease: WorkspaceLease): Promise<boolean>
  /** Synchronous ownership/expiry check after other asynchronous authorization checks. */
  current(lease: WorkspaceLease): boolean
  release(id: string, generation: number): Promise<void>
}

export interface AdmissionOptions {
  readonly runtime: (
    runtimeId: string,
    targetId: string,
  ) => { descriptor: RuntimeDescriptor; adapter: AgentAdapter } | undefined
  readonly session: (id: string) => Promise<AgentSession | undefined>
  readonly workspaces: AdmissionWorkspaces
  /** Trusted host consent store, never a renderer-provided object. */
  readonly consent?: (id: string) => Promise<ScopedBillingConsent | undefined>
  readonly capacity?: (
    runtime: RuntimeDescriptor,
    effective: RuntimePreflight,
  ) => Promise<"available" | "exhausted" | "unknown">
  readonly now?: () => number
  readonly lifetimeMilliseconds?: number
  readonly maxAdmissions?: number
}

interface AdmissionRecord {
  readonly request: PreflightRequest
  readonly effective: RuntimePreflight
  readonly workspace: WorkspaceDescriptor
  readonly expires: number
  readonly runtimeFingerprint: string
  readonly adapter: AgentAdapter
  readonly epoch: number
  readonly sessionRevision?: number
  sessionId?: string
  command?: { id: string; digest: string }
  revoked: boolean
}

/** In-memory admission tokens intentionally do not survive a host restart. */
export class AdmissionController implements AdmissionService {
  private readonly records = new Map<string, AdmissionRecord>()
  private readonly now: () => number
  private readonly lifetime: number
  private readonly maxAdmissions: number
  private readonly epochs = new Map<string, number>()
  private pending = 0

  constructor(private readonly options: AdmissionOptions) {
    this.now = options.now ?? Date.now
    this.lifetime = options.lifetimeMilliseconds ?? 60_000
    this.maxAdmissions = options.maxAdmissions ?? 1024
    if (!Number.isFinite(this.lifetime) || this.lifetime <= 0) throw new Error("Invalid admission lifetime")
    if (!Number.isSafeInteger(this.maxAdmissions) || this.maxAdmissions <= 0) throw new Error("Invalid admission limit")
  }

  async preflight(input: PreflightRequest): Promise<PreflightResult> {
    try {
      hashConfiguration(input)
      const request = structuredClone(input)
      if (JSON.stringify(request).length > 65_536) fail("invalid-input", "Admission intent is too large")
      for (const [id, record] of this.records)
        if (record.revoked || record.expires <= this.now()) this.records.delete(id)
      if (this.records.size + this.pending >= this.maxAdmissions)
        fail("capacity-limited", "Too many outstanding admissions")
      const epoch = this.epochs.get(request.intent.selection.runtimeId) ?? 0
      this.pending += 1
      try {
        const state = await this.check(request)
        if (epoch !== (this.epochs.get(request.intent.selection.runtimeId) ?? 0))
          fail("permission-denied", "Runtime changed during admission")
        const admissionId = randomUUID()
        this.records.set(admissionId, {
          request,
          effective: state.effective,
          workspace: state.workspace,
          expires: Math.min(
            this.now() + this.lifetime,
            Date.parse(state.effective.expiresAt),
            state.consent ? Date.parse(state.consent.expiresAt) : Infinity,
          ),
          runtimeFingerprint: state.runtimeFingerprint,
          adapter: state.adapter,
          epoch,
          ...(state.session ? { sessionId: state.session.id, sessionRevision: state.session.revision } : {}),
          revoked: false,
        })
        return { status: "ready", admissionId, effective: structuredClone(state.effective) }
      } finally {
        this.pending -= 1
      }
    } catch (error) {
      return {
        status: "blocked",
        errors: [
          error instanceof AdmissionError
            ? error.error
            : { code: "unavailable", message: "Runtime preflight could not be verified", retryable: true },
        ],
      }
    }
  }

  async require(
    admissionId: string,
    sessionId: string,
    operation: "create" | "resume" | "turn",
  ): Promise<AdmittedSessionRequest> {
    const record = this.record(admissionId)
    if (!sessionId || record.request.operation !== operation || (record.sessionId && record.sessionId !== sessionId))
      fail("permission-denied", "Admission binding mismatch")
    // Bind before awaiting so concurrent callers cannot reuse a create token for different sessions.
    record.sessionId = sessionId
    const current = await this.check(record.request)
    if (
      current.session?.revision !== record.sessionRevision ||
      JSON.stringify(current.workspace) !== JSON.stringify(record.workspace)
    )
      fail("workspace-conflict", "Admitted session or workspace changed")
    if (this.identity(current.effective) !== this.identity(record.effective))
      fail("billing-conflict", "Effective runtime account, configuration or policy changed")
    if (current.adapter !== record.adapter || current.runtimeFingerprint !== record.runtimeFingerprint)
      fail("unavailable", "Admitted runtime changed")
    this.record(admissionId)
    const lease = await this.options.workspaces.lease(
      record.workspace.id,
      sessionId,
      record.request.intent.policy.filesystem === "read-only" ? "read" : "write",
    )
    const admitted = structuredClone({
      operation,
      admissionId,
      sessionId,
      intent: record.request.intent,
      workspace: record.workspace,
      lease,
      effective: current.effective,
    })
    await this.validate(admitted)
    return admitted
  }

  /** Call again after durable dispatch bookkeeping, immediately before the native adapter call. */
  async validate(request: AdmittedSessionRequest): Promise<void> {
    const admitted = structuredClone(request)
    const record = this.record(admitted.admissionId)
    if (
      record.sessionId !== admitted.sessionId ||
      record.request.operation !== admitted.operation ||
      hashConfiguration(record.request.intent) !== hashConfiguration(admitted.intent) ||
      hashConfiguration(record.workspace) !== hashConfiguration(admitted.workspace) ||
      this.identity(record.effective) !== this.identity(admitted.effective)
    )
      fail("permission-denied", "Admission binding mismatch")
    if (
      admitted.lease.ownerId !== admitted.sessionId ||
      admitted.lease.workspaceId !== admitted.workspace.id ||
      admitted.lease.targetId !== admitted.workspace.targetId ||
      admitted.lease.mode !== (admitted.intent.policy.filesystem === "read-only" ? "read" : "write")
    )
      fail("workspace-conflict", "Workspace lease binding mismatch")
    if (!(await this.options.workspaces.valid(admitted.lease)))
      fail("workspace-conflict", "Workspace lease is no longer valid")
    const consent = await this.checkConsent(record.request.intent)
    this.record(admitted.admissionId)
    if (!this.options.workspaces.current(admitted.lease))
      fail("workspace-conflict", "Workspace lease is no longer valid")
    if (consent && !(Date.parse(consent.expiresAt) > this.now()))
      fail("billing-conflict", "Billing consent expired during admission")
    const runtime = this.options.runtime(admitted.intent.selection.runtimeId, admitted.intent.selection.targetId)
    if (
      !runtime ||
      runtime.adapter !== record.adapter ||
      this.runtimeFingerprint(runtime.descriptor, runtime.adapter) !== record.runtimeFingerprint
    )
      fail("unavailable", "Admitted runtime changed")
    this.checkEffective(record.request.intent, admitted.effective, runtime.descriptor.version)
  }

  /** Capture authority for an in-flight native permission without extending command admission. */
  permissionGuard(request: AdmittedSessionRequest): () => Promise<() => void> {
    const admitted = structuredClone(request)
    const record = this.record(admitted.admissionId)
    if (
      record.sessionId !== admitted.sessionId ||
      hashConfiguration(record.request.intent) !== hashConfiguration(admitted.intent) ||
      this.identity(record.effective) !== this.identity(admitted.effective)
    )
      fail("permission-denied", "Permission admission binding mismatch")
    // A pending native operation may outlive its admission token. Retain its revocation epoch,
    // runtime identity and immutable intent, then require fresh evidence for each grant.
    return async () => {
      const validEpoch = () => {
        if (record.revoked || record.epoch !== (this.epochs.get(admitted.intent.selection.runtimeId) ?? 0))
          fail("permission-denied", "Permission admission was revoked")
      }
      validEpoch()
      const current = await this.check({ operation: "resume", sessionId: admitted.sessionId, intent: admitted.intent })
      if (
        current.adapter !== record.adapter ||
        current.runtimeFingerprint !== record.runtimeFingerprint ||
        this.identity(current.effective) !== this.identity(record.effective) ||
        hashConfiguration(current.workspace) !== hashConfiguration(record.workspace)
      )
        fail("permission-denied", "Permission runtime, account, configuration or workspace changed")
      if (!(await this.options.workspaces.valid(admitted.lease))) fail("workspace-conflict", "Permission lease expired")
      const final = () => {
        validEpoch()
        this.checkEffective(admitted.intent, current.effective)
        const runtime = this.options.runtime(admitted.intent.selection.runtimeId, admitted.intent.selection.targetId)
        if (
          !runtime ||
          runtime.adapter !== record.adapter ||
          this.runtimeFingerprint(runtime.descriptor, runtime.adapter) !== record.runtimeFingerprint
        )
          fail("unavailable", "Permission runtime changed")
        if (current.consent && Date.parse(current.consent.expiresAt) <= this.now())
          fail("billing-conflict", "Permission consent expired")
        if (!this.options.workspaces.current(admitted.lease)) fail("workspace-conflict", "Permission lease expired")
      }
      final()
      return final
    }
  }

  /** One admitted intent permits one exact command payload, including its idempotency key. */
  bindCommand(admissionId: string, commandId: string, requestSha256: string): void {
    const record = this.record(admissionId)
    if (
      typeof commandId !== "string" ||
      !commandId ||
      commandId.length > 256 ||
      typeof requestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(requestSha256)
    )
      fail("invalid-input", "Invalid command identity")
    if (record.command && (record.command.id !== commandId || record.command.digest !== requestSha256))
      fail("permission-denied", "Admission is already bound to another command")
    record.command = { id: commandId, digest: requestSha256 }
  }

  async invalidate(runtimeId: string, _reason: string): Promise<void> {
    this.epochs.set(runtimeId, (this.epochs.get(runtimeId) ?? 0) + 1)
    for (const record of this.records.values())
      if (record.request.intent.selection.runtimeId === runtimeId) record.revoked = true
  }

  private record(id: string): AdmissionRecord {
    const record = this.records.get(id)
    if (
      !record ||
      record.revoked ||
      record.expires <= this.now() ||
      record.epoch !== (this.epochs.get(record.request.intent.selection.runtimeId) ?? 0)
    )
      fail("permission-denied", "Admission expired or was revoked")
    return record
  }

  private fresh(evidence: Evidence | undefined): boolean {
    if (
      !evidence ||
      !["native-status", "native-event", "provider-report", "local-observation"].includes(evidence.source)
    )
      return false
    const observed = Date.parse(evidence.observedAt)
    return (
      Number.isFinite(observed) &&
      observed <= this.now() &&
      observed >= this.now() - this.lifetime &&
      (evidence.expiresAt === undefined || Date.parse(evidence.expiresAt) > this.now())
    )
  }

  private identity(effective: RuntimePreflight): string {
    // Exclude timestamps; include all security-relevant observations and native configuration identity.
    const { evidence: _authEvidence, ...auth } = effective.auth
    const { evidence: _billingEvidence, ...billing } = effective.billing
    return hashConfiguration({
      auth,
      billing,
      enforcement: effective.enforcement,
      configurationFingerprint: effective.configurationFingerprint,
    })
  }

  private async check(request: PreflightRequest) {
    const intent = request.intent
    const selection = intent.selection
    if (
      !intent.workspaceId ||
      !selection.runtimeId ||
      !selection.targetId ||
      !selection.model.modelId ||
      !selection.model.providerId ||
      !intent.policy.id ||
      !intent.policy.version
    )
      fail("invalid-input", "Incomplete runtime intent")
    if (
      !["create", "resume", "turn"].includes(request.operation) ||
      !["chat", "code", "plan", "collaborate"].includes(intent.mode) ||
      !["read-only", "workspace-write"].includes(intent.policy.filesystem) ||
      !["disabled", "mediated", "sandboxed"].includes(intent.policy.shell) ||
      !["denied", "restricted", "native-policy"].includes(intent.policy.network) ||
      !["ask", "deny"].includes(intent.policy.approval) ||
      typeof intent.policy.requireEnforcedBoundary !== "boolean"
    )
      fail("invalid-input", "Invalid execution policy")
    const access = selection.access
    if (!["subscription", "api", "local", "provider-specific"].includes(access.mode) || !access.method?.trim())
      fail("invalid-input", "Invalid runtime access")
    const routes = {
      subscription: "subscription",
      api: "api-payg",
      local: "local",
      "provider-specific": "provider-specific",
    }
    if (access.billing !== routes[access.mode]) fail("billing-conflict", "Authentication and billing intent conflict")
    if (
      access.mode === "subscription" &&
      (!["require-disabled", "acknowledge-provider-settings"].includes(access.overagePolicy) ||
        !(
          ["chatgpt-subscription", "claude-code-subscription"].includes(access.method) ||
          /^provider:.+/.test(access.method)
        ))
    )
      fail("invalid-input", "Invalid subscription intent")
    if (selection.fallback.automatic !== false) fail("unsupported", "Automatic API fallback is not implemented")
    const runtime = this.options.runtime(selection.runtimeId, selection.targetId)
    if (
      !runtime ||
      runtime.descriptor.id !== selection.runtimeId ||
      runtime.descriptor.target.id !== selection.targetId ||
      runtime.descriptor.adapterId !== runtime.adapter.id
    )
      fail("unavailable", "Runtime is unavailable on this target")
    if (
      !["conditional", "supported"].includes(runtime.descriptor.integration) ||
      !runtime.descriptor.providers.some((provider) => provider.id === selection.model.providerId)
    )
      fail("unsupported", "Runtime or provider is unsupported")
    if (
      !runtime.descriptor.authModes.includes(selection.access.mode) ||
      !runtime.descriptor.billingModes.includes(selection.access.billing) ||
      (runtime.descriptor.kind === "api" && selection.access.mode !== "api") ||
      (runtime.descriptor.kind === "local-model" && selection.access.mode !== "local")
    )
      fail("unsupported", "Runtime access mode is unsupported")
    if (
      (selection.access.method === "chatgpt-subscription" && selection.model.providerId !== "openai") ||
      (selection.access.method === "claude-code-subscription" && selection.model.providerId !== "anthropic")
    )
      fail("billing-conflict", "Subscription provider does not match authentication")
    const runtimeFingerprint = this.runtimeFingerprint(runtime.descriptor, runtime.adapter)
    const workspace = structuredClone(await this.options.workspaces.get(intent.workspaceId))
    if (!workspace || workspace.targetId !== selection.targetId) fail("workspace-conflict", "Workspace target mismatch")
    const session =
      request.operation === "create" ? undefined : structuredClone(await this.options.session(request.sessionId))
    if (request.operation !== "create") {
      if (
        !session ||
        session.workspaceId !== intent.workspaceId ||
        session.binding.runtimeId !== selection.runtimeId ||
        session.binding.targetId !== selection.targetId ||
        session.binding.adapterId !== runtime.adapter.id
      )
        fail("permission-denied", "Session binding mismatch")
      if (JSON.stringify(session.intent) !== JSON.stringify(intent))
        fail("permission-denied", "Session intent changes require a new session")
      if (request.operation === "turn" && !["idle", "interrupted"].includes(session.status))
        fail("unavailable", "Session is not ready for a new turn")
    }
    await this.checkConsent(intent)
    const adapterRequest: AdapterPreflightRequest =
      session && request.operation !== "create"
        ? { operation: request.operation, existingSession: session, intent }
        : { operation: "create", intent }
    const result = await runtime.adapter.preflight(structuredClone(adapterRequest))
    if (result.status === "blocked")
      throw new AdmissionError(
        result.errors[0] ?? { code: "unavailable", message: "Native runtime blocked admission", retryable: false },
      )
    const effective = structuredClone(result.effective)
    this.checkEffective(intent, effective, runtime.descriptor.version)
    if (
      (await this.options.capacity?.(structuredClone(runtime.descriptor), structuredClone(effective))) === "exhausted"
    )
      fail("capacity-limited", "Native runtime capacity is exhausted")
    const consent = await this.checkConsent(intent)
    this.checkEffective(intent, effective, runtime.descriptor.version)
    const current = this.options.runtime(selection.runtimeId, selection.targetId)
    if (
      !current ||
      current.adapter !== runtime.adapter ||
      this.runtimeFingerprint(current.descriptor, current.adapter) !== runtimeFingerprint
    )
      fail("unavailable", "Runtime changed during admission")
    return { effective, workspace, session, consent, runtimeFingerprint, adapter: runtime.adapter }
  }

  private checkEffective(intent: SessionIntent, effective: RuntimePreflight, runtimeVersion?: string): void {
    const selection = intent.selection
    const checked = Date.parse(effective.checkedAt)
    if (
      !Number.isFinite(checked) ||
      checked > this.now() ||
      checked < this.now() - this.lifetime ||
      !(Date.parse(effective.expiresAt) > this.now()) ||
      !effective.configurationFingerprint
    )
      fail("auth-required", "Runtime evidence is stale or invalid")
    if (
      effective.auth.runtimeId !== selection.runtimeId ||
      effective.auth.targetId !== selection.targetId ||
      effective.auth.status !== "authenticated" ||
      effective.auth.mode !== selection.access.mode ||
      effective.auth.method !== selection.access.method ||
      !this.fresh(effective.auth.evidence)
    )
      fail("auth-required", "Native authentication does not match the requested mode")
    if (
      runtimeVersion !== undefined &&
      [
        effective.auth.evidence,
        effective.billing.evidence,
        ...Object.values(effective.capabilities).flatMap((support) =>
          support.status === "supported" ? [support.evidence] : [],
        ),
      ].some((evidence) => evidence?.runtimeVersion !== undefined && evidence.runtimeVersion !== runtimeVersion)
    )
      fail("auth-required", "Native evidence belongs to another runtime version")
    if (
      selection.access.mode === "subscription" &&
      (!effective.auth.accountId?.trim() ||
        !["native-status", "native-event", "provider-report"].includes(effective.auth.evidence?.source ?? ""))
    )
      fail("auth-required", "Native subscription account identity is unavailable")
    if (
      effective.billing.route === "unknown" ||
      effective.billing.route !== selection.access.billing ||
      effective.billing.providerId !== selection.model.providerId ||
      !this.fresh(effective.billing.evidence)
    )
      fail("billing-conflict", "Billing route could not be verified")
    if (
      selection.access.mode === "subscription" &&
      selection.access.overagePolicy === "require-disabled" &&
      effective.billing.providerOverage !== "disabled"
    )
      fail("billing-conflict", "Provider overage settings are not verified disabled")
    for (const capability of intent.requiredCapabilities) {
      const support = effective.capabilities[capability]
      if (support?.status !== "supported" || support.verification !== "verified" || !this.fresh(support.evidence))
        fail("unsupported", `Required capability is unverified: ${capability}`)
    }
    const boundary = effective.enforcement
    if (
      (intent.policy.requireEnforcedBoundary || intent.requiredCapabilities.includes("review-mode")) &&
      (!["os-sandbox", "native-enforcement", "mediated-tools"].includes(boundary.mechanism) ||
        boundary.filesystem !== true ||
        boundary.shell !== true ||
        boundary.network !== true)
    )
      fail("permission-denied", "Requested isolation cannot be enforced")
  }

  private runtimeFingerprint(descriptor: RuntimeDescriptor, adapter: AgentAdapter): string {
    return hashConfiguration({
      id: descriptor.id,
      adapterId: descriptor.adapterId,
      adapterVersion: adapter.version,
      kind: descriptor.kind,
      target: descriptor.target,
      providers: descriptor.providers,
      authModes: descriptor.authModes,
      billingModes: descriptor.billingModes,
      integration: descriptor.integration,
      version: descriptor.version ?? null,
      executable: descriptor.executable ?? null,
      nativeProtocolVersion: descriptor.nativeProtocolVersion ?? null,
    })
  }

  private async checkConsent(intent: SessionIntent): Promise<ScopedBillingConsent | undefined> {
    const { selection } = intent
    const access = selection.access
    if (access.mode !== "api" && access.mode !== "provider-specific") return
    const consent = await this.options.consent?.(access.consentId)
    if (
      !consent ||
      consent.id !== access.consentId ||
      consent.workspaceId !== intent.workspaceId ||
      consent.runtimeId !== selection.runtimeId ||
      consent.targetId !== selection.targetId ||
      consent.providerId !== selection.model.providerId ||
      consent.billing !== access.billing ||
      !(Date.parse(consent.expiresAt) > this.now())
    )
      fail("billing-conflict", "Explicit scoped billing consent is required")
    return structuredClone(consent)
  }
}
