import { createHash } from "node:crypto"
import { platform } from "node:os"

export interface NativeEnvironmentInput {
  /** Values are privileged launch material, never diagnostic or event payloads. */
  readonly inherited: Readonly<Record<string, string | undefined>>
  /** A host-selected native account home, never an ambient profile override. */
  readonly home?: string
  /** Host-selected directories for child tools; the runtime executable must be selected separately. */
  readonly path?: string
  readonly platform?: "win32" | "posix"
}

/** This is only the launch boundary. Native effective settings still need adapter preflight. */
export function buildNativeEnvironment(input: NativeEnvironmentInput): Readonly<Record<string, string>> {
  const windows = (input.platform ?? (platform() === "win32" ? "win32" : "posix")) === "win32"
  const allowed = new Set([
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TEMP",
    "TMP",
    ...(windows ? ["SYSTEMROOT", "WINDIR"] : ["TMPDIR"]),
  ])
  const seen = new Map<string, string>()
  const environment: Record<string, string> = {}
  Object.entries(input.inherited).forEach(([key, value]) => {
    if (value === undefined) return
    const name = windows ? key.toUpperCase() : key
    if (seen.has(name) && seen.get(name) !== value) throw new Error("Conflicting environment variable casing")
    seen.set(name, value)
    if (!allowed.has(name)) return
    requireEnvironmentValue(value)
    if (["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].includes(name)) requireAbsolutePath(value, windows)
    environment[name] = value
  })
  if (input.home !== undefined) {
    requireAbsolutePath(input.home, windows)
    environment.HOME = input.home
    if (windows) environment.USERPROFILE = input.home
  }
  if (input.path !== undefined) {
    input.path.split(windows ? ";" : ":").forEach((entry) => requireAbsolutePath(entry, windows))
    environment.PATH = input.path
  }
  return Object.freeze(environment)
}

/** Hash only safe effective configuration facts, never credential values or raw process environments. */
export function hashConfiguration(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value, new Set())).digest("hex")
}

function requireEnvironmentValue(value: string): void {
  if (typeof value !== "string" || value.includes("\u0000")) throw new Error("Invalid environment value")
}

function requireAbsolutePath(value: string, windows: boolean): void {
  requireEnvironmentValue(value)
  const normalized = value.replaceAll("/", "\\")
  const absolute = windows
    ? /^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(normalized) && !/^\\\\[?.]\\/.test(normalized)
    : value.startsWith("/")
  if (!absolute) throw new Error("Native environment paths must be absolute")
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== "object" || value === null || ancestors.has(value) || ancestors.size >= 64) {
    throw new Error("Invalid JSON configuration")
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("Invalid JSON configuration")
  }
  ancestors.add(value)
  const keys = Reflect.ownKeys(value)
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) throw new Error("Invalid JSON configuration")
    const entries = Array.from({ length: value.length }, (_, index) =>
      canonicalJson(configurationProperty(value, String(index)), ancestors),
    )
    ancestors.delete(value)
    return `[${entries.join(",")}]`
  }
  if (keys.some((key) => typeof key !== "string")) throw new Error("Invalid JSON configuration")
  const entries = (keys as string[]).sort().map((key) => {
    return `${JSON.stringify(key)}:${canonicalJson(configurationProperty(value, key), ancestors)}`
  })
  ancestors.delete(value)
  return `{${entries.join(",")}}`
}

function configurationProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Invalid JSON configuration")
  return descriptor.value
}
