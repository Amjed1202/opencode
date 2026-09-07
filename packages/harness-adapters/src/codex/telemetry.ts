import { randomUUID } from "node:crypto"
import type { AgentEventPayload, AgentSession } from "@harness/protocol"
import type { ThreadTokenUsageUpdatedNotification } from "./generated/0.153.4/v2/ThreadTokenUsageUpdatedNotification"
import type { TokenUsageBreakdown } from "./generated/0.153.4/v2/TokenUsageBreakdown"
import { isRecord } from "./stdio"

/** Pinned native cumulative counts. Repeated observations replace totals; they are never added together. */
export function codexTelemetry(value: unknown, session: AgentSession, epoch: string): readonly AgentEventPayload[] {
  const native = decode(value)
  if (!native || native.threadId !== session.binding.nativeSessionId) return []
  const observedAt = new Date().toISOString()
  const evidence = { source: "native-event", observedAt, runtimeVersion: "0.153.4" } as const
  const scope = {
    targetId: session.binding.targetId,
    runtimeId: session.binding.runtimeId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    turnId: native.turnId,
  }
  const counts = native.tokenUsage.total
  const sourceEventId = randomUUID()
  return [
    {
      type: "usage.updated",
      data: {
        id: randomUUID(),
        sourceEventId,
        scope,
        providerId: "openai",
        modelId: session.intent.selection.model.modelId,
        accountingScope: "session",
        accountingId: session.binding.nativeSessionId,
        epoch,
        basis: "cumulative",
        includesSubagents: "unknown",
        completeness: "partial",
        evidence,
        tokens: {
          input: counts.inputTokens,
          output: counts.outputTokens,
          cacheRead: counts.cachedInputTokens,
          cacheWrite: counts.cacheWriteInputTokens,
          reasoning: counts.reasoningOutputTokens,
          cacheRelation: "unknown",
          reasoningRelation: "unknown",
        },
        billing: session.effective.billing,
      },
    },
    {
      type: "context.updated",
      data: {
        sessionId: session.id,
        epoch,
        usedTokens: null,
        capacityTokens: native.tokenUsage.modelContextWindow,
        basis: "native-context",
        compactions: null,
        evidence,
      },
    },
  ]
}

function decode(value: unknown): ThreadTokenUsageUpdatedNotification | undefined {
  if (!isRecord(value) || !id(value.threadId) || !id(value.turnId) || !isRecord(value.tokenUsage)) return
  const total = breakdown(value.tokenUsage.total)
  const last = breakdown(value.tokenUsage.last)
  const window = value.tokenUsage.modelContextWindow
  if (!total || !last || !(window === null || (count(window) && window > 0))) return
  return { threadId: value.threadId, turnId: value.turnId, tokenUsage: { total, last, modelContextWindow: window } }
}
function breakdown(value: unknown): TokenUsageBreakdown | undefined {
  if (!isRecord(value)) return
  const { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens } =
    value
  if (
    !count(totalTokens) ||
    !count(inputTokens) ||
    !count(cachedInputTokens) ||
    !count(cacheWriteInputTokens) ||
    !count(outputTokens) ||
    !count(reasoningOutputTokens)
  )
    return
  return { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}
