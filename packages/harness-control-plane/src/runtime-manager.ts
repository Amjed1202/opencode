import { randomUUID } from "node:crypto"
import { isAbsolute, relative } from "node:path"
import type { AgentAdapter } from "@harness/adapters"
import type {
  AdmittedSessionRequest,
  AgentEventDraft,
  AgentInput,
  AgentSession,
  CommandReceipt,
  EventCursor,
  EventDelivery,
  NativeSessionInspection,
  PermissionBinding,
  PermissionDecision,
  PermissionResolution,
  PermissionRequest,
  HumanInputRequest,
  HumanInputResponse,
  HumanInputResolution,
  InteractionReview,
} from "@harness/protocol"
import type { CommandRecord } from "./index"
import type { AdmissionController, AdmissionOptions, AdmissionWorkspaces } from "./admission"
import { hashConfiguration } from "./environment"
import type { SQLiteJournal } from "./journal"
import type { EncryptedArtifactStore } from "./artifacts"
import { validateReviewContent } from "./review-content"

export interface RuntimeManagerOptions {
  readonly admission: AdmissionController
  readonly journal: SQLiteJournal
  readonly runtime: AdmissionOptions["runtime"]
  readonly workspaces: AdmissionWorkspaces
  /** Authenticated host identity; never populated from a renderer request. Grants require it. */
  readonly actorId?: string
  readonly now?: () => number
  /** Host-owned encrypted storage outside registered workspaces; absent storage disables grants/answers. */
  readonly artifacts?: EncryptedArtifactStore
}

interface ReviewProof {
  readonly kind: "permission" | "input"
  readonly request: PermissionBinding
  readonly artifactSha256: string
  readonly actorId: string
  readonly expiresAt: number
}

interface Pump {
  task: Promise<void>
  readonly stop: () => void
  stopping: boolean
}

/**
 * Privileged single-host coordinator. No renderer transport or automatic restart/replay is exposed.
 * Uncertain native operations keep their workspace leases even after detach. The host must shut
 * down the owning adapter/process and reconcile native state before releasing that ownership.
 */
export class LocalRuntimeManager {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly active = new Map<string, AdmittedSessionRequest>()
  private readonly pumps = new Map<string, Pump>()
  private readonly activeTurns = new Map<string, string>()
  private readonly permissionGuards = new Map<string, () => Promise<() => void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly pumpTasks = new Set<Promise<void>>()
  private readonly versions = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly reviews = new Map<string, ReviewProof>()
  private disposed = false
  private recovering = false
  private disposal?: Promise<void>

  constructor(private readonly options: RuntimeManagerOptions) {
    if (options.artifacts) options.workspaces.reservePrivateRoot(options.artifacts.rootPath)
  }

  async createSession(admissionId: string, commandId: string): Promise<AgentSession> {
    return this.operation(() =>
      this.serial(`command:${commandId}`, async () => {
        this.assertOpen()
        const digest = this.digest({ operation: "create", admissionId, commandId })
        const existing = await this.existing(commandId, digest)
        if (existing) return this.savedResult(existing)
        const request = await this.options.admission.require(admissionId, randomUUID(), "create")
        this.options.admission.bindCommand(admissionId, commandId, digest)
        const adapter = this.adapter(request.intent.selection.runtimeId, request.intent.selection.targetId)
        const record = this.record(request, commandId, digest)
        const reservation = await this.options.journal.reserve(record)
        if (!reservation.created) return this.savedResult(reservation.record)
        this.active.set(request.sessionId, request)
        try {
          await this.dispatch(record, request)
          await this.options.admission.validate(request)
          this.assertOpen()
          const native = structuredClone(await adapter.createSession(structuredClone(request)))
          this.validateSession(native, request, adapter)
          const session: AgentSession = { ...native, revision: 0, effective: request.effective, intent: request.intent }
          await this.options.journal.save(session, null)
          await this.options.journal.complete(commandId)
          this.startPump(session, adapter)
          return structuredClone(session)
        } catch {
          await this.uncertain(record)
          throw new Error("Native session creation is uncertain; inspect the native runtime before retrying")
        }
      }),
    )
  }

  async resumeSession(sessionId: string, admissionId: string, commandId: string): Promise<AgentSession> {
    return this.operation(() =>
      this.serial(`command:${commandId}`, () =>
        this.serial(`session:${sessionId}`, async () => {
          this.assertOpen()
          const digest = this.digest({ operation: "resume", sessionId, admissionId, commandId })
          const existing = await this.existing(commandId, digest)
          if (existing) return this.savedResult(existing)
          const session = await this.session(sessionId)
          if (["running", "awaiting-permission", "awaiting-input", "uncertain"].includes(session.status))
            throw new Error("Session must be reconciled before resume")
          const request = await this.options.admission.require(admissionId, sessionId, "resume")
          const adapter = this.adapter(session.binding.runtimeId, session.binding.targetId)
          if (!adapter.resume) throw new Error("Native resume is unsupported")
          this.options.admission.bindCommand(admissionId, commandId, digest)
          const record = this.record(request, commandId, digest)
          const reservation = await this.options.journal.reserve(record)
          if (!reservation.created) return this.savedResult(reservation.record)
          this.active.set(sessionId, request)
          try {
            await this.dispatch(record, request)
            this.stopPump(sessionId)
            await adapter.close(structuredClone(session))
            await this.options.admission.validate(request)
            this.assertOpen()
            const resumed = structuredClone(await adapter.resume(structuredClone(request), structuredClone(session)))
            this.validateSession(resumed, request, adapter)
            if (resumed.binding.nativeSessionId !== session.binding.nativeSessionId)
              throw new Error("Native resume changed thread identity")
            const updated = {
              ...resumed,
              createdAt: session.createdAt,
              intent: request.intent,
              effective: request.effective,
              revision: session.revision + 1,
            }
            await this.options.journal.save(updated, session.revision)
            await this.options.journal.complete(commandId)
            this.startPump(updated, adapter)
            return structuredClone(updated)
          } catch {
            await this.uncertain(record)
            throw new Error("Native session resume is uncertain; inspect the native runtime before retrying")
          }
        }),
      ),
    )
  }

