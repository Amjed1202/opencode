/** Wire values require bounded runtime validation before use. No decoder exists yet. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }
export type Timestamp = string
export type ProtocolVersion = "0.1"

export interface Evidence {
  readonly source: "native-status" | "native-event" | "provider-report" | "local-observation" | "user-declaration"
  readonly observedAt: Timestamp
  readonly runtimeVersion?: string
  readonly expiresAt?: Timestamp
}

export interface ArtifactReference {
  readonly id: string
  readonly sha256: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sensitivity: "content" | "restricted"
}

/** Authentication exchanges and credentials must never be represented here. */
export type NativeEventReference = {
  readonly namespace: string
  readonly nativeType: string
  readonly nativeId?: string
  readonly nativeVersion?: string
  readonly redaction: "sanitized" | "restricted-artifact"
} & (
  | { readonly storage: "inline"; readonly payload: JsonValue; readonly redaction: "sanitized" }
  | { readonly storage: "artifact"; readonly artifact: ArtifactReference }
)

export interface EventScope {
  readonly targetId: string
  readonly runtimeId?: string
  readonly workspaceId?: string
  readonly projectId?: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly commandId?: string
  readonly taskId?: string
  readonly collaborationRunId?: string
  readonly roleAssignmentId?: string
  readonly workflowStepId?: string
  readonly attemptId?: string
  readonly parentSessionId?: string
}

/** Deduplication key is (streamId, epoch, eventId), before host event IDs are assigned. */
export interface EventOrigin {
  readonly streamId: string
  readonly epoch: string
  readonly eventId: string
  readonly sequence?: number
  readonly identityStrategy: "native" | "adapter-assigned"
}

export interface ProtocolError {
  readonly code:
    | "unsupported"
    | "invalid-input"
    | "auth-required"
    | "billing-conflict"
    | "capacity-limited"
    | "permission-denied"
    | "workspace-conflict"
    | "unavailable"
    | "incompatible-protocol"
    | "native-error"
  readonly message: string
  readonly retryable: boolean
  readonly nativeCode?: string
}
