import { randomUUID } from "node:crypto"
import type { AgentAdapter } from "@harness/adapters"
import type {
  AdmittedSessionRequest,
  AgentEventDraft,
  AgentInput,
  AgentSession,
  CommandReceipt,
  EventCursor,
  EventDelivery,
} from "@harness/protocol"
import type { CommandRecord } from "./index"
import type { AdmissionController, AdmissionOptions, AdmissionWorkspaces } from "./admission"
import { hashConfiguration } from "./environment"
import type { SQLiteJournal } from "./journal"

export interface RuntimeManagerOptions {
  readonly admission: AdmissionController
  readonly journal: SQLiteJournal
  readonly runtime: AdmissionOptions["runtime"]
  readonly workspaces: AdmissionWorkspaces
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
  private readonly operations = new Set<Promise<unknown>>()
  private readonly pumpTasks = new Set<Promise<void>>()
  private readonly versions = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private disposed = false
  private recovering = false
  private disposal?: Promise<void>

  constructor(private readonly options: RuntimeManagerOptions) {}

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
          if (["running", "awaiting-permission", "uncertain"].includes(session.status))
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
      if (["running", "awaiting-permission", "uncertain"].includes(session.status))
        await this.streamUncertain(sessionId)
      const current = await this.session(sessionId)
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
    if (draft.type === "session.updated") throw new Error("Native adapters cannot replace host session authority")
    const command = draft.scope.commandId ? await this.options.journal.command(draft.scope.commandId) : undefined
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
    const events = await this.options.journal.append(session.id, [draft])
    if (!events.length) return
    if (draft.type === "agent.completed" && this.activeTurns.get(session.id) === draft.scope.commandId) {
      const current = await this.session(session.id)
      const status =
        draft.data.outcome === "succeeded" ? "idle" : draft.data.outcome === "interrupted" ? "interrupted" : "failed"
      await this.options.journal.save({ ...current, status, revision: current.revision + 1 }, current.revision)
      this.activeTurns.delete(session.id)
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
