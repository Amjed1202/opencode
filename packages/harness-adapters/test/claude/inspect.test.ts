import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import type { ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import { copyFile, link, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes } from "node:fs/promises"
import { delimiter, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { NativeClaudeInspector, PINNED_CLAUDE_VERSION } from "../../src/claude/inspect"
import type { ClaudeInspectionOptions } from "../../src/claude/inspect"

const inspectors: NativeClaudeInspector[] = []
const directories: string[] = []
const executable = await realpath(process.execPath)
const cwd = await realpath(import.meta.dir)
const environment = { HOME: cwd, USERPROFILE: cwd }
const fixture = join(import.meta.dir, "fixtures", "inspect-peer.ts")

function peer(scenario = "valid", overrides: Partial<ClaudeInspectionOptions> = {}) {
  const calls: {
    command: readonly string[]
    cwd: string
    env: Record<string, string>
    child: ChildProcessByStdio<null, Readable, Readable>
  }[] = []
  const inspector = new NativeClaudeInspector({
    executable,
    cwd,
    environment,
    timeoutMs: 1500,
    maxOutputBytes: 1024,
    launch(command, options) {
      const child = spawn(process.execPath, [fixture, scenario, ...command.slice(1)], {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      })
      calls.push({ command, ...options, child })
      return child
    },
    ...overrides,
  })
  inspectors.push(inspector)
  return { inspector, calls }
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "harness-claude-inspect-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(inspectors.splice(0).map((inspector) => inspector.dispose()))
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup path")
    await rm(directory, { recursive: true, force: true })
  }
})

test("fixed version and status commands use only explicit environment", async () => {
  const instance = peer()
  expect(await instance.inspector.version()).toBe(PINNED_CLAUDE_VERSION)
  expect(await instance.inspector.authStatus()).toEqual({ loggedIn: true })
  expect(instance.calls.map((call) => call.command)).toEqual([
    [executable, "--version"],
    [executable, "auth", "status"],
  ])
  for (const call of instance.calls) {
    expect(call.cwd).toBe(cwd)
    expect(call.env).toEqual({
      ...environment,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    })
    expect(call.child.exitCode).toBe(0)
  }
})

test("the diagnostic child receives immediate stdin EOF and no prompt", async () => {
  expect(await peer("stdin-eof").inspector.authStatus()).toEqual({ loggedIn: true })
})

test("logged-out native status has exit one and exposes no unknown account or path fields", async () => {
  expect(await peer("logged-out").inspector.authStatus()).toEqual({ loggedIn: false })
  const status = await peer("stderr-private").inspector.authStatus()
  expect(status).toEqual({ loggedIn: true })
  expect(JSON.stringify(status)).not.toContain("private-fixture-value")
})

test("the explicit environment is snapshotted before a caller can mutate it", async () => {
  const input = { ...environment }
  const instance = peer("valid", { environment: input })
  input.HOME = join(cwd, "changed")
  await instance.inspector.version()
  expect(instance.calls[0]!.env.HOME).toBe(cwd)
})

test.each([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "HTTP_PROXY",
  "CLAUDE_CODE_SAFE_MODE",
  "home",
  "Path",
])("rejects ambient or caller-injected configuration %s before spawning", (name) =>
  expect(() => peer("valid", { environment: { ...environment, [name]: "private-fixture-value" } })).toThrow(
    "Unsafe Claude inspection environment",
  ),
)

test("rejects invalid home, NUL values, relative paths and out-of-range bounds before spawning", () => {
  expect(() => peer("valid", { environment: { HOME: "relative", USERPROFILE: "relative" } })).toThrow()
  expect(() => peer("valid", { environment: { ...environment, PATH: "x\0y" } })).toThrow()
  if (process.platform === "win32")
    expect(() => peer("valid", { environment: { ...environment, USERPROFILE: join(cwd, "other") } })).toThrow()
  expect(() => peer("valid", { executable: "claude" })).toThrow()
  expect(() => peer("valid", { cwd: "relative" })).toThrow()
  for (const timeoutMs of [49, 30001, NaN, Infinity, 50.5]) expect(() => peer("valid", { timeoutMs })).toThrow()
  for (const maxOutputBytes of [255, 1024 * 1024 + 1, NaN, Infinity, 256.5])
    expect(() => peer("valid", { maxOutputBytes })).toThrow()
})

test("optional environment paths reject empty or relative directory and PATH entries", () => {
  for (const name of ["USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    for (const value of ["", "relative"]) {
      expect(() => peer("valid", { environment: { ...environment, [name]: value } })).toThrow()
    }
  }
  for (const PATH of ["", "relative", `${cwd}${delimiter}`, `${delimiter}${cwd}`, `${cwd}${delimiter}relative`]) {
    expect(() => peer("valid", { environment: { ...environment, PATH } })).toThrow()
  }
})

test("host-selected absolute environment directories and PATH entries are preserved", async () => {
  const selected = {
    ...environment,
    TEMP: cwd,
    TMP: cwd,
    TMPDIR: cwd,
    PATH: [cwd, resolve(executable, "..")].join(delimiter),
  }
  const instance = peer("valid", { environment: selected })
  expect(await instance.inspector.version()).toBe(PINNED_CLAUDE_VERSION)
  expect(instance.calls[0]!.env).toMatchObject(selected)
})

test.each(["wrong-version", "version-exit-one"])("rejects %s", async (scenario) => {
  await expect(peer(scenario).inspector.version()).rejects.toThrow("Unsupported Claude native version")
})

