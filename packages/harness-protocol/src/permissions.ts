import type { JsonValue, Timestamp } from "./common"

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
  readonly targetId: string
  readonly workspaceId: string
  readonly policyVersion: string
  readonly leaseGeneration: number
  readonly operationSha256: string
}

export interface PermissionRequest extends PermissionBinding {
  readonly nativeRequestId: string
  readonly toolCallId?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly details: JsonValue
  readonly choices: readonly PermissionChoice[]
  readonly expiresAt: Timestamp
}

/** Host resolves only choices offered by the still-current bound request. */
export interface PermissionDecision extends PermissionBinding {
  readonly choiceId: string
}

/** Actor and timestamp are assigned by the authenticated host, never by the renderer. */
export interface PermissionResolution extends PermissionBinding {
  readonly outcome: "allowed" | "denied" | "expired"
  readonly choiceId?: string
  readonly actorId: string
  readonly decidedAt: Timestamp
}

export interface HumanInputRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly targetId: string
  readonly prompt: string
  readonly schemaId?: string
  readonly expiresAt: Timestamp
}

export interface HumanInputResponse {
  readonly requestId: string
  readonly sessionId: string
  readonly targetId: string
  readonly value: JsonValue
}
