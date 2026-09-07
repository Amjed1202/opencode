import { expect, test } from "bun:test"
import { isolationArguments, readIsolation, requireIsolation } from "../../src/codex/isolation"

const config = {
  shell_environment_policy: { set: { FIXTURE_ENV: "fixture-never-forward" } },
  mcp_servers: { "fixture.server": { command: "fixture-never-execute", enabled: true } },
  plugins: { "fixture.plugin@market": { enabled: true } },
  notify: [],
}

test("native isolation retains only bounded names and TOML encoding round-trips dotted and plugin keys", () => {
  const isolation = readIsolation(config)
  const args = isolationArguments(isolation)
  expect(JSON.stringify(isolation)).not.toContain("fixture-never-forward")
  expect(JSON.stringify(args)).not.toContain("fixture-never-execute")
  expect(args.filter((arg) => arg !== "-c").map((arg) => Bun.TOML.parse(arg))).toEqual([
    { shell_environment_policy: { set: { FIXTURE_ENV: "" } } },
    { mcp_servers: { "fixture.server": { enabled: false } } },
    { plugins: { "fixture.plugin@market": { enabled: false } } },
  ])
})

test.each(["bad.key", 'bad"key', "bad key", "bad\nkey", "", "A".repeat(129)])(
  "unsafe shell environment name is rejected without an override: %j",
  (key) => {
    expect(() =>
      readIsolation({ ...config, shell_environment_policy: { set: { [key]: "fixture-never-forward" } } }),
    ).toThrow()
  },
)

test.each([false, 1, [], { nested: "fixture-never-forward" }].map((value) => ({ value })))(
  "non-string shell value is blocked: %j",
  (entry) => {
    expect(() =>
      readIsolation({ ...config, shell_environment_policy: { set: { FIXTURE_ENV: entry.value } } }),
    ).toThrow()
  },
)

test.each(['bad"key', "bad key", "bad\nkey", "", "A".repeat(129)])("unsafe extension name is rejected: %j", (key) => {
  for (const category of ["mcp_servers", "plugins"])
    expect(() => readIsolation({ ...config, [category]: { [key]: { enabled: true } } })).toThrow()
})

test("mapping shapes, entry count, enablement type and serialized argument size are bounded", () => {
  for (const value of [false, 1, "fixture", []]) {
    expect(() => readIsolation({ ...config, shell_environment_policy: { set: value } })).toThrow()
    for (const category of ["mcp_servers", "plugins"])
      expect(() => readIsolation({ ...config, [category]: value })).toThrow()
  }
  expect(() => readIsolation({ ...config, plugins: { fixture: { enabled: "false" } } })).toThrow()
  expect(() =>
    readIsolation({
      ...config,
      shell_environment_policy: { set: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`FIXTURE_${i}`, ""])) },
    }),
  ).toThrow()
  expect(() =>
    readIsolation({
      ...config,
      plugins: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`fixture_${i}`, { enabled: true }])),
    }),
  ).toThrow()
  const entries = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`fixture_${i}_${"x".repeat(110)}`, { enabled: true }]),
  )
  expect(() => readIsolation({ ...config, plugins: entries, mcp_servers: entries })).toThrow()
})

test("effective isolation requires known entries, empty strings, explicit false and an empty notification command", () => {
  const pinned = readIsolation(config)
  const effective = {
    shell_environment_policy: { set: { FIXTURE_ENV: "" } },
    mcp_servers: { "fixture.server": { command: "fixture-never-execute", enabled: false } },
    plugins: { "fixture.plugin@market": { enabled: false } },
    notify: [],
  }
  expect(() => requireIsolation(effective, pinned)).not.toThrow()
  expect(() => requireIsolation(config, pinned)).toThrow()
  expect(() =>
    requireIsolation({ ...effective, plugins: { ...effective.plugins, unknown: { enabled: false } } }, pinned),
  ).toThrow()
  expect(() => requireIsolation({ ...effective, notify: ["fixture-never-execute"] }, pinned)).toThrow()
  expect(() => requireIsolation({ ...effective, notify: null }, pinned)).toThrow()
})
