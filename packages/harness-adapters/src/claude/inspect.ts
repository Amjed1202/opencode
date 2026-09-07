import { spawn } from "node:child_process"
import type { ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import { lstat, realpath } from "node:fs/promises"
import { delimiter, isAbsolute, resolve } from "node:path"
import { createHash } from "node:crypto"

export const PINNED_CLAUDE_VERSION = "2.1.251"
export interface ClaudeSubscriptionObservation {
  readonly accountId: string
  readonly emailHash: string
  readonly personalSubscription: true
}
export interface ClaudeInspectionOptions {
  readonly executable: string
  /** Private host directory, not an untrusted repository. */
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** Privileged process seam for local fixtures; never exposed over desktop IPC. */
  readonly launch?: (
    command: readonly string[],
    options: { cwd: string; env: Record<string, string> },
  ) => ChildProcessByStdio<null, Readable, Readable>
}

/** Fixed native diagnostic commands only. No prompts, login, token import or arbitrary command operation. */
export class NativeClaudeInspector {
  private readonly options: ClaudeInspectionOptions
  private readonly children = new Map<ChildProcessByStdio<null, Readable, Readable>, Promise<void>>()
  private busy = false
  private disposed = false
  constructor(options: ClaudeInspectionOptions) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.cwd))
      throw new Error("Explicit local Claude paths are required")
    const allowed = new Set([
      "HOME",
      "USERPROFILE",
      "PATH",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ])
    if (
      Object.entries(options.environment).some(
        ([name, value]) => !allowed.has(name) || typeof value !== "string" || value.includes("\0"),
      )
    )
      throw new Error("Unsafe Claude inspection environment")
    if (
      !options.environment.HOME ||
      !isAbsolute(options.environment.HOME) ||
      (process.platform === "win32" && options.environment.USERPROFILE !== options.environment.HOME)
    )
      throw new Error("Explicit native account home is required")
    for (const name of ["USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      const value = options.environment[name]
      if (value !== undefined && !isAbsolute(value)) throw new Error("Unsafe Claude inspection environment")
    }
    if (
      options.environment.PATH !== undefined &&
      options.environment.PATH.split(delimiter).some((path) => !isAbsolute(path))
    )
      throw new Error("Unsafe Claude inspection environment")
    for (const [value, minimum, maximum] of [
      [options.timeoutMs ?? 5000, 50, 30000],
      [options.maxOutputBytes ?? 64 * 1024, 256, 1024 * 1024],
    ]) {
      if (!Number.isSafeInteger(value) || value! < minimum! || value! > maximum!)
        throw new Error("Invalid Claude diagnostic bounds")
    }
    this.options = { ...options, environment: Object.freeze({ ...options.environment }) }
  }

  async version(): Promise<string> {
    const result = await this.run(["--version"])
    if (result.code !== 0 || result.stdout.trim() !== `${PINNED_CLAUDE_VERSION} (Claude Code)`)
      throw new Error("Unsupported Claude native version")
    return PINNED_CLAUDE_VERSION
  }

  async authStatus(): Promise<{ loggedIn: boolean }> {
    const result = await this.run(["auth", "status"])
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch {
      throw new Error("Invalid Claude native status")
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("loggedIn" in value) ||
      typeof value.loggedIn !== "boolean" ||
      result.code !== (value.loggedIn ? 0 : 1)
    )
      throw new Error("Invalid Claude native status")
    // Auth method, provider, account identifiers, paths and all unknown fields stay private.
    // A signed-in native account is not evidence of subscription billing or safe effective settings.
    return { loggedIn: value.loggedIn }
  }

  /** Pinned native projection. Values and account identifiers never leave this inspector. */
  async subscriptionStatus(): Promise<ClaudeSubscriptionObservation> {
    const result = await this.run(["auth", "status"])
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch {
      throw new Error("Invalid Claude subscription observation")
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("loggedIn" in value) ||
      value.loggedIn !== true ||
      result.code !== 0 ||
      !("authMethod" in value) ||
      value.authMethod !== "claude.ai" ||
      !("apiProvider" in value) ||
      value.apiProvider !== "firstParty" ||
      !("subscriptionType" in value) ||
      !["pro", "max"].includes(String(value.subscriptionType)) ||
      ("apiKeySource" in value && value.apiKeySource !== undefined && value.apiKeySource !== null) ||
      !("email" in value) ||
      typeof value.email !== "string" ||
      !value.email ||
      value.email.length > 320 ||
      !("orgId" in value) ||
      typeof value.orgId !== "string" ||
      !value.orgId ||
      value.orgId.length > 128
    )
      throw new Error("Claude personal subscription route is unavailable")
    return {
      accountId: createHash("sha256")
        .update(JSON.stringify([value.email.toLowerCase(), value.orgId]))
        .digest("hex"),
      emailHash: createHash("sha256").update(value.email.toLowerCase()).digest("hex"),
      personalSubscription: true,
    }
  }

  private async run(args: readonly string[]) {
    if (this.disposed || this.busy) throw new Error("Claude inspector is unavailable")
    this.busy = true
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined
    let closed: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const before = await lstat(this.options.executable, { bigint: true })
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        !samePath(await realpath(this.options.executable), this.options.executable) ||
        !samePath(await realpath(this.options.cwd), this.options.cwd)
      )
        throw new Error("Unsafe Claude diagnostic path")
      if (this.disposed) throw new Error("Claude inspector is unavailable")
      const env = {
        ...this.options.environment,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      }
      child = (
        this.options.launch ??
        ((command, options) =>
          spawn(command[0]!, command.slice(1), {
            ...options,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
          }))
      )([this.options.executable, ...args], { cwd: this.options.cwd, env })
      const process = child
      closed = new Promise((resolve) =>
        process.once("close", () => {
          this.children.delete(process)
          resolve()
        }),
      )
      this.children.set(process, closed)
      const exited = new Promise<number | null>((resolve, reject) => {
        process.once("error", () => reject(new Error("Claude diagnostic process failed")))
        process.once("exit", (code) => resolve(code))
      })
      let bytes = 0
      const read = (stream: Readable) =>
        new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength
            if (bytes > (this.options.maxOutputBytes ?? 64 * 1024)) {
              reject(new Error("Claude diagnostic output exceeded limit"))
              return
            }
            chunks.push(chunk)
          })
          stream.once("error", () => reject(new Error("Claude diagnostic stream failed")))
          stream.once("close", () => {
            if (!stream.readableEnded) reject(new Error("Claude diagnostic stream closed"))
          })
          stream.once("end", () => {
            try {
              resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
            } catch {
              reject(new Error("Invalid Claude diagnostic encoding"))
            }
          })
        })
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude diagnostic timed out")), this.options.timeoutMs ?? 5000)
      })
      const [stdout, , code] = await Promise.race([
        Promise.all([read(process.stdout), read(process.stderr), exited]),
        timeout,
      ])
      const after = await lstat(this.options.executable, { bigint: true })
      if (
        this.disposed ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        after.nlink !== 1n
      )
        throw new Error("Claude diagnostic identity changed")
      return { stdout, code }
    } catch {
      throw new Error("Claude native inspection failed")
    } finally {
      clearTimeout(timer)
      if (child && closed) await this.stop(child, closed)
      this.busy = false
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.children].map(([child, closed]) => this.stop(child, closed)))
  }

  private async stop(child: ChildProcessByStdio<null, Readable, Readable>, closed: Promise<void>) {
    // Descendants can inherit these handles. Closing our read ends bounds cleanup;
    // it does not establish termination of the native process tree.
    child.stdout.destroy()
    child.stderr.destroy()
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    } catch {
      this.disposed = true
      throw new Error("Claude diagnostic termination is unconfirmed")
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const complete = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 250)
        }),
      ])
      // An unconfirmed shutdown cannot overlap another diagnostic.
      if (!complete) {
        this.disposed = true
        throw new Error("Claude diagnostic termination is unconfirmed")
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}