  async send(sessionId: string, admissionId: string, input: AgentInput): Promise<CommandReceipt> {
    const payload = structuredClone(input)
    return this.operation(() =>
      this.serial(`command:${payload.commandId}`, () =>
        this.serial(`session:${sessionId}`, async () => {
          this.assertOpen()
          const digest = this.digest({
            operation: "turn",
            sessionId,
            admissionId,
            input: payload,
          })
          const existing = await this.existing(payload.commandId, digest)
          if (existing) return existing.receipt
          if (payload.delivery !== "when-idle") throw new Error("Queued turns are not implemented")
          if (!payload.messageId || !payload.parts.length)
            throw new Error("A message identity and content are required")
          const session = await this.session(sessionId)
          if (!["idle", "interrupted"].includes(session.status)) throw new Error("Session is not idle")
          if (!this.pumps.has(sessionId) || this.pumps.get(sessionId)!.stopping)
            throw new Error("Native session event stream is not attached")
          const request = await this.options.admission.require(admissionId, sessionId, "turn")
          this.options.admission.bindCommand(admissionId, payload.commandId, digest)
          const record = this.record(request, payload.commandId, digest)
          const adapter = this.adapter(session.binding.runtimeId, session.binding.targetId)
          const reservation = await this.options.journal.reserve(record)
          if (!reservation.created) return reservation.record.receipt
          this.active.set(sessionId, request)
          this.activeTurns.set(sessionId, payload.commandId)
          try {
            await this.dispatch(record, request)
            const running: AgentSession = {
              ...session,
              effective: request.effective,
              status: "running",
              revision: session.revision + 1,
            }
            await this.options.journal.save(running, session.revision)
            await this.options.admission.validate(request)
            this.assertOpen()
            this.permissionGuards.set(sessionId, this.options.admission.permissionGuard(request))
            const receipt = structuredClone(
              await adapter.send(
                { session: structuredClone(running), admissionId, leaseGeneration: request.lease.generation },
                structuredClone(payload),
              ),
            )
            if (
              receipt.commandId !== payload.commandId ||
              receipt.sessionId !== sessionId ||
              receipt.state !== "dispatched" ||
              !receipt.nativeTurnId
            )
              throw new Error("Invalid native command acknowledgement")
            await this.options.journal.append(sessionId, [], { ...record, receipt })
            return receipt
          } catch {
            await this.uncertain(record)
            return (await this.options.journal.command(payload.commandId))!.receipt
          }
        }),
      ),
    )
  }

  /** Read persisted events and then follow new journal commits without a replay/subscription race. */
  async *events(sessionId: string, after?: EventCursor, signal?: AbortSignal): AsyncIterable<EventDelivery> {
    await this.session(sessionId)
    let cursor = after
    while (!this.disposed && !signal?.aborted) {
      const version = this.versions.get(sessionId) ?? 0
      for await (const delivery of this.options.journal.read(sessionId, cursor)) {
        if (delivery.kind === "event")
          cursor = { streamId: delivery.event.streamId, epoch: delivery.event.epoch, sequence: delivery.event.sequence }
        else {
          yield delivery
          return
        }
        yield delivery
      }
      if (!this.pumps.has(sessionId) || this.pumps.get(sessionId)!.stopping) return
      if (version !== (this.versions.get(sessionId) ?? 0)) continue
      await new Promise<void>((resolve) => {
        const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
        const wake = () => {
          listeners.delete(wake)
          signal?.removeEventListener("abort", wake)
          resolve()
        }
        listeners.add(wake)
        this.listeners.set(sessionId, listeners)
        signal?.addEventListener("abort", wake, { once: true })
        if (this.disposed || signal?.aborted || version !== (this.versions.get(sessionId) ?? 0)) wake()
      })
    }
  }

  async interrupt(sessionId: string, commandId: string): Promise<CommandReceipt> {
    return this.operation(() =>
      this.serial(`command:${commandId}`, () =>
        this.serial(`session:${sessionId}`, async () => {
          this.assertOpen()
          const digest = this.digest({ operation: "interrupt", sessionId, commandId })
          const existing = await this.existing(commandId, digest)
          if (existing) return existing.receipt
          const session = await this.session(sessionId)
          const request = this.active.get(sessionId)
          if (!request) throw new Error("Native session is not attached")
          const record = this.record(request, commandId, digest)
          const reservation = await this.options.journal.reserve(record)
          if (!reservation.created) return reservation.record.receipt
          try {
            await this.options.journal.markDispatched(commandId)
            await this.adapter(session.binding.runtimeId, session.binding.targetId).interrupt({
              session,
              admissionId: request.admissionId,
              leaseGeneration: request.lease.generation,
            })
            await this.options.journal.complete(commandId)
            return (await this.options.journal.command(commandId))!.receipt
          } catch {
            await this.uncertain(record)
            return (await this.options.journal.command(commandId))!.receipt
          }
        }),
      ),
    )
  }

  async closeSession(sessionId: string): Promise<void> {
    return this.operation(() => this.close(sessionId))
  }

