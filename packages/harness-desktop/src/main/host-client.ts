import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { DesktopOperation, DesktopState } from "../shared/contracts"

export class HostClient {
  private readonly child: ReturnType<typeof spawn>
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private buffer = Buffer.alloc(0)
  private stopped = false
  private closing = false
  constructor(
    private readonly options: {
      executable: string
      worker: string
      environment: Record<string, string>
      changed: (state: DesktopState) => void
      failed: () => void
    },
  ) {
    this.child = spawn(options.executable, [options.worker], {
      env: options.environment,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    })
    this.child.stdout!.on("data", (chunk: Buffer) => {
      if (this.stopped) return
      try {
        this.buffer = Buffer.concat([this.buffer, chunk])
        while (true) {
          const newline = this.buffer.indexOf(10)
          if (newline === -1) break
          if (newline > 4 * 1024 * 1024) throw new Error("Host frame exceeded limit")
          const frame: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, newline)),
          )
          this.buffer = this.buffer.subarray(newline + 1)
          if (typeof frame !== "object" || !frame || Array.isArray(frame)) throw new Error("Invalid host frame")
          if ("event" in frame && frame.event === "state" && "state" in frame && Object.keys(frame).length === 2)
            options.changed(frame.state as DesktopState)
          else if ("id" in frame && typeof frame.id === "string") {
            if (
              Object.keys(frame).length !== 2 ||
              "error" in frame === "result" in frame ||
              ("error" in frame && typeof frame.error !== "string")
            )
              throw new Error("Invalid host response")
            const request = this.pending.get(frame.id)
            if (!request) throw new Error("Unknown host response")
            this.pending.delete(frame.id)
            clearTimeout(request.timer)
            if ("error" in frame)
              request.reject(new Error(typeof frame.error === "string" ? frame.error : "Desktop operation failed"))
            else if ("result" in frame) request.resolve(frame.result)
            else throw new Error("Invalid host response")
          } else throw new Error("Invalid host frame")
        }
        if (this.buffer.length > 4 * 1024 * 1024) throw new Error("Host buffer exceeded limit")
      } catch {
        this.stop(true)
      }
    })
    this.child.stdin!.on("error", () => this.stop(true))
    this.child.stdout!.on("error", () => this.stop(true))
    this.child.on("error", () => this.stop(true))
    this.child.on("exit", () => this.stop(true))
  }

  request(operation: DesktopOperation | "initialize", input?: unknown): Promise<unknown> {
    if (this.stopped || this.pending.size >= 32) return Promise.reject(new Error("Desktop host is unavailable"))
    const id = randomUUID()
    const frame = JSON.stringify({ id, operation, ...(input === undefined ? {} : { input }) }) + "\n"
    if (Buffer.byteLength(frame) > 1024 * 1024) return Promise.reject(new Error("Desktop request exceeded limit"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(true)
      }, 65_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(frame, (error) => {
        if (error) this.stop(true)
      })
    })
  }

  async close() {
    if (this.stopped) return
    this.closing = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.request("shutdown").catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 3000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      this.stop()
    }
  }
  private stop(failed = false) {
    if (this.stopped) return
    this.stopped = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Desktop host disconnected; automatic replay is disabled"))
    }
    this.pending.clear()
    this.buffer = Buffer.alloc(0)
    this.child.kill()
    if (failed && !this.closing) this.options.failed()
  }
}
