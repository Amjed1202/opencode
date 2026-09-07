import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type {
  CanUseTool,
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeSubscriptionObservation } from "./inspect"

export const PINNED_CLAUDE_SDK_VERSION = "0.3.251"
export const claudeSettings = {
  disableAllHooks: true,
  autoMemoryEnabled: false,
  disableClaudeAiConnectors: true,
  syncClaudeAiSkills: false,
  enableArtifact: false,
  disableAgentView: true,
  disableRemoteControl: true,
  disableWorkflows: true,
  workflowKeywordTriggerEnabled: false,
  disableSkillShellExecution: true,
  fastMode: false,
  fastModePerSessionOptIn: true,
  fallbackModel: [],
} satisfies NonNullable<Exclude<Options["settings"], string>>

export interface ClaudeRuntimeOptions {
  readonly executable: string
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly sessionId?: string
  readonly resume?: string
  readonly model?: string
  readonly pluginPaths?: readonly string[]
  readonly modelSkills?: readonly string[]
  readonly tools: readonly string[]
  readonly canUseTool: CanUseTool
  readonly beforeWrite?: () => void
}

export interface ClaudeRuntime {
  initialize(): Promise<SDKControlInitializeResponse>
  send(message: SDKUserMessage): void
  events(): AsyncIterable<SDKMessage>
  interrupt(): Promise<void>
  authorizePermission(requestId: string, authorize: () => void): Promise<void>
  close(): Promise<void>
}

/** Official SDK owns its protocol; this wrapper owns the selected local process and prompt queue. */
export class NativeClaudeRuntime implements ClaudeRuntime {
  private readonly input = new InputStream()
  private readonly session: Query
  private child: ChildProcessWithoutNullStreams | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private lastInput: string | undefined
  private readonly replies = new Map<
    string,
    { guard: () => void; resolve: () => void; reject: (error: Error) => void }
  >()
  constructor(options: ClaudeRuntimeOptions) {
    this.session = query({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: options.executable,
        cwd: options.cwd,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.resume ? { resume: options.resume } : {}),
        ...(options.model ? { model: options.model } : {}),
        persistSession: options.sessionId !== undefined || options.resume !== undefined,
        settingSources: [],
        tools: [...options.tools],
        allowedTools: [],
        skills: [...(options.modelSkills ?? [])],
        plugins: (options.pluginPaths ?? []).map((path) => ({ type: "local", path })),
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: "default",
        canUseTool: options.canUseTool,
        hooks: {
          PreToolUse: [
            {
              hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } })],
            },
          ],
        },
        settings: { ...claudeSettings, permissions: { ask: [...options.tools], deny: ["mcp__*"] } },
        managedSettings: { disableAllHooks: true, disableSkillShellExecution: true },
        includePartialMessages: true,
        extraArgs: {
          restricted: null,
          "replay-user-messages": null,
          ...(!options.pluginPaths?.length ? { "safe-mode": null } : {}),
        },
        spawnClaudeCodeProcess: (native) => {
          if (native.command !== options.executable || native.cwd !== options.cwd || this.child)
            throw new Error("Invalid Claude native process binding")
          const child = spawn(native.command, native.args, {
            cwd: options.cwd,
            env: {
              ...options.environment,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              DISABLE_AUTOUPDATER: "1",
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            },
            windowsHide: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          })
          this.child = child
          // Bound native frames before the SDK parser can buffer an arbitrarily long line.
          let buffered = 0
          child.stdout.on("data", (data: Buffer) => {
            for (const byte of data) {
              buffered = byte === 10 ? 0 : buffered + 1
              if (buffered > 1024 * 1024) {
                child.kill("SIGKILL")
                break
              }
            }
          })
          child.stderr.resume()
          const write = child.stdin.write.bind(child.stdin)
          child.stdin.write = ((value: string | Uint8Array, ...args: unknown[]) => {
            const delivered: { resolve: () => void; reject: (error: Error) => void }[] = []
            try {
              options.beforeWrite?.()
              // Inspect SDK-generated replies only; the SDK remains the protocol encoder.
              // A host grant is rechecked at the actual pipe write, after SDK callback awaits.
              for (const line of (typeof value === "string" ? value : Buffer.from(value).toString("utf8")).split(
                "\n",
              )) {
                if (!line.trim()) continue
                const frame: unknown = JSON.parse(line)
                if (
                  !frame ||
                  typeof frame !== "object" ||
                  !("type" in frame) ||
                  frame.type !== "control_response" ||
                  !("response" in frame)
                )
                  continue
                const response = frame.response
                if (
                  !response ||
                  typeof response !== "object" ||
                  !("request_id" in response) ||
                  typeof response.request_id !== "string"
                )
                  throw new Error("Invalid SDK response framing")
                const guarded = this.replies.get(response.request_id)
                if (!guarded) {
                  if (
                    "response" in response &&
                    response.response &&
                    typeof response.response === "object" &&
                    "behavior" in response.response &&
                    response.response.behavior === "allow"
                  )
                    throw new Error("Unbound Claude tool allowance")
                  continue
                }
                if (
                  !("response" in response) ||
                  !response.response ||
                  typeof response.response !== "object" ||
                  !("behavior" in response.response)
                )
                  throw new Error("Unknown SDK permission reply")
                if (response.response.behavior === "allow") guarded.guard()
                else if (response.response.behavior !== "deny") throw new Error("Unknown SDK permission decision")
                this.replies.delete(response.request_id)
                delivered.push(guarded)
              }
              const callback = typeof args.at(-1) === "function" ? args.pop() : undefined
              args.push((error?: Error | null) => {
                if (error) {
                  for (const entry of delivered) entry.reject(new Error("Claude native reply write failed"))
                  child.kill("SIGKILL")
                } else for (const entry of delivered) entry.resolve()
                if (typeof callback === "function") Reflect.apply(callback, child.stdin, [error])
              })
              return Reflect.apply(write, child.stdin, [value, ...args])
            } catch {
              const error = new Error("Claude native reply authorization failed")
              for (const entry of delivered) entry.reject(error)
              for (const entry of this.replies.values()) entry.reject(error)
              this.replies.clear()
              child.kill("SIGKILL")
              throw error
            }
          }) as typeof child.stdin.write
          return child
        },
      },
    })
  }
  async initialize() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.session.initializationResult(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Claude initialization timed out")), 15000)
        }),
      ])
      if (this.closed || result.hooks_applied !== true || result.fast_mode_state !== "off")
        throw new Error("Claude initialization did not confirm native controls")
      return result
    } catch {
      await this.close()
      throw new Error("Claude native initialization is unavailable")
    } finally {
      clearTimeout(timer)
    }
  }
  send(message: SDKUserMessage) {
    if (this.closed) throw new Error("Claude runtime is closed")
    this.input.push(message)
    this.lastInput = message.uuid
  }
  events() {
    return this.session
  }
  async interrupt() {
    const input = this.lastInput
    const receipt = await this.session.interrupt()
    if (input && receipt?.still_queued?.includes(input)) {
      // A native queued input can survive interrupt. There is no public SDK queue-cancel method
      // on this pin: stop the selected process and leave the host command uncertain.
      await this.close()
      throw new Error("Claude input remained queued after interrupt; native execution was closed")
    }
  }
  authorizePermission(requestId: string, authorize: () => void) {
    if (this.closed || this.replies.has(requestId)) throw new Error("Claude permission reply is unavailable")
    return new Promise<void>((resolve, reject) => {
      this.replies.set(requestId, { guard: authorize, resolve, reject })
    })
  }
  close() {
    this.closing ??= this.stop()
    return this.closing
  }
  private async stop() {
    this.closed = true
    for (const reply of this.replies.values())
      reply.reject(new Error("Claude runtime closed before permission delivery"))
    this.replies.clear()
    this.input.close()
    this.session.close()
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", resolve)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2500)
        }),
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => child.once("close", resolve)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000)
          }),
        ])
      }
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("Claude native termination is unconfirmed")
    } finally {
      clearTimeout(timer)
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.destroy()
    }
  }
}

