import { randomBytes, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import type { BigIntStats } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?: (() => string) | undefined
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * The caller creates a private, application-owned directory outside repositories and invokes
 * this only after Electron is ready. Windows protection inherits that directory's OS ACL;
 * POSIX roots/files must also be owner-only. Identity checks reject observed aliases but do
 * not defend against an adversary already controlling the same OS account. The base64 string
 * required by safeStorage exists only in main-process memory and cannot be explicitly wiped.
 */
export async function loadOrCreateArtifactKey(options: {
  directory: string
  safeStorage: SafeStoragePort
  platform?: NodeJS.Platform
}): Promise<Uint8Array> {
  let key: Buffer | undefined
  let temporary: string | undefined
  try {
    const storage = options.safeStorage
    if (
      !storage.isEncryptionAvailable() ||
      ((options.platform ?? process.platform) === "linux" &&
        (!storage.getSelectedStorageBackend ||
          !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(storage.getSelectedStorageBackend())))
    )
      throw new Error("OS encryption unavailable")
    if (!absolute(options.directory)) throw new Error("Invalid vault root")
    const root = resolve(options.directory)
    const identity = directoryIdentity(root)
    const path = join(root, "artifact-key.json")
    if (fileIdentity(path)) return readKey(path, root, identity, storage)

    key = randomBytes(32)
    const wrapped = storage.encryptString(key.toString("base64"))
    if (!(wrapped instanceof Uint8Array) || wrapped.byteLength < 1 || wrapped.byteLength > 4096)
      throw new Error("Invalid wrapped key")
    const envelope = JSON.stringify({ version: 1, wrappedKey: wrapped.toString("base64") })
    ensureRoot(root, identity)
    temporary = join(root, `.artifact-key-${randomUUID()}.tmp`)
    const descriptor = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(descriptor, envelope, "utf8")
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    ensureRoot(root, identity)
    // No-overwrite publication prevents a second creator from replacing an existing key.
    // A crash during publication is fail-closed; corrupted keys never trigger silent rotation.
    linkSync(temporary, path)
    unlinkSync(temporary)
    temporary = undefined
    ensureRoot(root, identity)
    syncDirectory(root)
    const persisted = readKey(path, root, identity, storage)
    if (!Buffer.from(persisted).equals(key)) {
      persisted.fill(0)
      throw new Error("Wrapped key round trip failed")
    }
    return persisted
  } catch {
    throw new Error("Artifact key vault unavailable")
  } finally {
    key?.fill(0)
    if (temporary) {
      // A temporary file contains only OS-wrapped bytes. Leave it on cleanup failure.
      try {
        unlinkSync(temporary)
      } catch {
        /* Do not replace the primary vault failure. */
      }
    }
  }
}

function readKey(path: string, root: string, identity: BigIntStats, storage: SafeStoragePort): Uint8Array {
  ensureRoot(root, identity)
  const before = fileIdentity(path)
  if (!before || before.size > 8192n) throw new Error("Invalid vault envelope")
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let plaintext: Buffer | undefined
  try {
    if (!sameIdentity(before, fstatSync(descriptor, { bigint: true }))) throw new Error("Vault file changed")
    const bytes = Buffer.alloc(8193)
    const length = readSync(descriptor, bytes, 0, bytes.byteLength, 0)
    if (length > 8192) throw new Error("Invalid vault envelope")
    const envelope: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"))
    if (
      !record(envelope) ||
      Object.keys(envelope).sort().join(",") !== "version,wrappedKey" ||
      envelope.version !== 1 ||
      typeof envelope.wrappedKey !== "string"
    )
      throw new Error("Invalid vault envelope")
    const wrapped = decodeBase64(envelope.wrappedKey, 4096)
    const encoded = storage.decryptString(wrapped)
    plaintext = decodeBase64(encoded, 32)
    if (plaintext.byteLength !== 32) throw new Error("Invalid artifact key length")
    const after = fileIdentity(path)
    if (!after || !sameIdentity(before, after) || after.size !== before.size || after.mtimeNs !== before.mtimeNs)
      throw new Error("Vault file changed")
    ensureRoot(root, identity)
    return new Uint8Array(plaintext)
  } finally {
    plaintext?.fill(0)
    closeSync(descriptor)
  }
}

function directoryIdentity(path: string) {
  let current = path
  while (true) {
    const value = lstatSync(current, { bigint: true })
    if (!value.isDirectory() || value.isSymbolicLink() || !samePath(realpathSync(current), current))
      throw new Error("Unsafe vault directory")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const identity = lstatSync(path, { bigint: true })
  privateMode(identity)
  return identity
}

function ensureRoot(path: string, identity: BigIntStats) {
  if (!sameIdentity(directoryIdentity(path), identity)) throw new Error("Vault root changed")
}

function fileIdentity(path: string) {
  let value: BigIntStats
  try {
    value = lstatSync(path, { bigint: true })
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return
    throw error
  }
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || !samePath(realpathSync(path), path))
    throw new Error("Unsafe vault file")
  privateMode(value)
  return value
}

function privateMode(value: BigIntStats) {
  if (process.platform === "win32") return
  if ((value.mode & 0o077n) !== 0n || (process.getuid && value.uid !== BigInt(process.getuid())))
    throw new Error("Vault permissions are not private")
}

function syncDirectory(path: string) {
  // Node cannot fsync directory handles on Windows. Wrapped file contents are flushed above;
  // directory-entry durability there is provided by the filesystem, not claimed by this API.
  if (process.platform === "win32") return
  const descriptor = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function decodeBase64(value: string, limit: number) {
  if (!value || value.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Invalid base64 envelope")
  const bytes = Buffer.from(value, "base64")
  if (bytes.byteLength > limit || bytes.toString("base64") !== value) throw new Error("Invalid base64 envelope")
  return bytes
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
