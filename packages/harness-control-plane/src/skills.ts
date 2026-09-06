import { createHash } from "node:crypto"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { SkillCatalog, SkillDescriptor, SkillFeature, SkillScope, WorkspaceDescriptor } from "@harness/protocol"

export interface ClaudeSkillDiscoveryOptions {
  /** Host-resolved workspace from an authorized directory selection. Never accept a renderer path. */
  readonly workspace: WorkspaceDescriptor
  /** Explicitly authorized skills directory, not a home directory. Omission performs no user-root discovery. */
  readonly userSkillsRoot?: string
  readonly limits?: {
    readonly maxEntries?: number
    readonly maxFileBytes?: number
    readonly maxFrontmatterBytes?: number
  }
}

type Diagnostic = SkillCatalog["diagnostics"][number]
type Identity = { path: string; stat: BigIntStats }

/** Metadata-only local discovery. No native process, configuration, resource, script or skill body is exposed. */
export async function discoverClaudeSkills(options: ClaudeSkillDiscoveryOptions): Promise<SkillCatalog> {
  const selected = structuredClone(options)
  if (!selected.workspace.id || !selected.workspace.targetId || !absolute(selected.workspace.rootPath))
    throw new Error("Invalid selected skill workspace")
  if (selected.userSkillsRoot !== undefined && !absolute(selected.userSkillsRoot))
    throw new Error("Invalid authorized user skills root")
  const limits = {
    entries: limit(selected.limits?.maxEntries, 256, 2048),
    bytes: limit(selected.limits?.maxFileBytes, 64 * 1024, 1024 * 1024),
    frontmatter: limit(selected.limits?.maxFrontmatterBytes, 16 * 1024, 64 * 1024),
  }
  const skills: SkillDescriptor[] = []
  const diagnostics: Diagnostic[] = []
  const roots: SkillCatalog["roots"][number][] = []
  let visited = 0
  const sources: { scope: SkillScope; path: string }[] = [
    { scope: "workspace", path: join(selected.workspace.rootPath, ".claude", "skills") },
    ...(selected.userSkillsRoot ? [{ scope: "user" as const, path: selected.userSkillsRoot }] : []),
  ]
  for (const source of sources) {
    if (visited >= limits.entries) {
      roots.push({ scope: source.scope, status: "limit-reached" })
      diagnostics.push({ scope: source.scope, code: "limit-reached" })
      continue
    }
    try {
      const chain = await directoryChain(source.path)
      const directory = await opendir(source.path)
      let limited = false
      try {
        while (true) {
          const entry = await directory.read()
          if (!entry) break
          if (visited++ >= limits.entries) {
            limited = true
            diagnostics.push({ scope: source.scope, code: "limit-reached" })
            break
          }
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name) || entry.name.toLowerCase() === "synced") {
            diagnostics.push({ scope: source.scope, code: "unsupported-name" })
            continue
          }
          const relativePath = `${source.scope === "workspace" ? ".claude/skills/" : ""}${entry.name}/SKILL.md`
          try {
            const skillPath = join(source.path, entry.name)
            const child = await directoryChain(skillPath)
            const content = await readSkill(join(skillPath, "SKILL.md"), child, limits.bytes)
            const metadata = parseMetadata(content.text, limits.frontmatter)
            const features: SkillFeature[] = [
              ...(/!`|^\s*```!/m.test(content.text) ? ["dynamic-shell" as const] : []),
              ...(/(?:^|\s)@[^\s]+/m.test(content.text) ? ["file-reference" as const] : []),
              ...(/\$(?:ARGUMENTS|\d|\{CLAUDE_)/.test(content.text) ? ["substitutions" as const] : []),
              ...(metadata.fields.has("allowed-tools") || metadata.fields.has("disallowed-tools")
                ? ["tool-policy" as const]
                : []),
              ...(metadata.fields.has("hooks") ? ["hooks" as const] : []),
              ...(metadata.values.context === "fork" ? ["forked-context" as const] : []),
              ...((await lstat(join(skillPath, ".claude-plugin")).catch(() => undefined))
                ? ["plugin-components" as const]
                : []),
            ]
            await verifyChain(child)
            skills.push({
              id: digest(`${source.scope}\0${selected.workspace.id}\0${resolve(source.path)}\0${entry.name}`),
              format: "claude-skill",
              scope: source.scope,
              workspaceId: selected.workspace.id,
              commandName: entry.name,
              ...(metadata.values.name !== undefined ? { declaredName: metadata.values.name } : {}),
              ...(metadata.values.description !== undefined ? { description: metadata.values.description } : {}),
              relativePath,
              sha256: content.sha256,
              sizeBytes: content.sizeBytes,
              metadataStatus: metadata.status,
              invocation: {
                model: invocation(
                  metadata.values["disable-model-invocation"],
                  true,
                  metadata.fields.has("disable-model-invocation"),
                ),
                user: invocation(metadata.values["user-invocable"], false, metadata.fields.has("user-invocable")),
              },
              declared: {
                ...(metadata.values["argument-hint"] !== undefined
                  ? { argumentHint: metadata.values["argument-hint"] }
                  : {}),
                ...(metadata.lists["allowed-tools"] !== undefined
                  ? { allowedTools: metadata.lists["allowed-tools"] }
                  : {}),
                ...(metadata.lists["disallowed-tools"] !== undefined
                  ? { disallowedTools: metadata.lists["disallowed-tools"] }
                  : {}),
                ...(metadata.values.context !== undefined ? { context: metadata.values.context } : {}),
                ...(metadata.values.agent !== undefined ? { agent: metadata.values.agent } : {}),
                ...(metadata.values.model !== undefined ? { model: metadata.values.model } : {}),
                ...(metadata.values.compatibility !== undefined
                  ? { compatibility: metadata.values.compatibility }
                  : {}),
                unknownFields: [...metadata.fields].filter((key) => !knownFields.has(key)).sort(),
              },
              observedFeatures: features,
              activation: { status: "disabled", reason: "native-adapter-required" },
            })
          } catch (error) {
            diagnostics.push({ scope: source.scope, code: failure(error), relativePath })
          }
        }
      } finally {
        await directory.close()
      }
      await verifyChain(chain)
      roots.push({ scope: source.scope, status: limited ? "limit-reached" : "scanned" })
    } catch (error) {
      // Invalidate this root's entire snapshot when its directory identity changes mid-scan.
      for (let index = skills.length - 1; index >= 0; index--)
        if (skills[index]?.scope === source.scope) skills.splice(index, 1)
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT"
      roots.push({ scope: source.scope, status: missing ? "missing" : "rejected" })
      if (!missing) diagnostics.push({ scope: source.scope, code: failure(error) })
    }
  }
  return {
    workspaceId: selected.workspace.id,
    skills: skills.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    roots,
    diagnostics,
  }
}

