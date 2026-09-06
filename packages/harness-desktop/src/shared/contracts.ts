import type { HumanInputRequest, InteractionReview, PermissionRequest, SkillCatalog } from "@harness/protocol"

export const desktopChannels = {
  getState: "harness:state",
  chooseWorkspace: "harness:choose-workspace",
  chooseRuntime: "harness:choose-runtime",
  selectRuntime: "harness:select-runtime",
  chooseNativeHome: "harness:choose-native-home",
  chooseSkillsRoot: "harness:choose-skills-root",
  refresh: "harness:refresh",
  start: "harness:start",
  send: "harness:send",
  interrupt: "harness:interrupt",
  review: "harness:review",
  resolvePermission: "harness:resolve-permission",
  resolveInput: "harness:resolve-input",
  changed: "harness:changed",
} as const

export interface DesktopConfiguration {
  readonly runtime?: "codex" | "claude"
  readonly workspace?: { readonly id: string; readonly name: string; readonly path: string }
  readonly executable?: string
  readonly nativeHome?: string
  readonly userSkillsRoot?: string
}

export interface DesktopState {
  readonly revision: number
  readonly configuration: DesktopConfiguration
  readonly connection: {
    readonly status: "not-configured" | "not-checked" | "ready" | "blocked"
    readonly runtimeName: string
    readonly runtimeVersion?: string
    readonly authentication: "unknown" | "subscription" | "authenticated" | "unauthenticated"
    readonly billing: "unknown" | "subscription"
    readonly providerOverage: "unknown"
    readonly reason?: string
  }
  readonly session?: { readonly id: string; readonly status: string; readonly modelId: string }
  readonly messages: readonly { readonly id: string; readonly role: "user" | "assistant"; readonly text: string }[]
  readonly activity: readonly { readonly id: string; readonly kind: string; readonly label: string }[]
  readonly permissions: readonly PermissionRequest[]
  readonly inputs: readonly HumanInputRequest[]
  readonly skills: SkillCatalog | null
  readonly notices: readonly string[]
}

export interface StartSessionInput {
  readonly modelId: string
  readonly acknowledgeOverage: boolean
  readonly allowFileChanges: boolean
  readonly acknowledgeUnverifiedBoundary: boolean
}

export interface PermissionReplyInput {
  readonly requestId: string
  readonly choiceId: string
  readonly reviewToken?: string
}

export interface ChoiceReplyInput {
  readonly requestId: string
  readonly action: "answer" | "cancel"
  readonly selections: readonly { readonly questionId: string; readonly optionId: string }[]
  readonly reviewToken?: string
}

/** Narrow renderer API. No paths, credentials, channels or arbitrary native methods can be submitted. */
export interface DesktopAPI {
  getState(): Promise<DesktopState>
  chooseWorkspace(): Promise<DesktopState>
  chooseRuntime(): Promise<DesktopState>
  selectRuntime(input: { readonly runtime: "codex" | "claude" }): Promise<DesktopState>
  chooseNativeHome(): Promise<DesktopState>
  chooseSkillsRoot(): Promise<DesktopState>
  refresh(): Promise<DesktopState>
  start(input: StartSessionInput): Promise<DesktopState>
  send(input: { readonly text: string }): Promise<DesktopState>
  interrupt(): Promise<DesktopState>
  review(input: { readonly kind: "permission" | "input"; readonly requestId: string }): Promise<InteractionReview>
  resolvePermission(input: PermissionReplyInput): Promise<DesktopState>
  resolveInput(input: ChoiceReplyInput): Promise<DesktopState>
  onState(listener: (state: DesktopState) => void): () => void
}

export type DesktopOperation =
  | Exclude<keyof DesktopAPI, "onState" | "chooseWorkspace" | "chooseRuntime" | "chooseNativeHome" | "chooseSkillsRoot">
  | "configure"
  | "shutdown"

declare global {
  interface Window {
    harness: DesktopAPI
  }
}