  async resolvePermission(input: PermissionDecision): Promise<void> {
    const decision = structuredClone(input)
    return this.operation(() =>
      this.serial(`session:${decision.sessionId}`, async () => {
        const actorId = this.options.actorId
        if (!actorId?.trim()) throw new Error("A trusted host actor is required")
        const existing = await this.options.journal.permission(decision.requestId)
        const review =
          existing?.state === "pending" &&
          existing.request.choices.some((choice) => choice.id === decision.choiceId && choice.action === "allow")
            ? this.reviewProof("permission", existing.request, decision, actorId)
            : undefined
        const claim = await this.options.journal.claimPermission(decision, actorId, this.now(), review?.artifactSha256)
        if (!claim.created) {
          if (claim.record.state !== "resolved" || claim.record.resolution?.outcome !== claim.record.intent?.outcome)
            throw new Error("Permission outcome is uncertain or was denied; native replay is blocked")
          return
        }
        this.revokeReviews(decision.sessionId, decision.requestId)
        try {
          const session = await this.session(decision.sessionId)
          const request = this.active.get(session.id)
          const commandId = this.activeTurns.get(session.id)
          const command = commandId ? await this.options.journal.command(commandId) : undefined
          if (
            !request ||
            !command ||
            command.receipt.nativeTurnId !== decision.nativeTurnId ||
            !this.pumps.has(session.id) ||
            this.pumps.get(session.id)!.stopping
          )
            throw new Error("Permission native handle is detached")
          this.validatePermissionBinding(session, request, decision)
          const adapter = this.adapter(session.binding.runtimeId, session.binding.targetId)
          if (!adapter.resolvePermission) throw new Error("Native permission handling is unsupported")
          let authorization: (() => void) | undefined
          if (claim.record.intent!.outcome === "allowed") {
            if (session.intent.policy.approval !== "ask" || session.status !== "awaiting-permission")
              throw new Error("Session cannot grant permission")
            const guard = this.permissionGuards.get(session.id)
            if (!guard) throw new Error("Permission authorization is unavailable")
            authorization = await guard()
            if (!this.options.workspaces.current(request.lease)) throw new Error("Permission lease expired")
          }
          this.assertOpen()
          const authorizeReply = () => {
            this.assertOpen()
            if (Date.parse(claim.record.request.expiresAt) <= this.now()) throw new Error("Permission expired")
            if (review && review.expiresAt <= this.now()) throw new Error("Protected review expired before reply")
            authorization?.()
          }
          authorizeReply()
          await adapter.resolvePermission(
            {
              session: structuredClone(session),
              admissionId: request.admissionId,
              leaseGeneration: request.lease.generation,
              authorizeReply,
            },
            structuredClone(claim.record.decision!),
          )
          await this.options.journal.append(session.id, [this.permissionResolution(session, claim.record.intent!)])
          await this.permissionStatus(session.id)
          this.notify(session.id)
        } catch {
          await this.options.journal.markPermissionUncertain(decision.requestId)
          throw new Error("Permission outcome is uncertain; native replay is blocked")
        }
      }),
    )
  }

  async reviewPermission(requestId: string): Promise<InteractionReview> {
    return this.review("permission", requestId)
  }

  async reviewInput(requestId: string): Promise<InteractionReview> {
    return this.review("input", requestId)
  }

  async resolveInput(input: HumanInputResponse): Promise<void> {
    const response = structuredClone(input)
    return this.operation(() =>
      this.serial(`session:${response.sessionId}`, async () => {
        const actorId = this.options.actorId
        if (!actorId?.trim()) throw new Error("A trusted host actor is required")
        const existing = await this.options.journal.input(response.requestId)
        const review =
          existing?.state === "pending" && response.action === "answer"
            ? this.reviewProof("input", existing.request, response, actorId)
            : undefined
        const claim = await this.options.journal.claimInput(response, actorId, this.now(), review?.artifactSha256)
        if (!claim.created) {
          if (claim.record.state !== "resolved" || claim.record.resolution?.outcome !== claim.record.intent?.outcome)
            throw new Error("Input outcome is uncertain or was cancelled; native replay is blocked")
          return
        }
        this.revokeReviews(response.sessionId, response.requestId)
        try {
          const { session, request, adapter } = await this.interactionContext(response)
          if (!adapter.resolveInput) throw new Error("Native input handling is unsupported")
          let authorization: (() => void) | undefined
          if (claim.record.intent!.outcome === "answered") {
            if (!["awaiting-input", "awaiting-permission"].includes(session.status))
              throw new Error("Session cannot answer input")
            const guard = this.permissionGuards.get(session.id)
            if (!guard) throw new Error("Input authorization is unavailable")
            authorization = await guard()
            if (!this.options.workspaces.current(request.lease)) throw new Error("Input lease expired")
          }
          const authorizeReply = () => {
            this.assertOpen()
            if (Date.parse(claim.record.request.expiresAt) <= this.now()) throw new Error("Input expired")
            if (review && review.expiresAt <= this.now()) throw new Error("Protected review expired before reply")
            authorization?.()
          }
          authorizeReply()
          await adapter.resolveInput(
            {
              session: structuredClone(session),
              admissionId: request.admissionId,
              leaseGeneration: request.lease.generation,
              authorizeReply,
            },
            structuredClone(claim.record.response!),
          )
          await this.options.journal.append(session.id, [this.inputResolution(session, claim.record.intent!)])
          await this.permissionStatus(session.id)
          this.notify(session.id)
        } catch {
          await this.options.journal.markInputUncertain(response.requestId)
          throw new Error("Input outcome is uncertain; native replay is blocked")
        }
      }),
    )
  }

  private async interactionContext(binding: PermissionBinding) {
    const session = await this.session(binding.sessionId)
    const request = this.active.get(session.id)
    const commandId = this.activeTurns.get(session.id)
    const command = commandId ? await this.options.journal.command(commandId) : undefined
    if (
      !request ||
      !command ||
      command.receipt.nativeTurnId !== binding.nativeTurnId ||
      !this.pumps.has(session.id) ||
      this.pumps.get(session.id)!.stopping
    )
      throw new Error("Interaction native handle is detached")
    this.validatePermissionBinding(session, request, binding)
    return { session, request, adapter: this.adapter(session.binding.runtimeId, session.binding.targetId) }
  }

