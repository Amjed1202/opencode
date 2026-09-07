import { isRecord } from "./stdio"

export type NativeIsolation = {
  readonly shell: readonly string[]
  readonly mcp_servers: readonly string[]
  readonly plugins: readonly string[]
  readonly restart: boolean
}

/** Only bounded configuration names are retained; configured values never become subprocess arguments. */
export function readIsolation(config: Record<string, unknown>): NativeIsolation {
  const shell = isRecord(config.shell_environment_policy) ? config.shell_environment_policy.set : undefined
  const shellKeys = shell === undefined || shell === null ? [] : isRecord(shell) ? Object.keys(shell) : undefined
  if (
    !shellKeys ||
    shellKeys.length > 64 ||
    shellKeys.some(
      (key) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || !isRecord(shell) || typeof shell[key] !== "string",
    ) ||
    new Set(shellKeys.map((key) => (process.platform === "win32" ? key.toUpperCase() : key))).size !== shellKeys.length
  )
    throw new Error("Native shell environment mapping could not be verified")
  const extensions = (["mcp_servers", "plugins"] as const).map((category) => {
    const entries = config[category]
    const keys = entries === undefined || entries === null ? [] : isRecord(entries) ? Object.keys(entries) : undefined
    if (
      !keys ||
      keys.length > 64 ||
      keys.some((key) => {
        const entry = isRecord(entries) ? entries[key] : undefined
        return (
          !/^[A-Za-z0-9][A-Za-z0-9_@./:-]{0,127}$/.test(key) ||
          !isRecord(entry) ||
          (entry.enabled !== undefined && entry.enabled !== null && typeof entry.enabled !== "boolean")
        )
      })
    )
      throw new Error("Native extension mapping could not be verified")
    return {
      keys,
      enabled: isRecord(entries) && Object.values(entries).some((entry) => isRecord(entry) && entry.enabled !== false),
    }
  })
  const isolation = {
    shell: shellKeys,
    mcp_servers: extensions[0]!.keys,
    plugins: extensions[1]!.keys,
    restart:
      (isRecord(shell) && Object.values(shell).some((value) => value !== "")) ||
      extensions.some((entry) => entry.enabled),
  }
  isolationArguments(isolation)
  return isolation
}

export function isolationArguments(isolation: NativeIsolation): readonly string[] {
  const args = [
    ...isolation.shell.flatMap((key) => ["-c", `shell_environment_policy.set.${key}=""`]),
    ...(["mcp_servers", "plugins"] as const).flatMap((category) =>
      isolation[category].length
        ? [
            "-c",
            `${category}={${isolation[category].map((key) => `${JSON.stringify(key)}={enabled=false}`).join(",")}}`,
          ]
        : [],
    ),
  ]
  // Quoted inline table keys preserve dots and plugin IDs. Dotted -c path segments do not unquote keys.
  if (Buffer.byteLength(args.join("\0")) > 16_384) throw new Error("Native isolation arguments exceed the bound")
  return args
}

export function requireIsolation(config: Record<string, unknown>, pinned: NativeIsolation): void {
  const effective = readIsolation(config)
  if (
    effective.restart ||
    (["shell", "mcp_servers", "plugins"] as const).some((category) =>
      effective[category].some((key) => !pinned[category].includes(key)),
    )
  )
    throw new Error("Native shell environment or extensions are not isolated")
  if (!Array.isArray(config.notify) || config.notify.length)
    throw new Error("Native notification command is not isolated")
}
