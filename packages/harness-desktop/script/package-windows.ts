import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createReadStream } from "node:fs"
import { copyFile, lstat, mkdir, readdir, realpath, rename, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const runtimeVersions = {
  electron: "42.3.3",
  bun: "1.3.14",
  bunRevision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
} as const

const packageRoot = resolve(import.meta.dirname, "..")
const repository = resolve(packageRoot, "../..")
const dependencyPins = [
  { name: "solid-js", version: "1.9.10", license: "LICENSE", output: "SOLID-MIT.txt" },
  {
    name: "@anthropic-ai/claude-agent-sdk",
    version: "0.3.251",
    license: "LICENSE.md",
    output: "CLAUDE-AGENT-SDK-LICENSE.md",
  },
  { name: "@anthropic-ai/sdk", version: "0.93.0", license: "LICENSE", output: "ANTHROPIC-SDK-MIT.txt" },
  { name: "@modelcontextprotocol/sdk", version: "1.29.0", license: "LICENSE", output: "MCP-SDK-MIT.txt" },
  { name: "zod", version: "4.1.8", license: "LICENSE", output: "ZOD-MIT.txt" },
] as const
const electronFiles = new Set([
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "electron.exe",
  "ffmpeg.dll",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "LICENSE",
  "LICENSES.chromium.html",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "version",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
])

export type PackageFile = { source: string; destination: string }

export function requireChildPath(root: string, target: string) {
  if (!isAbsolute(root) || !isAbsolute(target)) throw new Error("Package paths must be absolute")
  const child = relative(resolve(root), resolve(target))
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Package target must remain strictly inside the output root")
  return resolve(target)
}

export async function regularFiles(root: string): Promise<string[]> {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
    throw new Error(`Expected a regular directory: ${root}`)
  const result = await Promise.all(
    (await readdir(root)).sort().map(async (name) => {
      const path = join(root, name)
      const identity = await lstat(path)
      if (identity.isSymbolicLink()) throw new Error(`Package inputs must not contain links: ${path}`)
      if (identity.isDirectory()) return (await regularFiles(path)).map((entry) => `${name}/${entry}`)
      if (!identity.isFile() || identity.nlink !== 1) throw new Error(`Expected an unlinked regular file: ${path}`)
      return [name]
    }),
  )
  return result.flat().sort()
}

export async function builtFiles(root: string): Promise<PackageFile[]> {
  const files = await regularFiles(root)
  for (const required of ["main/index.js", "preload/index.cjs", "host/index.js", "renderer/index.html"])
    if (!files.includes(required)) throw new Error(`Missing built application entry: ${required}`)
  for (const file of files) {
    if (
      !/^(?:(?:main|host)\/[\w.-]+\.js|preload\/[\w.-]+\.cjs|renderer\/index\.html|renderer\/assets\/[\w.-]+\.(?:js|css|woff2?|png|svg))$/.test(
        file,
      )
    )
      throw new Error(`Unexpected built application file: ${file}`)
    if (!/\.(?:js|cjs)$/.test(file)) continue
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(await Bun.file(join(root, file)).text())
    for (const entry of imports) {
      if (entry.path.startsWith(".")) {
        const dependency = requireChildPath(root, resolve(dirname(join(root, file)), entry.path))
        if (!files.includes(relative(root, dependency).split(sep).join("/")))
          throw new Error(`Missing bundled dependency: ${file} -> ${entry.path}`)
        continue
      }
      const native =
        entry.path === "electron" ||
        entry.path === "bun:sqlite" ||
        builtinModules.includes(entry.path.replace(/^node:/, ""))
      if (!native || file.startsWith("renderer/")) throw new Error(`Unbundled dependency: ${file} -> ${entry.path}`)
    }
  }
  return files.map((file) => ({ source: join(root, file), destination: `resources/app/out/${file}` }))
}

export async function sha256(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export async function artifactManifest(root: string) {
  return Promise.all(
    (await regularFiles(root))
      .filter((path) => path !== "artifacts.json")
      .map(async (path) => ({
        path,
        bytes: (await lstat(join(root, path))).size,
        sha256: await sha256(join(root, path)),
      })),
  )
}

export async function copyPackageFiles(root: string, files: PackageFile[]) {
  const destinations = new Set<string>()
  for (const file of files) {
    const destination = requireChildPath(root, resolve(root, file.destination))
    if (destinations.has(destination.toLowerCase())) throw new Error(`Duplicate package file: ${file.destination}`)
    destinations.add(destination.toLowerCase())
    const identity = await lstat(file.source)
    if (!identity.isFile() || identity.isSymbolicLink())
      throw new Error(`Expected a regular source without a symbolic link: ${file.source}`)
    await mkdir(dirname(destination), { recursive: true })
    // Bun may hard-link installed license files. Copy bytes into a new independent package file.
    await copyFile(file.source, destination, 1)
    const copied = await lstat(destination)
    if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1)
      throw new Error(`Package copies must be independent regular files: ${file.destination}`)
  }
}

export async function createPortableZip(outputRoot: string, directory: string) {
  const source = requireChildPath(await realpath(outputRoot), await realpath(directory))
  const archive = requireChildPath(outputRoot, join(outputRoot, `${basename(source)}-${randomUUID().slice(0, 8)}.zip`))
  const command =
    "Add-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($env:HARNESS_PACKAGE_SOURCE, $env:HARNESS_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)"
  const system = process.env.SYSTEMROOT ?? "C:\\Windows"
  console.log(`Creating portable archive: ${archive}`)
  const child = spawnSync(
    join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd: outputRoot,
      windowsHide: true,
      timeout: 180_000,
      encoding: "utf8",
      env: { SYSTEMROOT: system, WINDIR: system, HARNESS_PACKAGE_SOURCE: source, HARNESS_PACKAGE_ZIP: archive },
    },
  )
  if (child.error || child.status !== 0)
    throw new Error("Portable ZIP creation failed; any partial archive is retained for inspection")
  const hash = await sha256(archive)
  await writeFile(`${archive}.sha256`, `${hash}  ${basename(archive)}\n`, { flag: "wx" })
  return { path: archive, sha256: hash }
}

