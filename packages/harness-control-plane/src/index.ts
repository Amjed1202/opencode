import type { AgentAdapter } from "@harness/adapters"
import type {
  AdmittedSessionRequest,
  AgentEvent,
  AgentEventDraft,
  AgentInput,
  AgentSession,
  ArtifactReference,
  BillingPreferences,
  CollaborationRun,
  CollaborationWorkflow,
  CommandReceipt,
  EventCursor,
  EventDelivery,
  FindingDecision,
  HumanInputResponse,
  JsonObject,
  NodeGrant,
  NativeSessionInspection,
  PermissionDecision,
  PreflightResult,
  PreflightRequest,
  RemoteNodeDescriptor,
  RuntimeDescriptor,
  UsageSnapshot,
  WorkspaceDescriptor,
  WorkspaceLease,
} from "@harness/protocol"

/** Renderer-facing port: implement only through a restricted, validated transport. */
export interface ControlPlaneClient {
  runtimes(targetId: string): Promise<readonly RuntimeDescriptor[]>
  openWorkspace(targetId: string, pickerGrantId: string): Promise<WorkspaceDescriptor>
  preflight(request: PreflightRequest): Promise<PreflightResult>
  createSession(admissionId: string, commandId: string): Promise<AgentSession>
  resumeSession(sessionId: string, admissionId: string, commandId: string): Promise<AgentSession>
  send(sessionId: string, admissionId: string, input: AgentInput): Promise<CommandReceipt>
  events(sessionId: string, after?: EventCursor): AsyncIterable<EventDelivery>
  interrupt(sessionId: string, commandId: string): Promise<CommandReceipt>
  resolvePermission(decision: PermissionDecision): Promise<void>
  inspectSession(sessionId: string): Promise<NativeSessionInspection>
  reconcileSession(sessionId: string): Promise<AgentSession>
  resolveInput(response: HumanInputResponse): Promise<void>
  usage(sessionId: string): Promise<readonly UsageSnapshot[]>
  closeSession(sessionId: string): Promise<void>
}

/** Privileged host ports below. Initial Bun implementations are isolated in the ./host entry point. */
export interface AdapterRegistry {
  register(adapter: AgentAdapter): void
  get(adapterId: string): AgentAdapter | undefined
}

export interface AdmissionService {
  preflight(request: PreflightRequest): Promise<PreflightResult>
  require(
    admissionId: string,
    sessionId: string,
    operation: "create" | "resume" | "turn",
  ): Promise<AdmittedSessionRequest>
  invalidate(runtimeId: string, reason: string): Promise<void>
}

export interface SessionStore {
  get(id: string): Promise<AgentSession | undefined>
  list(workspaceId: string): Promise<readonly AgentSession[]>
  save(session: AgentSession, expectedRevision: number | null): Promise<void>
}

export interface CommandRecord {
  readonly id: string
  readonly requestSha256: string
  readonly admissionId: string
  readonly sessionId: string
  readonly receipt: CommandReceipt
}

export interface EventStore {
  /** Atomic deduplication by origin, sequence assignment and optional command-receipt update. */
  append(streamId: string, drafts: readonly AgentEventDraft[], command?: CommandRecord): Promise<readonly AgentEvent[]>
  read(streamId: string, after?: EventCursor): AsyncIterable<EventDelivery>
  command(id: string): Promise<CommandRecord | undefined>
}

export interface ArtifactStore {
  put(
    content: AsyncIterable<Uint8Array>,
    metadata: { readonly mediaType: string; readonly sensitivity: "content" | "restricted" },
  ): Promise<ArtifactReference>
  read(id: string, grantId: string): AsyncIterable<Uint8Array>
  delete(id: string): Promise<void>
}

export interface WorkspaceService {
  open(targetId: string, authorizedPath: string): Promise<WorkspaceDescriptor>
  lease(workspaceId: string, ownerId: string, mode: "read" | "write"): Promise<WorkspaceLease>
  release(leaseId: string, generation: number): Promise<void>
  snapshot(workspaceId: string, leaseId: string): Promise<ArtifactReference>
}

/** Privileged launch material must never be logged, persisted as an event or sent to the renderer. */
export interface ProcessLaunch {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly admissionId: string
  readonly leaseId: string
  readonly leaseGeneration: number
}

export interface ProcessSupervisor {
  spawn(request: ProcessLaunch): Promise<{ readonly processId: string }>
  interrupt(processId: string): Promise<void>
  wait(processId: string): Promise<{ readonly exitCode: number | null }>
}

/** OS-vault backend for product credentials; native provider session tokens are not imported. */
export interface SecretStore {
  put(kind: "api-key" | "node-credential" | "service-credential", value: Uint8Array): Promise<string>
  use(reference: string, consumer: (secret: Uint8Array) => Promise<void>): Promise<void>
  delete(reference: string): Promise<void>
}

export interface ConfigurationStore {
  billingPreferences(): Promise<BillingPreferences>
  get(namespace: string): Promise<JsonObject>
  set(namespace: string, value: JsonObject): Promise<void>
}

export interface CollaborationService {
  start(workflow: CollaborationWorkflow, task: ArtifactReference): Promise<CollaborationRun>
  decide(runId: string, decision: FindingDecision): Promise<void>
  pause(runId: string, reason: string): Promise<void>
}

export interface RemoteNodeService {
  list(): Promise<readonly RemoteNodeDescriptor[]>
  authorize(nodeId: string, grant: NodeGrant): Promise<void>
  revoke(nodeId: string, grantId: string): Promise<void>
}
