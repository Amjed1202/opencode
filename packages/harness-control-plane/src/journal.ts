import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import type {
  AgentEvent,
  AgentEventDraft,
  AgentSession,
  ArtifactReference,
  EventCursor,
  EventDelivery,
  EventScope,
  PermissionBinding,
  PermissionDecision,
  PermissionRequest,
  PermissionResolution,
} from "@harness/protocol"
import type { CommandRecord, EventStore, SessionStore } from "./index"

interface StreamRow {
  id: string
  epoch: string
  last_sequence: number
}

/** Claimed records retain intent; resolution records an acknowledged reply or an autonomous terminal decision. */
export interface PermissionRecord {
  readonly request: PermissionRequest
  readonly state: "pending" | "claimed" | "resolved" | "uncertain"
  readonly decision?: PermissionDecision
  readonly intent?: PermissionResolution
  readonly resolution?: PermissionResolution
}

export class SQLiteJournal implements EventStore, SessionStore {
  private readonly database: Database

  /** The caller supplies an application-owned database path; no runtime database is discovered or imported. */
  constructor(path: string) {
    if (!path.trim()) throw new Error("An explicit journal database path is required")
    this.database = new Database(path, { create: true, strict: true })
    try {
      const events = this.database
        .query<{ type: string }, []>("SELECT type FROM sqlite_master WHERE name = 'journal_events'")
        .get()
      if (
        events &&
        (events.type !== "table" ||
          this.database
            .query(
              `SELECT 1 FROM journal_events
            WHERE CASE WHEN json_valid(event) THEN json_extract(event, '$.protocolVersion') IS NOT '0.2' ELSE 1 END
            LIMIT 1`,
            )
            .get())
      )
        throw new Error("Unsupported stored protocol")
    } catch {
      // Never rewrite an old audit trail or partially migrate schema while rejecting its protocol.
      this.database.close()
      throw new Error("Incompatible journal event protocol; explicit migration to protocol 0.2 is required")
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS journal_commands (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS journal_permissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_permissions_pending ON journal_permissions (session_id, state);
      CREATE TABLE IF NOT EXISTS journal_permission_scopes (
        request_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_permission_streams (
        request_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        session TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_sessions_workspace ON journal_sessions (workspace_id);
      CREATE TABLE IF NOT EXISTS journal_streams (
        id TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS journal_origins (
        stream_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        event_id TEXT NOT NULL,
        host_stream_id TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (stream_id, epoch, event_id)
      );
      CREATE TABLE IF NOT EXISTS journal_events (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event TEXT NOT NULL,
        UNIQUE (stream_id, epoch, sequence)
      );
      CREATE TABLE IF NOT EXISTS journal_retention (
        stream_id TEXT PRIMARY KEY,
        through_sequence INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );
    `)
  }

  async reserve(record: CommandRecord): Promise<{ created: boolean; record: CommandRecord }> {
    validateCommand(record)
    return this.database
      .transaction(() => {
        const existing = this.lookupCommand(record.id)
        if (existing) {
          assertCommandIdentity(existing, record)
          return { created: false, record: existing }
        }
        if (record.receipt.state !== "admitted") throw new Error("A new command must be admitted")
        this.database
          .query("INSERT INTO journal_commands (id, record) VALUES (?, ?)")
          .run(record.id, JSON.stringify(record))
        return { created: true, record }
      })
      .immediate()
  }

  async command(id: string): Promise<CommandRecord | undefined> {
    return this.lookupCommand(id)
  }

  async commands(sessionId: string): Promise<readonly CommandRecord[]> {
    return this.database
      .query<{ record: string }, []>("SELECT record FROM journal_commands ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.record) as CommandRecord)
      .filter((record) => record.sessionId === sessionId)
  }

  async permission(id: string): Promise<PermissionRecord | undefined> {
    return this.lookupPermission(id)
  }

  async pendingPermissions(sessionId: string): Promise<readonly PermissionRecord[]> {
    return this.database
      .query<{ record: string }, [string]>(
        "SELECT record FROM journal_permissions WHERE session_id = ? AND state = 'pending' ORDER BY id",
      )
      .all(sessionId)
      .map((row) => JSON.parse(row.record) as PermissionRecord)
  }

  /** Prefer append(permission.requested) when publishing the request, so its event and ledger commit together. */
  async recordPermission(request: PermissionRequest): Promise<{ created: boolean; record: PermissionRecord }> {
    return this.database.transaction(() => this.writePermissionRequest(request)).immediate()
  }

  /** Reserve before touching the native reply handle. An exact retry never authorizes another native send. */
  async claimPermission(
    decision: PermissionDecision,
    trustedActorId: string,
    now = Date.now(),
  ): Promise<{ created: boolean; record: PermissionRecord }> {
    const decidedAt = permissionTimestamp(now)
    if (!trustedActorId.trim()) throw new Error("A trusted permission actor is required")
    return this.database
      .transaction(() => {
        const record = this.lookupPermission(decision.requestId)
        if (!record) throw new Error("Unknown permission request")
        assertPermissionBinding(record.request, decision)
        const choice = record.request.choices.find((choice) => choice.id === decision.choiceId)
        if (!choice || choice.scope !== "once")
          throw new Error("Permission decision must select an offered once choice")
        const normalized: PermissionDecision = { ...permissionBinding(record.request), choiceId: choice.id }
        if (record.decision) {
          if (canonicalJson(record.decision) !== canonicalJson(normalized))
            throw new Error("Permission conflict: request already has a different decision")
          return { created: false, record }
        }
        if (record.state !== "pending") throw new Error("Permission request is no longer pending")
        if (Date.parse(record.request.expiresAt) <= now) throw new Error("Permission request has expired")
        const resolution: PermissionResolution = {
          ...permissionBinding(record.request),
          choiceId: choice.id,
          outcome: choice.action === "allow" ? "allowed" : "denied",
          actorId: trustedActorId,
          decidedAt,
        }
        const next: PermissionRecord = {
          ...record,
          state: "claimed",
          decision: normalized,
          intent: resolution,
        }
        this.writePermission(next)
        return { created: true, record: next }
      })
      .immediate()
  }

  /** Native acknowledgement is required; ambiguous calls must use markPermissionUncertain instead. */
  async finishPermission(
    id: string,
    draft: Extract<AgentEventDraft, { type: "permission.resolved" }>,
  ): Promise<PermissionRecord> {
    if (draft.data.requestId !== id) throw new Error("Permission resolution identity mismatch")
    await this.append(draft.data.sessionId, [draft])
    return this.lookupPermission(id)!
  }

  /** Retain the original intent and actor while preventing an ambiguous native response from being retried. */
  async markPermissionUncertain(id: string): Promise<PermissionRecord> {
    return this.database
      .transaction(() => {
        const record = this.lookupPermission(id)
        if (!record) throw new Error("Unknown permission request")
        if (record.state === "resolved" || record.state === "uncertain") return record
        if (record.state !== "claimed") throw new Error("Only a claimed permission can become uncertain")
        const next: PermissionRecord = { ...record, state: "uncertain" }
        this.writePermission(next)
        return next
      })
      .immediate()
  }

  /** Exclusive restart recovery only: all native reply handles are gone, even for requests not yet timed out. */
  async recoverPermissions(now = Date.now(), trustedActorId = "host:recovery"): Promise<readonly PermissionRecord[]> {
    const decidedAt = permissionTimestamp(now)
    if (!trustedActorId.trim()) throw new Error("A trusted permission actor is required")
    return this.database
      .transaction(() =>
        this.database
          .query<{ record: string }, []>(
            "SELECT record FROM journal_permissions WHERE state IN ('pending', 'claimed') ORDER BY id",
          )
          .all()
          .map((row) => {
            const record = JSON.parse(row.record) as PermissionRecord
            if (record.state === "claimed") {
              const next: PermissionRecord = { ...record, state: "uncertain" }
              this.writePermission(next)
              return next
            }
            const original = this.database
              .query<{ scope: string }, [string]>("SELECT scope FROM journal_permission_scopes WHERE request_id = ?")
              .get(record.request.requestId)
            const stream = this.database
              .query<
                { stream_id: string },
                [string]
              >("SELECT stream_id FROM journal_permission_streams WHERE request_id = ?")
              .get(record.request.requestId)
            this.appendEvents(stream?.stream_id ?? record.request.sessionId, [
              {
                type: "permission.resolved",
                data: {
                  ...permissionBinding(record.request),
                  outcome: "expired",
                  actorId: trustedActorId,
                  decidedAt,
                },
                scope: {
                  ...(original ? (JSON.parse(original.scope) as EventScope) : {}),
                  sessionId: record.request.sessionId,
                  targetId: record.request.targetId,
                  workspaceId: record.request.workspaceId,
                  runtimeId: record.request.runtimeId,
                  turnId: record.request.nativeTurnId,
                },
                origin: {
                  streamId: `host:permissions:${record.request.sessionId}`,
                  epoch: "1",
                  eventId: `${record.request.requestId}:expired`,
                  identityStrategy: "adapter-assigned",
                },
                observedAt: decidedAt,
              },
            ])
            return this.lookupPermission(record.request.requestId)!
          }),
      )
      .immediate()
  }

  /** Persist before attempting the native call. This is an intent marker, not proof of native execution. */
  async markDispatched(id: string, nativeTurnId?: string): Promise<CommandRecord> {
    return this.database
      .transaction(() => {
        const record = this.lookupCommand(id)
        if (!record) throw new Error("Unknown command")
        if (record.receipt.state !== "admitted" && record.receipt.state !== "dispatched") {
          throw new Error("Command cannot be dispatched from its current state")
        }
        const next: CommandRecord = {
          ...record,
          receipt: {
            ...record.receipt,
            state: "dispatched",
            recordedAt: new Date().toISOString(),
            ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
          },
        }
        this.writeCommand(next, [])
        return next
      })
      .immediate()
  }

  /** For successful create/resume after durable session save; native turns settle through agent.completed. */
  async complete(id: string): Promise<void> {
    this.database
      .transaction(() => {
        const record = this.lookupCommand(id)
        if (record?.receipt.state !== "dispatched") throw new Error("Only a dispatched command can be completed")
        this.database.query("UPDATE journal_commands SET settled = 1 WHERE id = ?").run(id)
      })
      .immediate()
  }

  /** Distinguishes a durable successful create/resume result from an unresolved dispatch marker. */
  async isComplete(id: string): Promise<boolean> {
    return (
      this.database.query<{ settled: number }, [string]>("SELECT settled FROM journal_commands WHERE id = ?").get(id)
        ?.settled === 1
    )
  }

  /** Call only after acquiring exclusive runtime ownership at restart, never against an active dispatcher. */
  async recoverPending(): Promise<readonly CommandRecord[]> {
    return this.database
      .transaction(() => {
        const pending = this.database
          .query<{ record: string }, []>("SELECT record FROM journal_commands WHERE settled = 0 ORDER BY id")
          .all()
          .map((row) => JSON.parse(row.record) as CommandRecord)
          .filter((record) => record.receipt.state === "admitted" || record.receipt.state === "dispatched")
        return pending.map((record) => {
          const next: CommandRecord = {
            ...record,
            receipt: { ...record.receipt, state: "uncertain", recordedAt: new Date().toISOString() },
          }
          this.writeCommand(next, [])
          return next
        })
      })
      .immediate()
  }

  /** A crash can separate durable completion from its session projection; never leave that projection runnable. */
  async recoverActiveSessions(): Promise<readonly AgentSession[]> {
    return this.database
      .transaction(() => {
        const active = this.database
          .query<{ session: string }, []>("SELECT session FROM journal_sessions ORDER BY id")
          .all()
          .map((row) => JSON.parse(row.session) as AgentSession)
          .filter((session) => session.status === "running" || session.status === "awaiting-permission")
        return active.map((session): AgentSession => {
          const recovered: AgentSession = { ...session, status: "uncertain", revision: session.revision + 1 }
          this.database
            .query("UPDATE journal_sessions SET revision = ?, session = ? WHERE id = ?")
            .run(recovered.revision, JSON.stringify(recovered), recovered.id)
          return recovered
        })
      })
      .immediate()
  }

  async get(id: string): Promise<AgentSession | undefined> {
    const row = this.database
      .query<{ session: string }, [string]>("SELECT session FROM journal_sessions WHERE id = ?")
      .get(id)
    return row ? (JSON.parse(row.session) as AgentSession) : undefined
  }

  async list(workspaceId: string): Promise<readonly AgentSession[]> {
    return this.database
      .query<{ session: string }, [string]>("SELECT session FROM journal_sessions WHERE workspace_id = ? ORDER BY id")
      .all(workspaceId)
      .map((row) => JSON.parse(row.session) as AgentSession)
  }

  async save(session: AgentSession, expectedRevision: number | null): Promise<void> {
    if (!session.id || !session.workspaceId || session.intent.workspaceId !== session.workspaceId)
      throw new Error("Invalid session identity")
    if (
      !Number.isSafeInteger(session.revision) ||
      session.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)
    ) {
      throw new Error("Session revision must start at zero and increment by one")
    }
    this.database
      .transaction(() => {
        const existing = this.database
          .query<{ revision: number }, [string]>("SELECT revision FROM journal_sessions WHERE id = ?")
          .get(session.id)
        if (expectedRevision === null ? existing !== null : existing?.revision !== expectedRevision)
          throw new Error("Session revision conflict")
        this.database
          .query(
            `INSERT INTO journal_sessions (id, workspace_id, revision, session) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET workspace_id = excluded.workspace_id, revision = excluded.revision, session = excluded.session`,
          )
          .run(session.id, session.workspaceId, session.revision, JSON.stringify(session))
      })
      .immediate()
  }

  async append(
    streamId: string,
    drafts: readonly AgentEventDraft[],
    command?: CommandRecord,
  ): Promise<readonly AgentEvent[]> {
    return this.database.transaction(() => this.appendEvents(streamId, drafts, command)).immediate()
  }

  /** Caller must own the SQLite transaction, including any ledger transitions attached to these events. */
  private appendEvents(
    streamId: string,
    drafts: readonly AgentEventDraft[],
    command?: CommandRecord,
  ): readonly AgentEvent[] {
    if (!streamId) throw new Error("A host stream ID is required")
    if (command) this.writeCommand(command, drafts)
    const appended = drafts.flatMap((draft) => {
      validateOrigin(draft)
      const content = createHash("sha256").update(canonicalJson(draft)).digest("hex")
      const existing = this.database
        .query<
          { host_stream_id: string; content: string },
          [string, string, string]
        >("SELECT host_stream_id, content FROM journal_origins WHERE stream_id = ? AND epoch = ? AND event_id = ?")
        .get(draft.origin.streamId, draft.origin.epoch, draft.origin.eventId)
      if (existing) {
        if (existing.host_stream_id !== streamId || existing.content !== content)
          throw new Error("Origin conflict: source identity has different content or host stream")
        return []
      }
      if (draft.type === "permission.requested" || draft.type === "permission.resolved") {
        const original = this.database
          .query<{ scope: string }, [string]>("SELECT scope FROM journal_permission_scopes WHERE request_id = ?")
          .get(draft.data.requestId)
        const scope = original ? (JSON.parse(original.scope) as EventScope) : undefined
        if (
          draft.scope.sessionId !== draft.data.sessionId ||
          draft.scope.targetId !== draft.data.targetId ||
          (draft.scope.workspaceId !== undefined && draft.scope.workspaceId !== draft.data.workspaceId) ||
          (draft.scope.runtimeId !== undefined && draft.scope.runtimeId !== draft.data.runtimeId) ||
          (draft.scope.turnId !== undefined && draft.scope.turnId !== draft.data.nativeTurnId) ||
          (scope &&
            Object.entries(draft.scope).some(
              ([key, value]) =>
                value !== undefined &&
                scope[key as keyof EventScope] !== undefined &&
                value !== scope[key as keyof EventScope],
            )) ||
          (draft.type === "permission.resolved" &&
            draft.scope.commandId !== undefined &&
            draft.scope.commandId !== scope?.commandId)
        )
          throw new Error("Permission event scope mismatch")
        if (draft.type === "permission.requested") {
          this.writePermissionRequest(draft.data)
          this.database
            .query("INSERT OR IGNORE INTO journal_permission_scopes (request_id, scope) VALUES (?, ?)")
            .run(draft.data.requestId, JSON.stringify(draft.scope))
          this.database
            .query("INSERT OR IGNORE INTO journal_permission_streams (request_id, stream_id) VALUES (?, ?)")
            .run(draft.data.requestId, streamId)
        }
        if (draft.type === "permission.resolved") this.writePermissionResolution(draft.data)
      }
      this.database.query("INSERT OR IGNORE INTO journal_streams (id, epoch) VALUES (?, ?)").run(streamId, randomUUID())
      const stream = this.lookupStream(streamId)!
      if (!Number.isSafeInteger(stream.last_sequence + 1)) throw new Error("Host stream sequence exhausted")
      const event: AgentEvent = {
        ...draft,
        protocolVersion: "0.2",
        id: randomUUID(),
        streamId,
        epoch: stream.epoch,
        sequence: stream.last_sequence + 1,
      }
      this.database
        .query(
          "INSERT INTO journal_origins (stream_id, epoch, event_id, host_stream_id, content) VALUES (?, ?, ?, ?, ?)",
        )
        .run(draft.origin.streamId, draft.origin.epoch, draft.origin.eventId, streamId, content)
      this.database
        .query("INSERT INTO journal_events (id, stream_id, epoch, sequence, event) VALUES (?, ?, ?, ?, ?)")
        .run(event.id, streamId, event.epoch, event.sequence, JSON.stringify(event))
      this.database.query("UPDATE journal_streams SET last_sequence = ? WHERE id = ?").run(event.sequence, streamId)
      return [event]
    })
    drafts.forEach((draft) => {
      if (draft.type !== "agent.completed" || !draft.scope.commandId) return
      const record = this.lookupCommand(draft.scope.commandId)
      if (
        !record ||
        !isCompletion(record, draft) ||
        (record.receipt.state !== "dispatched" && record.receipt.state !== "uncertain")
      )
        return
      this.writeCommand(
        {
          ...record,
          receipt: {
            ...record.receipt,
            state: "dispatched",
            nativeTurnId: draft.data.nativeTurnId,
            recordedAt: new Date().toISOString(),
          },
        },
        [draft],
      )
      this.database.query("UPDATE journal_commands SET settled = 1 WHERE id = ?").run(record.id)
    })
    return appended
  }

  /** Finite durable replay snapshot. A live transport must subscribe/poll separately after this cursor. */
  async *read(streamId: string, after?: EventCursor): AsyncIterable<EventDelivery> {
    const deliveries = this.database.transaction(() => {
      const stream = this.lookupStream(streamId)
      if (after) validateCursor(streamId, stream, after)
      if (!stream) return []
      const retention = this.database
        .query<
          { through_sequence: number; snapshot: string },
          [string]
        >("SELECT through_sequence, snapshot FROM journal_retention WHERE stream_id = ?")
        .get(streamId)
      if (retention && (after?.sequence ?? 0) < retention.through_sequence) {
        return [
          {
            kind: "gap",
            recovery: {
              status: "gap",
              reason: "Requested events have been pruned",
              snapshot: JSON.parse(retention.snapshot) as ArtifactReference,
              cursor: { streamId, epoch: stream.epoch, sequence: retention.through_sequence },
            },
          } satisfies EventDelivery,
        ]
      }
      return this.database
        .query<{ event: string }, [string, string, number]>(
          "SELECT event FROM journal_events WHERE stream_id = ? AND epoch = ? AND sequence > ? ORDER BY sequence",
        )
        .all(streamId, stream.epoch, after?.sequence ?? 0)
        .map((row): EventDelivery => ({ kind: "event", event: JSON.parse(row.event) as AgentEvent }))
    })()
    for (const delivery of deliveries) yield delivery
  }

  async cursor(streamId: string): Promise<EventCursor | undefined> {
    const stream = this.lookupStream(streamId)
    return stream ? { streamId, epoch: stream.epoch, sequence: stream.last_sequence } : undefined
  }

  /** The caller must first durably persist a projection snapshot covering exactly this cursor. */
  async prune(streamId: string, through: EventCursor, snapshot: ArtifactReference): Promise<void> {
    if (
      !snapshot.id ||
      !/^[a-f0-9]{64}$/i.test(snapshot.sha256) ||
      !Number.isSafeInteger(snapshot.sizeBytes) ||
      snapshot.sizeBytes < 0
    ) {
      throw new Error("Retention requires a valid durable snapshot reference")
    }
    this.database
      .transaction(() => {
        validateCursor(streamId, this.lookupStream(streamId), through)
        const existing = this.database
          .query<
            { through_sequence: number },
            [string]
          >("SELECT through_sequence FROM journal_retention WHERE stream_id = ?")
          .get(streamId)
        if (existing && through.sequence < existing.through_sequence)
          throw new Error("Retention cursor cannot move backward")
        this.database
          .query(
            `INSERT INTO journal_retention (stream_id, through_sequence, snapshot) VALUES (?, ?, ?)
        ON CONFLICT (stream_id) DO UPDATE SET through_sequence = excluded.through_sequence, snapshot = excluded.snapshot`,
          )
          .run(streamId, through.sequence, JSON.stringify(snapshot))
        this.database
          .query("DELETE FROM journal_events WHERE stream_id = ? AND epoch = ? AND sequence <= ?")
          .run(streamId, through.epoch, through.sequence)
        // Keep compact origin hashes: replaying pruned output must not mint fresh host events.
      })
      .immediate()
  }

  close() {
    this.database.close()
  }

  private lookupCommand(id: string): CommandRecord | undefined {
    const row = this.database
      .query<{ record: string }, [string]>("SELECT record FROM journal_commands WHERE id = ?")
      .get(id)
    return row ? (JSON.parse(row.record) as CommandRecord) : undefined
  }

  private lookupPermission(id: string): PermissionRecord | undefined {
    const row = this.database
      .query<{ record: string }, [string]>("SELECT record FROM journal_permissions WHERE id = ?")
      .get(id)
    return row ? (JSON.parse(row.record) as PermissionRecord) : undefined
  }

  private writePermission(record: PermissionRecord) {
    this.database
      .query(
        `INSERT INTO journal_permissions (id, session_id, state, record) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET state = excluded.state, record = excluded.record`,
      )
      .run(record.request.requestId, record.request.sessionId, record.state, JSON.stringify(record))
  }

  private writePermissionRequest(request: PermissionRequest): { created: boolean; record: PermissionRecord } {
    validatePermissionRequest(request)
    const existing = this.lookupPermission(request.requestId)
    if (existing) {
      if (canonicalJson(existing.request) !== canonicalJson(request))
        throw new Error("Permission conflict: ID is already bound to a different request")
      return { created: false, record: existing }
    }
    const record: PermissionRecord = { request: structuredClone(request), state: "pending" }
    this.writePermission(record)
    return { created: true, record }
  }

  private writePermissionResolution(resolution: PermissionResolution) {
    const record = this.lookupPermission(resolution.requestId)
    if (!record) throw new Error("Unknown permission request")
    assertPermissionBinding(record.request, resolution)
    if (
      !resolution.actorId?.trim() ||
      !Number.isFinite(Date.parse(resolution.decidedAt)) ||
      !["allowed", "denied", "expired"].includes(resolution.outcome)
    )
      throw new Error("Invalid permission resolution")
    const choice = record.request.choices.find((choice) => choice.id === resolution.choiceId)
    if (
      resolution.choiceId !== undefined &&
      (!choice || choice.scope !== "once" || (choice.action === "allow") !== (resolution.outcome === "allowed"))
    )
      throw new Error("Permission resolution does not match an offered once choice")
    if (resolution.outcome === "allowed") {
      // Native events can acknowledge a host decision, but can never manufacture permission authority.
      if (
        !record.intent ||
        canonicalJson(record.intent) !== canonicalJson(resolution) ||
        record.state === "pending" ||
        (record.resolution && record.resolution.outcome !== "allowed") ||
        Date.parse(resolution.decidedAt) >= Date.parse(record.request.expiresAt)
      )
        throw new Error("Permission grant has no matching live host intent")
    }
    if (record.state === "resolved" && record.resolution?.outcome !== "allowed") {
      if (canonicalJson(record.resolution) !== canonicalJson(resolution))
        throw new Error("Permission conflict: terminal denial or expiry cannot be replaced")
      return
    }
    // A native timeout can win while a grant is being flushed. Preserve its earlier audited intent.
    this.writePermission({ ...record, state: "resolved", resolution: structuredClone(resolution) })
  }

  private lookupStream(id: string) {
    return this.database
      .query<StreamRow, [string]>("SELECT id, epoch, last_sequence FROM journal_streams WHERE id = ?")
      .get(id)
  }

  private writeCommand(record: CommandRecord, drafts: readonly AgentEventDraft[]) {
    validateCommand(record)
    const existing = this.lookupCommand(record.id)
    if (!existing) {
      if (record.receipt.state !== "admitted") throw new Error("A new command must be admitted")
      this.database
        .query("INSERT INTO journal_commands (id, record) VALUES (?, ?)")
        .run(record.id, JSON.stringify(record))
      return
    }
    assertCommandIdentity(existing, record)
    if (existing.receipt.nativeTurnId && existing.receipt.nativeTurnId !== record.receipt.nativeTurnId) {
      throw new Error("Command conflict: native turn identity cannot change")
    }
    const before = existing.receipt.state
    const after = record.receipt.state
    const settled = this.database
      .query<{ settled: number }, [string]>("SELECT settled FROM journal_commands WHERE id = ?")
      .get(record.id)!.settled
    if (settled && before !== after) throw new Error("A settled command receipt cannot regress")
    const allowed =
      before === after ||
      (before === "admitted" && (after === "dispatched" || after === "rejected" || after === "uncertain")) ||
      (before === "dispatched" && after === "uncertain") ||
      (before === "uncertain" && after === "dispatched" && drafts.some((draft) => isCompletion(record, draft)))
    if (!allowed) throw new Error("Invalid command receipt transition")
    this.database.query("UPDATE journal_commands SET record = ? WHERE id = ?").run(JSON.stringify(record), record.id)
  }
}

function validateCommand(record: CommandRecord) {
  if (!record.id || !record.sessionId || !record.admissionId || !/^[a-f0-9]{64}$/i.test(record.requestSha256)) {
    throw new Error("Invalid command identity")
  }
  if (record.receipt.commandId !== record.id || record.receipt.sessionId !== record.sessionId) {
    throw new Error("Command receipt identity does not match its record")
  }
}

function assertCommandIdentity(existing: CommandRecord, record: CommandRecord) {
  if (
    existing.requestSha256 !== record.requestSha256 ||
    existing.sessionId !== record.sessionId ||
    existing.admissionId !== record.admissionId
  )
    throw new Error("Command conflict: ID is already bound to a different request")
}

function permissionBinding(value: PermissionBinding): PermissionBinding {
  return {
    requestId: value.requestId,
    sessionId: value.sessionId,
    targetId: value.targetId,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    nativeSessionId: value.nativeSessionId,
    nativeTurnId: value.nativeTurnId,
    nativeRequestId: value.nativeRequestId,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    leaseGeneration: value.leaseGeneration,
    operationSha256: value.operationSha256,
  }
}

function assertPermissionBinding(request: PermissionRequest, candidate: PermissionBinding) {
  if (canonicalJson(permissionBinding(request)) !== canonicalJson(permissionBinding(candidate)))
    throw new Error("Permission binding mismatch")
}

function validatePermissionRequest(request: PermissionRequest) {
  if (
    [
      request.requestId,
      request.sessionId,
      request.targetId,
      request.workspaceId,
      request.runtimeId,
      request.nativeSessionId,
      request.nativeTurnId,
      request.nativeRequestId,
      request.policyId,
      request.policyVersion,
      request.action,
    ].some((value) => typeof value !== "string" || !value.trim()) ||
    !Number.isSafeInteger(request.leaseGeneration) ||
    request.leaseGeneration < 0 ||
    !/^[a-f0-9]{64}$/i.test(request.operationSha256) ||
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    !Array.isArray(request.resources) ||
    request.resources.some((resource) => typeof resource !== "string") ||
    !Array.isArray(request.choices) ||
    !request.choices.length ||
    request.choices.some(
      (choice) =>
        typeof choice.id !== "string" ||
        !choice.id.trim() ||
        typeof choice.label !== "string" ||
        !["allow", "deny"].includes(choice.action) ||
        !["once", "session", "workspace"].includes(choice.scope),
    ) ||
    new Set(request.choices.map((choice) => choice.id)).size !== request.choices.length
  )
    throw new Error("Invalid permission request")
  canonicalJson(request)
}

function permissionTimestamp(now: number) {
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) throw new Error("Invalid permission decision time")
  return new Date(now).toISOString()
}

function validateOrigin(draft: AgentEventDraft) {
  if (
    !draft.origin.streamId ||
    !draft.origin.epoch ||
    !draft.origin.eventId ||
    (draft.origin.sequence !== undefined && (!Number.isSafeInteger(draft.origin.sequence) || draft.origin.sequence < 0))
  ) {
    throw new Error("Invalid source event identity")
  }
}

function validateCursor(streamId: string, stream: StreamRow | null, cursor: EventCursor) {
  if (
    !stream ||
    cursor.streamId !== streamId ||
    cursor.epoch !== stream.epoch ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 0 ||
    cursor.sequence > stream.last_sequence
  ) {
    throw new Error("Cursor does not belong to this stream and epoch or is outside its sequence range")
  }
}

function isCompletion(record: CommandRecord, draft: AgentEventDraft) {
  return (
    draft.type === "agent.completed" &&
    draft.scope.commandId === record.id &&
    draft.scope.sessionId === record.sessionId &&
    (record.receipt.nativeTurnId === undefined || record.receipt.nativeTurnId === draft.data.nativeTurnId)
  )
}

/** Compare JSON content independently of object property insertion order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }
  throw new Error("Journal event must contain only JSON values")
}
