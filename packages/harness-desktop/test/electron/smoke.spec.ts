import { _electron, expect, test } from "@playwright/test"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

const bun = process.env.HARNESS_SMOKE_BUN
const root = process.env.HARNESS_SMOKE_ROOT
const packageRoot = resolve(import.meta.dirname, "../..")

test("built Electron app starts with isolated renderer and OS-wrapped artifact storage", async () => {
  test.skip(!bun || !root, "Set HARNESS_SMOKE_BUN and HARNESS_SMOKE_ROOT to explicit absolute test paths")
  if (!bun || !root || !isAbsolute(bun) || !isAbsolute(root)) throw new Error("Smoke test paths must be absolute")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, "desktop-smoke-"))
  const launch = () =>
    _electron.launch({
      args: [packageRoot, "--harness-bun", bun, "--harness-data", directory],
      chromiumSandbox: true,
      timeout: 30_000,
    })
  try {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await expect(page).toHaveURL("harness://desktop/index.html")
      await expect(page.getByRole("button", { name: "Open repository", exact: true }).first()).toBeEnabled()
      await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeDisabled()
      await expect(page.getByRole("alert")).toHaveCount(0)
      const renderer = await page.evaluate(async () => ({
        origin: location.origin,
        process: typeof process,
        require: typeof require,
        buffer: typeof Buffer,
        frozenBridge: Object.isFrozen(window.harness),
        methods: Object.keys(window.harness).sort(),
        state: await window.harness.getState(),
      }))
      expect(renderer.origin).toBe("harness://desktop")
      expect(renderer.process).toBe("undefined")
      expect(renderer.require).toBe("undefined")
      expect(renderer.buffer).toBe("undefined")
      expect(renderer.frozenBridge).toBe(true)
      expect(renderer.methods).toEqual([
        "chooseNativeHome",
        "chooseRuntime",
        "chooseSkillsRoot",
        "chooseWorkspace",
        "getState",
        "interrupt",
        "onState",
        "refresh",
        "resolveInput",
        "resolvePermission",
        "review",
        "selectRuntime",
        "send",
        "start",
      ])
      expect(renderer.state.configuration).toEqual({})
      expect(renderer.state.connection.status).toBe("not-configured")
      expect(renderer.state.connection.authentication).toBe("unknown")
      expect(renderer.state.connection.billing).toBe("unknown")
      expect(renderer.state.connection.providerOverage).toBe("unknown")
      expect(renderer.state.session).toBeUndefined()
      expect(renderer.state.models).toEqual({ status: "not-loaded", items: [] })
      await expect(page.getByLabel("Codex model", { exact: true })).toBeDisabled()
      expect(renderer.state.messages).toEqual([])
      const isolation = await app.evaluate(({ app, BrowserWindow, safeStorage }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error("Desktop window is missing")
        return {
          sandboxed: app.getAppMetrics().find((metric) => metric.pid === window.webContents.getOSProcessId())
            ?.sandboxed,
          sandboxDisabled: app.commandLine.hasSwitch("no-sandbox"),
          devToolsOpen: window.webContents.isDevToolsOpened(),
          encryptionAvailable: safeStorage.isEncryptionAvailable(),
        }
      })
      expect(isolation).toEqual({
        sandboxed: true,
        sandboxDisabled: false,
        devToolsOpen: false,
        encryptionAvailable: true,
      })
      const protocol = await app.evaluate(async ({ net }) => {
        const document = await net.fetch("harness://desktop/index.html")
        const unexpected = await Promise.all([
          net.fetch("harness://desktop/main/index.js"),
          net.fetch("harness://desktop/index.html?unexpected=1"),
          net.fetch("harness://other/index.html"),
        ])
        return {
          policy: document.headers.get("content-security-policy"),
          unexpected: unexpected.map((response) => response.status),
        }
      })
      expect(protocol.policy).toContain("connect-src 'none'")
      expect(protocol.policy).toContain("script-src 'self'")
      expect(protocol.policy).toContain("frame-src 'none'")
      expect(protocol.unexpected).toEqual([404, 404, 404])
      const envelope = JSON.parse(await readFile(join(directory, "artifact-key.json"), "utf8")) as {
        version: number
        wrappedKey: string
      }
      expect(Object.keys(envelope).sort()).toEqual(["version", "wrappedKey"])
      expect(envelope.version).toBe(1)
      expect(
        await app.evaluate(({ safeStorage }, wrapped) => {
          const value = safeStorage.decryptString(Buffer.from(wrapped, "base64"))
          return { bytes: Buffer.from(value, "base64").byteLength, encodedBytesDiffer: value !== wrapped }
        }, envelope.wrappedKey),
      ).toEqual({ bytes: 32, encodedBytesDiffer: true })
      const selected = await page.evaluate(() => window.harness.selectRuntime({ runtime: "claude" }))
      expect(selected.configuration.runtime).toBe("claude")
      expect(selected.configuration.executable).toBeUndefined()
      expect(selected.configuration.nativeHome).toBeUndefined()
      expect(selected.models).toEqual({ status: "unsupported", items: [] })
      expect(selected.connection).toMatchObject({
        runtimeName: "Claude Code",
        authentication: "unknown",
        billing: "unknown",
        status: "not-checked",
      })
      await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeDisabled()
      const blocked = await page.evaluate(async () => {
        try {
          await window.harness.start({
            modelId: "must-not-run",
            acknowledgeOverage: true,
            acknowledgeUnverifiedBoundary: true,
            allowFileChanges: false,
          })
          return false
        } catch {
          return true
        }
      })
      expect(blocked).toBe(true)
      expect((await page.evaluate(() => window.harness.getState())).session).toBeUndefined()
      await page.evaluate(() => window.harness.selectRuntime({ runtime: "codex" }))
      await expect(page.getByLabel("Codex model", { exact: true })).toBeDisabled()
      const screenshot = resolve(packageRoot, "../../docs/validation/m1c-models-desktop.png")
      await mkdir(resolve(screenshot, ".."), { recursive: true })
      await page.screenshot({ path: screenshot })
    } finally {
      await app.close()
    }
    const persisted = await readFile(join(directory, "artifact-key.json"), "utf8")
    const reopened = await launch()
    try {
      const page = await reopened.firstWindow()
      await expect(page).toHaveURL("harness://desktop/index.html")
      await expect(page.getByRole("button", { name: "Open repository", exact: true }).first()).toBeEnabled()
      expect(await readFile(join(directory, "artifact-key.json"), "utf8")).toBe(persisted)
      expect((await page.evaluate(() => window.harness.getState())).configuration).toEqual({})
    } finally {
      await reopened.close()
    }
  } finally {
    const inside = relative(root, directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Refusing cleanup outside smoke root")
    await rm(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 })
  }
})
