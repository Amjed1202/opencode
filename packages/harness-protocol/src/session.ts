import type { AgentCapabilities, Capability } from "./capabilities"
import type { ArtifactReference, ProtocolError, Timestamp } from "./common"
import type { EnforcementEvidence, ExecutionPolicy } from "./permissions"
import type { BillingEvidence, RuntimeAuthState, RuntimeSelection } from "./runtime"

export interface WorkspaceDescriptor {
  readonly id: string
  readonly projectId: string
  readonly targetId: string
  readonly rootPath: string
  readonly kind: "repository" | "worktree" | "isolated-snapshot"
  readonly baseRevision?: string
}

export interface WorkspaceLease {
  readonly id: string
  readonly workspaceId: string
  readonly targetId: string
  readonly ownerId: string
  readonly mode: "read" | "write"
  readonly generation: number
  readonly expiresAt: Timestamp
}

export interface SessionIntent {
  readonly workspaceId: string
  readonly selection: RuntimeSelection
  readonly policy: ExecutionPolicy
  readonly requiredCapabilities: readonly Capability[]
  readonly mode: "chat" | "code" | "plan" | "collaborate"
}

export type PreflightRequest =
  | { readonly operation: "create"; readonly intent: SessionIntent }
  | { readonly operation: "resume" | "turn"; readonly sessionId: string; readonly intent: SessionIntent }

/** Host loads existing state; client-supplied native bindings are never authoritative. */
export type AdapterPreflightRequest =
  | { readonly operation: "create"; readonly intent: SessionIntent }
  | { readonly operation: "resume" | "turn"; readonly existingSession: AgentSession; readonly intent: SessionIntent }

export interface RuntimePreflight {
  readonly auth: RuntimeAuthState
  readonly billing: BillingEvidence
  readonly capabilities: AgentCapabilities
  readonly enforcement: EnforcementEvidence
  readonly checkedAt: Timestamp
  readonly expiresAt: Timestamp
  readonly configurationFingerprint: string
}

export type AdapterPreflight =
  | { readonly status: "ready"; readonly effective: RuntimePreflight }
  | { readonly status: "blocked"; readonly errors: readonly ProtocolError[]; readonly observed?: RuntimePreflight }

/** Opaque reference is meaningful only after host-side binding/expiry validation. */
export type PreflightResult =
  | { readonly status: "ready"; readonly admissionId: string; readonly effective: RuntimePreflight }
  | { readonly status: "blocked"; readonly errors: readonly ProtocolError[] }

export interface AdmittedSessionRequest {
  readonly operation: "create" | "resume" | "turn"
  readonly admissionId: string
  readonly sessionId: string
  readonly intent: SessionIntent
  readonly workspace: WorkspaceDescriptor
  readonly lease: WorkspaceLease
  readonly effective: RuntimePreflight
}

export interface NativeSessionBinding {
  readonly runtimeId: string
  readonly adapterId: string
  readonly targetId: string
  readonly nativeSessionId: string
  readonly nativeProtocolVersion?: string
}

export interface AgentSession {
  readonly id: string
  readonly workspaceId: string
  readonly intent: SessionIntent
  readonly binding: NativeSessionBinding
  readonly effective: RuntimePreflight
  readonly status: "idle" | "running" | "awaiting-permission" | "interrupted" | "failed" | "closed" | "uncertain"
  readonly createdAt: Timestamp
  readonly revision: number
}

export interface AgentInput {
  readonly commandId: string
  readonly messageId: string
  readonly parts: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "attachment"; readonly artifact: ArtifactReference }
  )[]
  readonly delivery: "when-idle" | "queue"
}

export interface CommandReceipt {
  readonly commandId: string
  readonly sessionId: string
  readonly state: "admitted" | "dispatched" | "rejected" | "uncertain"
  readonly recordedAt: Timestamp
  readonly nativeTurnId?: string
  readonly error?: ProtocolError
}