const knownFields = new Set([
  "name",
  "description",
  "argument-hint",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "disallowed-tools",
  "context",
  "agent",
  "model",
  "compatibility",
])

/** A deliberately bounded YAML subset. Complex or unknown values are observed, never interpreted. */
function parseMetadata(text: string, maxBytes: number) {
  const lines = text.split(/\r?\n/)
  const values: Record<string, string> = Object.create(null)
  const lists: Record<string, string[]> = Object.create(null)
  const fields = new Set<string>()
  if (lines[0] !== "---") return { values, lists, fields, status: "absent" as const }
  const end = lines.indexOf("---", 1)
  if (end < 0 || Buffer.byteLength(lines.slice(1, end).join("\n")) > maxBytes) throw new Error("Invalid skill metadata")
  let partial = false
  for (let index = 1; index < end; index++) {
    const line = lines[index]!
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const match = /^([a-zA-Z][a-zA-Z0-9_-]{0,63}):(?:[ \t]+(.*))?$/.exec(line)
    if (!match || fields.has(match[1]!) || fields.size >= 64) throw new Error("Invalid skill metadata")
    const key = match[1]!
    fields.add(key)
    const nested: string[] = []
    while (index + 1 < end && /^(?:\s|$)/.test(lines[index + 1]!)) nested.push(lines[++index]!)
    if (!knownFields.has(key)) {
      partial = true
      continue
    }
    const raw = (match[2] ?? "").trim()
    if ((key === "allowed-tools" || key === "disallowed-tools") && (raw.startsWith("[") || nested.length)) {
      const entries = raw.startsWith("[")
        ? inlineList(raw)
        : nested
            .filter((line) => line.trim())
            .map((line) => {
              const entry = /^\s+- (.*)$/.exec(line)
              if (!entry) throw new Error("Invalid skill metadata")
              return scalar(entry[1]!)
            })
      if (entries.length > 64 || entries.some((entry) => entry.length > 512 || unsafeDisplay(entry)))
        throw new Error("Invalid skill metadata")
      lists[key] = entries
      continue
    }
    const value = /^[|>][-+]?$/.test(raw)
      ? nested
          .map((line) => line.replace(/^ {1,8}/, ""))
          .join(raw.startsWith(">") ? " " : "\n")
          .trim()
      : nested.some((line) => line.trim())
        ? undefined
        : scalar(raw)
    if (value === undefined) {
      partial = true
      continue
    }
    if (value.length > (key === "description" ? 4096 : 1024) || unsafeDisplay(value))
      throw new Error("Invalid skill metadata")
    values[key] = value
    if (key === "allowed-tools" || key === "disallowed-tools") lists[key] = [value]
  }
  return { values, lists, fields, status: partial ? ("partial" as const) : ("parsed" as const) }
}

