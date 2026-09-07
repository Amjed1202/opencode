import { afterEach, expect, test } from "bun:test"
import { dirname } from "node:path"
import type { RuntimeDescriptor } from "@harness/protocol"
import { CodexAdapter } from "../../src/codex/adapter"
import { StdioJsonRpc } from "../../src/codex/stdio"

const active: CodexAdapter[] = []
const failure = "Codex model discovery failed; no model selection is available"

async function rejectsDiscovery(operation: Promise<unknown>): Promise<void> {
  // Await native pipe I/O before running Bun's synchronous error matcher.
  const error: unknown = await operation.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(failure)
}

async function fixture(scenario = "normal", timeout = 1000) {
  let transport: StdioJsonRpc | undefined
  const adapter = new CodexAdapter({
    executable: process.execPath,
    cwd: import.meta.dir,
    environment: { PATH: dirname(process.execPath), HOME: import.meta.dir, USERPROFILE: import.meta.dir },
    target: { id: "local", name: "Local", kind: "local" },
    requestTimeoutMs: timeout,
    transportFactory: (options) =>
      (transport = new StdioJsonRpc({
        ...options,
        command: [process.execPath, `${import.meta.dir}/app-server-peer.ts`, scenario, ...options.command.slice(1)],
      })),
  })
  active.push(adapter)
  const runtime = (
    await adapter.discover({
      target: { id: "local", name: "Local", kind: "local" },
      allowedExecutablePaths: [process.execPath],
    })
  )[0]!
  expect(runtime).toBeDefined()
  return {
    adapter,
    runtime,
    state: async () =>
      (await transport!.request("fixture/state", {})) as {
        requests: string[]
        turns: number
        modelRequests: { cursor: string | null; limit: number; includeHidden: boolean }[]
      },
  }
}

afterEach(async () => {
  await Promise.all(active.splice(0).map((adapter) => adapter.dispose()))
})

test("native catalog exposes dispatch strings and names only, bracketed by account/configuration checks", async () => {
  const peer = await fixture()
  expect(await peer.adapter.models(peer.runtime)).toEqual([
    { id: "gpt-5.4", name: "GPT-5.4", providerId: "openai", capabilities: {} },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", providerId: "openai", capabilities: {} },
  ])
  const state = await peer.state()
  expect(state.requests).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "config/read",
    "account/read",
    "model/list",
    "account/read",
    "config/read",
    "account/read",
    "fixture/state",
  ])
  expect(state.modelRequests).toEqual([{ cursor: null, limit: 100, includeHidden: false }])
  expect(state.turns).toBe(0)
})

