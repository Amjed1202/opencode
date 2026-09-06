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
  ModelDescriptor,
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

/** Host-only interface. No implementation, process launch or native SDK dependency is provided. */
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
  readonly resolvePermission?: (context: AdapterSessionContext, decision: PermissionDecision) => Promise<void>
  readonly resolveInput?: (context: AdapterSessionContext, response: HumanInputResponse) => Promise<void>
  readonly models?: (runtime: RuntimeDescriptor) => Promise<readonly ModelDescriptor[]>
  readonly usage?: (session: AgentSession) => Promise<readonly UsageSnapshot[]>
  readonly quota?: (runtime: RuntimeDescriptor) => Promise<readonly QuotaSnapshot[]>
}
