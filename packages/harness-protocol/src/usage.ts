import type { Evidence, EventScope, Timestamp } from "./common"
import type { BillingEvidence } from "./runtime"

export interface TokenCounts {
  readonly input: number | null
  readonly output: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly reasoning: number | null
  readonly cacheRelation: "included-in-input" | "separate" | "unknown"
  readonly reasoningRelation: "included-in-output" | "separate" | "unknown"
}

export interface CostObservation {
  readonly kind: "api-estimate" | "api-equivalent" | "provider-reported-charge"
  readonly amount: number | null
  readonly currency: string
  readonly pricingSource?: string
  readonly pricingVersion?: string
  readonly evidence?: Evidence
}

export interface UsageSnapshot {
  readonly id: string
  readonly sourceEventId: string
  readonly scope: EventScope
  readonly providerId: string
  readonly modelId?: string
  readonly accountingScope: "request-attempt" | "turn" | "session" | "account"
  readonly accountingId: string
  readonly epoch: string
  readonly basis: "delta" | "cumulative"
  readonly includesSubagents: "yes" | "no" | "unknown"
  readonly completeness: "partial" | "final" | "unknown"
  readonly evidence: Evidence
  readonly tokens?: TokenCounts
  readonly costs?: readonly CostObservation[]
  readonly billing: BillingEvidence
  readonly activity?: {
    readonly turns?: number
    readonly toolCalls?: number
    readonly terminalCommands?: number
    readonly filesChanged?: number
    readonly retries?: number
    readonly errors?: number
    readonly firstTextMs?: number
    readonly generationMs?: number
    readonly taskMs?: number
  }
}

export interface ContextSnapshot {
  readonly sessionId: string
  readonly epoch: string
  readonly usedTokens: number | null
  readonly capacityTokens: number | null
  readonly basis: "native-context" | "estimated-context" | "unknown"
  readonly compactions: number | null
  readonly evidence: Evidence
}

export interface QuotaWindow {
  readonly id: string
  readonly durationMinutes: number | null
  readonly usedPercent: number | null
  readonly resetsAt: Timestamp | null
}

export interface QuotaSnapshot {
  readonly runtimeId: string
  readonly targetId: string
  readonly accountId: string
  readonly bucketId: string
  readonly windows: readonly QuotaWindow[]
  readonly evidence: Evidence
}
