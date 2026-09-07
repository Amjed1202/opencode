import type {
  HumanInputRequest,
  InteractionReview,
  PermissionRequest,
  SkillCatalog,
  UsageSnapshot,
  ContextSnapshot,
} from "@harness/protocol"

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
  viewConversation: "harness:view-conversation",
  inspectConversation: "harness:inspect-conversation",
  reconcileConversation: "harness:reconcile-conversation",
  resumeConversation: "harness:resume-conversation",
  detachConversation: "harness:detach-conversation",
  listFiles: "harness:list-files",
  previewFile: "harness:preview-file",
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
  readonly session?: { readonly id: string; readonly status: string; readonly modelId: string } | undefined
  readonly conversations?: { readonly items: readonly ConversationSummary[]; readonly truncated: boolean }
  readonly history?:
    | { readonly id: string; readonly partial: boolean; readonly unconfirmedMessages: number }
    | undefined
  readonly inspection?: ConversationInspection | undefined
  readonly runtimeFeatures?: { readonly resume: boolean; readonly inspection: boolean }
  readonly usage?: UsageSnapshot | undefined
  readonly context?: ContextSnapshot | undefined
  /** Native catalog observation only; never proof of entitlement or billing. */
  readonly models: {
    readonly status: "not-loaded" | "ready" | "unavailable" | "unsupported"
    readonly items: readonly { readonly id: string; readonly name: string }[]
    readonly checkedAt?: string
  }
  readonly messages: readonly { readonly id: string; readonly role: "user" | "assistant"; readonly text: string }[]
  readonly activity: readonly { readonly id: string; readonly kind: string; readonly label: string }[]
  readonly permissions: readonly PermissionRequest[]
  readonly inputs: readonly HumanInputRequest[]
  readonly skills: SkillCatalog | null
  readonly notices: readonly string[]
}

export interface ConversationSummary {
  readonly id: string
  readonly workspaceId: string
  readonly runtimeId: string
  readonly modelId: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly compatible: boolean
}
export interface ConversationInspection {
  readonly sessionId: string
  readonly observedAt: string
  readonly nativeState: string
  readonly completeness: string
  readonly turnCount: number
  readonly runningTurns: number
  readonly terminalTurns: number
  readonly unknownTurns: number
}
export interface WorkspaceFileList {
  readonly items: readonly {
    readonly id: string
    readonly path: string
    readonly bytes: number
    readonly change: "added" | "modified" | "deleted" | "unchanged" | "unknown"
  }[]
  readonly truncated: boolean
  readonly baseline: "session-start" | "unavailable"
}
export interface WorkspaceFilePreview {
  readonly path: string
  readonly text: string | null
  readonly before: string | null
  readonly diff: string | null
  readonly baseline: "session-start" | "unavailable"
}

export interface StartSessionInput {
  readonly modelId: string
  readonly acknowledgeOverage: boolean
  readonly allowFileChanges: boolean
  readonly acknowledgeUnverifiedBoundary: boolean
  readonly skills?: readonly {
    readonly skillId: string
    readonly sha256: string
    readonly invocation: "user" | "model"
  }[]
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
  viewConversation(input: { readonly sessionId: string }): Promise<DesktopState>
  inspectConversation(input: { readonly sessionId: string }): Promise<DesktopState>
  reconcileConversation(input: { readonly sessionId: string }): Promise<DesktopState>
  resumeConversation(input: {
    readonly sessionId: string
    readonly acknowledgeOverage: boolean
    readonly acknowledgeUnverifiedBoundary: boolean
  }): Promise<DesktopState>
  detachConversation(): Promise<DesktopState>
  listFiles(): Promise<WorkspaceFileList>
  previewFile(input: { readonly fileId: string }): Promise<WorkspaceFilePreview>
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
