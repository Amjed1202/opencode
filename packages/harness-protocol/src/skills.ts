import type { Evidence } from "./common"

export type SkillScope = "workspace" | "user"

/** Observations only: absence of a flag does not certify that a skill is safe. */
export type SkillFeature =
  | "dynamic-shell"
  | "file-reference"
  | "substitutions"
  | "tool-policy"
  | "hooks"
  | "forked-context"
  | "plugin-components"

/** All display strings are untrusted file metadata; render as text, never HTML or instructions. */
export interface SkillDescriptor {
  readonly id: string
  readonly format: "claude-skill"
  readonly scope: SkillScope
  readonly workspaceId: string
  readonly commandName: string
  readonly declaredName?: string
  readonly description?: string
  readonly relativePath: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly metadataStatus: "parsed" | "partial" | "absent"
  readonly invocation: {
    readonly model: "allowed-by-metadata" | "disabled-by-metadata" | "unknown"
    readonly user: "allowed-by-metadata" | "disabled-by-metadata" | "unknown"
  }
  readonly declared: {
    readonly argumentHint?: string
    readonly allowedTools?: readonly string[]
    readonly disallowedTools?: readonly string[]
    readonly context?: string
    readonly agent?: string
    readonly model?: string
    readonly compatibility?: string
    readonly unknownFields: readonly string[]
  }
  readonly observedFeatures: readonly SkillFeature[]
  readonly activation: { readonly status: "disabled"; readonly reason: "native-adapter-required" }
}

export interface SkillCatalog {
  readonly workspaceId: string
  readonly skills: readonly SkillDescriptor[]
  readonly roots: readonly {
    readonly scope: SkillScope
    readonly status: "scanned" | "missing" | "rejected" | "limit-reached"
  }[]
  readonly diagnostics: readonly {
    readonly scope: SkillScope
    readonly code:
      | "unsafe-path"
      | "unreadable"
      | "invalid-metadata"
      | "too-large"
      | "unsupported-name"
      | "limit-reached"
    readonly relativePath?: string
  }[]
}

/** Native runtime evidence is separate from catalog discovery and host authorization. */
export type NativeSkillSupport =
  | { readonly status: "disabled" | "unknown"; readonly reason: string }
  | {
      readonly status: "supported"
      readonly runtimeId: string
      readonly formats: readonly "claude-skill"[]
      readonly invocation: readonly ("user" | "model")[]
      readonly evidence: Evidence
      readonly limitations: readonly string[]
    }

/** Future admission input, never a tool grant or a request to inline SKILL.md into another runtime. */
export interface SkillActivationIntent {
  readonly skillId: string
  readonly sha256: string
  readonly workspaceId: string
  readonly runtimeId: string
  readonly targetId: string
  readonly policyId: string
  readonly policyVersion: string
  readonly invocation: "user" | "model"
}
