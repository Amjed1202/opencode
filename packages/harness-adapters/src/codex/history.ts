import { isAbsolute, resolve } from "node:path"
import type { AgentSession, NativeSessionInspection, NativeTurnObservation } from "@harness/protocol"
import { isRecord } from "./stdio"
import type { ThreadReadParams } from "./generated/0.153.4/v2/ThreadReadParams"
import type { ThreadTurnsListParams } from "./generated/0.153.4/v2/ThreadTurnsListParams"

/** Read-only native evidence. No message ID matching, history hydration, resume, or inference. */
export async function inspectCodexHistory(options: {
  request: (method: string, params: unknown) => Promise<unknown>
  session: AgentSession
  cwd: string
  maxPages?: number
  maxTurns?: number
  maxBytes?: number
}): Promise<NativeSessionInspection> {
  try {
    const maxPages = bounded(options.maxPages ?? 4, 32)
    const maxTurns = bounded(options.maxTurns ?? 200, 2000)
    const maxBytes = bounded(options.maxBytes ?? 1024 * 1024, 16 * 1024 * 1024)
    if (
      !absolute(options.cwd) ||
      !identifier(options.session.binding.nativeSessionId) ||
      options.session.binding.adapterId !== "codex-app-server" ||
      options.session.binding.nativeProtocolVersion !== "0.153.4" ||
      options.session.binding.runtimeId !== options.session.intent.selection.runtimeId ||
      options.session.binding.targetId !== options.session.intent.selection.targetId ||
      options.session.workspaceId !== options.session.intent.workspaceId
    )
      throw new Error("Invalid inspection binding")

    let bytes = 0
    const request = async (method: string, params: ThreadReadParams | ThreadTurnsListParams) => {
      const response = await options.request(method, params)
      const serialized = JSON.stringify(response)
      if (typeof serialized !== "string") throw new Error("Missing response")
      bytes += Buffer.byteLength(serialized)
      if (bytes > maxBytes) throw new Error("History byte limit exceeded")
      return response
    }
    const read = { threadId: options.session.binding.nativeSessionId, includeTurns: false } satisfies ThreadReadParams
    const before = metadata(await request("thread/read", read), options.session, options.cwd)
    const turns = new Map<string, { observation: NativeTurnObservation; fingerprint: string }>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    let received = 0
    let exhausted = false
    let repeated = false
    for (let index = 0; index < maxPages && received < maxTurns; index++) {
      const limit = Math.min(50, maxTurns - received)
      const response = await request("thread/turns/list", {
        threadId: options.session.binding.nativeSessionId,
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "summary",
      } satisfies ThreadTurnsListParams)
      if (
        !isRecord(response) ||
        !Array.isArray(response.data) ||
        response.data.length > limit ||
        !validCursor(response.nextCursor) ||
        !validCursor(response.backwardsCursor)
      )
        throw new Error("Invalid native history page")
      for (const value of response.data) {
        const decoded = decodeTurn(value)
        const previous = turns.get(decoded.observation.nativeTurnId)
        if (previous && previous.fingerprint !== decoded.fingerprint) throw new Error("Conflicting native turn")
        if (previous) repeated = true
        turns.set(decoded.observation.nativeTurnId, decoded)
      }
      received += response.data.length
      cursor = response.nextCursor
      if (cursor === null) {
        exhausted = true
        break
      }
      if (cursors.has(cursor)) throw new Error("Native cursor loop")
      cursors.add(cursor)
    }
    const after = metadata(await request("thread/read", read), options.session, options.cwd)
    const observations = [...turns.values()].map((turn) => turn.observation)
    // Pagination has no snapshot token. Changes or overlap make absence inconclusive.
    const complete = exhausted && !repeated && before.fingerprint === after.fingerprint
    const running =
      before.state === "running" || after.state === "running" || observations.some((turn) => turn.status === "running")
    return {
      sessionId: options.session.id,
      binding: { ...options.session.binding },
      observedAt: new Date().toISOString(),
      nativeState: running ? "running" : complete && after.state === "idle" ? "idle" : "unknown",
      completeness: complete ? "complete" : "partial",
      turns: observations,
    }
  } catch {
    // Native error objects, cursors, previews, items and account context are never returned.
    throw new Error("Codex history inspection failed; native state remains unknown")
  }
}

function metadata(response: unknown, session: AgentSession, cwd: string) {
  if (!isRecord(response) || !isRecord(response.thread)) throw new Error("Missing thread metadata")
  const thread = response.thread
  if (
    thread.id !== session.binding.nativeSessionId ||
    !absolute(thread.cwd) ||
    !samePath(thread.cwd, cwd) ||
    thread.modelProvider !== session.intent.selection.model.providerId ||
    !Array.isArray(thread.turns) ||
    thread.turns.length !== 0 ||
    !timestamp(thread.createdAt) ||
    thread.createdAt === null ||
    !timestamp(thread.updatedAt) ||
    thread.updatedAt === null ||
    !isRecord(thread.status)
  )
    throw new Error("Invalid thread metadata")
  const status = thread.status
  if (typeof status.type !== "string" || !["idle", "active", "notLoaded", "systemError"].includes(status.type))
    throw new Error("Unknown thread state")
  if (
    status.type === "active" &&
    (!Array.isArray(status.activeFlags) ||
      status.activeFlags.some((flag) => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput"))
  )
    throw new Error("Invalid active thread flags")
  return {
    state: status.type === "active" ? "running" : status.type === "idle" ? "idle" : "unknown",
    fingerprint: JSON.stringify([
      thread.id,
      thread.cwd,
      thread.modelProvider,
      thread.createdAt,
      thread.updatedAt,
      status,
    ]),
  }
}

function decodeTurn(value: unknown): { observation: NativeTurnObservation; fingerprint: string } {
  if (
    !isRecord(value) ||
    !identifier(value.id) ||
    !Array.isArray(value.items) ||
    (value.itemsView !== "summary" && value.itemsView !== "notLoaded") ||
    !timestamp(value.startedAt) ||
    !timestamp(value.completedAt) ||
    !timestamp(value.durationMs) ||
    (value.error !== null && !isRecord(value.error))
  )
    throw new Error("Invalid turn summary")
  if (value.startedAt !== null && value.completedAt !== null && value.completedAt < value.startedAt)
    throw new Error("Invalid turn timestamps")
  if (
    value.error !== null &&
    (value.status !== "failed" ||
      typeof value.error.message !== "string" ||
      (value.error.additionalDetails !== null && typeof value.error.additionalDetails !== "string") ||
      (value.error.misalignment !== null && !isRecord(value.error.misalignment)) ||
      (value.error.codexErrorInfo !== null &&
        typeof value.error.codexErrorInfo !== "string" &&
        !isRecord(value.error.codexErrorInfo)))
  )
    throw new Error("Invalid turn error")
  const status: NativeTurnObservation["status"] =
    value.status === "completed"
      ? "succeeded"
      : value.status === "failed"
        ? "failed"
        : value.status === "interrupted"
          ? "interrupted"
          : value.status === "inProgress"
            ? "running"
            : "unknown"
  if (status === "unknown") throw new Error("Unknown turn status")
  return {
    observation: { nativeTurnId: value.id, status },
    fingerprint: JSON.stringify([status, value.startedAt, value.completedAt, value.durationMs]),
  }
}

function bounded(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid history resource limit")
  return value
}

function timestamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}

function validCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 4096)
}

function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    (process.platform !== "win32" || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value))
  )
}

function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}
