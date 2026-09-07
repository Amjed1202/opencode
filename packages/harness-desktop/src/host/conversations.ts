import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import type { AgentSession } from "@harness/protocol"
import type { LocalRuntimeManager, SQLiteJournal } from "@harness/control-plane/host"
import type { DesktopConfiguration } from "../shared/contracts"
import { runtimeErrorLabel } from "../shared/runtime-errors"

export interface ConversationSummary {
  readonly id: string
  readonly workspaceId: string
  readonly runtimeId: string
  readonly modelId: string
  readonly status: AgentSession["status"]
  readonly createdAt: string
  readonly updatedAt: string
  readonly compatible: boolean
}

/** A privileged projection of the host's own journal. No native discovery, replay, or automatic attachment. */
export class DesktopConversations {
  constructor(private readonly journal: SQLiteJournal) {}

  async bind(sessionId: string, configuration: DesktopConfiguration): Promise<void> {
    const session = await this.localSession(sessionId, configuration.workspace?.id)
    if (session.revision !== 0 || session.status !== "idle")
      throw new Error("Only a newly created session can bind host context")
    await this.journal.bindHostContext(sessionId, await context(configuration))
  }

  async list(configuration: DesktopConfiguration) {
    if (!configuration.workspace) return { items: [], truncated: false }
    const result = await this.journal.recentSessions(configuration.workspace.id)
    const selected = await context(configuration).catch(() => undefined)
    const items = await Promise.all(
      result.items.map(
        async (entry): Promise<ConversationSummary> => ({
          id: identity(entry.session.id),
          workspaceId: identity(entry.session.workspaceId),
          runtimeId: identity(entry.session.binding.runtimeId),
          modelId: identity(entry.session.intent.selection.model.modelId),
          status: entry.session.status,
          createdAt: timestamp(entry.session.createdAt),
          updatedAt: timestamp(entry.updatedAt),
          compatible: Boolean(selected && selected === (await this.journal.hostContext(entry.session.id))),
        }),
      ),
    )
    return { items, truncated: result.truncated }
  }

  /** Called after admission and before send. Missing command receipts remain explicitly unconfirmed. */
  async recordUser(
    sessionId: string,
    message: { readonly commandId: string; readonly messageId: string; readonly text: string },
  ) {
    await this.journal.recordUserMessage(sessionId, { ...message, recordedAt: new Date().toISOString() })
  }

  async hydrate(sessionId: string, workspaceId: string) {
    await this.localSession(sessionId, workspaceId)
    const preview = await this.journal.preview(sessionId)
    const projected = new Map<
      string,
      {
        id: string
        role: "user" | "assistant"
        text: string
        recordedAt: string
        order: number
      }
    >()
    preview.messages.forEach((message, order) => {
      projected.set(`user:${message.messageId}`, {
        id: identity(message.messageId),
        role: "user",
        text: message.text,
        recordedAt: message.recordedAt,
        order,
      })
    })
    preview.events.forEach((event) => {
      if (
        event.scope.sessionId !== sessionId ||
        (event.type !== "assistant.text.delta" && event.type !== "assistant.text.completed")
      )
        return
      const key = `assistant:${event.data.messageId}`
      const previous = projected.get(key)
      projected.set(key, {
        id: identity(event.data.messageId),
        role: "assistant",
        text: event.type === "assistant.text.completed" ? event.data.text : (previous?.text ?? "") + event.data.delta,
        recordedAt: previous?.recordedAt ?? event.observedAt,
        order: previous?.order ?? event.sequence,
      })
    })
    const messages = [...projected.values()]
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.order - right.order)
      .map((message) => ({ id: message.id, role: message.role, text: message.text }))
    // Return only event names, fixed error categories and durable IDs. Patches, question labels, tool inputs, raw errors,
    // thinking, account metadata and artifact references never cross this history projection.
    const activity = preview.events
      .filter((event) => event.scope.sessionId === sessionId && event.type !== "assistant.text.delta")
      .slice(-100)
      .map((event) => ({
        id: identity(event.id),
        kind: identity(event.type),
        label: event.type === "agent.error" ? runtimeErrorLabel(event.data.error) : identity(event.type),
      }))
    return {
      messages,
      activity,
      completeness: "partial" as const,
      truncated: preview.truncated,
      unconfirmedMessages: preview.messages.filter((message) =>
        ["not-recorded", "admitted", "uncertain"].includes(message.state),
      ).length,
      ...(preview.cursor ? { cursor: preview.cursor } : {}),
    }
  }

  /** Host-only session lookup. Native IDs, account evidence and policy never become renderer authority. */
  async requireSession(
    sessionId: string,
    configuration: DesktopConfiguration,
    runtimeId: string,
  ): Promise<AgentSession> {
    const session = await this.localSession(sessionId, configuration.workspace?.id)
    if (
      session.binding.runtimeId !== runtimeId ||
      session.binding.targetId !== "local" ||
      (await this.journal.hostContext(sessionId)) !== (await context(configuration))
    )
      throw new Error(
        "Select the original repository, runtime executable and native account home for this conversation",
      )
    return session
  }

  async inspect(
    manager: LocalRuntimeManager,
    sessionId: string,
    configuration: DesktopConfiguration,
    runtimeId: string,
  ) {
    await this.requireSession(sessionId, configuration, runtimeId)
    const result = await manager.inspectSession(sessionId)
    return {
      sessionId,
      observedAt: result.observedAt,
      nativeState: result.nativeState,
      completeness: result.completeness,
      turnCount: result.turns.length,
      runningTurns: result.turns.filter((turn) => turn.status === "running").length,
      terminalTurns: result.turns.filter((turn) => ["succeeded", "failed", "interrupted"].includes(turn.status)).length,
      unknownTurns: result.turns.filter((turn) => turn.status === "unknown").length,
    }
  }

  async reconcile(
    manager: LocalRuntimeManager,
    sessionId: string,
    configuration: DesktopConfiguration,
    runtimeId: string,
  ) {
    await this.requireSession(sessionId, configuration, runtimeId)
    return manager.reconcileSession(sessionId)
  }

  private async localSession(sessionId: string, workspaceId: string | undefined) {
    const session = await this.journal.get(identity(sessionId))
    if (!workspaceId || !session || session.workspaceId !== workspaceId || session.intent.workspaceId !== workspaceId)
      throw new Error("Conversation does not belong to the selected repository")
    return session
  }
}

async function context(configuration: DesktopConfiguration) {
  if (!configuration.workspace || !configuration.executable || !configuration.nativeHome)
    throw new Error("Choose the original repository, runtime executable and account home")
  const paths = await Promise.all([
    realpath(configuration.workspace.path),
    realpath(configuration.executable),
    realpath(configuration.nativeHome),
  ])
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: configuration.workspace.id,
        runtime: configuration.runtime ?? "codex",
        paths: process.platform === "win32" ? paths.map((path) => path.toLowerCase()) : paths,
      }),
    )
    .digest("hex")
}

function identity(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    throw new Error("Invalid journal identity")
  return value
}

function timestamp(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid journal timestamp")
  return new Date(value).toISOString()
}