  private review(kind: "permission" | "input", requestId: string): Promise<InteractionReview> {
    return this.operation(async () => {
      const original =
        kind === "permission"
          ? await this.options.journal.permission(requestId)
          : await this.options.journal.input(requestId)
      if (!original) throw new Error("Unknown review request")
      return this.serial(`session:${original.request.sessionId}`, async () => {
        const record =
          kind === "permission"
            ? await this.options.journal.permission(requestId)
            : await this.options.journal.input(requestId)
        const actorId = this.options.actorId
        const store = this.options.artifacts
        if (!record || record.state !== "pending" || !actorId?.trim() || !store || !record.request.reviewArtifact)
          throw new Error("Protected review is unavailable")
        const { request, session } = await this.interactionContext(record.request)
        this.checkArtifactLocation(request)
        if (!["awaiting-input", "awaiting-permission"].includes(session.status))
          throw new Error("Review session is not awaiting an interaction")
        const guard = this.permissionGuards.get(session.id)
        if (!guard) throw new Error("Review authorization is unavailable")
        const authorize = await guard()
        const expires = Math.min(Date.parse(record.request.expiresAt), this.now() + 60_000)
        if (!Number.isFinite(expires) || expires <= this.now()) throw new Error("Protected review expired")
        const artifact = record.request.reviewArtifact
        const grant = await store.grant({
          id: artifact.id,
          sessionId: session.id,
          actorId,
          expiresAt: new Date(expires).toISOString(),
        })
        let content: InteractionReview["content"]
        let bytes: Uint8Array | undefined
        try {
          if (this.digest(grant.artifact) !== this.digest(artifact))
            throw new Error("Protected review artifact changed")
          bytes = await store.read({ id: artifact.id, grantId: grant.id, sessionId: session.id, actorId })
          content = validateReviewContent(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            record.request,
          )
        } finally {
          bytes?.fill(0)
          store.revokeGrant(grant.id)
        }
        this.assertOpen()
        authorize()
        if (expires <= this.now()) throw new Error("Protected review expired")
        for (const [id, proof] of this.reviews) if (proof.expiresAt <= this.now()) this.reviews.delete(id)
        if (this.reviews.size >= 1024) throw new Error("Protected review capacity reached")
        const reviewToken = randomUUID()
        const reviewedAt = new Date(this.now()).toISOString()
        await this.options.journal.append(session.id, [
          {
            type: "interaction.reviewed",
            data: { requestId, artifactId: artifact.id, artifactSha256: artifact.sha256, actorId, reviewedAt },
            scope: {
              sessionId: session.id,
              runtimeId: session.binding.runtimeId,
              targetId: session.binding.targetId,
              workspaceId: session.workspaceId,
              turnId: record.request.nativeTurnId,
            },
            origin: {
              streamId: `host:reviews:${session.id}`,
              epoch: "1",
              eventId: randomUUID(),
              identityStrategy: "adapter-assigned",
            },
            observedAt: reviewedAt,
          },
        ])
        this.assertOpen()
        authorize()
        if (expires <= this.now()) throw new Error("Protected review expired")
        this.reviews.set(reviewToken, {
          kind,
          request: structuredClone(record.request),
          artifactSha256: artifact.sha256,
          actorId,
          expiresAt: expires,
        })
        this.notify(session.id)
        return { artifact: structuredClone(artifact), content, reviewToken, expiresAt: new Date(expires).toISOString() }
      })
    })
  }

  private reviewProof(
    kind: "permission" | "input",
    request: PermissionRequest | HumanInputRequest,
    response: PermissionBinding & { reviewToken?: string },
    actorId: string,
  ) {
    const proof = response.reviewToken ? this.reviews.get(response.reviewToken) : undefined
    if (
      !proof ||
      proof.kind !== kind ||
      proof.actorId !== actorId ||
      proof.expiresAt <= this.now() ||
      !samePermissionBinding(proof.request, request) ||
      !samePermissionBinding(request, response) ||
      !request.reviewArtifact ||
      proof.artifactSha256 !== request.reviewArtifact.sha256
    )
      throw new Error("A current protected review is required")
    return proof
  }

  private revokeReviews(sessionId: string, requestId?: string) {
    for (const [id, proof] of this.reviews)
      if (proof.request.sessionId === sessionId && (!requestId || proof.request.requestId === requestId))
        this.reviews.delete(id)
    if (!requestId) this.options.artifacts?.revokeSession(sessionId)
  }

  private checkArtifactLocation(request: AdmittedSessionRequest) {
    const root = this.options.artifacts?.rootPath
    if (!root || pathContains(request.workspace.rootPath, root) || pathContains(root, request.workspace.rootPath))
      throw new Error("Protected review storage must be outside the workspace")
  }

  private async protectReview(
    request: PermissionRequest | HumanInputRequest,
    admission: AdmittedSessionRequest,
    session: AgentSession,
  ) {
    this.checkArtifactLocation(admission)
    const adapter = this.adapter(session.binding.runtimeId, session.binding.targetId)
    const context = {
      session: structuredClone(session),
      admissionId: admission.admissionId,
      leaseGeneration: admission.lease.generation,
    }
    const value =
      "choices" in request
        ? await adapter.reviewPermission?.(context, request.requestId)
        : await adapter.reviewInput?.(context, request.requestId)
    const content = validateReviewContent(value, request)
    const bytes = new TextEncoder().encode(JSON.stringify(content))
    try {
      return await this.options.artifacts!.put({ sessionId: session.id, content: bytes, mediaType: "application/json" })
    } finally {
      bytes.fill(0)
    }
  }

  /** Observation only: never resumes a thread, settles a command, or sends user content. */
  async inspectSession(sessionId: string): Promise<NativeSessionInspection> {
    return this.operation(() =>
      this.serial(`session:${sessionId}`, async () => this.inspect(await this.session(sessionId))),
    )
  }

