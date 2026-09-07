import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { link, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import {
  artifactManifest,
  builtFiles,
  copyPackageFiles,
  createPortableZip,
  regularFiles,
  requireChildPath,
  sha256,
} from "../../script/package-windows"

const scratch = resolve(import.meta.dirname, "../../test-results")
let directory: string

beforeAll(async () => {
  await mkdir(scratch, { recursive: true })
  directory = await mkdtemp(join(await realpath(scratch), "package-unit-"))
})

afterAll(async () => {
  const target = requireChildPath(await realpath(scratch), await realpath(directory))
  await rm(target, { recursive: true, force: true })
})

async function fixture(name: string) {
  const root = join(directory, name)
  await Promise.all(
    ["main", "host", "preload", "renderer/assets"].map((path) => mkdir(join(root, path), { recursive: true })),
  )
  await Promise.all([
    writeFile(join(root, "main/index.js"), 'import { app } from "electron"; import { join } from "node:path";'),
    writeFile(join(root, "host/index.js"), 'import { Database } from "bun:sqlite";'),
    writeFile(join(root, "preload/index.cjs"), 'const { contextBridge } = require("electron");'),
    writeFile(join(root, "renderer/index.html"), '<script type="module" src="./assets/index.js"></script>'),
    writeFile(join(root, "renderer/assets/index.js"), 'document.body.textContent = "Harness";'),
  ])
  return root
}

describe("portable package boundaries", () => {
  test.skipIf(process.platform !== "win32")(
    "creates a unique ZIP preserving the package folder and writes its SHA-256",
    async () => {
      const source = await fixture("zip-build")
      const archive = await createPortableZip(directory, source)
      expect(await sha256(archive.path)).toBe(archive.sha256)
      expect(await readFile(`${archive.path}.sha256`, "utf8")).toBe(`${archive.sha256}  ${basename(archive.path)}\n`)
      const system = process.env.SYSTEMROOT ?? "C:\\Windows"
      const inspected = spawnSync(
        join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.IO.Compression.FileSystem\n$zip=[System.IO.Compression.ZipFile]::OpenRead($env:HARNESS_TEST_ZIP)\ntry { @($zip.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $zip.Dispose() }",
        ],
        {
          cwd: directory,
          windowsHide: true,
          timeout: 15_000,
          encoding: "utf8",
          env: { SYSTEMROOT: system, WINDIR: system, HARNESS_TEST_ZIP: archive.path },
        },
      )
      expect(inspected.status).toBe(0)
      expect((JSON.parse(inspected.stdout) as string[]).map((name) => name.replaceAll("\\", "/")).sort()).toEqual([
        "zip-build/host/index.js",
        "zip-build/main/index.js",
        "zip-build/preload/index.cjs",
        "zip-build/renderer/assets/index.js",
        "zip-build/renderer/index.html",
      ])
      const second = await createPortableZip(directory, source)
      expect(second.path).not.toBe(archive.path)
      expect(await sha256(archive.path)).toBe(archive.sha256)
    },
  )

  test("rejects equal, sibling, relative and escaping destinations", () => {
    const root = resolve("output")
    expect(requireChildPath(root, join(root, "Harness-windows-x64"))).toBe(join(root, "Harness-windows-x64"))
    for (const path of [root, resolve(root, ".."), resolve(root, "../output-other/Harness.exe")])
      expect(() => requireChildPath(root, path)).toThrow("strictly inside")
    expect(() => requireChildPath("output", "output/app")).toThrow("absolute")
  })

  test("copies only the built application, then hashes all assembled files deterministically", async () => {
    const build = await fixture("complete-build")
    const target = join(directory, "assembled")
    await mkdir(target)
    const files = await builtFiles(build)
    await copyPackageFiles(target, files)
    await writeFile(join(target, "artifacts.json"), "manifest is excluded from its own hash")
    const manifest = await artifactManifest(target)
    expect(manifest.map((entry) => entry.path)).toEqual([
      "resources/app/out/host/index.js",
      "resources/app/out/main/index.js",
      "resources/app/out/preload/index.cjs",
      "resources/app/out/renderer/assets/index.js",
      "resources/app/out/renderer/index.html",
    ])
    expect(manifest).toEqual(await artifactManifest(target))
    expect(manifest[0]?.sha256).toBe(await sha256(join(build, "host/index.js")))
    expect(manifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && entry.bytes > 0)).toBe(true)
    await expect(copyPackageFiles(target, files)).rejects.toThrow()
    expect(await readFile(join(target, files[0]!.destination), "utf8")).toBe(await readFile(files[0]!.source, "utf8"))
  })

  test("copies a hard-linked dependency notice into an independent package file", async () => {
    const root = join(directory, "hard-linked-notice")
    const target = join(directory, "notice-package")
    await Promise.all([mkdir(root), mkdir(target)])
    const source = join(root, "LICENSE")
    const alias = join(root, "cached-license")
    await writeFile(source, "Original dependency notice")
    await link(source, alias)
    expect((await lstat(alias)).nlink).toBe(2)
    await copyPackageFiles(target, [{ source: alias, destination: "licenses/DEPENDENCY.txt" }])
    const copied = join(target, "licenses/DEPENDENCY.txt")
    expect(await readFile(copied, "utf8")).toBe("Original dependency notice")
    expect((await lstat(copied)).nlink).toBe(1)
    await writeFile(copied, "Changed package copy")
    expect(await readFile(source, "utf8")).toBe("Original dependency notice")
    expect(await readFile(alias, "utf8")).toBe("Original dependency notice")
  })

  test("refuses credential/cache files, incomplete builds and unresolved external dependencies", async () => {
    const secret = await fixture("secret-build")
    await writeFile(join(secret, ".env"), "EXAMPLE=value")
    await expect(builtFiles(secret)).rejects.toThrow("Unexpected built application file")
    const cache = await fixture("cache-build")
    await mkdir(join(cache, ".codex"))
    await writeFile(join(cache, ".codex/auth.json"), "{}")
    await expect(builtFiles(cache)).rejects.toThrow("Unexpected built application file")
    const incomplete = join(directory, "incomplete")
    await mkdir(incomplete)
    await expect(builtFiles(incomplete)).rejects.toThrow("Missing built application entry")
    const external = await fixture("external-build")
    await writeFile(join(external, "main/index.js"), 'import "some-unbundled-package";')
    await expect(builtFiles(external)).rejects.toThrow("Unbundled dependency")
    const relative = await fixture("relative-build")
    await writeFile(join(relative, "host/index.js"), 'import "./missing.js";')
    await expect(builtFiles(relative)).rejects.toThrow("Missing bundled dependency")
  })

  test("rejects directory links and escaping copy plans", async () => {
    const root = join(directory, "links")
    const outside = join(directory, "outside")
    await Promise.all([mkdir(root), mkdir(outside)])
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    await expect(regularFiles(root)).rejects.toThrow("must not contain links")
    await writeFile(join(outside, "input.txt"), "safe fixture")
    await expect(
      copyPackageFiles(root, [{ source: join(outside, "input.txt"), destination: "../escaped.txt" }]),
    ).rejects.toThrow("strictly inside")
  })
})
