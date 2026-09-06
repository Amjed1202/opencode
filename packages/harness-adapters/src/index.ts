import type {
  AdapterPreflight,
  AdapterPreflightRequest,
  AdmittedSessionRequest,
  AgentCapabilities,
  AgentEventDraft,
  AgentInput,
  AgentSession,
  CommandReceipt,
  ExecutionTarget,
  HumanInputResponse,
  HumanInputReviewContent,
  PermissionReviewContent,
  ModelDescriptor,
  NativeSessionInspection,
  PermissionDecision,
  QuotaSnapshot,
  RuntimeDescriptor,
  UsageSnapshot,
} from "@harness/protocol"

export interface DiscoveryContext {
  readonly target: ExecutionTarget
  readonly allowedExecutablePaths: readonly string[]
}

export interface AdapterSessionContext {
  readonly session: AgentSession
  readonly admissionId: string
  readonly leaseGeneration: number
}

/** Host-only callback, invoked synchronously at the final native approval write boundary. */
export interface AdapterPermissionContext extends AdapterSessionContext {
  readonly authorizeReply?: () => void
}

/** Host-only interface. Concrete native implementations are exposed through separate adapter entry points. */
export interface AgentAdapter {
  readonly id: string
  readonly version: string
  discover(context: DiscoveryContext): Promise<readonly RuntimeDescriptor[]>
  capabilities(runtime: RuntimeDescriptor): AgentCapabilities
  preflight(request: AdapterPreflightRequest): Promise<AdapterPreflight>
  createSession(request: AdmittedSessionRequest): Promise<AgentSession>
  send(context: AdapterSessionContext, input: AgentInput): Promise<CommandReceipt>
  events(session: AgentSession): AsyncIterable<AgentEventDraft>
  interrupt(context: AdapterSessionContext): Promise<void>
  /** Detach/cleanup, never delete the native conversation. */
  close(session: AgentSession): Promise<void>
  readonly resume?: (request: AdmittedSessionRequest, existing: AgentSession) => Promise<AgentSession>
  readonly inspect?: (session: AgentSession) => Promise<NativeSessionInspection>
  readonly resolvePermission?: (context: AdapterPermissionContext, decision: PermissionDecision) => Promise<void>
  readonly resolveInput?: (context: AdapterPermissionContext, response: HumanInputResponse) => Promise<void>
  readonly reviewPermission?: (context: AdapterSessionContext, requestId: string) => Promise<PermissionReviewContent>
  readonly reviewInput?: (context: AdapterSessionContext, requestId: string) => Promise<HumanInputReviewContent>
  readonly models?: (runtime: RuntimeDescriptor) => Promise<readonly ModelDescriptor[]>
  readonly usage?: (session: AgentSession) => Promise<readonly UsageSnapshot[]>
  readonly quota?: (runtime: RuntimeDescriptor) => Promise<readonly QuotaSnapshot[]>
}