  /** Caller owns the native processes exclusively. Reconcile detached state, never replay work. */
  async reconcileSession(sessionId: string): Promise<AgentSession> {
    return this.operation(() =>
      this.serial(`session:${sessionId}`, async () => {
        const pump = this.pumps.get(sessionId)
        if (pump && !pump.stopping) throw new Error("Reconciliation requires a detached native stream")
        const session = await this.session(sessionId)
        if (session.status !== "uncertain") throw new Error("Only uncertain sessions require reconciliation")
        const observed = await this.inspect(session)
        if (
          observed.completeness !== "complete" ||
          observed.nativeState !== "idle" ||
          observed.turns.some((turn) => turn.status === "running" || turn.status === "unknown")
        )
          return session
        const commands = await this.options.journal.commands(sessionId)
        let unresolved = false
        for (const command of commands) {
          if (await this.options.journal.isComplete(command.id)) continue
          const turn = observed.turns.find((turn) => turn.nativeTurnId === command.receipt.nativeTurnId)
          if (!turn || (turn.status !== "succeeded" && turn.status !== "failed" && turn.status !== "interrupted")) {
            unresolved = true
            continue
          }
          await this.options.journal.append(sessionId, [
            {
              type: "agent.completed",
              data: { nativeTurnId: turn.nativeTurnId, outcome: turn.status },
              scope: {
                sessionId,
                targetId: session.binding.targetId,
                runtimeId: session.binding.runtimeId,
                workspaceId: session.workspaceId,
                commandId: command.id,
                turnId: turn.nativeTurnId,
              },
              origin: {
                streamId: `host:recovery:${sessionId}`,
                epoch: "1",
                eventId: command.id,
                identityStrategy: "adapter-assigned",
              },
              observedAt: observed.observedAt,
            },
          ])
        }
        await this.expirePermissions(session, "host:recovery")
        if (unresolved) {
          this.notify(sessionId)
          return this.session(sessionId)
        }
        const current = await this.session(sessionId)
        const updated: AgentSession = { ...current, status: "idle", revision: current.revision + 1 }
        await this.options.journal.save(updated, current.revision)
        this.activeTurns.delete(sessionId)
        this.permissionGuards.delete(sessionId)
        this.notify(sessionId)
        return structuredClone(updated)
      }),
    )
  }

  private async inspect(session: AgentSession): Promise<NativeSessionInspection> {
    const adapter = this.adapter(session.binding.runtimeId, session.binding.targetId)
    if (!adapter.inspect) throw new Error("Native history inspection is unsupported")
    const observed = structuredClone(await adapter.inspect(structuredClone(session)))
    const timestamp = Date.parse(observed.observedAt)
    if (
      observed.sessionId !== session.id ||
      this.digest(observed.binding) !== this.digest(session.binding) ||
      !Number.isFinite(timestamp) ||
      timestamp > this.now() ||
      timestamp < this.now() - 60_000 ||
      !["idle", "running", "unknown"].includes(observed.nativeState) ||
      !["complete", "partial"].includes(observed.completeness) ||
      !Array.isArray(observed.turns) ||
      observed.turns.length > 2000
    )
      throw new Error("Invalid native inspection binding or evidence")
    const ids = new Set<string>()
    for (const turn of observed.turns) {
      if (
        typeof turn.nativeTurnId !== "string" ||
        !turn.nativeTurnId ||
        turn.nativeTurnId.length > 256 ||
        ids.has(turn.nativeTurnId) ||
        !["running", "succeeded", "failed", "interrupted", "unknown"].includes(turn.status)
      )
        throw new Error("Invalid native turn observation")
      ids.add(turn.nativeTurnId)
    }
    if (
      observed.nativeState === "idle" &&
      (observed.completeness !== "complete" || observed.turns.some((turn) => turn.status === "running"))
    )
      throw new Error("Inconsistent native inspection")
    return observed
  }

  /** Requires exclusive ownership of this host journal and native processes. Never dispatches commands. */
  async recover(): Promise<readonly CommandReceipt[]> {
    this.assertOpen()
    if (this.active.size || this.operations.size || this.pumps.size)
      throw new Error("Recovery requires exclusive inactive runtime ownership")
    this.recovering = true
    return this.track(
      (async () => {
        try {
          const pending = await this.options.journal.recoverPending()
          await this.options.journal.recoverActiveSessions()
          await this.options.journal.recoverPermissions(this.now())
          await this.options.journal.recoverInputs(this.now())
          for (const record of pending) {
            const session = await this.options.journal.get(record.sessionId)
            if (session && session.status !== "uncertain")
              await this.options.journal.save(
                { ...session, status: "uncertain", revision: session.revision + 1 },
                session.revision,
              )
          }
          return pending.map((record) => record.receipt)
        } finally {
          this.recovering = false
        }
      })(),
    )
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.reviews.clear()
    for (const id of this.listeners.keys()) this.notify(id)
    this.disposal = (async () => {
      await Promise.allSettled([...this.operations])
      const results = await Promise.allSettled(
        [...this.active.keys()].map(async (sessionId) => {
          if (await this.options.journal.get(sessionId)) await this.close(sessionId)
          // Unknown native creates and unresolved turns retain leases until adapter-wide shutdown.
        }),
      )
      await Promise.allSettled([...this.pumpTasks])
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Native cleanup failed; workspace ownership is retained")
    })()
    return this.disposal
  }

