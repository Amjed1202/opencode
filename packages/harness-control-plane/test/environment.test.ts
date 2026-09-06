import { describe, expect, test } from "bun:test"
import { buildNativeEnvironment, hashConfiguration } from "../src/environment"

describe("native launch environment", () => {
  test("keeps selected Windows OS values and explicitly selected native home and executable search path", () => {
    const environment = buildNativeEnvironment({
      inherited: { SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\Temp", LANG: "en_US.UTF-8" },
      home: "C:\\Native Account",
      path: "C:\\Trusted Runtime;C:\\Windows\\System32",
      platform: "win32",
    })
    expect(environment).toEqual({
      SYSTEMROOT: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      LANG: "en_US.UTF-8",
      HOME: "C:\\Native Account",
      USERPROFILE: "C:\\Native Account",
      PATH: "C:\\Trusted Runtime;C:\\Windows\\System32",
    })
    expect(Object.isFrozen(environment)).toBe(true)
  })

  test("does not forward ambient credential, billing, configuration, shell, proxy, or executable overrides", () => {
    const inherited = Object.fromEntries(
      [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CODEX_API_KEY",
        "CUSTOM_PROVIDER_TOKEN",
        "OPENAI_BASE_URL",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_PROFILE",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AZURE_OPENAI_ENDPOINT",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SHELL",
        "NODE_OPTIONS",
        "NODE_PATH",
        "BUN_OPTIONS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "BASH_ENV",
        "ENV",
        "HTTPS_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
      ].map((key) => [key, "fixture-value"]),
    )
    const environment = buildNativeEnvironment({ inherited, platform: "win32" })
    // Check names only so a regression cannot print credential values in a failed assertion.
    expect(Object.keys(environment)).toEqual([])
  })

  test("rejects conflicting Windows key variants without exposing values", () => {
    expect(() =>
      buildNativeEnvironment({
        inherited: { TEMP: "C:\\First", Temp: "C:\\Second" },
        platform: "win32",
      }),
    ).toThrow("Conflicting environment variable casing")
  })

  test("coalesces matching Windows key variants and ignores undefined values", () => {
    expect(
      buildNativeEnvironment({
        inherited: { TEMP: "C:\\Temp", Temp: "C:\\Temp", TMP: undefined },
        platform: "win32",
      }),
    ).toEqual({ TEMP: "C:\\Temp" })
  })

  test("uses case-sensitive POSIX OS names without importing Windows controls", () => {
    expect(
      buildNativeEnvironment({
        inherited: { LANG: "C.UTF-8", lang: "ignored", TMPDIR: "/tmp/native", SystemRoot: "C:\\Windows" },
        home: "/home/native",
        path: "/usr/local/bin:/usr/bin",
        platform: "posix",
      }),
    ).toEqual({ LANG: "C.UTF-8", TMPDIR: "/tmp/native", HOME: "/home/native", PATH: "/usr/local/bin:/usr/bin" })
  })

  test.each([
    ["posix", "bin"],
    ["posix", "/usr/bin:"],
    ["posix", "/usr/bin:.:/bin"],
    ["win32", "C:bin"],
    ["win32", "\\bin"],
    ["win32", "C:\\bin;"],
    ["win32", "C:\\bin;relative"],
  ] as const)("rejects cwd-dependent %s search path %s", (platform, path) => {
    expect(() => buildNativeEnvironment({ inherited: {}, platform, path })).toThrow("absolute")
  })

  test.each(["", "relative", "C:relative", "\\root-relative"])(
    "requires an absolute explicit native home: %s",
    (home) => {
      expect(() => buildNativeEnvironment({ inherited: {}, platform: "win32", home })).toThrow("absolute")
    },
  )

  test("rejects null bytes in retained runtime variables", () => {
    expect(() => buildNativeEnvironment({ inherited: { LANG: "invalid\u0000value" }, platform: "posix" })).toThrow(
      "Invalid environment value",
    )
  })

  test.each(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"])("rejects cwd-dependent inherited Windows %s", (name) => {
    expect(() => buildNativeEnvironment({ inherited: { [name]: "relative" }, platform: "win32" })).toThrow("absolute")
  })
})

describe("configuration fingerprint", () => {
  test("uses a known SHA-256 JSON digest", () => {
    expect(hashConfiguration({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
  })

  test("ignores object key insertion order throughout the configuration", () => {
    expect(hashConfiguration({ b: [{ y: "v", x: true }], a: null })).toBe(
      hashConfiguration({ a: null, b: [{ x: true, y: "v" }] }),
    )
  })

  test("distinguishes changes to configuration and array order", () => {
    expect(hashConfiguration({ model: "first", modes: ["a", "b"] })).not.toBe(
      hashConfiguration({ model: "second", modes: ["a", "b"] }),
    )
    expect(hashConfiguration(["a", "b"])).not.toBe(hashConfiguration(["b", "a"]))
  })

  test("rejects nonfinite numbers instead of colliding with null", () => {
    expect(() => hashConfiguration({ value: Number.NaN })).toThrow("Invalid JSON configuration")
    expect(() => hashConfiguration({ value: Number.POSITIVE_INFINITY })).toThrow("Invalid JSON configuration")
  })

  test("rejects circular and sparse configurations", () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => hashConfiguration(circular as never)).toThrow("Invalid JSON configuration")
    expect(() => hashConfiguration(Array(1))).toThrow("Invalid JSON configuration")
  })

  test("rejects objects with serialization hooks without invoking them", () => {
    const configuration = {
      toJSON: () => {
        throw new Error("serialization hook ran")
      },
    }
    expect(() => hashConfiguration(configuration as never)).toThrow("Invalid JSON configuration")
    expect(() => hashConfiguration(new Date() as never)).toThrow("Invalid JSON configuration")
  })

  test("rejects array getters without invoking them", () => {
    const configuration = Object.defineProperty([], "0", {
      get: () => {
        throw new Error("getter ran")
      },
    })
    expect(() => hashConfiguration(configuration)).toThrow("Invalid JSON configuration")
  })

  test("rejects configuration properties that JSON would silently omit", () => {
    expect(() => hashConfiguration({ [Symbol("hidden")]: true })).toThrow("Invalid JSON configuration")
    expect(() => hashConfiguration(Object.defineProperty({}, "hidden", { value: true }))).toThrow(
      "Invalid JSON configuration",
    )
    expect(() => hashConfiguration(Object.assign([], { hidden: true }))).toThrow("Invalid JSON configuration")
  })
})