export function verifyClaudeInitialization(value: SDKControlInitializeResponse, auth: ClaudeSubscriptionObservation) {
  if (
    !value.account ||
    value.account.apiProvider !== "firstParty" ||
    !["pro", "max", "Pro", "Max", "Claude Pro", "Claude Max"].includes(value.account.subscriptionType ?? "") ||
    (value.account.apiKeySource !== undefined && value.account.apiKeySource !== "none") ||
    typeof value.account.email !== "string" ||
    createHash("sha256").update(value.account.email.toLowerCase()).digest("hex") !== auth.emailHash ||
    value.hooks_applied !== true ||
    value.fast_mode_state !== "off" ||
    !Array.isArray(value.models) ||
    value.models.length > 128
  )
    throw new Error("Claude initialized account or native controls differ from admission")
}

/** Absence-only check: policy values and native credential files are never read. */
export async function requireUnmanagedClaude(environment: Readonly<Record<string, string>>) {
  if (process.platform !== "win32") throw new Error("Claude unmanaged policy check is Windows-only")
  for (const path of [
    "C:\\Program Files\\ClaudeCode\\managed-settings.json",
    "C:\\Program Files\\ClaudeCode\\managed-settings.d",
    "C:\\Program Files\\ClaudeCode\\managed-mcp.json",
    join(environment.HOME!, ".claude", "remote-settings.json"),
  ]) {
    const present = await lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw new Error("Claude managed policy presence is unknown")
      },
    )
    if (present) throw new Error("Managed Claude configurations require a separate supported contract")
  }
  const powershell = join(environment.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (resolve(await realpath(powershell)).toLowerCase() !== resolve(powershell).toLowerCase())
    throw new Error("Invalid native policy inspector")
  const command =
    "$ErrorActionPreference='Stop'; $present=$false; foreach($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryHive]::CurrentUser)){foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view); try{$key=$base.OpenSubKey('SOFTWARE\\Policies\\ClaudeCode'); if($null -ne $key){$present=$true; $key.Dispose()}}finally{$base.Dispose()}}}; if($present){[Console]::Write('present')}else{[Console]::Write('absent')}"
  await new Promise<void>((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...environment },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let bytes = 0
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Claude native policy inspection timed out"))
    }, 5000)
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8")
      bytes += data.length
      if (bytes > 64) child.kill("SIGKILL")
    })
    child.stderr.resume()
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Claude policy inspection is unavailable"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout === "absent") resolve()
      else reject(new Error("Claude managed policy absence is unverified"))
    })
  })
}

class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private ended = false
  private wake: (() => void) | undefined
  push(message: SDKUserMessage) {
    if (this.ended || this.queue.length) throw new Error("Claude input is unavailable")
    this.queue.push(message)
    this.wake?.()
  }
  close() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      const message = this.queue.shift()
      if (message) {
        yield message
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}
