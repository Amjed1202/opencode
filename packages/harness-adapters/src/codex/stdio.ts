import type { Subprocess } from "bun"

export type RpcId = string | number
export interface NativeNotification {
  readonly method: string
  readonly params: unknown
}
export interface NativeRequest extends NativeNotification {
  readonly id: RpcId
}
export type NativeReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }

export interface StdioJsonRpcOptions {
  readonly command: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly requestTimeoutMs?: number
  readonly maxMessageBytes?: number
  readonly onNotification?: (message: NativeNotification) => void
  readonly onRequest?: (message: NativeRequest) => NativeReply
  readonly onClose?: (error: Error) => void
}

/** Private newline-delimited App Server transport; never logs native stderr or error bodies. */
export class StdioJsonRpc {
  private readonly process: Subprocess<"pipe", "pipe", "ignore">
  private readonly pending = new Map<
    RpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly maxBytes: number
  private readonly timeout: number
  private nextId = 0
  private stopped = false

  constructor(private readonly options: StdioJsonRpcOptions) {
    this.maxBytes = options.maxMessageBytes ?? 1024 * 1024
    this.timeout = options.requestTimeoutMs ?? 15_000
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 128 ||
      this.maxBytes > 16 * 1024 * 1024 ||
      !Number.isFinite(this.timeout) ||
      this.timeout <= 0 ||
      this.timeout > 120_000
    )
      throw new Error("Invalid transport limits")
    if (!options.command.length) throw new Error("Executable is required")
    this.process = Bun.spawn([...options.command], {
      cwd: options.cwd,
      env: { ...options.environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    })
    // stdout must drain before exit rejects pending work: a process may flush a final response before exiting.
    void this.read().catch(() => this.stop(new Error("Native protocol stream failed")))
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) throw new Error("Native transport is closed")
    if (this.pending.size >= 64) throw new Error("Too many pending native requests")
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.stop(new Error("Native request timed out; dispatch outcome is unknown")),
        this.timeout,
      )
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch {
        this.stop(new Error("Native request write failed"))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  async close(): Promise<void> {
    this.stop(new Error("Native transport is closed"))
    await this.process.exited
  }

  private write(value: unknown): void {
    if (this.stopped) throw new Error("Native transport is closed")
    const line = JSON.stringify(value) + "\n"
    if (Buffer.byteLength(line) > this.maxBytes) throw new Error("Native message exceeds limit")
    void Promise.resolve(this.process.stdin.write(line))
      .then(() => this.process.stdin.flush())
      .catch(() => this.stop(new Error("Native request write failed")))
  }

  private async read(): Promise<void> {
    const reader = this.process.stdout.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let buffer = Buffer.alloc(0)
    while (!this.stopped) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer = Buffer.concat([buffer, chunk.value])
      let newline = buffer.indexOf(10)
      while (newline !== -1) {
        if (newline > this.maxBytes) throw new Error("Native message exceeds limit")
        const line = buffer.subarray(0, newline)
        buffer = buffer.subarray(newline + 1)
        if (line.length) this.receive(JSON.parse(decoder.decode(line)))
        newline = buffer.indexOf(10)
      }
      if (buffer.length > this.maxBytes) throw new Error("Native message exceeds limit")
    }
    this.stop(new Error(buffer.length ? "Native stream ended mid-message" : "Native process exited"))
  }

  private receive(value: unknown): void {
    if (!isRecord(value)) throw new Error("Invalid native envelope")
    if (value.jsonrpc !== undefined && value.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version")
    if (typeof value.method === "string") {
      if (value.result !== undefined || value.error !== undefined) throw new Error("Ambiguous native envelope")
      if (value.id === undefined) {
        this.options.onNotification?.({ method: value.method, params: value.params })
        return
      }
      if (!isRpcId(value.id)) throw new Error("Invalid request ID")
      const reply = this.options.onRequest?.({ id: value.id, method: value.method, params: value.params }) ?? {
        error: { code: -32601, message: "Unsupported native request" },
      }
      this.write({ id: value.id, ...reply })
      return
    }
    if (!isRpcId(value.id) || !("result" in value) === !("error" in value)) throw new Error("Invalid native response")
    const pending = this.pending.get(value.id)
    if (!pending) throw new Error("Uncorrelated native response")
    this.pending.delete(value.id)
    clearTimeout(pending.timer)
    if ("error" in value) {
      pending.reject(new Error("Native request was rejected"))
      return
    }
    pending.resolve(value.result)
  }

  private stop(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.process.kill()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.options.onClose?.(error)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isRpcId(value: unknown): value is RpcId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
}
