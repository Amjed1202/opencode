import { Database } from "bun:sqlite"
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs"
import type { BigIntStats } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { ArtifactReference } from "@harness/protocol"

export interface ArtifactGrant {
  readonly id: string
  readonly artifact: ArtifactReference
  readonly sessionId: string
  readonly actorId: string
  readonly expiresAt: string
}

type StoredArtifact = { sessionId: string; reference: ArtifactReference; content: Buffer }

/**
 * Privileged encrypted patch storage, separate from the renderer-facing ArtifactStore port.
 * The host supplies an existing private directory outside repositories and a vault-managed key.
 * Only random IDs and AES-GCM envelopes reach SQLite, including its WAL. FULL-synchronous
 * transactions provide durable commits; deletion is logical deletion, not secure erasure.
 * Root/file identity checks reject existing links and replacement. They do not protect against
 * a hostile same-privilege process racing filesystem operations; the OS must protect this root.
 * Grants deliberately live only in memory and cannot survive a host restart.
 */
export class EncryptedArtifactStore {
  readonly rootPath: string
  private readonly database: Database
  private readonly rootIdentity: BigIntStats
  private readonly databaseIdentity: BigIntStats
  private readonly key: Buffer
  private readonly maxBytes: number
  private readonly now: () => number
  private readonly grants = new Map<string, ArtifactGrant>()
  private closed = false

