import { describe, expect, test } from "bun:test"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmod, link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadOrCreateArtifactKey } from "../../src/main/vault"
import type { SafeStoragePort } from "../../src/main/vault"

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-desktop-vault-")))
  const wrappingKey = randomBytes(32)
  const safeStorage: SafeStoragePort = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce)
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", wrappingKey, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(value.length - 16))
      return Buffer.concat([decipher.update(value.subarray(12, value.length - 16)), decipher.final()]).toString("utf8")
    },
  }
  return {
    directory,
    safeStorage,
    path: join(directory, "artifact-key.json"),
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

describe("desktop OS-wrapped artifact key", () => {
  test("persists only the wrapped key, reloads across instances, and returns independent key buffers", async () => {
    const value = await fixture()
    try {
      const first = await loadOrCreateArtifactKey(value)
      expect(first.byteLength).toBe(32)
      const serialized = await readFile(value.path, "utf8")
      expect(serialized).not.toContain(Buffer.from(first).toString("base64"))
      expect(await readdir(value.directory)).toEqual(["artifact-key.json"])
      expect(await loadOrCreateArtifactKey(value)).toEqual(first)
      const second = await loadOrCreateArtifactKey(value)
      first.fill(0)
      expect(await loadOrCreateArtifactKey(value)).toEqual(second)
    } finally {
      await value.close()
    }
  })

  test("fails closed without safeStorage and rejects the Linux plaintext backend before creating files", async () => {
    for (const storage of [
      { isEncryptionAvailable: () => false },
      { getSelectedStorageBackend: () => "basic_text" },
      { getSelectedStorageBackend: () => "unknown" },
      { getSelectedStorageBackend: () => "" },
      { getSelectedStorageBackend: undefined },
      {
        encryptString: () => {
          throw new Error("keyring locked")
        },
      },
    ]) {
      const value = await fixture()
      try {
        await expect(
          loadOrCreateArtifactKey({ ...value, platform: "linux", safeStorage: { ...value.safeStorage, ...storage } }),
        ).rejects.toThrow("Artifact key vault unavailable")
        expect(await readdir(value.directory)).toEqual([])
      } finally {
        await value.close()
      }
    }
  })

  test("preserves corrupt, unsupported, oversized and foreign wrapped keys without rotation", async () => {
    for (const content of [
      "broken",
      JSON.stringify({ version: 2, wrappedKey: "AAAA" }),
      "a".repeat(9000),
      JSON.stringify({ version: 1, wrappedKey: "AAAA", extra: true }),
      JSON.stringify({ version: 1, wrappedKey: "AAAA" }),
    ]) {
      const value = await fixture()
      try {
        await writeFile(value.path, content, { mode: 0o600 })
        await expect(loadOrCreateArtifactKey(value)).rejects.toThrow("Artifact key vault unavailable")
        expect(await readFile(value.path, "utf8")).toBe(content)
      } finally {
        await value.close()
      }
    }
  })

  test("rejects noncanonical decrypted keys, file hard links, and relative roots", async () => {
    const value = await fixture()
    try {
      await loadOrCreateArtifactKey(value)
      await expect(
        loadOrCreateArtifactKey({ ...value, safeStorage: { ...value.safeStorage, decryptString: () => "bad key" } }),
      ).rejects.toThrow()
      await link(value.path, join(value.directory, "alias.json"))
      await expect(loadOrCreateArtifactKey(value)).rejects.toThrow()
      await expect(loadOrCreateArtifactKey({ ...value, directory: "." })).rejects.toThrow()
    } finally {
      await value.close()
    }
  })

  test("rejects directory aliases before reading or creating a key", async () => {
    const value = await fixture()
    const holder = await fixture()
    try {
      const alias = join(holder.directory, "alias")
      await symlink(value.directory, alias, process.platform === "win32" ? "junction" : "dir")
      await expect(loadOrCreateArtifactKey({ ...value, directory: alias })).rejects.toThrow()
      expect(await readdir(value.directory)).toEqual([])
    } finally {
      await holder.close()
      await value.close()
    }
  })

  test.skipIf(process.platform === "win32")(
    "rejects group/world accessible POSIX key directories and files",
    async () => {
      const value = await fixture()
      try {
        await loadOrCreateArtifactKey(value)
        await chmod(value.path, 0o644)
        await expect(loadOrCreateArtifactKey(value)).rejects.toThrow()
        await chmod(value.path, 0o600)
        await chmod(value.directory, 0o755)
        await expect(loadOrCreateArtifactKey(value)).rejects.toThrow()
      } finally {
        await value.close()
      }
    },
  )
})
