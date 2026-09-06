import type { ArtifactReference, JsonValue, Timestamp } from "./common"

export interface ExecutionPolicy {
  readonly id: string
  readonly version: string
  readonly filesystem: "read-only" | "workspace-write"
  readonly shell: "disabled" | "mediated" | "sandboxed"
  readonly network: "denied" | "restricted" | "native-policy"
  readonly allowedMcpServers: readonly string[]
  readonly approval: "ask" | "deny"
  readonly requireEnforcedBoundary: boolean
}

export interface EnforcementEvidence {
  readonly mechanism: "os-sandbox" | "native-enforcement" | "mediated-tools" | "advisory" | "none"
  readonly filesystem: boolean
  readonly shell: boolean
  readonly network: boolean
  readonly limitations: readonly string[]
}

export interface PermissionChoice {
  readonly id: string
  readonly action: "allow" | "deny"
  readonly scope: "once" | "session" | "workspace"
  readonly label: string
}

export interface PermissionBinding {
  readonly requestId: string
  readonly sessionId: string
  readonly runtimeId: string
  readonly nativeSessionId: string
  readonly nativeTurnId: string
  readonly nativeRequestId: string
  readonly targetId: string
  readonly workspaceId: string
  readonly policyId: string
  readonly policyVersion: string
  readonly leaseGeneration: number
  readonly operationSha256: string
}

export interface PermissionRequest extends PermissionBinding {
  readonly toolCallId?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly details: JsonValue
  readonly choices: readonly PermissionChoice[]
  readonly expiresAt: Timestamp
  readonly reviewArtifact?: ArtifactReference
  /** Assigned by the host before adding protected review metadata. */
  readonly sourceRequestSha256?: string
}

/** Host resolves only choices offered by the still-current bound request. */
export interface PermissionDecision extends PermissionBinding {
  readonly choiceId: string
  /** Ephemeral host review capability. Never persisted in audit records. */
  readonly reviewToken?: string
}

/** Actor and timestamp are assigned by the authenticated host, never by the renderer. */
export interface PermissionResolution extends PermissionBinding {
  readonly outcome: "allowed" | "denied" | "expired"
  readonly choiceId?: string
  readonly actorId: string
  readonly decidedAt: Timestamp
  readonly reviewArtifactSha256?: string
}

export interface HumanInputRequest extends PermissionBinding {
  readonly prompt: "Choose one option for each question."
  readonly schemaId: "harness.choice-input.v1"
  readonly questions: readonly { readonly id: string; readonly optionIds: readonly string[] }[]
  readonly expiresAt: Timestamp
  readonly reviewArtifact?: ArtifactReference
  readonly sourceRequestSha256?: string
}

export interface HumanInputResponse extends PermissionBinding {
  readonly action: "answer" | "cancel"
  readonly selections: readonly { readonly questionId: string; readonly optionId: string }[]
  readonly reviewToken?: string
}

export interface HumanInputResolution extends PermissionBinding {
  readonly outcome: "answered" | "cancelled" | "expired"
  readonly actorId: string
  readonly decidedAt: Timestamp
  readonly answerSha256?: string
  readonly reviewArtifactSha256?: string
}

/** Restricted display content, fetched only through a host-authorized review path. */
export interface PermissionReviewContent {
  readonly kind: "patch"
  readonly requestId: string
  readonly operationSha256: string
  readonly changes: readonly {
    readonly path: string
    readonly kind: "add" | "delete" | "update"
    readonly diff: string
    readonly movePath?: string
  }[]
}

export interface HumanInputReviewContent {
  readonly kind: "choice-input"
  readonly requestId: string
  readonly operationSha256: string
  readonly questions: readonly {
    readonly id: string
    readonly header: string
    readonly question: string
    readonly options: readonly { readonly id: string; readonly label: string; readonly description: string }[]
  }[]
}

export interface InteractionReview {
  readonly artifact: ArtifactReference
  readonly content: PermissionReviewContent | HumanInputReviewContent
  readonly reviewToken: string
  readonly expiresAt: Timestamp
}