  private async close(sessionId: string) {
    const pump = this.pumps.get(sessionId)
    await this.serial(`session:${sessionId}`, async () => {
      const session = await this.session(sessionId)
      this.stopPump(sessionId)
      try {
        await this.adapter(session.binding.runtimeId, session.binding.targetId).close(structuredClone(session))
      } catch {
        await this.streamUncertain(sessionId)
        throw new Error("Native close failed; workspace ownership is retained")
      }
      if (["running", "awaiting-permission", "awaiting-input", "uncertain"].includes(session.status))
        await this.streamUncertain(sessionId)
      const current = await this.session(sessionId)
      await this.expirePermissions(current, "host:close")
      if (current.status !== "uncertain") {
        await this.options.journal.save(
          { ...current, status: "closed", revision: current.revision + 1 },
          current.revision,
        )
        const request = this.active.get(sessionId)
        if (request) await this.options.workspaces.release(request.lease.id, request.lease.generation)
        this.active.delete(sessionId)
      }
      this.activeTurns.delete(sessionId)
      this.permissionGuards.delete(sessionId)
      this.notify(sessionId)
    })
    // An event ingestion may be waiting for the session lock above; drain after releasing it.
    await pump?.task
  }

  private async dispatch(record: CommandRecord, request: AdmittedSessionRequest) {
    if (!(await this.options.workspaces.valid(request.lease)))
      throw new Error("Workspace lease expired before dispatch")
    await this.options.journal.markDispatched(record.id)
  }

  private async uncertain(record: CommandRecord) {
    this.revokeReviews(record.sessionId)
    const current = await this.options.journal.command(record.id)
    if (current && !(await this.options.journal.isComplete(record.id)))
      await this.options.journal.append(record.sessionId, [], {
        ...current,
        receipt: { ...current.receipt, state: "uncertain", recordedAt: new Date().toISOString() },
      })
    const session = await this.options.journal.get(record.sessionId)
    if (session && session.status !== "uncertain")
      await this.options.journal.save(
        { ...session, status: "uncertain", revision: session.revision + 1 },
        session.revision,
      )
    this.notify(record.sessionId)
  }

  private startPump(input: AgentSession, adapter: AgentAdapter) {
    const session = structuredClone(input)
    this.stopPump(session.id)
    const stopped = Promise.withResolvers<void>()
    const pump: Pump = { task: Promise.resolve(), stopping: false, stop: () => stopped.resolve() }
    this.pumps.set(session.id, pump)
    pump.task = (async () => {
      let iterator: AsyncIterator<AgentEventDraft> | undefined
      try {
        iterator = adapter.events(structuredClone(session))[Symbol.asyncIterator]()
        while (!pump.stopping) {
          const next = await Promise.race([
            iterator.next(),
            stopped.promise.then(() => ({ done: true as const, value: undefined })),
          ])
          if (next.done) break
          const draft = structuredClone(next.value)
          await this.serial(`session:${session.id}`, async () => {
            if (this.pumps.get(session.id) === pump && !pump.stopping) await this.ingest(session, draft)
          })
        }
        if (!pump.stopping)
          await this.serial(`session:${session.id}`, async () => {
            if (this.pumps.get(session.id) === pump && !pump.stopping) await this.streamUncertain(session.id)
          })
      } catch {
        if (!pump.stopping)
          await this.serial(`session:${session.id}`, async () => {
            if (this.pumps.get(session.id) === pump && !pump.stopping) await this.streamUncertain(session.id)
          })
      } finally {
        if (this.pumps.get(session.id) === pump) this.pumps.delete(session.id)
        // Adapter.close owns native resources. Returning the iterator releases consumer buffers.
        await iterator?.return?.()
        this.notify(session.id)
      }
    })()
    this.pumpTasks.add(pump.task)
    void pump.task.then(
      () => this.pumpTasks.delete(pump.task),
      () => this.pumpTasks.delete(pump.task),
    )
    void pump.task.catch(() => this.notify(session.id))
  }

  private stopPump(sessionId: string) {
    const pump = this.pumps.get(sessionId)
    if (!pump) return
    pump.stopping = true
    pump.stop()
  }

  private async streamUncertain(sessionId: string) {
    this.revokeReviews(sessionId)
    const commandId = this.activeTurns.get(sessionId)
    const record = commandId ? await this.options.journal.command(commandId) : undefined
    if (record) return this.uncertain(record)
    const session = await this.options.journal.get(sessionId)
    if (session && session.status !== "closed" && session.status !== "uncertain") {
      await this.options.journal.save(
        { ...session, status: "uncertain", revision: session.revision + 1 },
        session.revision,
      )
    }
    this.notify(sessionId)
  }

