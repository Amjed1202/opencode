import { randomUUID } from "node:crypto"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"

const fileLimit = 128 * 1024
const totalLimit = 2 * 1024 * 1024
const entryLimit = 256
const excluded = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "out",
  "build",
  ".next",
  ".cache",
  ".codex",
  ".claude",
])
type Entry = {
  id: string
  path: string
  bytes: number
  text: string
  identity: { dev: number; ino: number; mtimeMs: number; ctimeMs: number }
}
export type WorkspaceFileList = {
  items: {
    id: string
    path: string
    bytes: number
    change: "added" | "modified" | "deleted" | "unchanged" | "unknown"
  }[]
  truncated: boolean
  baseline: "session-start" | "unavailable"
}
export type WorkspaceFilePreview = {
  path: string
  text: string | null
  before: string | null
  diff: string | null
  baseline: "session-start" | "unavailable"
}

/** Bounded text snapshots only. No Git commands, project code, links, or renderer-supplied paths are executed. */
export class WorkspaceFiles {
  private current = new Map<string, Entry>()
  private baseline: Map<string, Entry> | undefined
  private baselineTruncated = false
  private rootIdentity: { dev: number; ino: number } | undefined
  constructor(private readonly root: string) {}

  async begin() {
    const scan = await this.scan()
    this.baseline = scan.entries
    this.baselineTruncated = scan.truncated
    this.current = new Map(scan.entries)
  }

  async list(): Promise<WorkspaceFileList> {
    const scan = await this.scan()
    this.current = scan.entries
    const items: WorkspaceFileList["items"] = [...this.current.values()].map((entry) => {
      const before = this.baseline?.get(entry.path)
      return {
        id: entry.id,
        path: entry.path,
        bytes: entry.bytes,
        change: !this.baseline
          ? "unknown"
          : before
            ? before.text === entry.text
              ? "unchanged"
              : "modified"
            : this.baselineTruncated
              ? "unknown"
              : "added",
      }
    })
    // A partial scan cannot establish deletion.
    if (this.baseline && !scan.truncated)
      for (const entry of this.baseline.values()) {
        if (!this.current.has(entry.path)) items.push({ id: entry.id, path: entry.path, bytes: 0, change: "deleted" })
      }
    return {
      items: items.slice(0, entryLimit),
      truncated: scan.truncated || this.baselineTruncated || items.length > entryLimit,
      baseline: this.baseline ? "session-start" : "unavailable",
    }
  }

  async preview(id: string): Promise<WorkspaceFilePreview> {
    const entry = [...this.current.values(), ...(this.baseline?.values() ?? [])].find((entry) => entry.id === id)
    if (!entry) throw new Error("Refresh files and choose a listed file")
    const current = this.current.get(entry.path)
    const latest = current ? await this.read(entry.path) : undefined
    const text = latest?.text ?? null
    if (
      current &&
      (!latest ||
        text !== current.text ||
        latest.identity.dev !== current.identity.dev ||
        latest.identity.ino !== current.identity.ino ||
        latest.identity.mtimeMs !== current.identity.mtimeMs ||
        latest.identity.ctimeMs !== current.identity.ctimeMs)
    )
      throw new Error("File changed since the list was read. Refresh files first.")
    if (!current) {
      await this.checkRoot()
      const exists = await lstat(join(this.root, entry.path)).then(
        () => true,
        (error) => {
          if (error.code !== "ENOENT") throw error
          return false
        },
      )
      if (exists) throw new Error("File changed since the list was read. Refresh files first.")
    }
    const before = this.baseline?.get(entry.path)?.text ?? null
    const known = Boolean(this.baseline && (before !== null || !this.baselineTruncated))
    return {
      path: entry.path,
      text,
      before,
      diff: known ? unified(entry.path, before, text) : null,
      baseline: known ? "session-start" : "unavailable",
    }
  }

