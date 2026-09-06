import { isAbsolute, resolve } from "node:path"
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
  RuntimeDescriptor,
  RuntimePreflight,
} from "@harness/protocol"
import type { AdapterSessionContext, AgentAdapter, DiscoveryContext } from "../index"
import { NativeClaudeInspector, PINNED_CLAUDE_VERSION } from "./inspect"

export interface ClaudeInspector {
  version(): Promise<string>
  authStatus(): Promise<{ readonly loggedIn: boolean }>
  dispose(): Promise<void>
}

export interface ClaudeAdapterOptions {
  readonly executable: string
  /** Private host inspection directory; never the selected repository. */
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly target: ExecutionTarget
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** Privileged fixture seam. Never accepted from renderer or remote requests. */
  readonly inspectorFactory?: (options: ConstructorParameters<typeof NativeClaudeInspector>[0]) => ClaudeInspector
}

const unavailable =
  "Claude execution and Skills activation require verified native policy, permission and billing evidence."

/** Native authentication status only. No login, credential import, inference or session route exists here. */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude-code"
  readonly version = "0.1.0"
  private readonly options: ClaudeAdapterOptions
  private readonly inspector: ClaudeInspector
  private disposed = false
  private disposing: Promise<void> | undefined

  constructor(options: ClaudeAdapterOptions) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.cwd) ||
      options.target.kind !== "local" ||
      !options.target.id ||
      options.target.nodeId !== undefined
    )
      throw new Error("Claude requires an explicit absolute local executable and inspection directory")
    this.options = {
      ...options,
      environment: Object.freeze({ ...options.environment }),
      target: Object.freeze({ ...options.target }),
    }
    this.inspector = (options.inspectorFactory ?? ((input) => new NativeClaudeInspector(input)))({
      executable: this.options.executable,
      cwd: this.options.cwd,
      environment: this.options.environment,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    })
  }

  async discover(context: DiscoveryContext): Promise<readonly RuntimeDescriptor[]> {
    if (
      this.disposed ||
      !this.sameTarget(context.target) ||
      !context.allowedExecutablePaths.some((path) => samePath(path, this.options.executable))
    )
      return []
    try {
      await this.verifyVersion()
    } catch {
      return []
    }
    return [
      {
        id: "claude-local",
        adapterId: this.id,
        name: "Claude Code",
        kind: "native-agent",
        providers: [{ id: "anthropic", name: "Anthropic" }],
        target: { ...this.options.target },
        version: PINNED_CLAUDE_VERSION,
        executable: this.options.executable,
        authModes: ["unknown"],
        billingModes: ["unknown"],
        capabilities: this.capabilities(),
        integration: "conditional",
      },
    ]
  }

  capabilities(): AgentCapabilities {
    return Object.fromEntries(
      [
        "chat",
        "coding",
        "reasoning",
        "filesystem",
        "terminal",
        "diff",
        "git",
        "mcp",
        "subagents",
        "skills",
        "hooks",
        "web",
        "image-input",
        "structured-output",
        "permissions",
        "session-resume",
        "context-telemetry",
        "token-telemetry",
        "cost-telemetry",
        "quota-telemetry",
        "remote-execution",
        "review-mode",
        "streaming",
        "human-input",
      ].map((capability) => [capability, { status: "unsupported" as const, reason: unavailable }]),
    )
  }

  async status(runtime: RuntimeDescriptor): Promise<RuntimePreflight> {
    if (
      runtime.id !== "claude-local" ||
      runtime.adapterId !== this.id ||
      runtime.kind !== "native-agent" ||
      runtime.version !== PINNED_CLAUDE_VERSION ||
      runtime.nativeProtocolVersion !== undefined ||
      runtime.executable === undefined ||
      !samePath(runtime.executable, this.options.executable) ||
      !this.sameTarget(runtime.target) ||
      runtime.providers.length !== 1 ||
      runtime.providers[0]?.id !== "anthropic"
    )
      throw new Error("Invalid Claude native status binding")
    try {
      await this.verifyVersion()
      const auth = await this.inspector.authStatus()
      if (this.disposed || typeof auth.loggedIn !== "boolean") throw new Error("Invalid native authentication status")
      const checkedAt = new Date().toISOString()
      return {
        auth: {
          runtimeId: "claude-local",
          targetId: this.options.target.id,
          status: auth.loggedIn ? "authenticated" : "unauthenticated",
          mode: "unknown",
          evidence: { source: "native-status", observedAt: checkedAt, runtimeVersion: PINNED_CLAUDE_VERSION },
        },
        billing: { route: "unknown", providerOverage: "unknown" },
        capabilities: this.capabilities(),
        enforcement: {
          mechanism: "none",
          filesystem: false,
          shell: false,
          network: false,
          limitations: [unavailable],
        },
        checkedAt,
        expiresAt: checkedAt,
        configurationFingerprint: "claude-native-status-only:unverified",
      }
    } catch {
      throw new Error("Claude native status is unavailable")
    }
  }

  async preflight(_request: AdapterPreflightRequest): Promise<AdapterPreflight> {
    return { status: "blocked", errors: [{ code: "unsupported", message: unavailable, retryable: false }] }
  }

  async createSession(_request: AdmittedSessionRequest): Promise<AgentSession> {
    throw new Error(unavailable)
  }

  async send(_context: AdapterSessionContext, _input: AgentInput): Promise<CommandReceipt> {
    throw new Error(unavailable)
  }

  events(_session: AgentSession): AsyncIterable<AgentEventDraft> {
    throw new Error(unavailable)
  }

  async interrupt(_context: AdapterSessionContext): Promise<void> {
    throw new Error(unavailable)
  }

  async close(_session: AgentSession): Promise<void> {
    await this.dispose()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposing ??= this.inspector.dispose()
    await this.disposing
  }

  private sameTarget(target: ExecutionTarget): boolean {
    return (
      target.id === this.options.target.id &&
      target.kind === "local" &&
      target.name === this.options.target.name &&
      target.nodeId === undefined
    )
  }

  private async verifyVersion(): Promise<void> {
    if (this.disposed) throw new Error("Claude native inspector is closed")
    if ((await this.inspector.version()) !== PINNED_CLAUDE_VERSION || this.disposed)
      throw new Error("Unsupported Claude native version")
  }
}

function samePath(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}