  private async ingest(session: AgentSession, draft: AgentEventDraft) {
    if (
      draft.scope.sessionId !== session.id ||
      draft.scope.targetId !== session.binding.targetId ||
      draft.scope.runtimeId !== session.binding.runtimeId ||
      (draft.scope.workspaceId !== undefined && draft.scope.workspaceId !== session.workspaceId)
    )
      throw new Error("Native event scope mismatch")
    if (draft.type === "session.updated" || draft.type === "interaction.reviewed")
      throw new Error("Native adapters cannot replace host session authority")
    const command = draft.scope.commandId ? await this.options.journal.command(draft.scope.commandId) : undefined
    if (draft.type === "permission.requested" || draft.type === "input.requested") {
      if (draft.data.reviewArtifact !== undefined || draft.data.sourceRequestSha256 !== undefined)
        throw new Error("Native adapters cannot supply host review authority")
      const sourceRequestSha256 = this.digest(draft.data)
      const existing =
        draft.type === "permission.requested"
          ? await this.options.journal.permission(draft.data.requestId)
          : await this.options.journal.input(draft.data.requestId)
      if (existing) {
        if (
          (existing.request.sourceRequestSha256 ?? this.digest(existing.request)) !== sourceRequestSha256 ||
          !command ||
          command.sessionId !== session.id ||
          command.receipt.nativeTurnId !== draft.data.nativeTurnId
        )
          throw new Error("Conflicting permission replay")
        return
      }
      const current = await this.session(session.id)
      const request = this.active.get(session.id)
      if (
        !request ||
        !command ||
        this.activeTurns.get(session.id) !== command.id ||
        command.receipt.nativeTurnId !== draft.data.nativeTurnId ||
        !["running", "awaiting-permission", "awaiting-input"].includes(current.status)
      )
        throw new Error("Native permission has no matching active turn")
      this.validatePermissionBinding(current, request, draft.data)
      if (
        draft.type === "permission.requested" &&
        current.intent.policy.approval !== "ask" &&
        draft.data.choices.some((choice) => choice.action === "allow")
      )
        throw new Error("Permission grant contradicts policy")
      let reviewArtifact: PermissionRequest["reviewArtifact"]
      if (draft.type === "input.requested" || draft.data.choices.some((choice) => choice.action === "allow")) {
        try {
          reviewArtifact = await this.protectReview(draft.data, request, current)
        } catch {
          /* Unavailable protected content permits only denial or cancellation. */
        }
      }
      if (draft.type === "permission.requested")
        draft = {
          ...draft,
          data: {
            ...draft.data,
            sourceRequestSha256,
            ...(reviewArtifact ? { reviewArtifact } : {}),
            choices: reviewArtifact
              ? draft.data.choices
              : draft.data.choices.filter((choice) => choice.action === "deny"),
          },
        }
      else
        draft = {
          ...draft,
          data: { ...draft.data, sourceRequestSha256, ...(reviewArtifact ? { reviewArtifact } : {}) },
        }
    }
    if (draft.type === "permission.resolved") {
      if (draft.data.outcome === "allowed") throw new Error("Native adapters cannot grant host permission")
      const existing = await this.options.journal.permission(draft.data.requestId)
      if (!existing || !samePermissionBinding(existing.request, draft.data))
        throw new Error("Native permission resolution binding mismatch")
      // A repeated or late negative acknowledgement cannot replace the first terminal denial,
      // nor acquire a different timestamp under an already durable source-event identity.
      if (existing.state === "resolved" && existing.resolution?.outcome !== "allowed") return
      draft = {
        ...draft,
        data: { ...draft.data, actorId: "host:native-policy", decidedAt: new Date(this.now()).toISOString() },
      }
      this.revokeReviews(session.id, draft.data.requestId)
    }
    if (draft.type === "input.resolved") {
      if (draft.data.outcome === "answered") throw new Error("Native adapters cannot answer host input")
      const existing = await this.options.journal.input(draft.data.requestId)
      if (!existing || !samePermissionBinding(existing.request, draft.data))
        throw new Error("Native input resolution binding mismatch")
      if (existing.state === "resolved" && existing.resolution?.outcome !== "answered") return
      draft = {
        ...draft,
        data: { ...draft.data, actorId: "host:native-policy", decidedAt: new Date(this.now()).toISOString() },
      }
      this.revokeReviews(session.id, draft.data.requestId)
    }
    if (draft.type === "agent.completed" || draft.type === "agent.started") {
      if (
        !command ||
        command.sessionId !== session.id ||
        !draft.data.nativeTurnId ||
        (command.receipt.nativeTurnId !== undefined && command.receipt.nativeTurnId !== draft.data.nativeTurnId) ||
        (command.receipt.nativeTurnId === undefined && this.activeTurns.get(session.id) !== command.id)
      )
        throw new Error("Native lifecycle event has no matching command")
    }
    const events = await this.options.journal.append(session.id, [draft]).catch(async (error) => {
      if ((draft.type === "permission.requested" || draft.type === "input.requested") && draft.data.reviewArtifact)
        await this.options.artifacts
          ?.delete({ id: draft.data.reviewArtifact.id, sessionId: session.id })
          .catch(() => {})
      throw error
    })
    if (!events.length) return
    if (
      draft.type === "permission.requested" ||
      draft.type === "permission.resolved" ||
      draft.type === "input.requested" ||
      draft.type === "input.resolved"
    )
      await this.permissionStatus(session.id)
    if (draft.type === "agent.completed" && this.activeTurns.get(session.id) === draft.scope.commandId) {
      const current = await this.session(session.id)
      const status =
        draft.data.outcome === "succeeded" ? "idle" : draft.data.outcome === "interrupted" ? "interrupted" : "failed"
      await this.options.journal.save({ ...current, status, revision: current.revision + 1 }, current.revision)
      await this.expirePermissions(current, "host:turn-completed")
      this.activeTurns.delete(session.id)
      this.permissionGuards.delete(session.id)
    }
    if (
      draft.type === "stream.gap" ||
      (draft.type === "agent.error" && this.activeTurns.get(session.id) === draft.scope.commandId)
    )
      await this.streamUncertain(session.id)
    this.notify(session.id)
  }

  private validateSession(session: AgentSession, request: AdmittedSessionRequest, adapter: AgentAdapter) {
    if (
      session.id !== request.sessionId ||
      session.workspaceId !== request.workspace.id ||
      session.binding.adapterId !== adapter.id ||
      session.binding.runtimeId !== request.intent.selection.runtimeId ||
      session.binding.targetId !== request.workspace.targetId ||
      !session.binding.nativeSessionId ||
      session.status !== "idle"
    )
      throw new Error("Native session does not match admission")
    if (
      this.digest(session.intent) !== this.digest(request.intent) ||
      this.digest(session.effective) !== this.digest(request.effective) ||
      !Number.isFinite(Date.parse(session.createdAt))
    )
      throw new Error("Native session intent or effective settings differ from admission")
  }

  private validatePermissionBinding(
    session: AgentSession,
    request: AdmittedSessionRequest,
    binding: PermissionBinding,
  ) {
    if (
      binding.sessionId !== session.id ||
      binding.runtimeId !== session.binding.runtimeId ||
      binding.targetId !== session.binding.targetId ||
      binding.workspaceId !== session.workspaceId ||
      binding.nativeSessionId !== session.binding.nativeSessionId ||
      binding.policyId !== session.intent.policy.id ||
      binding.policyVersion !== session.intent.policy.version ||
      binding.leaseGeneration !== request.lease.generation
    )
      throw new Error("Permission binding mismatch")
  }