function scalar(raw: string): string {
  if (!raw) return ""
  if (raw.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(raw)
    if (!match) throw new Error("Invalid skill metadata")
    const value: unknown = JSON.parse(match[1]!)
    if (typeof value !== "string") throw new Error("Invalid skill metadata")
    return value
  }
  if (raw.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(raw)
    if (!match) throw new Error("Invalid skill metadata")
    return match[1]!.replaceAll("''", "'")
  }
  if (/^[!&*\[\]{}>|]/.test(raw) || /:\s/.test(raw)) throw new Error("Invalid skill metadata")
  return raw.replace(/\s+#.*$/, "").trim()
}

function inlineList(raw: string): string[] {
  if (!raw.endsWith("]")) throw new Error("Invalid skill metadata")
  const value = raw.slice(1, -1)
  if (!value.trim()) return []
  const entries: string[] = []
  let start = 0
  let quote = ""
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (quote) {
      if (quote === '"' && character === "\\") {
        index++
        continue
      }
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          index++
          continue
        }
        quote = ""
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character !== ",") continue
    entries.push(value.slice(start, index).trim())
    start = index + 1
  }
  entries.push(value.slice(start).trim())
  if (quote || entries.some((entry) => !entry)) throw new Error("Invalid skill metadata")
  return entries.map(scalar)
}

function invocation(
  value: string | undefined,
  invert: boolean,
  present: boolean,
): SkillDescriptor["invocation"]["model"] {
  if (value === undefined) return present ? "unknown" : "allowed-by-metadata"
  if (!/^(true|false|yes|no|on|off|1|0)$/i.test(value)) return "unknown"
  const enabled = /^(true|yes|on|1)$/i.test(value)
  return enabled !== invert ? "allowed-by-metadata" : "disabled-by-metadata"
}

async function directoryChain(path: string): Promise<Identity[]> {
  const paths: string[] = []
  for (let current = resolve(path); ; current = dirname(current)) {
    paths.unshift(current)
    if (dirname(current) === current) break
  }
  const result: Identity[] = []
  for (const current of paths) {
    const stat = await lstat(current, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(current), current))
      throw new Error("Unsafe skill path")
    result.push({ path: current, stat })
  }
  return result
}

async function verifyChain(chain: Identity[]) {
  for (const identity of chain) {
    const stat = await lstat(identity.path, { bigint: true })
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameIdentity(stat, identity.stat) ||
      !samePath(await realpath(identity.path), identity.path)
    )
      throw new Error("Unsafe skill path")
  }
}

async function readSkill(path: string, chain: Identity[], maxBytes: number) {
  const initial = await lstat(path, { bigint: true })
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || !samePath(await realpath(path), path))
    throw new Error("Unsafe skill path")
  if (initial.size > BigInt(maxBytes)) throw new Error("Skill file too large")
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || !sameIdentity(initial, before)) throw new Error("Unsafe skill path")
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > maxBytes) throw new Error("Skill file too large")
    const after = await file.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (
      !sameIdentity(before, after) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      after.size !== BigInt(length) ||
      after.nlink !== 1n ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, after)
    )
      throw new Error("Unsafe skill path")
    await verifyChain(chain)
    const content = bytes.subarray(0, length)
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(content),
      sha256: digest(content),
      sizeBytes: length,
    }
  } finally {
    await file.close()
  }
}

function absolute(path: unknown): path is string {
  return (
    typeof path === "string" &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    (process.platform !== "win32" || /^[a-zA-Z]:[\\/]/.test(path)) &&
    !path.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
}

function samePath(a: string, b: string) {
  // Bun on Windows reports realpath("C:\\") as "C:". Normalize only this volume-root representation.
  return process.platform === "win32"
    ? a.replace(/^([a-z]):$/i, "$1:\\").toLowerCase() === b.replace(/^([a-z]):$/i, "$1:\\").toLowerCase()
    : a === b
}
function unsafeDisplay(value: string) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
}
function sameIdentity(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino
}
function digest(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}
function limit(value: number | undefined, fallback: number, max: number) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max))
    throw new Error("Invalid skill discovery limit")
  return value ?? fallback
}
function failure(error: unknown): Diagnostic["code"] {
  if (!(error instanceof Error)) return "unreadable"
  if (error.message === "Unsafe skill path") return "unsafe-path"
  if (error.message === "Invalid skill metadata" || error instanceof SyntaxError || error instanceof TypeError)
    return "invalid-metadata"
  if (error.message === "Skill file too large") return "too-large"
  return "unreadable"
}
