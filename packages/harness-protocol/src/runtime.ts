import type { AgentCapabilities, NativeExtension } from "./capabilities"
import type { Evidence } from "./common"

export type ClaudeAuthMode = "claude-code-subscription" | "api-key"
export type CodexAuthMode = "chatgpt-subscription" | "api-key"
export type AuthMode = "subscription" | "api" | "local" | "provider-specific" | "unknown"
export type BillingMode = "subscription" | "api-payg" | "local" | "provider-specific" | "unknown"

export interface ProviderDescriptor {
  readonly id: string
  readonly name: string
}

export interface ModelDescriptor {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly capabilities: AgentCapabilities
  readonly contextWindowTokens?: number
  readonly extensions?: readonly NativeExtension[]
}

export interface ExecutionTarget {
  readonly id: string
  readonly kind: "local" | "remote-node"
  readonly name: string
  readonly nodeId?: string
}

export interface RuntimeDescriptor {
  readonly id: string
  readonly adapterId: string
  readonly name: string
  readonly kind: "native-agent" | "api" | "local-model"
  readonly providers: readonly ProviderDescriptor[]
  readonly target: ExecutionTarget
  readonly version?: string
  readonly executable?: string
  readonly nativeProtocolVersion?: string
  readonly authModes: readonly AuthMode[]
  readonly billingModes: readonly BillingMode[]
  readonly capabilities: AgentCapabilities
  readonly integration: "unimplemented" | "conditional" | "supported" | "unavailable"
}

/** Safe status only; token values, refresh tokens and environment values are prohibited. */
export interface RuntimeAuthState {
  readonly runtimeId: string
  readonly targetId: string
  readonly status: "authenticated" | "unauthenticated" | "unknown"
  readonly mode: AuthMode
  readonly method?: string
  readonly accountLabel?: string
  readonly accountId?: string
  readonly plan?: string
  readonly evidence?: Evidence
}

export interface BillingEvidence {
  readonly route: BillingMode
  readonly providerId?: string
  readonly providerOverage: "disabled" | "enabled" | "unknown" | "not-applicable"
  readonly evidence?: Evidence
}

/** Requested intent is distinct from observed evidence. These variants prevent API/subscription label mixing. */
export type RuntimeAccess =
  | {
      readonly mode: "subscription"
      readonly method: "claude-code-subscription" | "chatgpt-subscription" | `provider:${string}`
      readonly billing: "subscription"
      readonly overagePolicy: "require-disabled" | "acknowledge-provider-settings"
    }
  | { readonly mode: "api"; readonly method: string; readonly billing: "api-payg"; readonly consentId: string }
  | { readonly mode: "local"; readonly method: string; readonly billing: "local" }
  | {
      readonly mode: "provider-specific"
      readonly method: string
      readonly billing: "provider-specific"
      readonly consentId: string
    }

export type ApiFallbackPolicy =
  | { readonly automatic: false }
  | {
      readonly automatic: true
      readonly consentId: string
      readonly providerIds: readonly string[]
      readonly scope: { readonly kind: "session" | "provider"; readonly id: string }
      readonly expiresAt: string
    }

export interface BillingPreferences {
  readonly preferSubscriptionRuntimes: boolean
  readonly apiFallback: ApiFallbackPolicy
  readonly unknownBilling: "block"
}

/** Intended defaults, not an implementation of admission or charge prevention. */
export const DEFAULT_BILLING_PREFERENCES = {
  preferSubscriptionRuntimes: true,
  apiFallback: { automatic: false },
  unknownBilling: "block",
} as const satisfies BillingPreferences

export interface RuntimeSelection {
  readonly runtimeId: string
  readonly targetId: string
  readonly model: { readonly providerId: string; readonly modelId: string }
  readonly access: RuntimeAccess
  readonly fallback: ApiFallbackPolicy
  readonly extensions?: readonly NativeExtension[]
}
