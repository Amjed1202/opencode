import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import type {
  AgentEvent,
  AgentEventDraft,
  AgentSession,
  ArtifactReference,
  EventCursor,
  EventDelivery,
} from "@harness/protocol"
import type { CommandRecord, EventStore, SessionStore } from "./index"

interface StreamRow {
  id: string
  epoch: string
  last_sequence: number
}

export class SQLiteJournal implements EventStore, SessionStore {
  private readonly database: Database

  /** The caller supplies an application-owned database path; no runtime database is discovered or imported. */
  constructor(path: string) {
    if (!path.trim()) throw new Error("An explicit journal database path is required")
    this.database = new Database(path, { create: true, strict: true })
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS journal_commands (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0
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
    if (!streamId) throw new Error("A host stream ID is required")
    return this.database
      .transaction(() => {
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
          this.database
            .query("INSERT OR IGNORE INTO journal_streams (id, epoch) VALUES (?, ?)")
            .run(streamId, randomUUID())
          const stream = this.lookupStream(streamId)!
          if (!Number.isSafeInteger(stream.last_sequence + 1)) throw new Error("Host stream sequence exhausted")
          const event: AgentEvent = {
            ...draft,
            protocolVersion: "0.1",
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
      })
      .immediate()
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
