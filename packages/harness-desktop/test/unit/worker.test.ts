import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { removeFixtureDirectory } from "../../../harness-control-plane/test/support"
import type { DesktopState } from "../../src/shared/contracts"

type Frame = { id?: string; result?: unknown; error?: string; event?: string; state?: DesktopState }

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-private-worker-")))
  const storage = join(directory, "storage")
  const workspace = join(directory, "workspace")
  await mkdir(storage)
  await mkdir(workspace)
  const key = randomBytes(32)
  const child = spawn(process.execPath, [join(import.meta.dir, "../../src/host/worker.ts")], {
    cwd: join(import.meta.dir, "../.."),
    env: process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {},
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const state = { output: "", errors: "", buffered: "", ended: false }
  const frames: Frame[] = []
  const waiters = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  child.stdout.on("data", (chunk: Buffer) => {
    state.output += chunk.toString("utf8")
    state.buffered += decoder.decode(chunk, { stream: true })
    while (state.buffered.includes("\n")) {
      const index = state.buffered.indexOf("\n")
      const frame: Frame = JSON.parse(state.buffered.slice(0, index))
      state.buffered = state.buffered.slice(index + 1)
      frames.push(frame)
      if (frame.id) {
        waiters.get(frame.id)?.resolve(frame)
        waiters.delete(frame.id)
      }
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    state.errors = (state.errors + chunk.toString("utf8")).slice(-64 * 1024)
  })
  child.stdin.on("error", () => {})
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => {
      state.ended = true
      for (const waiter of waiters.values()) waiter.reject(new Error("Worker closed before response"))
      waiters.clear()
      resolve(code)
    })
  })
  const write = (bytes: string | Uint8Array) =>
    new Promise<void>((resolve, reject) => child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())))
  const response = (id: string) => {
    const existing = frames.find((frame) => frame.id === id)
    if (existing) return Promise.resolve(existing)
    return bounded(new Promise<Frame>((resolve, reject) => waiters.set(id, { resolve, reject })))
  }
  const request = async (operation: string, input?: unknown) => {
    const id = randomUUID()
    await write(JSON.stringify({ id, operation, ...(input === undefined ? {} : { input }) }) + "\n")
    return response(id)
  }
  return {
    directory,
    storage,
    workspace,
    key,
    child,
    state,
    frames,
    exited,
    write,
    response,
    request,
    initialize: () =>
      request("initialize", {
        directory: storage,
        key: key.toString("base64"),
        environment: {},
        toolPath: dirname(process.execPath),
      }),
    async close() {
      if (!state.ended) child.kill()
      await bounded(exited)
      key.fill(0)
      await removeFixtureDirectory(directory)
    },
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Private worker timed out")), 3000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("real Bun desktop private worker", () => {
  test("initializes empty local state without provider configuration and shuts down cleanly", async () => {
    const value = await fixture()
    try {
      const initialized = await value.initialize()
      const state = initialized.result as DesktopState
      expect(initialized.error).toBeUndefined()
      expect(state.configuration).toEqual({})
      expect(state.connection.status).toBe("not-configured")
      expect(state.connection.authentication).toBe("unknown")
      expect(state.messages).toEqual([])
      expect(state.permissions).toEqual([])
      expect(state.inputs).toEqual([])
      expect(state.session).toBeUndefined()
      expect((await value.request("getState")).result).toEqual(state)
      expect(
        (
          await value.request("start", {
            modelId: "fixture-only",
            acknowledgeOverage: true,
            allowFileChanges: false,
            acknowledgeUnverifiedBoundary: true,
          })
        ).error,
      ).toContain("no automatic retry")
      expect((await value.request("send", { text: "never sent to a provider" })).error).toContain("no automatic retry")
      expect((await value.request("getState")).result).toEqual(state)
      expect((await value.request("shutdown")).result).toBeNull()
      expect(await bounded(value.exited)).toBe(0)
      expect(await readdir(value.workspace)).toEqual([])
      expect(
        (await readdir(value.storage)).every((name) => name === "artifacts" || name.startsWith("journal.sqlite")),
      ).toBe(true)
      expect(value.state.output + value.state.errors).not.toContain(value.key.toString("base64"))
    } finally {
      await value.close()
    }
  })

  test("preserves multibyte configure values split between stdin chunks", async () => {
    const value = await fixture()
    try {
      await value.initialize()
      const id = randomUUID()
      const input = { workspace: { id: "unicode-project", name: "Café🙂", path: value.workspace } }
      const bytes = Buffer.from(JSON.stringify({ id, operation: "configure", input }) + "\n")
      const offset = bytes.indexOf(Buffer.from("🙂")) + 1
      await value.write(bytes.subarray(0, offset))
      await new Promise((resolve) => setTimeout(resolve, 20))
      await value.write(bytes.subarray(offset))
      const frame = await value.response(id)
      expect(frame.error).toBeUndefined()
      expect((frame.result as DesktopState).configuration.workspace?.name).toBe(input.workspace.name)
      expect((frame.result as DesktopState).configuration.workspace?.path).toBe(input.workspace.path)
      expect((frame.result as DesktopState).configuration.workspace?.id).toMatch(/^[a-f0-9]{64}$/)
      expect((frame.result as DesktopState).connection.status).toBe("not-checked")
      expect(
        value.frames.some(
          (frame) => frame.event === "state" && frame.state?.configuration.workspace?.name === "Café🙂",
        ),
      ).toBe(true)
      expect((await value.request("getState")).result).toEqual(frame.result)
      await value.request("shutdown")
      expect(await bounded(value.exited)).toBe(0)
    } finally {
      await value.close()
    }
  })

  test("rejects malformed, invalid-UTF8, oversized and truncated frames without creating storage", async () => {
    for (const bytes of [
      Buffer.from("{bad}\n"),
      Buffer.from([0xff, 0x0a]),
      Buffer.from(JSON.stringify({ id: randomUUID(), operation: "getState", unknown: true }) + "\n"),
      Buffer.from("x".repeat(1024 * 1024 + 1)),
      Buffer.from(JSON.stringify({ id: randomUUID(), operation: "getState" })),
      Buffer.from([0xf0, 0x9f]),
    ]) {
      const value = await fixture()
      try {
        await value.write(bytes)
        value.child.stdin.end()
        expect(await bounded(value.exited)).not.toBe(0)
        expect(value.frames).toEqual([])
        expect(await readdir(value.storage)).toEqual([])
      } finally {
        await value.close()
      }
    }
  })

  test("fails closed after initialization when the final frame is truncated", async () => {
    const value = await fixture()
    try {
      await value.initialize()
      const id = randomUUID()
      await value.write(JSON.stringify({ id, operation: "send", input: { text: "incomplete frame" } }))
      value.child.stdin.end()
      expect(await bounded(value.exited)).not.toBe(0)
      expect(value.frames.some((frame) => frame.id === id)).toBe(false)
      expect(value.state.output + value.state.errors).not.toContain(value.key.toString("base64"))
    } finally {
      await value.close()
    }
  })

  test("rejects invalid key/environment initialization and duplicate initialization", async () => {
    const value = await fixture()
    try {
      for (const input of [
        { directory: value.storage, key: "not-base64", environment: {}, toolPath: dirname(process.execPath) },
        {
          directory: value.storage,
          key: value.key.toString("base64"),
          environment: [],
          toolPath: dirname(process.execPath),
        },
        {
          directory: value.storage,
          key: value.key.toString("base64"),
          environment: { VALUE: "bad\0value" },
          toolPath: dirname(process.execPath),
        },
      ])
        expect((await value.request("initialize", input)).error).toContain("no automatic retry")
      expect(await readdir(value.storage)).toEqual([])
      const initial = await value.initialize()
      expect(initial.error).toBeUndefined()
      expect((await value.initialize()).error).toContain("no automatic retry")
      expect((await value.request("getState")).result).toEqual(initial.result)
      await value.request("shutdown")
      expect(await bounded(value.exited)).toBe(0)
    } finally {
      await value.close()
    }
  })
})
