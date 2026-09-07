import { createHash } from "node:crypto"
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { PermissionReviewContent } from "@harness/protocol"

export function hashClaude(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function sameClaudePath(left: string, right: string) {
  // Bun's Windows realpath returns a bare drive letter for the volume root.
  const normal = (path: string) => resolve(/^[a-zA-Z]:$/.test(path) ? `${path}\\` : path).toLowerCase()
  return normal(left) === normal(right)
}

export async function ordinaryClaudePath(path: string, directory: boolean) {
  const resolved = resolve(path)
  let current = directory ? resolved : dirname(resolved)
  while (true) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameClaudePath(await realpath(current), current))
      throw new Error("Claude path traverses a nonordinary directory")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolved
}

export async function claudeFile(path: string, missing = false) {
  await ordinaryClaudePath(path, false)
  const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (missing && error.code === "ENOENT") return undefined
    throw new Error("Claude file is unavailable")
  })
  if (!before) return { text: "", sha256: hashClaude(null), exists: false }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 256n * 1024n ||
    !sameClaudePath(await realpath(path), path)
  )
    throw new Error("Claude file is not a bounded ordinary file")
  const file = await open(path, "r")
  try {
    const opened = await file.stat({ bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size !== before.size)
      throw new Error("Claude file changed during read")
    const data = Buffer.alloc(Number(opened.size) + 1)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    const after = await file.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    await ordinaryClaudePath(path, false)
    if (
      bytesRead !== Number(opened.size) ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.nlink !== 1n
    )
      throw new Error("Claude file changed during read")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead))
    if (text.includes("\0")) throw new Error("Binary Claude file is unsupported")
    return { text, sha256: createHash("sha256").update(data.subarray(0, bytesRead)).digest("hex"), exists: true }
  } finally {
    await file.close()
  }
}

export function claudeWorkspacePath(root: string, path: unknown) {
  if (typeof path !== "string" || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))
    throw new Error("Invalid Claude file path")
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const name = relative(root, resolved).replaceAll("\\", "/")
  if (
    !name ||
    name === ".." ||
    name.startsWith("../") ||
    isAbsolute(name) ||
    name
      .split("/")
      .some(
        (part) =>
          part.includes(":") ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
          [".git", ".claude", ".codex", ".agents"].includes(part.toLowerCase()),
      )
  )
    throw new Error("Claude file is outside the admitted repository surface")
  return { path: resolved, name }
}

/** Final synchronous preimage check at the actual SDK allow-reply write. */
export function verifyClaudeFileNow(path: string, sha256: string) {
  let current = dirname(resolve(path))
  while (true) {
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameClaudePath(realpathSync(current), current))
      throw new Error("Claude path changed after review")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const before = (() => {
    try {
      return lstatSync(path, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && sha256 === hashClaude(null)) return
      throw error
    }
  })()
  if (!before) return
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 256n * 1024n ||
    !sameClaudePath(realpathSync(path), path)
  )
    throw new Error("Claude file changed after review")
  const file = openSync(path, "r")
  try {
    const opened = fstatSync(file, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size !== before.size)
      throw new Error("Claude file changed after review")
    const buffer = Buffer.alloc(Number(opened.size) + 1)
    const length = readSync(file, buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, length)
    const after = fstatSync(file, { bigint: true })
    const current = lstatSync(path, { bigint: true })
    if (
      content.length !== Number(before.size) ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.nlink !== 1n ||
      createHash("sha256").update(content).digest("hex") !== sha256
    )
      throw new Error("Claude file changed after review")
  } finally {
    closeSync(file)
  }
}

export async function claudePatch(root: string, tool: string, input: Record<string, unknown>) {
  if (tool !== "Write" && tool !== "Edit") throw new Error("Unsupported Claude write tool")
  if (
    Object.keys(input).some(
      (key) =>
        !(
          tool === "Write" ? ["file_path", "content"] : ["file_path", "old_string", "new_string", "replace_all"]
        ).includes(key),
    )
  )
    throw new Error("Unknown Claude write input")
  const selected = claudeWorkspacePath(root, input.file_path)
  const before = await claudeFile(selected.path, tool === "Write")
  const after = tool === "Write" ? input.content : replace(before.text, input)
  if (typeof after !== "string" || Buffer.byteLength(after) > 256 * 1024 || after.includes("\0"))
    throw new Error("Claude write exceeds review bounds")
  const oldLines = before.text.split("\n")
  const newLines = after.split("\n")
  const diff = [
    `--- ${before.exists ? `a/${selected.name}` : "/dev/null"}`,
    `+++ b/${selected.name}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n")
  if (Buffer.byteLength(diff) > 512 * 1024) throw new Error("Claude patch exceeds review bounds")
  return {
    path: selected.path,
    beforeSha256: before.sha256,
    operationSha256: hashClaude({ tool, input, before: before.sha256 }),
    change: {
      path: selected.path,
      kind: before.exists ? "update" : "add",
      diff,
    } satisfies PermissionReviewContent["changes"][number],
  }
}

function replace(text: string, input: Record<string, unknown>) {
  if (
    typeof input.old_string !== "string" ||
    !input.old_string ||
    typeof input.new_string !== "string" ||
    (input.replace_all !== undefined && typeof input.replace_all !== "boolean")
  )
    throw new Error("Invalid Claude edit")
  const parts = text.split(input.old_string)
  if (parts.length < 2 || (!input.replace_all && parts.length !== 2))
    throw new Error("Claude edit does not match one reviewed location")
  return parts.join(input.new_string)
}
