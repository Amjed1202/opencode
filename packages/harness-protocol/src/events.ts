import type {
  ArtifactReference,
  EventScope,
  EventOrigin,
  JsonValue,
  NativeEventReference,
  ProtocolError,
  ProtocolVersion,
  Timestamp,
} from "./common"
import type { ReviewFinding } from "./collaboration"
import type { HumanInputRequest, PermissionRequest, PermissionResolution } from "./permissions"
import type { ReplayStatus } from "./remote"
import type { RuntimeAuthState, BillingEvidence } from "./runtime"
import type { AgentSession } from "./session"
import type { ContextSnapshot, QuotaSnapshot, UsageSnapshot } from "./usage"

export interface TextPart {
  readonly messageId: string
  readonly partId: string
}

export interface FileObservation {
  readonly path: string
  readonly source: "native-reported" | "filesystem-observed"
  readonly state: "proposed" | "applied" | "unknown"
  readonly artifact?: ArtifactReference
}

export interface AgentEventMap {
  "assistant.text.delta": TextPart & { readonly delta: string }
  "assistant.text.completed": TextPart & { readonly text: string }
  "assistant.thinking": TextPart & { readonly text: string; readonly phase: "delta" | "completed" }
  "agent.started": { readonly nativeTurnId: string }
  "agent.completed": { readonly nativeTurnId: string; readonly outcome: "succeeded" | "failed" | "interrupted" }
  "agent.error": { readonly error: ProtocolError; readonly nativeTurnId?: string }
  "tool.started": { readonly callId: string; readonly name: string; readonly input: JsonValue }
  "tool.output": { readonly callId: string; readonly text?: string; readonly artifact?: ArtifactReference }
  "tool.completed": { readonly callId: string; readonly outcome: "succeeded" | "failed" | "denied" | "cancelled" }
  "terminal.started": { readonly terminalId: string; readonly command?: string }
  "terminal.output": { readonly terminalId: string; readonly output: string }
  "terminal.completed": { readonly terminalId: string; readonly exitCode: number | null }
  "file.read": FileObservation
  "file.changed": FileObservation
  "file.created": FileObservation
  "file.deleted": FileObservation
  "diff.created": {
    readonly snapshotId: string
    readonly diff: ArtifactReference
    readonly state: "proposed" | "applied"
  }
  "git.changed": { readonly workspaceId: string; readonly revision?: string; readonly status: ArtifactReference }
  "permission.requested": PermissionRequest
  "permission.resolved": PermissionResolution
  "input.requested": HumanInputRequest
  "input.resolved": { readonly requestId: string; readonly outcome: "answered" | "cancelled" | "expired" }
  "task.started": { readonly taskId: string; readonly title: string }
  "task.updated": { readonly taskId: string; readonly state: string; readonly revision: number }
  "task.completed": { readonly taskId: string; readonly outcome: "succeeded" | "failed" | "cancelled" }
  "usage.updated": UsageSnapshot
  "quota.updated": QuotaSnapshot
  "context.updated": ContextSnapshot
  "context.compacted": { readonly sessionId: string; readonly previousEpoch: string; readonly context: ContextSnapshot }
  "session.updated": AgentSession
  "subagent.started": { readonly nativeSubagentId: string; readonly parentCallId?: string }
  "subagent.completed": { readonly nativeSubagentId: string; readonly outcome: "succeeded" | "failed" | "interrupted" }
  "collaboration.review.created": {
    readonly runId: string
    readonly bundleId: string
    readonly findings: readonly ReviewFinding[]
  }
  "runtime.updated": { readonly auth: RuntimeAuthState; readonly billing: BillingEvidence }
  "native.event": { readonly namespace: string; readonly nativeType: string }
  "stream.gap": { readonly sourceStreamId: string; readonly reason: string; readonly snapshot?: ArtifactReference }
}

export type AgentEventType = keyof AgentEventMap
export type AgentEventPayload = {
  [K in AgentEventType]: { readonly type: K; readonly data: AgentEventMap[K] }
}[AgentEventType]

/** Adapter output. The host adds durable identity/order after validation and redaction. */
export type AgentEventDraft = AgentEventPayload & {
  readonly origin: EventOrigin
  readonly scope: EventScope
  readonly observedAt: Timestamp
  readonly nativeOccurredAt?: Timestamp
  readonly native?: NativeEventReference
}

export type AgentEvent = AgentEventDraft & {
  readonly protocolVersion: ProtocolVersion
  readonly id: string
  readonly streamId: string
  readonly epoch: string
  readonly sequence: number
}

/** Replay control frames do not become model events or executable commands. */
export type EventDelivery =
  | { readonly kind: "event"; readonly event: AgentEvent }
  | { readonly kind: "gap"; readonly recovery: Extract<ReplayStatus, { status: "gap" }> }
