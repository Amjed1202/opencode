import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { WorkspaceFiles } from "../../src/host/workspace-files"
import { requireChildPath } from "../../script/package-windows"

const scratch = resolve(import.meta.dirname, "../../test-results")
let directory: string

beforeAll(async () => {
  await mkdir(scratch, { recursive: true })
  directory = await mkdtemp(join(await realpath(scratch), "workspace-files-"))
})

afterAll(async () => {
  const target = requireChildPath(await realpath(scratch), await realpath(directory))
  await rm(target, { recursive: true, force: true })
})

async function fixture() {
  const root = join(directory, randomUUID())
  await mkdir(root)
  return { root, files: new WorkspaceFiles(await realpath(root)) }
}

test("excluded runtime and environment paths cannot bypass filters with mixed case", async () => {
  const item = await fixture()
  await mkdir(join(item.root, ".CoDeX"))
  await writeFile(join(item.root, ".CoDeX", "private.txt"), "not for the file panel")
  await writeFile(join(item.root, ".ENV.local"), "NOT_FOR_PREVIEW=true")
  await writeFile(join(item.root, "visible.txt"), "visible")
  expect((await item.files.list()).items.map((entry) => entry.path)).toEqual(["visible.txt"])
})

test("lists opaque IDs and unknown baselines without accepting renderer paths", async () => {
  const item = await fixture()
  await writeFile(join(item.root, "readme.txt"), "hello\n")
  const list = await item.files.list()
  expect(list).toMatchObject({
    baseline: "unavailable",
    truncated: false,
    items: [{ path: "readme.txt", bytes: 6, change: "unknown" }],
  })
  expect(list.items[0]!.id).toMatch(/^[\da-f-]{36}$/)
  expect(list.items[0]!.id).not.toContain("readme")
  expect(await item.files.preview(list.items[0]!.id)).toEqual({
    path: "readme.txt",
    text: "hello\n",
    before: null,
    diff: null,
    baseline: "unavailable",
  })
  await expect(item.files.preview("readme.txt")).rejects.toThrow("choose a listed file")
  await expect(item.files.preview(join(item.root, "readme.txt"))).rejects.toThrow("choose a listed file")
})

test("tracks added, modified, deleted and unchanged text against the explicit session baseline", async () => {
  const item = await fixture()
  await Promise.all(
    ["modified", "deleted", "unchanged"].map((name) => writeFile(join(item.root, `${name}.txt`), "before\n")),
  )
  await item.files.begin()
  await Promise.all([
    writeFile(join(item.root, "modified.txt"), "after\n"),
    writeFile(join(item.root, "added.txt"), "new"),
    unlink(join(item.root, "deleted.txt")),
  ])
  const list = await item.files.list()
  expect(list.baseline).toBe("session-start")
  expect(list.truncated).toBe(false)
  expect(Object.fromEntries(list.items.map((entry) => [entry.path, entry.change]))).toEqual({
    "added.txt": "added",
    "modified.txt": "modified",
    "unchanged.txt": "unchanged",
    "deleted.txt": "deleted",
  })
  const previews = Object.fromEntries(
    await Promise.all(list.items.map(async (entry) => [entry.path, await item.files.preview(entry.id)])),
  )
  expect(previews["modified.txt"]).toMatchObject({ before: "before\n", text: "after\n", baseline: "session-start" })
  expect(previews["modified.txt"].diff).toContain("-before\n+after")
  expect(previews["added.txt"].diff).toContain("--- /dev/null")
  expect(previews["added.txt"].diff).toContain("Inspection preview only")
  expect(previews["deleted.txt"]).toMatchObject({ before: "before\n", text: null })
  expect(previews["deleted.txt"].diff).toContain("+++ /dev/null")
  expect(previews["unchanged.txt"].diff).toBe("No changes since session start.")
})

test("requires refresh after text changes, file replacement, deletion or reappearance", async () => {
  const item = await fixture()
  const path = join(item.root, "file.txt")
  await writeFile(path, "first")
  await item.files.begin()
  const first = (await item.files.list()).items[0]!
  await writeFile(path, "second")
  await expect(item.files.preview(first.id)).rejects.toThrow("Refresh files first")
  const second = (await item.files.list()).items[0]!
  await writeFile(join(item.root, "replacement.txt"), "second")
  await unlink(path)
  await rename(requireChildPath(directory, join(item.root, "replacement.txt")), requireChildPath(directory, path))
  await expect(item.files.preview(second.id)).rejects.toThrow("Refresh files first")
  const replaced = (await item.files.list()).items[0]!
  await unlink(path)
  await expect(item.files.preview(replaced.id)).rejects.toThrow()
  const deleted = (await item.files.list()).items[0]!
  expect(deleted.change).toBe("deleted")
  await writeFile(path, "first")
  await expect(item.files.preview(deleted.id)).rejects.toThrow("Refresh files first")
})