  private constructor(options: { rootPath: string; key: Uint8Array; now?: () => number; maxBytes?: number }) {
    if (
      !(options.key instanceof Uint8Array) ||
      options.key.byteLength !== 32 ||
      !absolute(options.rootPath) ||
      !Number.isSafeInteger(options.maxBytes ?? 1024 * 1024) ||
      (options.maxBytes ?? 1024 * 1024) < 1 ||
      (options.maxBytes ?? 1024 * 1024) > 1024 * 1024
    )
      throw new Error("Invalid artifact storage configuration")
    this.key = Buffer.from(options.key)
    this.maxBytes = options.maxBytes ?? 1024 * 1024
    this.now = options.now ?? Date.now
    try {
      const requested = resolve(options.rootPath)
      this.rootIdentity = directoryIdentity(requested)
      this.rootPath = realpathSync(requested)
      if (!samePath(requested, this.rootPath)) throw new Error("Storage root alias")
      checkFiles(this.rootPath)
      const path = join(this.rootPath, "artifacts.sqlite")
      if (!fileIdentity(path)) closeSync(openSync(path, "wx", 0o600))
      this.databaseIdentity = fileIdentity(path)!
      const database = new Database(path, { create: false, strict: true })
      try {
        database.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          PRAGMA busy_timeout = 5000;
          PRAGMA temp_store = MEMORY;
          PRAGMA secure_delete = ON;
          CREATE TABLE IF NOT EXISTS artifact_blobs (id TEXT PRIMARY KEY, envelope BLOB NOT NULL);
        `)
        this.database = database
        this.ensure()
      } catch (error) {
        database.close()
        throw error
      }
    } catch {
      this.key.fill(0)
      throw new Error("Artifact storage could not be opened")
    }
  }

  static async open(options: { rootPath: string; key: Uint8Array; now?: () => number; maxBytes?: number }) {
    return new EncryptedArtifactStore(options)
  }

  async put(input: {
    sessionId: string
    content: Uint8Array
    mediaType: string
    expectedSha256?: string
  }): Promise<ArtifactReference> {
    let content: Buffer | undefined
    let plaintext: Buffer | undefined
    try {
      this.ensure()
      identity(input.sessionId)
      if (
        !(input.content instanceof Uint8Array) ||
        input.content.byteLength > this.maxBytes ||
        !mediaType(input.mediaType)
      )
        throw new Error("Unsupported artifact content")
      content = Buffer.from(input.content)
      const sha256 = digest(content)
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256)
        throw new Error("Artifact digest mismatch")
      const reference: ArtifactReference = {
        id: randomUUID(),
        sha256,
        mediaType: input.mediaType,
        sizeBytes: content.byteLength,
        sensitivity: "restricted",
      }
      plaintext = Buffer.from(
        JSON.stringify({ sessionId: input.sessionId, reference, content: content.toString("base64") }),
      )
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce)
      cipher.setAAD(additionalData(reference.id))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      // HPA1 identifies envelope version 1 and its fixed AES-256-GCM/12-byte nonce/16-byte tag format.
      const envelope = Buffer.concat([Buffer.from("HPA1"), nonce, cipher.getAuthTag(), ciphertext])
      this.database
        .transaction(() => {
          this.ensure()
          this.database.query("INSERT INTO artifact_blobs (id, envelope) VALUES (?, ?)").run(reference.id, envelope)
        })
        .immediate()
      this.ensure()
      return reference
    } catch {
      throw new Error("Artifact write failed")
    } finally {
      content?.fill(0)
      plaintext?.fill(0)
    }
  }

  async grant(input: { id: string; sessionId: string; actorId: string; expiresAt: string }): Promise<ArtifactGrant> {
    let stored: StoredArtifact | undefined
    try {
      this.ensure()
      identifier(input.id)
      identity(input.sessionId)
      identity(input.actorId)
      const current = this.time()
      const expires = Date.parse(input.expiresAt)
      if (!Number.isFinite(expires) || expires <= current || expires > current + 60_000)
        throw new Error("Invalid grant lifetime")
      for (const [id, grant] of this.grants) if (Date.parse(grant.expiresAt) <= current) this.grants.delete(id)
      if (this.grants.size >= 1024) throw new Error("Artifact grant limit exceeded")
      stored = this.decode(input.id)
      if (stored.sessionId !== input.sessionId) throw new Error("Artifact session mismatch")
      const grant: ArtifactGrant = {
        id: randomUUID(),
        artifact: stored.reference,
        sessionId: input.sessionId,
        actorId: input.actorId,
        expiresAt: new Date(expires).toISOString(),
      }
      this.ensure()
      if (expires <= this.time()) throw new Error("Artifact grant expired")
      this.grants.set(grant.id, structuredClone(grant))
      return grant
    } catch {
      throw new Error("Artifact grant denied")
    } finally {
      stored?.content.fill(0)
    }
  }

  async read(input: { id: string; grantId: string; sessionId: string; actorId: string }): Promise<Uint8Array> {
    let stored: StoredArtifact | undefined
    try {
      this.ensure()
      identifier(input.id)
      identifier(input.grantId)
      identity(input.sessionId)
      identity(input.actorId)
      const grant = this.grants.get(input.grantId)
      if (
        !grant ||
        grant.artifact.id !== input.id ||
        grant.sessionId !== input.sessionId ||
        grant.actorId !== input.actorId ||
        Date.parse(grant.expiresAt) <= this.time()
      )
        throw new Error("Artifact grant mismatch")
      stored = this.decode(input.id)
      if (stored.sessionId !== input.sessionId || JSON.stringify(stored.reference) !== JSON.stringify(grant.artifact))
        throw new Error("Artifact changed after grant")
      this.ensure()
      if (this.grants.get(input.grantId) !== grant || Date.parse(grant.expiresAt) <= this.time())
        throw new Error("Artifact grant expired")
      return new Uint8Array(stored.content)
    } catch {
      throw new Error("Artifact read denied")
    } finally {
      stored?.content.fill(0)
    }
  }

  async delete(input: { id: string; sessionId: string }): Promise<void> {
    let stored: StoredArtifact | undefined
    try {
      this.ensure()
      identifier(input.id)
      identity(input.sessionId)
      stored = this.decode(input.id)
      if (stored.sessionId !== input.sessionId) throw new Error("Artifact session mismatch")
      this.database
        .transaction(() => {
          this.ensure()
          this.database.query("DELETE FROM artifact_blobs WHERE id = ?").run(input.id)
        })
        .immediate()
      for (const [id, grant] of this.grants) if (grant.artifact.id === input.id) this.grants.delete(id)
      this.ensure()
    } catch {
      throw new Error("Artifact deletion denied")
    } finally {
      stored?.content.fill(0)
    }
  }

  revokeGrant(grantId: string): void {
    this.grants.delete(grantId)
  }
  revokeSession(sessionId: string): void {
    for (const [id, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(id)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.grants.clear()
    this.key.fill(0)
    this.database.close()
  }

  private decode(id: string): StoredArtifact {
    const row = this.database
      .query<{ envelope: Uint8Array }, [string]>("SELECT envelope FROM artifact_blobs WHERE id = ?")
      .get(id)
    if (
      !row ||
      !(row.envelope instanceof Uint8Array) ||
      row.envelope.byteLength < 32 ||
      row.envelope.byteLength > this.maxBytes * 2 + 8192
    )
      throw new Error("Missing or oversized encrypted artifact")
    const envelope = Buffer.from(row.envelope)
    if (envelope.subarray(0, 4).toString() !== "HPA1") throw new Error("Unsupported artifact envelope")
    const decipher = createDecipheriv("aes-256-gcm", this.key, envelope.subarray(4, 16))
    decipher.setAAD(additionalData(id))
    decipher.setAuthTag(envelope.subarray(16, 32))
    const plaintext = Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()])
    let content: Buffer | undefined
    try {
      const value: unknown = JSON.parse(plaintext.toString("utf8"))
      if (!record(value) || !record(value.reference) || typeof value.content !== "string")
        throw new Error("Malformed artifact")
      identity(value.sessionId)
      const reference = value.reference
      if (
        reference.id !== id ||
        typeof reference.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(reference.sha256) ||
        !mediaType(reference.mediaType) ||
        reference.sensitivity !== "restricted" ||
        !Number.isSafeInteger(reference.sizeBytes) ||
        typeof reference.sizeBytes !== "number" ||
        reference.sizeBytes < 0 ||
        reference.sizeBytes > this.maxBytes ||
        value.content.length > Math.ceil(this.maxBytes / 3) * 4
      )
        throw new Error("Invalid artifact metadata")
      content = Buffer.from(value.content, "base64")
      if (
        content.toString("base64") !== value.content ||
        content.byteLength !== reference.sizeBytes ||
        digest(content) !== reference.sha256
      )
        throw new Error("Artifact digest mismatch")
      return {
        sessionId: value.sessionId,
        reference: {
          id,
          sha256: reference.sha256,
          mediaType: reference.mediaType,
          sizeBytes: reference.sizeBytes,
          sensitivity: "restricted",
        },
        content,
      }
    } catch (error) {
      content?.fill(0)
      throw error
    } finally {
      plaintext.fill(0)
    }
  }

  private ensure() {
    if (this.closed) throw new Error("Artifact store is closed")
    const root = directoryIdentity(this.rootPath)
    if (!sameIdentity(root, this.rootIdentity)) throw new Error("Artifact root changed")
    checkFiles(this.rootPath)
    const database = fileIdentity(join(this.rootPath, "artifacts.sqlite"))
    if (!database || !sameIdentity(database, this.databaseIdentity)) throw new Error("Artifact database changed")
  }

  private time() {
    const value = this.now()
    if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) throw new Error("Invalid artifact clock")
    return value
  }
}

function directoryIdentity(path: string) {
  let current = path
  while (true) {
    const stat = lstatSync(current, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(current), current))
      throw new Error("Unsafe artifact directory")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return lstatSync(path, { bigint: true })
}

function fileIdentity(path: string): BigIntStats | undefined {
  let stat: BigIntStats
  try {
    stat = lstatSync(path, { bigint: true })
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !samePath(realpathSync(path), path))
    throw new Error("Unsafe artifact file")
  return stat
}

function checkFiles(root: string) {
  for (const name of ["artifacts.sqlite", "artifacts.sqlite-wal", "artifacts.sqlite-shm", "artifacts.sqlite-journal"])
    fileIdentity(join(root, name))
}

function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino
}
function samePath(left: string, right: string) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}
function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    (process.platform !== "win32" || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value))
  )
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new Error("Invalid artifact identifier")
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || !/^[^\x00-\x1f\x7f]{1,256}$/.test(value))
    throw new Error("Invalid artifact identity")
}
function mediaType(value: unknown): value is "application/json" | "text/x-diff" {
  return value === "application/json" || value === "text/x-diff"
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
function additionalData(id: string) {
  return Buffer.from(`harness.patch-artifact.v1:${id}`)
}
