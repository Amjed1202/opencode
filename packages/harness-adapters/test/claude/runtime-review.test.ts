import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { NativeClaudeRuntime } from "../../src/claude/runtime"

let buildDirectory: string
let executable: string
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), "harness-claude-wire-review-"))
  executable = join(buildDirectory, process.platform === "win32" ? "claude-peer.exe" : "claude-peer")
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "fixtures", "runtime-peer.ts"),
      "--compile",
      "--outfile",
      executable,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true },
  )
  const errors = await new Response(build.stderr).text()
  if ((await build.exited) !== 0) throw new Error(`Review peer failed to compile: ${errors}`)
  // Separate first execution of a freshly compiled Windows binary from protocol timing.
  const warmup = Bun.spawn([executable], {
    cwd: buildDirectory,
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT!,
      HARNESS_CLAUDE_REVIEW_DIRECTORY: buildDirectory,
      HARNESS_CLAUDE_REVIEW_SCENARIO: "warmup",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  if ((await warmup.exited) !== 0) throw new Error("Review peer cold startup failed")
}, 45000)
afterAll(async () => {
  if (buildDirectory) await removeFixture(buildDirectory)
})

async function fixture(scenario: string, permission: CanUseTool, beforeWrite?: () => void) {
  const directory = await mkdtemp(join(buildDirectory, "run-"))
  const runtime = new NativeClaudeRuntime({
    executable,
    cwd: directory,
    environment: {
      SYSTEMROOT: process.env.SYSTEMROOT!,
      HARNESS_CLAUDE_REVIEW_DIRECTORY: directory,
      HARNESS_CLAUDE_REVIEW_SCENARIO: scenario,
    },
    sessionId: randomUUID(),
    tools: ["Write"],
    canUseTool: permission,
    ...(beforeWrite ? { beforeWrite } : {}),
  })
  const reading = (async () => {
    try {
      for await (const _event of runtime.events()) {
      }
    } catch {}
  })()
  return {
    runtime,
    directory,
    send: () =>
      runtime.send({
        type: "user",
        uuid: randomUUID(),
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: { role: "user", content: "Synthetic local fixture" },
      }),
    close: async () => {
      await runtime.close()
      await reading
    },
    pid: async () => {
      await existsSoon(join(directory, "process.json"))
      return (await Bun.file(join(directory, "process.json")).json()).pid as number
    },
  }
}

test("wire review: official SDK allows only after the synchronous pipe-write guard", async () => {
  let guarded = false
  const delivery = Promise.withResolvers<Promise<void>>()
  const state = await fixture("allow", async (_tool, input, native) => {
    delivery.resolve(
      state.runtime.authorizePermission(native.requestId!, () => {
        guarded = true
      }),
    )
    return { behavior: "allow", updatedInput: input }
  })
  try {
    await state.runtime.initialize()
    state.send()
    await Promise.race([
      delivery.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Guarded SDK delivery did not settle")), 1500),
      ),
    ])
    expect(guarded).toBe(true)
    await existsSoon(join(state.directory, "permission.json"))
    expect(await Bun.file(join(state.directory, "permission.json")).json()).toMatchObject({
      subtype: "success",
      request_id: "fixture-permission",
      response: { behavior: "allow", toolUseID: "fixture-call" },
    })
  } finally {
    await state.close()
  }
  expect(stopped(await state.pid())).toBe(true)
}, 25000)

test("wire review: revoke between SDK permission callback and pipe write blocks allowance", async () => {
  let active = true
  let callbackReturned = false
  const outcome = Promise.withResolvers<string>()
  const state = await fixture(
    "revoked",
    async (_tool, input, native) => {
      void state.runtime
        .authorizePermission(native.requestId!, () => {
          if (!active) throw new Error("Fixture authority revoked")
        })
        .then(
          () => outcome.resolve("allowed"),
          () => outcome.resolve("blocked"),
        )
      callbackReturned = true
      return { behavior: "allow", updatedInput: input }
    },
    () => {
      if (callbackReturned) active = false
    },
  )
  try {
    await state.runtime.initialize()
    state.send()
    expect(await outcome.promise).toBe("blocked")
  } finally {
    await state.close()
  }
  expect(await Bun.file(join(state.directory, "permission.json")).exists()).toBe(false)
  expect(stopped(await state.pid())).toBe(true)
})

test("wire review: an SDK callback allowance without a registered guard never reaches the child", async () => {
  const called = Promise.withResolvers<void>()
  const state = await fixture("unbound", async (_tool, input) => {
    called.resolve()
    return { behavior: "allow", updatedInput: input }
  })
  try {
    await state.runtime.initialize()
    state.send()
    await called.promise
    await Bun.sleep(20)
  } finally {
    await state.close()
  }
  expect(await Bun.file(join(state.directory, "permission.json")).exists()).toBe(false)
  expect(stopped(await state.pid())).toBe(true)
})

test("wire review: rejecting unconfirmed startup controls also confirms child shutdown", async () => {
  const state = await fixture("invalid-controls", async () => ({ behavior: "deny", message: "fixture" }))
  try {
    await expect(state.runtime.initialize()).rejects.toThrow("unavailable")
  } finally {
    await state.close()
  }
  expect(stopped(await state.pid())).toBe(true)
})

test("interrupt wire review: a native receipt retaining the sent UUID forces confirmed shutdown", async () => {
  const state = await fixture("queued-interrupt", async () => ({ behavior: "deny", message: "fixture" }))
  try {
    await state.runtime.initialize()
    state.send()
    await existsSoon(join(state.directory, "permission.json"))
    await expect(state.runtime.interrupt()).rejects.toThrow("remained queued")
    expect(stopped(await state.pid())).toBe(true)
    expect(() => state.send()).toThrow("closed")
  } finally {
    await state.close()
  }
}, 10000)

test("interrupt wire review: unknown native queued UUIDs do not attest or cancel the host input", async () => {
  const state = await fixture("unknown-interrupt", async () => ({ behavior: "deny", message: "fixture" }))
  try {
    await state.runtime.initialize()
    state.send()
    await existsSoon(join(state.directory, "permission.json"))
    await state.runtime.interrupt()
    expect(stopped(await state.pid())).toBe(false)
  } finally {
    await state.close()
  }
  expect(stopped(await state.pid())).toBe(true)
}, 10000)

async function existsSoon(path: string) {
  const expires = Date.now() + 2500
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= expires) throw new Error("Fixture evidence did not arrive")
    await Bun.sleep(5)
  }
}
function stopped(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}
async function removeFixture(directory: string) {
  const path = relative(tmpdir(), directory)
  if (!path || path.startsWith("..") || !path.startsWith("harness-claude-wire-review-"))
    throw new Error("Unexpected fixture cleanup path")
  await rm(directory, { recursive: true, force: true })
}