test("does not scan excluded accounts, environment files, dependencies or Git metadata", async () => {
  const item = await fixture()
  await Promise.all(
    [".git", "node_modules", ".codex", ".claude", "vendor", "dist", "out", "build", ".next", ".cache"].map(
      async (name) => {
        await mkdir(join(item.root, name))
        await writeFile(join(item.root, name, "secret.txt"), "fixture only")
      },
    ),
  )
  await Promise.all([".env", ".env.local"].map((name) => writeFile(join(item.root, name), "fixture only")))
  await writeFile(join(item.root, "visible.txt"), "visible")
  const list = await item.files.list()
  expect(list.items.map((entry) => entry.path)).toEqual(["visible.txt"])
  expect(list.truncated).toBe(false)
})

test("rejects binary, invalid UTF-8, oversize and hard-linked files and preserves UTF-8 BOM bytes", async () => {
  const item = await fixture()
  await Promise.all([
    writeFile(join(item.root, "binary.bin"), Buffer.from([65, 0, 66])),
    writeFile(join(item.root, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xff])),
    writeFile(join(item.root, "oversize.txt"), "x".repeat(128 * 1024 + 1)),
    writeFile(join(item.root, "source.txt"), "linked"),
    writeFile(join(item.root, "bom.txt"), "\ufeffhello"),
  ])
  await link(join(item.root, "source.txt"), join(item.root, "hardlink.txt"))
  const list = await item.files.list()
  expect(list.truncated).toBe(true)
  expect(list.items.map((entry) => entry.path)).toEqual(["bom.txt"])
  expect(list.items[0]!.bytes).toBe(8)
  expect((await item.files.preview(list.items[0]!.id)).text).toBe("\ufeffhello")
})

test("a skipped junction cannot invent deletion or read its target", async () => {
  const item = await fixture()
  const original = join(item.root, "folder")
  const destination = join(item.root, "node_modules")
  await mkdir(original)
  await writeFile(join(original, "existing.txt"), "before")
  await item.files.begin()
  const prior = (await item.files.list()).items[0]!
  await rename(requireChildPath(directory, await realpath(original)), requireChildPath(directory, destination))
  await symlink(destination, original, process.platform === "win32" ? "junction" : "dir")
  const list = await item.files.list()
  expect(list.truncated).toBe(true)
  expect(list.items).toEqual([])
  await expect(item.files.preview(prior.id)).rejects.toThrow("Refresh files first")
})

test("hitting the file cap with a pending directory cannot invent deletion", async () => {
  const item = await fixture()
  await mkdir(join(item.root, "a-folder"))
  await writeFile(join(item.root, "a-folder/existing.txt"), "keep me")
  await item.files.begin()
  await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      writeFile(join(item.root, `z-${String(index).padStart(3, "0")}.txt`), "new"),
    ),
  )
  const list = await item.files.list()
  expect(list.items).toHaveLength(256)
  expect(list.truncated).toBe(true)
  expect(list.items.some((entry) => entry.change === "deleted")).toBe(false)
})

test("marks the depth limit partial and avoids claiming additions outside a partial baseline", async () => {
  const item = await fixture()
  const deep = join(item.root, ...Array.from({ length: 8 }, (_, index) => `level-${index}`))
  await mkdir(deep, { recursive: true })
  await writeFile(join(deep, "deep.txt"), "outside preview depth")
  await item.files.begin()
  await writeFile(join(item.root, "later.txt"), "later")
  const list = await item.files.list()
  expect(list.truncated).toBe(true)
  expect(list.items).toMatchObject([{ path: "later.txt", change: "unknown" }])
  expect((await item.files.preview(list.items[0]!.id)).diff).toBeNull()
})

test("enforces the total text budget and the combined current/deleted metadata cap", async () => {
  const bytes = await fixture()
  await Promise.all(
    Array.from({ length: 17 }, (_, index) => writeFile(join(bytes.root, `${index}.txt`), "x".repeat(128 * 1024))),
  )
  const budget = await bytes.files.list()
  expect(budget.truncated).toBe(true)
  expect(budget.items).toHaveLength(16)
  expect(budget.items.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(2 * 1024 * 1024)
  const metadata = await fixture()
  await Promise.all(
    Array.from({ length: 200 }, (_, index) => writeFile(join(metadata.root, `old-${index}.txt`), "old")),
  )
  await metadata.files.begin()
  await Promise.all(Array.from({ length: 200 }, (_, index) => unlink(join(metadata.root, `old-${index}.txt`))))
  await Promise.all(
    Array.from({ length: 200 }, (_, index) => writeFile(join(metadata.root, `new-${index}.txt`), "new")),
  )
  const list = await metadata.files.list()
  expect(list.items).toHaveLength(256)
  expect(list.truncated).toBe(true)
  expect(list.items.filter((entry) => entry.change === "added")).toHaveLength(200)
  expect(list.items.filter((entry) => entry.change === "deleted")).toHaveLength(56)
})

test("rejects replacement of the selected repository directory", async () => {
  const item = await fixture()
  await writeFile(join(item.root, "before.txt"), "before")
  const prior = (await item.files.list()).items[0]!
  await rename(
    requireChildPath(directory, await realpath(item.root)),
    requireChildPath(directory, `${item.root}-original`),
  )
  await mkdir(item.root)
  await writeFile(join(item.root, "before.txt"), "before")
  await expect(item.files.list()).rejects.toThrow("Repository location changed")
  await expect(item.files.preview(prior.id)).rejects.toThrow("Repository location changed")
})
