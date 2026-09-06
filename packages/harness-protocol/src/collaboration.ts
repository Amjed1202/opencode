import type { ArtifactReference, Timestamp } from "./common"
import type { ExecutionPolicy } from "./permissions"
import type { RuntimeSelection } from "./runtime"

export type CollaborationRole =
  | "planner"
  | "builder"
  | "reviewer"
  | "test-auditor"
  | "security-reviewer"
  | "researcher"
  | "architect"
  | "judge"
  | `custom:${string}`

export interface RoleAssignment {
  readonly id: string
  readonly role: CollaborationRole
  readonly runtime: RuntimeSelection
  readonly workspaceId: string
  readonly policy: ExecutionPolicy
}

export interface WorkflowStep {
  readonly id: string
  readonly kind: "agent" | "tests" | "review" | "decision" | "user-approval"
  readonly roleAssignmentId?: string
  readonly dependsOn: readonly string[]
  readonly outputSchemaId: string
}

export interface CollaborationLimits {
  readonly maxReviewCycles: number
  readonly maxAttempts: number
  readonly maxWallTimeMs: number
  readonly maxTokens?: number
  readonly estimatedApiCostLimit?: { readonly amount: number; readonly currency: string }
  readonly unknownBudgetPolicy: "pause" | "advisory"
  readonly stopOnApproval: boolean
  readonly stopOnRepeatedFinding: boolean
  readonly requireUserAfterCycles: number
}

export const DEFAULT_MAX_REVIEW_CYCLES = 2

export interface CollaborationWorkflow {
  readonly id: string
  readonly version: string
  readonly assignments: readonly RoleAssignment[]
  readonly steps: readonly WorkflowStep[]
  readonly limits: CollaborationLimits
}

export interface ReviewBundle {
  readonly id: string
  readonly workspaceId: string
  readonly snapshotId: string
  readonly diffSha256: string
  readonly baseRevision?: string
  readonly headRevision?: string
  readonly originalTask: ArtifactReference
  readonly implementationSummary: ArtifactReference
  readonly diff: ArtifactReference
  readonly fileManifest: ArtifactReference
  readonly testResults: readonly ArtifactReference[]
  readonly context: readonly ArtifactReference[]
}

export interface ReviewFinding {
  readonly id: string
  readonly reviewBundleId: string
  readonly producerStepId: string
  readonly attemptId: string
  readonly fingerprint: string
  readonly severity: "critical" | "high" | "medium" | "low" | "suggestion"
  readonly title: string
  readonly description: string
  readonly file?: string
  readonly line?: number
  readonly evidence?: string
  readonly recommendation?: string
  readonly confidence?: number
}

export interface FindingDecision {
  readonly id: string
  readonly findingId: string
  readonly reviewBundleId: string
  readonly decision: "accept" | "reject" | "partially-accept"
  readonly rationale: string
  readonly actorId: string
  readonly recordedAt: Timestamp
  readonly addressedClaim?: string
  readonly evidence: readonly ArtifactReference[]
}

export interface CollaborationRun {
  readonly id: string
  readonly workflowId: string
  readonly workflowVersion: string
  readonly state:
    | "pending"
    | "building"
    | "testing"
    | "reviewing"
    | "deciding"
    | "fixing"
    | "paused"
    | "completed"
    | "failed"
  readonly cycle: number
  readonly startedAt: Timestamp
  readonly stopReason?: string
}