function runtimeOutput(executable: string, args: string[], node = false) {
  const environment = Object.fromEntries(
    ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  )
  const child = spawnSync(executable, args, {
    cwd: dirname(executable),
    env: { ...environment, ...(node ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    windowsHide: true,
    timeout: 15_000,
    encoding: "utf8",
  })
  if (child.error || child.status !== 0) throw new Error(`Runtime verification failed: ${basename(executable)}`)
  return child.stdout.trim()
}

export async function packageWindows(options: { outputRoot: string; bun: string; electron: string; name?: string }) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Packaging requires Windows x64")
  if (!isAbsolute(options.outputRoot) || !isAbsolute(options.bun) || !isAbsolute(options.electron))
    throw new Error("Output and runtime paths must be explicit absolute paths")
  const outputRoot = await realpath(options.outputRoot)
  if (outputRoot.toLowerCase() !== resolve(options.outputRoot).toLowerCase())
    throw new Error("Output root must be its canonical path, without directory links")
  const name = options.name ?? "Harness-windows-x64"
  if (!/^Harness-windows-x64(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/.test(name))
    throw new Error("Invalid package directory name")
  const target = requireChildPath(outputRoot, join(outputRoot, name))
  if (
    (await Bun.file(join(target, "artifacts.json")).exists()) ||
    (await readdir(outputRoot)).some((entry) => entry.toLowerCase() === name.toLowerCase())
  )
    throw new Error(`Output already exists; choose a new --name. Nothing was removed: ${target}`)
  const bun = await realpath(options.bun)
  const electron = await realpath(options.electron)
  if (basename(electron).toLowerCase() !== "electron.exe" || basename(bun).toLowerCase() !== "bun.exe")
    throw new Error("Select the pinned electron.exe and bun.exe")
  const binary = JSON.parse(
    runtimeOutput(
      electron,
      [
        "--eval",
        "console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome,arch:process.arch,platform:process.platform}))",
      ],
      true,
    ),
  ) as Record<string, string>
  if (binary.electron !== runtimeVersions.electron || binary.arch !== "x64" || binary.platform !== "win32")
    throw new Error("Electron binary does not match the pinned Windows x64 release")
  const bunVersion = JSON.parse(
    runtimeOutput(bun, [
      "--no-env-file",
      "--eval",
      "console.log(JSON.stringify({version:Bun.version,revision:Bun.revision,arch:process.arch,platform:process.platform}))",
    ]),
  ) as Record<string, string>
  if (
    bunVersion.version !== runtimeVersions.bun ||
    bunVersion.revision !== runtimeVersions.bunRevision ||
    bunVersion.arch !== "x64" ||
    bunVersion.platform !== "win32"
  )
    throw new Error("Bun binary does not match the pinned Windows x64 release")
  const distribution = dirname(electron)
  const distributionFiles = await regularFiles(distribution)
  for (const required of electronFiles)
    if (!distributionFiles.includes(required)) throw new Error(`Incomplete Electron distribution: ${required}`)
  for (const file of distributionFiles)
    if (!electronFiles.has(file) && !/^locales\/[\w-]+\.pak$/.test(file) && file !== "resources/default_app.asar")
      throw new Error(`Unexpected Electron distribution file: ${file}`)
  const app = (await Bun.file(join(packageRoot, "package.json")).json()) as {
    version: string
    devDependencies: { electron: string }
  }
  if (app.devDependencies.electron !== runtimeVersions.electron)
    throw new Error("Electron dependency and packaging pin disagree")
  const adapters = join(repository, "packages/harness-adapters")
  const sdkRoot = await realpath(join(adapters, "node_modules/@anthropic-ai/claude-agent-sdk"))
  const dependencies = await Promise.all(
    dependencyPins.map(async (pin) => {
      const root =
        pin.name === "zod"
          ? dirname(Bun.resolveSync("zod/package.json", sdkRoot))
          : join(pin.name === "solid-js" ? packageRoot : adapters, "node_modules", pin.name)
      const installed = (await Bun.file(join(root, "package.json")).json()) as { version: string; license: string }
      if (installed.version !== pin.version)
        throw new Error(`Dependency notice pin disagrees with installed package: ${pin.name}`)
      return {
        name: pin.name,
        version: installed.version,
        license: installed.license,
        source: join(root, pin.license),
        notice: `licenses/${pin.output}`,
      }
    }),
  )
  const files = [
    ...distributionFiles
      .filter((file) => file !== "resources/default_app.asar")
      .map((file) => ({
        source: join(distribution, file),
        destination: file === "electron.exe" ? "Harness.exe" : file,
      })),
    ...(await builtFiles(join(packageRoot, "out"))),
    { source: bun, destination: "resources/runtime/bun.exe" },
    { source: join(repository, "LICENSE"), destination: "licenses/HARNESS-MIT.txt" },
    ...dependencies.map((dependency) => ({ source: dependency.source, destination: dependency.notice })),
    { source: join(sdkRoot, "README.md"), destination: "licenses/CLAUDE-AGENT-SDK-README.md" },
    { source: join(packageRoot, "licenses/BUN-LICENSE.md"), destination: "licenses/BUN-LICENSE.md" },
    { source: join(packageRoot, "licenses/MIME-TYPES-MIT.txt"), destination: "licenses/MIME-TYPES-MIT.txt" },
    { source: join(packageRoot, "licenses/MIME-DB-MIT.txt"), destination: "licenses/MIME-DB-MIT.txt" },
    { source: join(packageRoot, "PACKAGING.md"), destination: "PACKAGING.md" },
  ]
  const staging = requireChildPath(outputRoot, join(outputRoot, `${name}.partial-${randomUUID()}`))
  await mkdir(staging)
  console.log(`Assembling package in ${staging}; failures retain this directory for inspection.`)
  await copyPackageFiles(staging, files)
  await writeFile(
    join(staging, "licenses/THIRD-PARTY.json"),
    JSON.stringify(
      {
        note: "Installed build dependency notices. The published Claude Agent SDK JavaScript is itself bundled; its upstream embedded notices are also retained. No native Claude CLI is included.",
        packages: dependencies.map((dependency) => ({
          name: dependency.name,
          version: dependency.version,
          license: dependency.license,
          notice: dependency.notice,
        })),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  )
  const sdkSource = await Bun.file(join(sdkRoot, "sdk.mjs")).text()
  const sdkNotices = [...sdkSource.matchAll(/\/\*[\s\S]*?\*\//g)]
    .map((match) => match[0])
    .filter((comment) => /[Cc]opyright|@license|[Pp]ermission is hereby|[Ll]icense/.test(comment))
  await writeFile(join(staging, "licenses/CLAUDE-SDK-EMBEDDED-NOTICES.txt"), sdkNotices.join("\n\n") + "\n", {
    flag: "wx",
  })
  await writeFile(
    join(staging, "resources/app/package.json"),
    JSON.stringify(
      {
        name: "harness-desktop",
        productName: "Harness",
        version: app.version,
        private: true,
        type: "module",
        main: "out/main/index.js",
        license: "MIT",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  )
  await writeFile(
    join(staging, "README.txt"),
    `Harness ${app.version} — Windows x64 portable development package\n\nExtract or copy the complete folder to a user-owned directory, then open Harness.exe.\nNo Node.js, Bun installation, administrator access, or development tools are needed to launch.\nInstall the pinned native Codex/Claude Code runtimes separately and select them inside Harness.\nNative sign-in remains in each native application. No accounts or credentials ship here.\n\nThis Harness package is unsigned. It has no installer, auto-updater, or Harness signing certificate.\nThe renamed upstream Electron executable retains its upstream icon and PE metadata.\nKeep every DLL, locale, resource and license beside the executable.\nApplication data is stored privately per Windows user, separately from this package.\nSee PACKAGING.md for requirements, data location, verification and current limitations.\n`,
    { flag: "wx" },
  )
  const manifest = {
    schema: 1,
    application: {
      name: "Harness",
      version: app.version,
      platform: "win32",
      arch: "x64",
      signing: "unsigned-harness-development-package",
    },
    runtimes: { electron: binary, bun: bunVersion },
    files: await artifactManifest(staging),
  }
  await writeFile(join(staging, "artifacts.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" })
  // Both complete absolute paths are rechecked before the only directory move. No cleanup/deletion occurs.
  requireChildPath(outputRoot, await realpath(staging))
  requireChildPath(outputRoot, target)
  await rename(staging, target)
  console.log(
    `Portable package: ${target}\nFiles: ${manifest.files.length}\nManifest SHA256: ${await sha256(join(target, "artifacts.json"))}`,
  )
  const archive = await createPortableZip(outputRoot, target)
  console.log(`Portable ZIP: ${archive.path}\nZIP SHA256: ${archive.sha256}`)
  return target
}

if (import.meta.main) {
  const values = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index]
    const value = process.argv[index + 1]
    if (!flag || !["--output-root", "--bun", "--electron", "--name"].includes(flag) || !value || values.has(flag))
      throw new Error(
        "Usage: bun run package:windows --output-root ABSOLUTE_EXISTING_DIRECTORY --bun ABSOLUTE_BUN_EXE --electron ABSOLUTE_ELECTRON_EXE [--name Harness-windows-x64-SUFFIX]",
      )
    values.set(flag, value)
  }
  const outputRoot = values.get("--output-root")
  const bun = values.get("--bun")
  const electron = values.get("--electron")
  if (!outputRoot || !bun || !electron) throw new Error("Required arguments: --output-root, --bun, --electron")
  await packageWindows({ outputRoot, bun, electron, ...(values.has("--name") ? { name: values.get("--name")! } : {}) })
}