  private permissionResolution(session: AgentSession, resolution: PermissionResolution): AgentEventDraft {
    return {
      type: "permission.resolved",
      data: resolution,
      scope: {
        sessionId: session.id,
        runtimeId: session.binding.runtimeId,
        targetId: session.binding.targetId,
        workspaceId: session.workspaceId,
        turnId: resolution.nativeTurnId,
      },
      origin: {
        streamId: `host:permissions:${session.id}`,
        epoch: "1",
        eventId: `${resolution.requestId}:${resolution.outcome}`,
        identityStrategy: "adapter-assigned",
      },
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  private async permissionStatus(sessionId: string) {
    const current = await this.session(sessionId)
    if (!["running", "awaiting-permission", "awaiting-input"].includes(current.status)) return
    const status = (await this.options.journal.pendingPermissions(sessionId)).length
      ? "awaiting-permission"
      : (await this.options.journal.pendingInputs(sessionId)).length
        ? "awaiting-input"
        : "running"
    if (status !== current.status)
      await this.options.journal.save({ ...current, status, revision: current.revision + 1 }, current.revision)
  }

  private async expirePermissions(session: AgentSession, actorId: string) {
    this.revokeReviews(session.id)
    for (const { request } of await this.options.journal.pendingInputs(session.id)) {
      await this.options.journal.append(session.id, [
        this.inputResolution(session, {
          ...interactionBinding(request),
          outcome: "expired",
          actorId,
          decidedAt: new Date(this.now()).toISOString(),
        }),
      ])
    }
    for (const { request } of await this.options.journal.pendingPermissions(session.id)) {
      const {
        requestId,
        sessionId,
        runtimeId,
        targetId,
        workspaceId,
        nativeSessionId,
        nativeTurnId,
        nativeRequestId,
        policyId,
        policyVersion,
        leaseGeneration,
        operationSha256,
      } = request
      await this.options.journal.append(session.id, [
        this.permissionResolution(session, {
          requestId,
          sessionId,
          runtimeId,
          targetId,
          workspaceId,
          nativeSessionId,
          nativeTurnId,
          nativeRequestId,
          policyId,
          policyVersion,
          leaseGeneration,
          operationSha256,
          outcome: "expired",
          actorId,
          decidedAt: new Date(this.now()).toISOString(),
        }),
      ])
    }
  }

  private inputResolution(session: AgentSession, resolution: HumanInputResolution): AgentEventDraft {
    return {
      type: "input.resolved",
      data: resolution,
      scope: {
        sessionId: session.id,
        runtimeId: session.binding.runtimeId,
        targetId: session.binding.targetId,
        workspaceId: session.workspaceId,
        turnId: resolution.nativeTurnId,
      },
      origin: {
        streamId: `host:inputs:${session.id}`,
        epoch: "1",
        eventId: `${resolution.requestId}:${resolution.outcome}`,
        identityStrategy: "adapter-assigned",
      },
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  private record(request: AdmittedSessionRequest, commandId: string, requestSha256: string): CommandRecord {
    return {
      id: commandId,
      requestSha256,
      admissionId: request.admissionId,
      sessionId: request.sessionId,
      receipt: { commandId, sessionId: request.sessionId, state: "admitted", recordedAt: new Date().toISOString() },
    }
  }

  private async existing(id: string, digest: string) {
    const record = await this.options.journal.command(id)
    if (record && record.requestSha256 !== digest)
      throw new Error("Command conflict: idempotency key has a different request")
    return record
  }

  private async savedResult(record: CommandRecord) {
    if (record.receipt.state !== "dispatched" || !(await this.options.journal.isComplete(record.id)))
      throw new Error("Command outcome is uncertain; automatic retry is blocked")
    const session = await this.options.journal.get(record.sessionId)
    if (!session) throw new Error("Command outcome is uncertain; no durable session is available")
    return session
  }

  private async session(id: string) {
    const session = await this.options.journal.get(id)
    if (!session) throw new Error("Unknown session")
    return session
  }

  private adapter(runtimeId: string, targetId: string) {
    const runtime = this.options.runtime(runtimeId, targetId)
    if (!runtime) throw new Error("Runtime unavailable")
    return runtime.adapter
  }

  private digest(value: unknown) {
    return hashConfiguration(value)
  }
  private assertOpen() {
    if (this.disposed || this.recovering) throw new Error("Runtime manager is closed or recovering")
  }

  private operation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    return this.track(operation())
  }

  private track<T>(result: Promise<T>): Promise<T> {
    this.operations.add(result)
    void result.then(
      () => this.operations.delete(result),
      () => this.operations.delete(result),
    )
    return result
  }
  private notify(id: string) {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    for (const wake of this.listeners.get(id) ?? []) wake()
  }

  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.locks.set(key, settled)
    try {
      return await result
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key)
    }
  }
}

function pathContains(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\"))
}

function interactionBinding(request: PermissionBinding): PermissionBinding {
  const {
    requestId,
    sessionId,
    runtimeId,
    targetId,
    workspaceId,
    nativeSessionId,
    nativeTurnId,
    nativeRequestId,
    policyId,
    policyVersion,
    leaseGeneration,
    operationSha256,
  } = request
  return {
    requestId,
    sessionId,
    runtimeId,
    targetId,
    workspaceId,
    nativeSessionId,
    nativeTurnId,
    nativeRequestId,
    policyId,
    policyVersion,
    leaseGeneration,
    operationSha256,
  }
}

function samePermissionBinding(left: PermissionBinding, right: PermissionBinding): boolean {
  return (
    [
      "requestId",
      "sessionId",
      "runtimeId",
      "targetId",
      "workspaceId",
      "nativeSessionId",
      "nativeTurnId",
      "nativeRequestId",
      "policyId",
      "policyVersion",
      "leaseGeneration",
      "operationSha256",
    ] as const
  ).every((key) => left[key] === right[key])
}