test.each([
  "malformed",
  "trailing",
  "array",
  "null",
  "missing",
  "wrong-type",
  "logged-in-exit-one",
  "logged-out-exit-zero",
  "wrong-exit",
])("rejects invalid native status %s without reflecting native content", async (scenario) => {
  const result = await peer(scenario)
    .inspector.authStatus()
    .catch((error: Error) => error)
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).not.toContain("private-fixture-value")
})

test("accepts multibyte UTF-8 split between stdout chunks", async () => {
  expect(await peer("split-utf8").inspector.authStatus()).toEqual({ loggedIn: true })
})

test.each(["invalid-utf8", "invalid-stderr", "truncated-utf8", "oversize-stdout", "oversize-stderr", "shared-budget"])(
  "fails closed on %s with one byte budget across both pipes",
  async (scenario) => {
    const instance = peer(scenario, { maxOutputBytes: 256 })
    await expect(instance.inspector.authStatus()).rejects.toThrow("Claude native inspection failed")
    expect(instance.calls[0]!.child.exitCode !== null || instance.calls[0]!.child.signalCode !== null).toBe(true)
  },
)

test("a timed out diagnostic is killed and the inspector can subsequently be disposed", async () => {
  const instance = peer("hang", { timeoutMs: 150 })
  const started = Date.now()
  await expect(instance.inspector.authStatus()).rejects.toThrow("Claude native inspection failed")
  expect(Date.now() - started).toBeLessThan(2000)
  expect(instance.calls[0]!.child.killed).toBe(true)
})

test("diagnostic timeout remains bounded when a descendant retains output handles", async () => {
  const instance = peer("descendant", { timeoutMs: 150 })
  const started = Date.now()
  await expect(instance.inspector.authStatus()).rejects.toThrow("Claude native inspection failed")
  expect(Date.now() - started).toBeLessThan(1000)
})

test("dispose remains bounded when an exited diagnostic leaves inherited output handles", async () => {
  const instance = peer("descendant")
  const pending = instance.inspector.authStatus().catch((error: Error) => error)
  const deadline = Date.now() + 1000
  while (instance.calls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
  expect(instance.calls).toHaveLength(1)
  const child = instance.calls[0]!.child
  if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const started = Date.now()
  await instance.inspector.dispose()
  expect(Date.now() - started).toBeLessThan(1000)
  expect(await pending).toBeInstanceOf(Error)
  await expect(instance.inspector.authStatus()).rejects.toThrow("unavailable")
})

test("dispose interrupts in-flight diagnostics, rejects concurrent commands and prevents future launches", async () => {
  const instance = peer("hang")
  const pending = instance.inspector.authStatus().catch((error: Error) => error)
  const deadline = Date.now() + 1000
  while (instance.calls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
  expect(instance.calls).toHaveLength(1)
  await expect(instance.inspector.version()).rejects.toThrow("unavailable")
  await instance.inspector.dispose()
  expect(await pending).toBeInstanceOf(Error)
  await expect(instance.inspector.version()).rejects.toThrow("unavailable")
  await instance.inspector.dispose()
  expect(instance.calls).toHaveLength(1)
})

test("disposing before path checks complete prevents a process launch", async () => {
  const instance = peer()
  const pending = instance.inspector.version().catch((error: Error) => error)
  await instance.inspector.dispose()
  expect(await pending).toBeInstanceOf(Error)
  expect(instance.calls).toHaveLength(0)
})

test("spawn errors and synchronous launch errors are bounded and sanitized", async () => {
  const missing = join(await temporaryDirectory(), "missing-native.exe")
  const asynchronous = peer("valid", {
    launch: (_command, options) =>
      spawn(missing, [], { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false }),
  })
  await expect(asynchronous.inspector.version()).rejects.toThrow("Claude native inspection failed")
  const synchronous = peer("valid", {
    launch: () => {
      throw new Error("private-fixture-value")
    },
  })
  await expect(synchronous.inspector.version()).rejects.toThrow("Claude native inspection failed")
})

test("missing or non-regular executable and missing working directory fail before launching", async () => {
  const directory = await temporaryDirectory()
  for (const options of [
    { executable: directory },
    { executable: join(directory, "absent.exe") },
    { cwd: join(directory, "absent") },
  ]) {
    const instance = peer("valid", options)
    await expect(instance.inspector.version()).rejects.toThrow("Claude native inspection failed")
    expect(instance.calls).toHaveLength(0)
  }
})

test("hardlinked executables are rejected before launch", async () => {
  const directory = await temporaryDirectory()
  const copy = join(directory, "native.exe")
  await copyFile(executable, copy)
  await link(copy, join(directory, "linked.exe"))
  const instance = peer("valid", { executable: copy })
  await expect(instance.inspector.version()).rejects.toThrow("Claude native inspection failed")
  expect(instance.calls).toHaveLength(0)
})

test("a linked working directory is rejected before launch", async () => {
  const directory = await temporaryDirectory()
  const target = join(directory, "target")
  const alias = join(directory, "alias")
  await mkdir(target)
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
  const instance = peer("valid", { cwd: alias })
  await expect(instance.inspector.version()).rejects.toThrow("Claude native inspection failed")
  expect(instance.calls).toHaveLength(0)
})

test("an executable identity change during the diagnostic invalidates its result", async () => {
  const directory = await temporaryDirectory()
  const copy = join(directory, "native.exe")
  await copyFile(executable, copy)
  const instance = peer("split-utf8", { executable: copy })
  const pending = instance.inspector.authStatus().catch((error: Error) => error)
  const deadline = Date.now() + 1000
  while (instance.calls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
  expect(instance.calls).toHaveLength(1)
  const current = await stat(copy)
  await utimes(copy, current.atime, new Date(current.mtimeMs + 10000))
  expect(await pending).toBeInstanceOf(Error)
})
