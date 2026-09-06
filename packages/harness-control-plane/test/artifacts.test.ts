import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { EncryptedArtifactStore } from "../src/artifacts"

const directories: string[] = []
const stores: EncryptedArtifactStore[] = []
const now = Date.parse("2026-09-06T12:00:00.000Z")
const secret = "private patch content that must never be written in plaintext"

afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  for (const directory of directories.splice(0)) {
    if (!relative(tmpdir(), directory).startsWith("harness-artifacts-")) throw new Error("Unsafe fixture cleanup")
    rmSync(directory, { recursive: true, force: true })
  }
})

function directory() {
  const path = mkdtempSync(join(tmpdir(), "harness-artifacts-"))
  directories.push(path)
  return path
}

async function fixture(options: { key?: Uint8Array; maxBytes?: number; clock?: () => number } = {}) {
  const rootPath = directory()
  const key = options.key ?? randomBytes(32)
  const store = await EncryptedArtifactStore.open({
    rootPath,
    key,
    now: options.clock ?? (() => now),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  })
  stores.push(store)
  return { rootPath, key, store }
}

async function put(store: EncryptedArtifactStore, sessionId = "session-a", content = secret) {
  return store.put({ sessionId, content: Buffer.from(content), mediaType: "text/x-diff" })
}

async function grant(store: EncryptedArtifactStore, id: string, actorId = "host:user-a", expiresAt = now + 60_000) {
  return store.grant({ id, sessionId: "session-a", actorId, expiresAt: new Date(expiresAt).toISOString() })
}

test("encrypted patch roundtrip returns only the bytes authorized for the exact session and actor", async () => {
  const { store } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  const content = await store.read({
    id: artifact.id,
    grantId: access.id,
    sessionId: "session-a",
    actorId: "host:user-a",
  })
  expect(Buffer.from(content).toString()).toBe(secret)
  expect(artifact).toEqual({
    id: expect.any(String),
    sha256: createHash("sha256").update(secret).digest("hex"),
    mediaType: "text/x-diff",
    sizeBytes: Buffer.byteLength(secret),
    sensitivity: "restricted",
  })
  expect(access.artifact).toEqual(artifact)
})

test("disk files contain no plaintext patch, session identity, actor identity or encryption key", async () => {
  const { store, rootPath, key } = await fixture()
  const artifact = await put(store)
  await grant(store, artifact.id)
  expect(readdirSync(rootPath).length).toBeGreaterThan(0)
  for (const path of readdirSync(rootPath)) {
    const bytes = readFileSync(join(rootPath, path))
    expect(bytes.includes(Buffer.from(secret))).toBe(false)
    expect(bytes.includes(Buffer.from("session-a"))).toBe(false)
    expect(bytes.includes(Buffer.from("host:user-a"))).toBe(false)
    expect(bytes.includes(Buffer.from(key))).toBe(false)
  }
})

