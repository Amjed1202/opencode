import { _electron, expect, test } from "@playwright/test"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { artifactManifest, requireChildPath, runtimeVersions } from "../../script/package-windows"

test("portable Windows app launches its bundled Bun without developer tools or account configuration", async () => {
  const packageDirectory = process.env.HARNESS_PACKAGE_ROOT
  const scratch = process.env.HARNESS_SMOKE_ROOT
  test.skip(
    process.platform !== "win32" || !packageDirectory || !scratch,
    "Set HARNESS_PACKAGE_ROOT and HARNESS_SMOKE_ROOT to absolute paths on Windows",
  )
  if (!packageDirectory || !scratch || !isAbsolute(packageDirectory) || !isAbsolute(scratch))
    throw new Error("Packaged smoke paths must be absolute")
  const packageRoot = await realpath(packageDirectory)
  const manifest = JSON.parse(await readFile(join(packageRoot, "artifacts.json"), "utf8")) as {
    files: Awaited<ReturnType<typeof artifactManifest>>
    runtimes: { electron: { electron: string }; bun: { version: string; revision: string } }
  }
  expect(await artifactManifest(packageRoot)).toEqual(manifest.files)
  expect(manifest.runtimes.electron.electron).toBe(runtimeVersions.electron)
  expect(manifest.runtimes.bun).toMatchObject({ version: runtimeVersions.bun, revision: runtimeVersions.bunRevision })
  expect(
    manifest.files.some((entry) =>
      /(?:^|\/)(?:\.git|\.codex|\.claude|node_modules|auth\.json|\.env)(?:\/|$)/.test(entry.path),
    ),
  ).toBe(false)
  expect(manifest.files.some((entry) => entry.path === "resources/runtime/bun.exe")).toBe(true)
  for (const license of [
    "LICENSE",
    "LICENSES.chromium.html",
    "licenses/HARNESS-MIT.txt",
    "licenses/SOLID-MIT.txt",
    "licenses/BUN-LICENSE.md",
    "licenses/CLAUDE-AGENT-SDK-LICENSE.md",
    "licenses/CLAUDE-AGENT-SDK-README.md",
    "licenses/CLAUDE-SDK-EMBEDDED-NOTICES.txt",
    "licenses/ANTHROPIC-SDK-MIT.txt",
    "licenses/MCP-SDK-MIT.txt",
    "licenses/ZOD-MIT.txt",
    "licenses/THIRD-PARTY.json",
  ])
    expect(manifest.files.some((entry) => entry.path === license)).toBe(true)
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  const root = await realpath(scratch)
  const directory = await mkdtemp(join(root, "packaged-smoke-"))
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        /^(SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|COMSPEC)$/i.test(key),
    ),
  ) as Record<string, string>
  const launch = () =>
    _electron.launch({
      executablePath: join(packageRoot, "Harness.exe"),
      args: ["--harness-data", directory],
      cwd: directory,
      env: { ...environment, PATH: join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32") },
      chromiumSandbox: true,
      timeout: 30_000,
    })
  try {
    for (const attempt of [0, 1]) {
      const app = await launch()
      try {
        const page = await app.firstWindow()
        await expect(page).toHaveURL("harness://desktop/index.html")
        await expect(page.getByRole("button", { name: "Open repository", exact: true }).first()).toBeEnabled()
        const state = await page.evaluate(() => window.harness.getState())
        expect(state.configuration.executable).toBeUndefined()
        expect(state.configuration.nativeHome).toBeUndefined()
        expect(state.session).toBeUndefined()
        expect(state.messages).toEqual([])
        expect(state.connection.status).toBe("not-configured")
        expect(
          await app.evaluate(({ app }) => ({
            name: app.getName(),
            packaged: app.isPackaged,
            version: app.getVersion(),
          })),
        ).toMatchObject({ name: "Harness", packaged: true })
        const isolation = await page.evaluate(() => ({
          node: typeof process,
          require: typeof require,
          bridge: Object.isFrozen(window.harness),
        }))
        expect(isolation).toEqual({ node: "undefined", require: "undefined", bridge: true })
        if (attempt === 0) await page.screenshot({ path: test.info().outputPath("portable-start.png") })
      } finally {
        await app.close()
      }
    }
    const envelope = JSON.parse(await readFile(join(directory, "artifact-key.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(envelope).sort()).toEqual(["version", "wrappedKey"])
    expect(await artifactManifest(packageRoot)).toEqual(manifest.files)
  } finally {
    const target = requireChildPath(root, await realpath(directory))
    await rm(target, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 })
  }
})
