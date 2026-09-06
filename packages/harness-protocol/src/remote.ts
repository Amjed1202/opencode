import type { ArtifactReference, ProtocolVersion, Timestamp } from "./common"
import type { RuntimeDescriptor } from "./runtime"

export interface EventCursor {
  readonly streamId: string
  readonly epoch: string
  readonly sequence: number
}

export interface RemoteNodeDescriptor {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly identityFingerprint: string
  readonly status: "unpaired" | "offline" | "connected" | "revoked" | "incompatible"
  readonly os?: string
  readonly architecture?: string
  readonly lastSeenAt?: Timestamp
}

/** Carries public identity/status, never bootstrap secrets or native provider tokens. */
export interface NodeHandshake {
  readonly nodeId: string
  readonly serverEpoch: string
  readonly protocolVersion: ProtocolVersion
  readonly identityFingerprint: string
  readonly runtimes: readonly RuntimeDescriptor[]
  readonly maxFrameBytes: number
  readonly maxArtifactBytes: number
  readonly eventRetentionSeconds: number
  readonly grantIds: readonly string[]
}

export interface NodeGrant {
  readonly id: string
  readonly nodeId: string
  readonly principalId: string
  readonly workspaceIds: readonly string[]
  readonly actions: readonly ("observe" | "read-artifact" | "execute" | "approve" | "manage-runtime")[]
  readonly expiresAt: Timestamp
}

export interface RemoteCommandContext {
  readonly commandId: string
  readonly requestSha256: string
  readonly nodeId: string
  readonly serverEpoch: string
  readonly leaseId: string
  readonly leaseGeneration: number
  readonly deadline: Timestamp
}

export type ReplayStatus =
  | { readonly status: "available"; readonly cursor: EventCursor }
  | {
      readonly status: "gap"
      readonly reason: string
      readonly snapshot: ArtifactReference
      readonly cursor: EventCursor
    }

export interface DisconnectPolicy {
  readonly approvedWork: "pause" | "continue-with-valid-lease"
  readonly newApprovals: "pause"
}