test("native catalog pagination preserves order and uses the opaque native cursor", async () => {
  const peer = await fixture("models-paginated")
  expect((await peer.adapter.models(peer.runtime)).map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.4-mini"])
  expect((await peer.state()).modelRequests).toEqual([
    { cursor: null, limit: 100, includeHidden: false },
    { cursor: "opaque:page/2+=", limit: 100, includeHidden: false },
  ])
})

test("native hidden models stay out of the picker even if returned despite includeHidden false", async () => {
  const peer = await fixture("models-hidden")
  expect((await peer.adapter.models(peer.runtime)).map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.4-mini"])
})

for (const scenario of ["models-empty", "models-all-hidden"]) {
  test(`${scenario} returns an empty catalog without a fabricated model`, async () => {
    const peer = await fixture(scenario)
    expect(await peer.adapter.models(peer.runtime)).toEqual([])
    const state = await peer.state()
    expect(state.requests.filter((method) => method === "account/read")).toHaveLength(4)
    expect(state.turns).toBe(0)
  })
}

test("each discovery observes the native catalog again without reusing a prior selection", async () => {
  const peer = await fixture("models-disappear")
  expect((await peer.adapter.models(peer.runtime)).map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.4-mini"])
  expect((await peer.adapter.models(peer.runtime)).map((model) => model.id)).toEqual(["gpt-5.4-mini"])
  expect((await peer.state()).modelRequests).toHaveLength(2)
})

for (const scenario of [
  "models-error",
  "models-malformed",
  "models-malformed-id",
  "models-long-id",
  "models-malformed-name",
  "models-blank-name",
  "models-padded-name",
  "models-long-name",
  "models-malformed-hidden",
  "models-missing-hidden",
  "models-malformed-response",
  "models-invalid-cursor",
  "models-missing-cursor",
  "models-long-cursor",
  "models-duplicate",
  "models-duplicate-pages",
  "models-cursor-loop",
  "models-too-many",
  "models-total",
  "models-page-limit",
  "models-byte-limit",
]) {
  test(`${scenario} rejects the entire catalog with a sanitized error and no native turn`, async () => {
    const peer = await fixture(scenario)
    await rejectsDiscovery(peer.adapter.models(peer.runtime))
    const state = await peer.state()
    expect(state.turns).toBe(0)
    expect(state.requests.some((method) => method.startsWith("thread/") || method.startsWith("turn/"))).toBe(false)
    expect(state.modelRequests.length).toBeLessThanOrEqual(8)
    if (scenario === "models-total") expect(state.modelRequests.map((request) => request.limit)).toEqual([100, 100, 56])
    if (scenario === "models-page-limit") expect(state.modelRequests).toHaveLength(8)
    if (scenario === "models-byte-limit") expect(state.modelRequests).toHaveLength(2)
  })
}

test("the count boundary accepts exactly 256 native entries and reduces the final request size", async () => {
  const peer = await fixture("models-limit")
  expect(await peer.adapter.models(peer.runtime)).toHaveLength(256)
  expect((await peer.state()).modelRequests.map((request) => request.limit)).toEqual([100, 100, 56])
})

for (const scenario of [
  "models-account-switch",
  "models-config-switch",
  "models-account-event",
  "models-config-event",
]) {
  test(`${scenario} invalidates the catalog before it becomes visible`, async () => {
    const peer = await fixture(scenario)
    await rejectsDiscovery(peer.adapter.models(peer.runtime))
    expect((await peer.state()).turns).toBe(0)
  })
}

test("unverified API account never reaches native model listing", async () => {
  const peer = await fixture("api")
  await rejectsDiscovery(peer.adapter.models(peer.runtime))
  expect((await peer.state()).modelRequests).toEqual([])
})

test("every runtime identity field is checked before account or catalog requests", async () => {
  const peer = await fixture()
  const runtime = peer.runtime
  const altered: RuntimeDescriptor[] = [
    { ...runtime, id: "other" },
    { ...runtime, adapterId: "other" },
    { ...runtime, kind: "api" },
    { ...runtime, version: "0.154.0" },
    { ...runtime, nativeProtocolVersion: "0.154.0" },
    { ...runtime, executable: `${process.execPath}.other` },
    { ...runtime, executable: "bun.exe" },
    { ...runtime, target: { ...runtime.target, id: "other" } },
    { ...runtime, target: { ...runtime.target, kind: "remote-node" } },
    { ...runtime, target: { ...runtime.target, nodeId: "unexpected" } },
    { ...runtime, providers: [{ id: "other", name: "Other" }] },
    { ...runtime, providers: [...runtime.providers, { id: "other", name: "Other" }] },
  ]
  for (const value of altered) await rejectsDiscovery(peer.adapter.models(value))
  expect((await peer.state()).requests).toEqual(["initialize", "initialized", "fixture/state"])
})

test("disposal while a catalog request is pending never publishes its result", async () => {
  const peer = await fixture("models-delay", 2000)
  const pending = peer.adapter.models(peer.runtime)
  const rejected = rejectsDiscovery(pending)
  let reached = false
  for (let index = 0; index < 40; index++) {
    if ((await peer.state()).modelRequests.length) {
      reached = true
      break
    }
    await Bun.sleep(5)
  }
  expect(reached).toBe(true)
  await peer.adapter.dispose()
  await rejected
  await rejectsDiscovery(peer.adapter.models(peer.runtime))
})

test("a timed out model catalog produces no fallback entry", async () => {
  const peer = await fixture("models-no-response", 100)
  await rejectsDiscovery(peer.adapter.models(peer.runtime))
})