test("random artifact identities do not deduplicate content or share grants", async () => {
  const { store } = await fixture()
  const first = await put(store)
  const second = await put(store)
  expect(first.id).not.toBe(second.id)
  expect(first.sha256).toBe(second.sha256)
  const access = await grant(store, first.id)
  const result = await store
    .read({ id: second.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
})

test("the encryption key is cloned and ciphertext survives reopening while grants do not", async () => {
  const key = randomBytes(32)
  const original = Buffer.from(key)
  const { store, rootPath } = await fixture({ key })
  key.fill(0)
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  store.close()
  const restarted = await EncryptedArtifactStore.open({ rootPath, key: original, now: () => now })
  stores.push(restarted)
  const stale = await restarted
    .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
    .catch((error: unknown) => error)
  expect(stale).toBeInstanceOf(Error)
  const fresh = await grant(restarted, artifact.id)
  expect(
    Buffer.from(
      await restarted.read({ id: artifact.id, grantId: fresh.id, sessionId: "session-a", actorId: "host:user-a" }),
    ).toString(),
  ).toBe(secret)
})

test("a completed encrypted commit survives forcibly terminating its writer", async () => {
  const rootPath = directory()
  const key = randomBytes(32)
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      import { EncryptedArtifactStore } from ${JSON.stringify(new URL("../src/artifacts.ts", import.meta.url).href)};
      const store = await EncryptedArtifactStore.open({ rootPath: ${JSON.stringify(rootPath)}, key: Buffer.from(${JSON.stringify(key.toString("base64"))}, "base64") });
      const artifact = await store.put({ sessionId: "session-a", content: Buffer.from(${JSON.stringify(secret)}), mediaType: "text/x-diff" });
      console.log(artifact.id);
      setInterval(() => {}, 1000);
    `,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  let id = ""
  try {
    const output = await child.stdout.getReader().read()
    id = new TextDecoder().decode(output.value).trim()
    expect(id).toMatch(/^[a-f0-9-]{36}$/)
  } finally {
    child.kill()
    await child.exited
  }
  const restarted = await EncryptedArtifactStore.open({ rootPath, key, now: () => now })
  stores.push(restarted)
  const access = await grant(restarted, id)
  expect(
    Buffer.from(
      await restarted.read({ id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" }),
    ).toString(),
  ).toBe(secret)
})

test("wrong keys cannot decrypt existing ciphertext or create usable grants", async () => {
  const { store, rootPath } = await fixture()
  const artifact = await put(store)
  store.close()
  const wrong = await EncryptedArtifactStore.open({ rootPath, key: randomBytes(32), now: () => now })
  stores.push(wrong)
  const result = await grant(wrong, artifact.id).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).not.toContain(secret)
})

test.each([
  { sessionId: "session-b", actorId: "host:user-a" },
  { sessionId: "session-a", actorId: "host:user-b" },
])("an artifact grant cannot cross identity boundaries %j", async (identity) => {
  const { store } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  const result = await store.read({ id: artifact.id, grantId: access.id, ...identity }).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
})

test("grant creation cannot change an artifact's encrypted session binding", async () => {
  const { store } = await fixture()
  const artifact = await put(store)
  const result = await store
    .grant({
      id: artifact.id,
      sessionId: "session-b",
      actorId: "host:user-b",
      expiresAt: new Date(now + 1000).toISOString(),
    })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
})

test("expiry is checked again on every content read", async () => {
  let current = now
  const { store } = await fixture({ clock: () => current })
  const artifact = await put(store)
  const access = await grant(store, artifact.id, "host:user-a", now + 10)
  current = now + 10
  const result = await store
    .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
})

test("grant revocation and session revocation prevent subsequent reads", async () => {
  const { store } = await fixture()
  const artifact = await put(store)
  const first = await grant(store, artifact.id)
  const second = await grant(store, artifact.id, "host:user-b")
  store.revokeGrant(first.id)
  expect(
    await store
      .read({ id: artifact.id, grantId: first.id, sessionId: "session-a", actorId: "host:user-a" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  store.revokeSession("session-a")
  expect(
    await store
      .read({ id: artifact.id, grantId: second.id, sessionId: "session-a", actorId: "host:user-b" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
})

test("deletion removes the encrypted artifact and invalidates all outstanding grants", async () => {
  const { store } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  expect(
    await store.delete({ id: artifact.id, sessionId: "session-b" }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  await store.delete({ id: artifact.id, sessionId: "session-a" })
  expect(await grant(store, artifact.id).catch((error: unknown) => error)).toBeInstanceOf(Error)
  expect(
    await store
      .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
})

test.each(["../outside", "C:/outside", "", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/../outside"])(
  "artifact IDs cannot become filesystem paths: %s",
  async (id) => {
    const { store } = await fixture()
    expect(await grant(store, id).catch((error: unknown) => error)).toBeInstanceOf(Error)
    expect(await store.delete({ id, sessionId: "session-a" }).catch((error: unknown) => error)).toBeInstanceOf(Error)
  },
)

test.each([0, 16, 31, 33])("invalid %i-byte encryption keys cannot create storage", async (length) => {
  const rootPath = directory()
  const result = await EncryptedArtifactStore.open({ rootPath, key: new Uint8Array(length) }).catch(
    (error: unknown) => error,
  )
  if (result instanceof EncryptedArtifactStore) stores.push(result)
  expect(result).toBeInstanceOf(Error)
  expect(readdirSync(rootPath)).toEqual([])
})

test.each([0, -1, 1.5, 1024 * 1024 + 1, NaN])("invalid byte cap %s cannot create storage", async (maxBytes) => {
  const rootPath = directory()
  expect(
    await EncryptedArtifactStore.open({ rootPath, key: randomBytes(32), maxBytes }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  expect(readdirSync(rootPath)).toEqual([])
})

test("storage requires an explicit existing absolute host directory", async () => {
  const rootPath = directory()
  for (const path of ["relative/artifacts", join(rootPath, "missing")]) {
    expect(
      await EncryptedArtifactStore.open({ rootPath: path, key: randomBytes(32) }).catch((error: unknown) => error),
    ).toBeInstanceOf(Error)
  }
  expect(readdirSync(rootPath)).toEqual([])
})

test("application JSON supports exact digest validation at the byte limit", async () => {
  const content = Buffer.from('{"patch":"private"}')
  const { store } = await fixture({ maxBytes: content.byteLength })
  const artifact = await store.put({
    sessionId: "session-a",
    content,
    mediaType: "application/json",
    expectedSha256: createHash("sha256").update(content).digest("hex"),
  })
  const access = await grant(store, artifact.id)
  expect(
    await store.read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" }),
  ).toEqual(new Uint8Array(content))
})

test("media-type, byte and expected-digest checks fail before persisting content", async () => {
  const { store, rootPath } = await fixture({ maxBytes: 16 })
  const attempts = [
    { sessionId: "session-a", content: Buffer.from("small"), mediaType: "text/html" },
    { sessionId: "session-a", content: Buffer.alloc(17), mediaType: "application/json" },
    {
      sessionId: "session-a",
      content: Buffer.from("small"),
      mediaType: "application/json",
      expectedSha256: "a".repeat(64),
    },
  ]
  for (const attempt of attempts)
    expect(await store.put(attempt).catch((error: unknown) => error)).toBeInstanceOf(Error)
  const database = new Database(join(rootPath, "artifacts.sqlite"), { readonly: true })
  try {
    expect(database.query("SELECT COUNT(*) AS count FROM artifact_blobs").get()).toEqual({ count: 0 })
  } finally {
    database.close()
  }
})

test.each([now, now - 1, now + 60_001])(
  "grant lifetime %i must be positive and at most sixty seconds",
  async (expires) => {
    const { store } = await fixture()
    const artifact = await put(store)
    expect(await grant(store, artifact.id, "host:user-a", expires).catch((error: unknown) => error)).toBeInstanceOf(
      Error,
    )
  },
)

test("a tampered encrypted envelope fails authentication without exposing plaintext", async () => {
  const { store, rootPath } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  const database = new Database(join(rootPath, "artifacts.sqlite"))
  try {
    const row = database
      .query<{ envelope: Uint8Array }, [string]>("SELECT envelope FROM artifact_blobs WHERE id = ?")
      .get(artifact.id)!
    const changed = Buffer.from(row.envelope)
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    database.query("UPDATE artifact_blobs SET envelope = ? WHERE id = ?").run(changed, artifact.id)
  } finally {
    database.close()
  }
  const result = await store
    .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).not.toContain(secret)
})

test("ciphertext from a different random artifact ID cannot be substituted", async () => {
  const { store, rootPath } = await fixture()
  const first = await put(store)
  const second = await put(store)
  const access = await grant(store, first.id)
  const database = new Database(join(rootPath, "artifacts.sqlite"))
  try {
    database
      .query("UPDATE artifact_blobs SET envelope = (SELECT envelope FROM artifact_blobs WHERE id = ?) WHERE id = ?")
      .run(second.id, first.id)
  } finally {
    database.close()
  }
  expect(
    await store
      .read({ id: first.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
})

test("linked roots, hardlinked databases and unsafe sidecars are rejected", async () => {
  const parent = directory()
  const actual = join(parent, "actual")
  const alias = join(parent, "alias")
  mkdirSync(actual)
  symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir")
  expect(
    await EncryptedArtifactStore.open({ rootPath: alias, key: randomBytes(32) }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  const source = join(parent, "outside.sqlite")
  writeFileSync(source, "fixture")
  linkSync(source, join(actual, "artifacts.sqlite"))
  expect(
    await EncryptedArtifactStore.open({ rootPath: actual, key: randomBytes(32) }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  const sidecars = join(parent, "sidecars")
  mkdirSync(sidecars)
  linkSync(source, join(sidecars, "artifacts.sqlite-wal"))
  expect(
    await EncryptedArtifactStore.open({ rootPath: sidecars, key: randomBytes(32) }).catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  expect(existsSync(join(sidecars, "artifacts.sqlite"))).toBe(false)
})

// Windows denies renaming a directory containing an open SQLite database itself.
test.skipIf(process.platform === "win32")(
  "replacing the registered storage root invalidates an open store",
  async () => {
    const parent = directory()
    const rootPath = join(parent, "root")
    mkdirSync(rootPath)
    const store = await EncryptedArtifactStore.open({ rootPath, key: randomBytes(32), now: () => now })
    stores.push(store)
    renameSync(rootPath, join(parent, "old-root"))
    mkdirSync(rootPath)
    expect(await put(store).catch((error: unknown) => error)).toBeInstanceOf(Error)
  },
)

test("adding a hardlink to an open database invalidates subsequent access", async () => {
  const { store, rootPath } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  linkSync(join(rootPath, "artifacts.sqlite"), join(rootPath, "copied.sqlite"))
  expect(
    await store
      .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  expect(await put(store).catch((error: unknown) => error)).toBeInstanceOf(Error)
})

test("returned grant and reference objects cannot change stored authorization", async () => {
  const { store } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  Object.assign(access, { actorId: "host:user-b", expiresAt: new Date(now + 120_000).toISOString() })
  Object.assign(access.artifact, { sha256: "0".repeat(64) })
  expect(
    await store
      .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-b" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
  expect(
    Buffer.from(
      await store.read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" }),
    ).toString(),
  ).toBe(secret)
})

test("grants are bounded and expired entries release capacity", async () => {
  let current = now
  const { store } = await fixture({ clock: () => current })
  const artifact = await put(store)
  for (let index = 0; index < 1024; index++) await grant(store, artifact.id, `host:user-${index}`, now + 10)
  expect(await grant(store, artifact.id).catch((error: unknown) => error)).toBeInstanceOf(Error)
  current = now + 10
  expect((await grant(store, artifact.id)).artifact.id).toBe(artifact.id)
}, 60_000)

test("closing a store clears authority and rejects further reads and writes", async () => {
  const { store } = await fixture()
  const artifact = await put(store)
  const access = await grant(store, artifact.id)
  store.close()
  expect(await put(store).catch((error: unknown) => error)).toBeInstanceOf(Error)
  expect(
    await store
      .read({ id: artifact.id, grantId: access.id, sessionId: "session-a", actorId: "host:user-a" })
      .catch((error: unknown) => error),
  ).toBeInstanceOf(Error)
})
