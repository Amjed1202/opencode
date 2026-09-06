import type { Evidence, JsonObject } from "./common"

export type Capability =
  | "chat"
  | "coding"
  | "reasoning"
  | "filesystem"
  | "terminal"
  | "diff"
  | "git"
  | "mcp"
  | "subagents"
  | "skills"
  | "hooks"
  | "web"
  | "image-input"
  | "structured-output"
  | "permissions"
  | "session-resume"
  | "context-telemetry"
  | "token-telemetry"
  | "cost-telemetry"
  | "quota-telemetry"
  | "remote-execution"
  | "review-mode"
  | "streaming"
  | "human-input"

export type CapabilitySupport =
  | {
      readonly status: "supported"
      readonly verification: "declared" | "verified"
      readonly evidence: Evidence
      readonly limitations: readonly string[]
    }
  | { readonly status: "unsupported"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string }

/** Missing capabilities are unknown. This describes support; it does not grant authority. */
export type AgentCapabilities = Readonly<Partial<Record<Capability, CapabilitySupport>>>

export interface NativeExtension {
  readonly namespace: string
  readonly version: string
  readonly schemaId: string
  readonly value: JsonObject
}