  private async scan() {
    await this.checkRoot()
    const entries = new Map<string, Entry>()
    const pending = [""]
    let bytes = 0
    let visited = 0
    let truncated = false
    while (pending.length) {
      const directory = pending.shift()!
      if (directory && !(await this.safePath(directory, true).catch(() => false))) {
        truncated = true
        continue
      }
      const handle = await opendir(join(this.root, directory)).catch(() => undefined)
      if (!handle) {
        truncated = true
        continue
      }
      const names: Dirent[] = []
      try {
        for await (const name of handle) {
          names.push(name)
          if (names.length > 2000 - visited) {
            truncated = true
            break
          }
        }
      } catch {
        truncated = true
        continue
      }
      if (directory && !(await this.safePath(directory, true).catch(() => false))) {
        truncated = true
        continue
      }
      names.sort((left, right) => left.name.localeCompare(right.name))
      for (const name of names) {
        if (++visited > 2000 || entries.size >= entryLimit) {
          truncated = true
          break
        }
        if (
          excluded.has(name.name.toLowerCase()) ||
          name.name.toLowerCase().startsWith(".env") ||
          /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name.name)
        )
          continue
        const path = directory ? join(directory, name.name) : name.name
        if (name.isDirectory()) {
          if (path.split(sep).length < 8) pending.push(path)
          else truncated = true
          continue
        }
        if (!name.isFile()) {
          truncated = true
          continue
        }
        const snapshot = await this.read(path).catch(() => undefined)
        if (!snapshot) {
          truncated = true
          continue
        }
        const size = snapshot.bytes
        if (bytes + size > totalLimit) {
          truncated = true
          continue
        }
        bytes += size
        entries.set(path, { id: this.current.get(path)?.id ?? randomUUID(), path, ...snapshot })
      }
      if (visited > 2000 || entries.size >= entryLimit) {
        if (pending.length) truncated = true
        break
      }
    }
    await this.checkRoot()
    return { entries, truncated }
  }

  private async safePath(path: string, directory = false) {
    await this.checkRoot()
    const absolute = join(this.root, path)
    const inside = relative(this.root, absolute)
    if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return false
    let cursor = this.root
    for (const component of inside.split(sep)) {
      cursor = join(cursor, component)
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) return false
    }
    if ((await realpath(absolute)) !== absolute || (await realpath(this.root)) !== this.root) return false
    const stat = await lstat(absolute)
    return directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && stat.size <= fileLimit
  }

  private async checkRoot() {
    const identity = await lstat(this.root)
    if (
      identity.isSymbolicLink() ||
      !identity.isDirectory() ||
      (await realpath(this.root)) !== this.root ||
      (this.rootIdentity && (identity.dev !== this.rootIdentity.dev || identity.ino !== this.rootIdentity.ino))
    )
      throw new Error("Repository location changed")
    this.rootIdentity ??= { dev: identity.dev, ino: identity.ino }
  }

  private async read(path: string) {
    if (!(await this.safePath(path))) throw new Error("File is not a bounded regular workspace file")
    const absolute = join(this.root, path)
    const expected = await lstat(absolute)
    const file = await open(absolute, "r")
    try {
      const start = await file.stat()
      if (
        start.dev !== expected.dev ||
        start.ino !== expected.ino ||
        !start.isFile() ||
        start.nlink !== 1 ||
        start.size > fileLimit
      )
        throw new Error("File identity changed")
      const data = Buffer.alloc(fileLimit + 1)
      let bytes = 0
      while (bytes < start.size) {
        const result = await file.read(data, bytes, start.size - bytes, bytes)
        if (!result.bytesRead) break
        bytes += result.bytesRead
      }
      const end = await file.stat()
      if (
        bytes !== start.size ||
        start.size !== end.size ||
        start.mtimeMs !== end.mtimeMs ||
        start.ctimeMs !== end.ctimeMs ||
        !(await this.safePath(path))
      )
        throw new Error("File changed while reading")
      const current = await lstat(absolute)
      if (current.dev !== start.dev || current.ino !== start.ino) throw new Error("File identity changed")
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, bytes))
      if (text.includes("\0")) throw new Error("Binary preview unavailable")
      return {
        text,
        bytes,
        identity: { dev: start.dev, ino: start.ino, mtimeMs: start.mtimeMs, ctimeMs: start.ctimeMs },
      }
    } finally {
      await file.close()
    }
  }
}

/** One exact replacement hunk, with common prefix/suffix trimmed; bounded linear work. */
function unified(path: string, before: string | null, after: string | null) {
  if (before === after) return "No changes since session start."
  const left = before?.split("\n") ?? []
  const right = after?.split("\n") ?? []
  let first = 0
  while (first < left.length && first < right.length && left[first] === right[first]) first++
  let last = 0
  while (
    last < left.length - first &&
    last < right.length - first &&
    left[left.length - 1 - last] === right[right.length - 1 - last]
  )
    last++
  return [
    "Inspection preview only; end-of-file newline markers are not shown.",
    `--- ${before === null ? "/dev/null" : path}`,
    `+++ ${after === null ? "/dev/null" : path}`,
    `@@ -${first + 1},${left.length - first - last} +${first + 1},${right.length - first - last} @@`,
    ...left.slice(first, left.length - last).map((line) => `-${line}`),
    ...right.slice(first, right.length - last).map((line) => `+${line}`),
  ].join("\n")
}
