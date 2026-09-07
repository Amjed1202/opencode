import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import type {
  AgentEvent,
  AgentEventDraft,
  AgentSession,
  ArtifactReference,
  EventCursor,
  EventDelivery,
  EventScope,
  HumanInputRequest,
  HumanInputResponse,
  HumanInputResolution,
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

/** Only bound option identifiers are retained; review tokens and native display content are never stored. */
export interface InputRecord {
  readonly request: HumanInputRequest
  readonly state: "pending" | "claimed" | "resolved" | "uncertain"
  readonly response?: HumanInputResponse
  readonly intent?: HumanInputResolution
  readonly resolution?: HumanInputResolution
}

/** Host-submitted text is an attempt, not evidence that native work started or completed. */
export interface JournalUserMessage {
  readonly commandId: string
  readonly messageId: string
  readonly text: string
  readonly recordedAt: string
}

export class SQLiteJournal implements EventStore, SessionStore {
  private readonly database: Database
  private readonly statements = new Map<string, Statement<unknown, SQLQueryBindings[]>>()

  /** The caller supplies an application-owned database path; no runtime database is discovered or imported. */
  constructor(path: string) {
    if (!path.trim()) throw new Error("An explicit journal database path is required")
    this.database = new Database(path, { create: true, strict: true })
    try {
      const events = this.query<{ type: string }, []>(
        "SELECT type FROM sqlite_master WHERE name = 'journal_events'",
      ).get()
      if (
        events &&
        (events.type !== "table" ||
          this.query(
            `SELECT 1 FROM journal_events
            WHERE CASE WHEN json_valid(event) THEN json_extract(event, '$.protocolVersion') IS NOT '0.3' ELSE 1 END
            LIMIT 1`,
          ).get())
      )
        throw new Error("Unsupported stored protocol")
    } catch {
      // Never rewrite an old audit trail or partially migrate schema while rejecting its protocol.
      this.close()
      throw new Error("Incompatible journal event protocol; explicit migration to protocol 0.3 is required")
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
      CREATE TABLE IF NOT EXISTS journal_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record TEXT NOT NULL,
        scope TEXT,
        stream_id TEXT
      );
      CREATE INDEX IF NOT EXISTS journal_inputs_pending ON journal_inputs (session_id, state);
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
      CREATE TABLE IF NOT EXISTS journal_session_updates (
        session_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_host_contexts (
        session_id TEXT PRIMARY KEY,
        context_sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_user_messages (
        command_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_user_messages_session ON journal_user_messages (session_id, recorded_at);
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
        this.query("INSERT INTO journal_commands (id, record) VALUES (?, ?)").run(record.id, JSON.stringify(record))
        return { created: true, record }
      })
      .immediate()
  }

  async command(id: string): Promise<CommandRecord | undefined> {
    return this.lookupCommand(id)
  }

  async commands(sessionId: string): Promise<readonly CommandRecord[]> {
    return this.query<{ record: string }, []>("SELECT record FROM journal_commands ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.record) as CommandRecord)
      .filter((record) => record.sessionId === sessionId)
  }

  /** Unknown native creates have no saved session and therefore cannot safely be scoped to a workspace. */
  async hasUnsettledWork(workspaceId: string): Promise<boolean> {
    return Boolean(
      this.query<{ pending: number }, [string]>(
        `SELECT 1 AS pending FROM journal_commands AS commands
         LEFT JOIN journal_sessions AS sessions ON sessions.id = json_extract(commands.record, '$.sessionId')
         WHERE commands.settled = 0 AND (sessions.id IS NULL OR sessions.workspace_id = ?)
         LIMIT 1`,
      ).get(workspaceId),
    )
  }

  async permission(id: string): Promise<PermissionRecord | undefined> {
    return this.lookupPermission(id)
  }

  async pendingPermissions(sessionId: string): Promise<readonly PermissionRecord[]> {
    return this.query<{ record: string }, [string]>(
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
    reviewArtifactSha256?: string,
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
        validateReviewedArtifact(record.request.reviewArtifact, reviewArtifactSha256, choice.action === "allow")
        const resolution: PermissionResolution = {
          ...permissionBinding(record.request),
          choiceId: choice.id,
          outcome: choice.action === "allow" ? "allowed" : "denied",
          actorId: trustedActorId,
          decidedAt,
          ...(reviewArtifactSha256 === undefined ? {} : { reviewArtifactSha256 }),
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
        this.query<{ record: string }, []>(
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
            const original = this.query<{ scope: string }, [string]>(
              "SELECT scope FROM journal_permission_scopes WHERE request_id = ?",
            ).get(record.request.requestId)
            const stream = this.query<{ stream_id: string }, [string]>(
              "SELECT stream_id FROM journal_permission_streams WHERE request_id = ?",
            ).get(record.request.requestId)
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

  async input(id: string): Promise<InputRecord | undefined> {
    return this.lookupInput(id)
  }

  async pendingInputs(sessionId: string): Promise<readonly InputRecord[]> {
    return this.query<{ record: string }, [string]>(
      "SELECT record FROM journal_inputs WHERE session_id = ? AND state = 'pending' ORDER BY id",
    )
      .all(sessionId)
      .map((row) => JSON.parse(row.record) as InputRecord)
  }

  /** Persist the normalized intent before consuming the native handle; an exact retry cannot send twice. */
  async claimInput(
    response: HumanInputResponse,
    trustedActorId: string,
    now = Date.now(),
    reviewArtifactSha256?: string,
  ): Promise<{ created: boolean; record: InputRecord }> {
    const decidedAt = permissionTimestamp(now)
    if (!trustedActorId.trim()) throw new Error("A trusted input actor is required")
    return this.database
      .transaction(() => {
        const record = this.lookupInput(response.requestId)
        if (!record) throw new Error("Unknown input request")
        assertPermissionBinding(record.request, response)
        const normalized = normalizeInputResponse(record.request, response)
        if (record.response) {
          if (canonicalJson(record.response) !== canonicalJson(normalized))
            throw new Error("Input conflict: request already has a different response")
          return { created: false, record }
        }
        if (record.state !== "pending") throw new Error("Input request is no longer pending")
        if (Date.parse(record.request.expiresAt) <= now) throw new Error("Input request has expired")
        validateReviewedArtifact(record.request.reviewArtifact, reviewArtifactSha256, normalized.action === "answer")
        const next: InputRecord = {
          ...record,
          state: "claimed",
          response: normalized,
          intent: {
            ...permissionBinding(record.request),
            outcome: normalized.action === "answer" ? "answered" : "cancelled",
            actorId: trustedActorId,
            decidedAt,
            ...(normalized.action === "answer"
              ? { answerSha256: createHash("sha256").update(canonicalJson(normalized.selections)).digest("hex") }
              : {}),
            ...(reviewArtifactSha256 === undefined ? {} : { reviewArtifactSha256 }),
          },
        }
        this.writeInput(next)
        return { created: true, record: next }
      })
      .immediate()
  }

  async markInputUncertain(id: string): Promise<InputRecord> {
    return this.database
      .transaction(() => {
        const record = this.lookupInput(id)
        if (!record) throw new Error("Unknown input request")
        if (record.state === "resolved" || record.state === "uncertain") return record
        if (record.state !== "claimed") throw new Error("Only a claimed input can become uncertain")
        const next: InputRecord = { ...record, state: "uncertain" }
        this.writeInput(next)
        return next
      })
      .immediate()
  }

  /** Exclusive recovery expires lost native handles atomically with their replay events; it never answers. */
  async recoverInputs(now = Date.now(), trustedActorId = "host:recovery"): Promise<readonly InputRecord[]> {
    const decidedAt = permissionTimestamp(now)
    if (!trustedActorId.trim()) throw new Error("A trusted input actor is required")
    return this.database
      .transaction(() =>
        this.query<{ record: string; scope: string | null; stream_id: string | null }, []>(
          "SELECT record, scope, stream_id FROM journal_inputs WHERE state IN ('pending', 'claimed') ORDER BY id",
        )
          .all()
          .map((row) => {
            const record = JSON.parse(row.record) as InputRecord
            if (record.state === "claimed") {
              const next: InputRecord = { ...record, state: "uncertain" }
              this.writeInput(next)
              return next
            }
            this.appendEvents(row.stream_id ?? record.request.sessionId, [
              {
                type: "input.resolved",
                data: { ...permissionBinding(record.request), outcome: "expired", actorId: trustedActorId, decidedAt },
                scope: {
                  ...(row.scope ? (JSON.parse(row.scope) as EventScope) : {}),
                  sessionId: record.request.sessionId,
                  targetId: record.request.targetId,
                  workspaceId: record.request.workspaceId,
                  runtimeId: record.request.runtimeId,
                  turnId: record.request.nativeTurnId,
                },
                origin: {
                  streamId: `host:inputs:${record.request.sessionId}`,
                  epoch: "1",
                  eventId: `${record.request.requestId}:expired`,
                  identityStrategy: "adapter-assigned",
                },
                observedAt: decidedAt,
              },
            ])
            return this.lookupInput(record.request.requestId)!
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
        this.query("UPDATE journal_commands SET settled = 1 WHERE id = ?").run(id)
      })
      .immediate()
  }

  /** Distinguishes a durable successful create/resume result from an unresolved dispatch marker. */
  async isComplete(id: string): Promise<boolean> {
    return (
      this.query<{ settled: number }, [string]>("SELECT settled FROM journal_commands WHERE id = ?").get(id)
        ?.settled === 1
    )
  }

  /** Call only after acquiring exclusive runtime ownership at restart, never against an active dispatcher. */
  async recoverPending(): Promise<readonly CommandRecord[]> {
    return this.database
      .transaction(() => {
        const pending = this.query<{ record: string }, []>(
          "SELECT record FROM journal_commands WHERE settled = 0 ORDER BY id",
        )
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
        const active = this.query<{ session: string }, []>("SELECT session FROM journal_sessions ORDER BY id")
          .all()
          .map((row) => JSON.parse(row.session) as AgentSession)
          .filter(
            (session) =>
              session.status === "running" ||
              session.status === "awaiting-permission" ||
              session.status === "awaiting-input",
          )
        return active.map((session): AgentSession => {
          const recovered: AgentSession = { ...session, status: "uncertain", revision: session.revision + 1 }
          this.query("UPDATE journal_sessions SET revision = ?, session = ? WHERE id = ?").run(
            recovered.revision,
            JSON.stringify(recovered),
            recovered.id,
          )
          return recovered
        })
      })
      .immediate()
  }

  async get(id: string): Promise<AgentSession | undefined> {
    const row = this.query<{ session: string }, [string]>("SELECT session FROM journal_sessions WHERE id = ?").get(id)
    return row ? (JSON.parse(row.session) as AgentSession) : undefined
  }

  async list(workspaceId: string): Promise<readonly AgentSession[]> {
    return this.query<{ session: string }, [string]>(
      "SELECT session FROM journal_sessions WHERE workspace_id = ? ORDER BY id",
    )
      .all(workspaceId)
      .map((row) => JSON.parse(row.session) as AgentSession)
  }

  /** Bounded local catalog only; no native history discovery is performed. */
  async recentSessions(workspaceId: string, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid session preview limit")
    const rows = this.query<{ session: string; updated_at: string }, [string, number]>(
      `SELECT session, MAX(json_extract(session, '$.createdAt'),
        COALESCE((SELECT updated_at FROM journal_session_updates WHERE session_id = sessions.id), ''),
        COALESCE((SELECT MAX(json_extract(event, '$.observedAt')) FROM journal_events WHERE stream_id = sessions.id), ''),
        COALESCE((SELECT MAX(recorded_at) FROM journal_user_messages WHERE session_id = sessions.id), ''),
        COALESCE((SELECT MAX(json_extract(record, '$.receipt.recordedAt')) FROM journal_commands
          WHERE json_extract(record, '$.sessionId') = sessions.id), '')) AS updated_at
       FROM journal_sessions AS sessions WHERE workspace_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(workspaceId, limit + 1)
    return {
      items: rows
        .slice(0, limit)
        .map((row) => ({ session: JSON.parse(row.session) as AgentSession, updatedAt: row.updated_at })),
      truncated: rows.length > limit,
    }
  }

  /** Immutable host-selected context. A missing historical binding never authorizes native attachment. */
  async bindHostContext(sessionId: string, contextSha256: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(contextSha256) || !(await this.get(sessionId)))
      throw new Error("Invalid host context binding")
    this.database
      .transaction(() => {
        const current = this.query<{ context_sha256: string }, [string]>(
          "SELECT context_sha256 FROM journal_host_contexts WHERE session_id = ?",
        ).get(sessionId)
        if (current && current.context_sha256 !== contextSha256) throw new Error("Host context binding conflict")
        this.query("INSERT OR IGNORE INTO journal_host_contexts (session_id, context_sha256) VALUES (?, ?)").run(
          sessionId,
          contextSha256,
        )
      })
      .immediate()
  }

  async hostContext(sessionId: string): Promise<string | undefined> {
    return this.query<{ context_sha256: string }, [string]>(
      "SELECT context_sha256 FROM journal_host_contexts WHERE session_id = ?",
    ).get(sessionId)?.context_sha256
  }

  async recordUserMessage(sessionId: string, message: JournalUserMessage): Promise<void> {
    if (
      !message.commandId ||
      message.commandId.length > 256 ||
      !message.messageId ||
      message.messageId.length > 256 ||
      !message.text ||
      Buffer.byteLength(message.text) > 256 * 1024 ||
      !Number.isFinite(Date.parse(message.recordedAt)) ||
      !(await this.get(sessionId))
    )
      throw new Error("Invalid local user message")
    this.database
      .transaction(() => {
        const current = this.query<
          {
            session_id: string
            message_id: string
            text: string
          },
          [string]
        >("SELECT session_id, message_id, text FROM journal_user_messages WHERE command_id = ?").get(message.commandId)
        if (
          current &&
          (current.session_id !== sessionId ||
            current.message_id !== message.messageId ||
            current.text !== message.text)
        )
          throw new Error("Local user message conflict")
        this.query(
          "INSERT OR IGNORE INTO journal_user_messages (command_id, session_id, message_id, text, recorded_at) VALUES (?, ?, ?, ?, ?)",
        ).run(message.commandId, sessionId, message.messageId, message.text, message.recordedAt)
      })
      .immediate()
  }

  /** Bounded journal tail. Restricted artifact contents and arbitrary native history are never opened. */
  async preview(sessionId: string, maxEvents = 1000, maxBytes = 512 * 1024) {
    if (
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents > 2000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1024 ||
      maxBytes > 1024 * 1024
    )
      throw new Error("Invalid history preview limits")
    return this.database.transaction(() => {
      const stream = this.lookupStream(sessionId)
      const rows = this.query<{ event: string | null; sequence: number }, [number, string, number]>(
        `SELECT CASE WHEN length(CAST(event AS BLOB)) <= ? THEN event ELSE NULL END AS event, sequence
         FROM journal_events WHERE stream_id = ? ORDER BY sequence DESC LIMIT ?`,
      ).all(maxBytes, sessionId, maxEvents + 1)
      const users = this.query<
        {
          command_id: string
          message_id: string
          text: string | null
          recorded_at: string
          state: string | null
        },
        [number, string]
      >(
        `SELECT command_id, message_id, CASE WHEN length(CAST(text AS BLOB)) <= ? THEN text ELSE NULL END AS text,
          recorded_at, json_extract(commands.record, '$.receipt.state') AS state
         FROM journal_user_messages AS messages LEFT JOIN journal_commands AS commands ON commands.id = messages.command_id
         WHERE messages.session_id = ? ORDER BY recorded_at DESC, command_id DESC LIMIT 201`,
      ).all(maxBytes, sessionId)
      let bytes = 0
      let truncated = rows.length > maxEvents || users.length > 200
      const events = rows
        .slice(0, maxEvents)
        .flatMap((row) => {
          if (!row.event || bytes + Buffer.byteLength(row.event) > maxBytes) {
            truncated = true
            return []
          }
          bytes += Buffer.byteLength(row.event)
          return [JSON.parse(row.event) as AgentEvent]
        })
        .reverse()
      const messages = users
        .slice(0, 200)
        .flatMap((row) => {
          if (!row.text || bytes + Buffer.byteLength(row.text) > maxBytes) {
            truncated = true
            return []
          }
          bytes += Buffer.byteLength(row.text)
          return [
            {
              commandId: row.command_id,
              messageId: row.message_id,
              text: row.text,
              recordedAt: row.recorded_at,
              state: row.state ?? "not-recorded",
            },
          ]
        })
        .reverse()
      const retained = this.query<{ through_sequence: number }, [string]>(
        "SELECT through_sequence FROM journal_retention WHERE stream_id = ?",
      ).get(sessionId)
      return {
        events,
        messages,
        truncated: truncated || Boolean(retained),
        ...(stream ? { cursor: { streamId: sessionId, epoch: stream.epoch, sequence: stream.last_sequence } } : {}),
      }
    })()
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
        const existing = this.query<{ revision: number }, [string]>(
          "SELECT revision FROM journal_sessions WHERE id = ?",
        ).get(session.id)
        if (expectedRevision === null ? existing !== null : existing?.revision !== expectedRevision)
          throw new Error("Session revision conflict")
        this.query(
          `INSERT INTO journal_sessions (id, workspace_id, revision, session) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET workspace_id = excluded.workspace_id, revision = excluded.revision, session = excluded.session`,
        ).run(session.id, session.workspaceId, session.revision, JSON.stringify(session))
        this.query(
          `INSERT INTO journal_session_updates (session_id, updated_at) VALUES (?, ?)
          ON CONFLICT (session_id) DO UPDATE SET updated_at = excluded.updated_at`,
        ).run(session.id, new Date().toISOString())
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
      const existing = this.query<{ host_stream_id: string; content: string }, [string, string, string]>(
        "SELECT host_stream_id, content FROM journal_origins WHERE stream_id = ? AND epoch = ? AND event_id = ?",
      ).get(draft.origin.streamId, draft.origin.epoch, draft.origin.eventId)
      if (existing) {
        if (existing.host_stream_id !== streamId || existing.content !== content)
          throw new Error("Origin conflict: source identity has different content or host stream")
        return []
      }
      if (
        draft.type === "permission.requested" ||
        draft.type === "permission.resolved" ||
        draft.type === "input.requested" ||
        draft.type === "input.resolved"
      ) {
        const original =
          draft.type === "input.requested" || draft.type === "input.resolved"
            ? this.query<{ scope: string | null }, [string]>("SELECT scope FROM journal_inputs WHERE id = ?").get(
                draft.data.requestId,
              )
            : this.query<{ scope: string }, [string]>(
                "SELECT scope FROM journal_permission_scopes WHERE request_id = ?",
              ).get(draft.data.requestId)
        const scope = original?.scope ? (JSON.parse(original.scope) as EventScope) : undefined
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
          ((draft.type === "permission.resolved" || draft.type === "input.resolved") &&
            draft.scope.commandId !== undefined &&
            draft.scope.commandId !== scope?.commandId)
        )
          throw new Error("Permission or input event scope mismatch")
        if (draft.type === "permission.requested") {
          this.writePermissionRequest(draft.data)
          this.query("INSERT OR IGNORE INTO journal_permission_scopes (request_id, scope) VALUES (?, ?)").run(
            draft.data.requestId,
            JSON.stringify(draft.scope),
          )
          this.query("INSERT OR IGNORE INTO journal_permission_streams (request_id, stream_id) VALUES (?, ?)").run(
            draft.data.requestId,
            streamId,
          )
        }
        if (draft.type === "permission.resolved") this.writePermissionResolution(draft.data)
        if (draft.type === "input.requested") {
          this.writeInputRequest(draft.data)
          this.query(
            "UPDATE journal_inputs SET scope = COALESCE(scope, ?), stream_id = COALESCE(stream_id, ?) WHERE id = ?",
          ).run(JSON.stringify(draft.scope), streamId, draft.data.requestId)
        }
        if (draft.type === "input.resolved") this.writeInputResolution(draft.data)
      }
      this.query("INSERT OR IGNORE INTO journal_streams (id, epoch) VALUES (?, ?)").run(streamId, randomUUID())
      const stream = this.lookupStream(streamId)!
      if (!Number.isSafeInteger(stream.last_sequence + 1)) throw new Error("Host stream sequence exhausted")
      const event: AgentEvent = {
        ...draft,
        protocolVersion: "0.3",
        id: randomUUID(),
        streamId,
        epoch: stream.epoch,
        sequence: stream.last_sequence + 1,
      }
      this.query(
        "INSERT INTO journal_origins (stream_id, epoch, event_id, host_stream_id, content) VALUES (?, ?, ?, ?, ?)",
      ).run(draft.origin.streamId, draft.origin.epoch, draft.origin.eventId, streamId, content)
      this.query("INSERT INTO journal_events (id, stream_id, epoch, sequence, event) VALUES (?, ?, ?, ?, ?)").run(
        event.id,
        streamId,
        event.epoch,
        event.sequence,
        JSON.stringify(event),
      )
      this.query("UPDATE journal_streams SET last_sequence = ? WHERE id = ?").run(event.sequence, streamId)
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
      this.query("UPDATE journal_commands SET settled = 1 WHERE id = ?").run(record.id)
    })
    return appended
  }

  /** Finite durable replay snapshot. A live transport must subscribe/poll separately after this cursor. */
  async *read(streamId: string, after?: EventCursor): AsyncIterable<EventDelivery> {
    const deliveries = this.database.transaction(() => {
      const stream = this.lookupStream(streamId)
      if (after) validateCursor(streamId, stream, after)
      if (!stream) return []
      const retention = this.query<{ through_sequence: number; snapshot: string }, [string]>(
        "SELECT through_sequence, snapshot FROM journal_retention WHERE stream_id = ?",
      ).get(streamId)
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
      return this.query<{ event: string }, [string, string, number]>(
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
        const existing = this.query<{ through_sequence: number }, [string]>(
          "SELECT through_sequence FROM journal_retention WHERE stream_id = ?",
        ).get(streamId)
        if (existing && through.sequence < existing.through_sequence)
          throw new Error("Retention cursor cannot move backward")
        this.query(
          `INSERT INTO journal_retention (stream_id, through_sequence, snapshot) VALUES (?, ?, ?)
        ON CONFLICT (stream_id) DO UPDATE SET through_sequence = excluded.through_sequence, snapshot = excluded.snapshot`,
        ).run(streamId, through.sequence, JSON.stringify(snapshot))
        this.query("DELETE FROM journal_events WHERE stream_id = ? AND epoch = ? AND sequence <= ?").run(
          streamId,
          through.epoch,
          through.sequence,
        )
        // Keep compact origin hashes: replaying pruned output must not mint fresh host events.
      })
      .immediate()
  }

  close() {
    // Bun 1.3.14's query cache evicts after 20 statements without finalizing them. Own every
    // static query so close never leaves a SQLite zombie connection waiting for garbage collection.
    for (const statement of this.statements.values()) statement.finalize()
    this.statements.clear()
    this.database.close(true)
  }

  private query<Row = unknown, Parameters extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string) {
    const existing = this.statements.get(sql)
    if (existing) return existing as Statement<Row, Parameters>
    const statement = this.database.prepare<Row, Parameters>(sql)
    this.statements.set(sql, statement as Statement<unknown, SQLQueryBindings[]>)
    return statement
  }

  private lookupCommand(id: string): CommandRecord | undefined {
    const row = this.query<{ record: string }, [string]>("SELECT record FROM journal_commands WHERE id = ?").get(id)
    return row ? (JSON.parse(row.record) as CommandRecord) : undefined
  }

  private lookupPermission(id: string): PermissionRecord | undefined {
    const row = this.query<{ record: string }, [string]>("SELECT record FROM journal_permissions WHERE id = ?").get(id)
    return row ? (JSON.parse(row.record) as PermissionRecord) : undefined
  }

  private lookupInput(id: string): InputRecord | undefined {
    const row = this.query<{ record: string }, [string]>("SELECT record FROM journal_inputs WHERE id = ?").get(id)
    return row ? (JSON.parse(row.record) as InputRecord) : undefined
  }

  private writeInput(record: InputRecord) {
    this.query(
      `INSERT INTO journal_inputs (id, session_id, state, record) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET state = excluded.state, record = excluded.record`,
    ).run(record.request.requestId, record.request.sessionId, record.state, JSON.stringify(record))
  }

  private writeInputRequest(request: HumanInputRequest) {
    validateInputRequest(request)
    const existing = this.lookupInput(request.requestId)
    if (existing) {
      if (canonicalJson(existing.request) !== canonicalJson(request))
        throw new Error("Input conflict: ID is already bound to a different request")
      return
    }
    this.writeInput({ request: structuredClone(request), state: "pending" })
  }

  private writeInputResolution(resolution: HumanInputResolution) {
    const record = this.lookupInput(resolution.requestId)
    if (!record) throw new Error("Unknown input request")
    assertPermissionBinding(record.request, resolution)
    if (
      !resolution.actorId?.trim() ||
      !Number.isFinite(Date.parse(resolution.decidedAt)) ||
      !["answered", "cancelled", "expired"].includes(resolution.outcome) ||
      Object.keys(resolution).some(
        (key) =>
          ![
            ...Object.keys(permissionBinding(resolution)),
            "outcome",
            "actorId",
            "decidedAt",
            "answerSha256",
            "reviewArtifactSha256",
          ].includes(key),
      ) ||
      (resolution.answerSha256 !== undefined &&
        (!/^[a-f0-9]{64}$/i.test(resolution.answerSha256) || resolution.outcome !== "answered"))
    )
      throw new Error("Invalid input resolution")
    validateReviewedArtifact(record.request.reviewArtifact, resolution.reviewArtifactSha256, false)
    if (
      resolution.outcome === "answered" &&
      (!record.intent ||
        canonicalJson(record.intent) !== canonicalJson(resolution) ||
        record.state === "pending" ||
        (record.resolution && record.resolution.outcome !== "answered") ||
        Date.parse(resolution.decidedAt) >= Date.parse(record.request.expiresAt))
    )
      throw new Error("Input answer has no matching live host intent")
    if (record.state === "resolved" && record.resolution?.outcome !== "answered") {
      if (canonicalJson(record.resolution) !== canonicalJson(resolution))
        throw new Error("Input conflict: terminal cancellation or expiry cannot be replaced")
      return
    }
    this.writeInput({ ...record, state: "resolved", resolution: structuredClone(resolution) })
  }

  private writePermission(record: PermissionRecord) {
    this.query(
      `INSERT INTO journal_permissions (id, session_id, state, record) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET state = excluded.state, record = excluded.record`,
    ).run(record.request.requestId, record.request.sessionId, record.state, JSON.stringify(record))
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
    validateReviewedArtifact(record.request.reviewArtifact, resolution.reviewArtifactSha256, false)
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
    return this.query<StreamRow, [string]>("SELECT id, epoch, last_sequence FROM journal_streams WHERE id = ?").get(id)
  }

  private writeCommand(record: CommandRecord, drafts: readonly AgentEventDraft[]) {
    validateCommand(record)
    const existing = this.lookupCommand(record.id)
    if (!existing) {
      if (record.receipt.state !== "admitted") throw new Error("A new command must be admitted")
      this.query("INSERT INTO journal_commands (id, record) VALUES (?, ?)").run(record.id, JSON.stringify(record))
      return
    }
    assertCommandIdentity(existing, record)
    if (existing.receipt.nativeTurnId && existing.receipt.nativeTurnId !== record.receipt.nativeTurnId) {
      throw new Error("Command conflict: native turn identity cannot change")
    }
    const before = existing.receipt.state
    const after = record.receipt.state
    const settled = this.query<{ settled: number }, [string]>("SELECT settled FROM journal_commands WHERE id = ?").get(
      record.id,
    )!.settled
    if (settled && before !== after) throw new Error("A settled command receipt cannot regress")
    const allowed =
      before === after ||
      (before === "admitted" && (after === "dispatched" || after === "rejected" || after === "uncertain")) ||
      (before === "dispatched" && after === "uncertain") ||
      (before === "uncertain" && after === "dispatched" && drafts.some((draft) => isCompletion(record, draft)))
    if (!allowed) throw new Error("Invalid command receipt transition")
    this.query("UPDATE journal_commands SET record = ? WHERE id = ?").run(JSON.stringify(record), record.id)
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

function assertPermissionBinding(request: PermissionBinding, candidate: PermissionBinding) {
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
    (request.sourceRequestSha256 !== undefined &&
      (typeof request.sourceRequestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.sourceRequestSha256))) ||
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
  validateReviewArtifact(request.reviewArtifact)
}

function validateReviewArtifact(artifact: ArtifactReference | undefined) {
  if (artifact === undefined) return
  if (
    !artifact ||
    typeof artifact.id !== "string" ||
    !artifact.id.trim() ||
    artifact.id.length > 256 ||
    artifact.sensitivity !== "restricted" ||
    !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
    typeof artifact.mediaType !== "string" ||
    !artifact.mediaType ||
    artifact.mediaType.length > 128 ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0 ||
    Object.keys(artifact).some((key) => !["id", "sha256", "mediaType", "sizeBytes", "sensitivity"].includes(key))
  )
    throw new Error("Invalid restricted review artifact")
}

function validateReviewedArtifact(
  artifact: ArtifactReference | undefined,
  sha256: string | undefined,
  required: boolean,
) {
  if (
    (required && artifact && sha256 === undefined) ||
    (sha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(sha256) || artifact?.sha256 !== sha256))
  )
    throw new Error("Reviewed artifact does not match the bound request")
}

function validateInputRequest(request: HumanInputRequest) {
  const binding = permissionBinding(request)
  if (
    Object.entries(binding).some(([key, value]) =>
      key === "leaseGeneration"
        ? !Number.isSafeInteger(value) || Number(value) < 0
        : typeof value !== "string" || !value.trim(),
    ) ||
    !/^[a-f0-9]{64}$/i.test(request.operationSha256) ||
    (request.sourceRequestSha256 !== undefined &&
      (typeof request.sourceRequestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.sourceRequestSha256))) ||
    request.prompt !== "Choose one option for each question." ||
    request.schemaId !== "harness.choice-input.v1" ||
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    Object.keys(request).some(
      (key) =>
        ![
          ...Object.keys(binding),
          "prompt",
          "schemaId",
          "questions",
          "expiresAt",
          "reviewArtifact",
          "sourceRequestSha256",
        ].includes(key),
    ) ||
    !Array.isArray(request.questions) ||
    request.questions.length < 1 ||
    request.questions.length > 3 ||
    Array.from(request.questions).some(
      (question) =>
        !question ||
        Object.keys(question).some((key) => !["id", "optionIds"].includes(key)) ||
        !inputIdentifier(question.id) ||
        !Array.isArray(question.optionIds) ||
        question.optionIds.length < 2 ||
        question.optionIds.length > 8 ||
        Array.from(question.optionIds).some((id: unknown) => !inputIdentifier(id)) ||
        new Set(question.optionIds).size !== question.optionIds.length,
    ) ||
    new Set(request.questions.map((question) => question.id)).size !== request.questions.length
  )
    throw new Error("Invalid option-only input request")
  validateReviewArtifact(request.reviewArtifact)
  canonicalJson(request)
}

function normalizeInputResponse(request: HumanInputRequest, response: HumanInputResponse): HumanInputResponse {
  if (
    !Array.isArray(response.selections) ||
    !["answer", "cancel"].includes(response.action) ||
    Array.from(response.selections).some(
      (selection) =>
        !selection ||
        Object.keys(selection).some((key) => !["questionId", "optionId"].includes(key)) ||
        !inputIdentifier(selection.questionId) ||
        !inputIdentifier(selection.optionId),
    ) ||
    (response.action === "cancel" && response.selections.length !== 0) ||
    (response.action === "answer" &&
      (response.selections.length !== request.questions.length ||
        new Set(response.selections.map((selection) => selection.questionId)).size !== request.questions.length ||
        response.selections.some(
          (selection) =>
            !request.questions
              .find((question) => question.id === selection.questionId)
              ?.optionIds.includes(selection.optionId),
        )))
  )
    throw new Error("Input response must select exactly one offered option per question, or cancel with no selections")
  return {
    ...permissionBinding(request),
    action: response.action,
    selections: response.selections
      .map((selection) => ({ questionId: selection.questionId, optionId: selection.optionId }))
      .sort((left, right) => (left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0)),
  }
}

function inputIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
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
