import { describe, expect, test } from "bun:test"
import { createDesktopBridge } from "../../src/preload/bridge"
import { desktopChannels } from "../../src/shared/contracts"
import type { DesktopState } from "../../src/shared/contracts"

function fixture() {
  const calls: { channel: string; input: unknown }[] = []
  const listeners = new Map<string, Set<(event: unknown, state: DesktopState) => void>>()
  const result: DesktopState = {
    revision: 1,
    configuration: {},
    connection: {
      status: "not-configured",
      runtimeName: "Codex",
      authentication: "unknown",
      billing: "unknown",
      providerOverage: "unknown",
    },
    messages: [],
    activity: [],
    permissions: [],
    inputs: [],
    skills: null,
    notices: [],
  }
  const ipc = {
    async invoke(channel: string, input?: unknown) {
      calls.push({ channel, input })
      return result
    },
    on(channel: string, listener: (event: unknown, state: DesktopState) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
    },
    removeListener(channel: string, listener: (event: unknown, state: DesktopState) => void) {
      listeners.get(channel)?.delete(listener)
    },
  }
  return { calls, listeners, result, bridge: createDesktopBridge(ipc) }
}

describe("isolated desktop preload bridge", () => {
  test("exposes only fixed application operations and preserves their arguments and results", async () => {
    const value = fixture()
    const start = {
      modelId: "model",
      acknowledgeOverage: true,
      allowFileChanges: false,
      acknowledgeUnverifiedBoundary: true,
    }
    const permission = { requestId: "request", choiceId: "deny" }
    const input = { requestId: "input", action: "cancel" as const, selections: [] }
    const review = { kind: "permission" as const, requestId: "request" }
    expect(Object.isFrozen(value.bridge)).toBe(true)
    expect(Object.keys(value.bridge).sort()).toEqual(
      Object.keys(desktopChannels)
        .filter((key) => key !== "changed")
        .concat("onState")
        .sort(),
    )
    expect(await value.bridge.getState()).toEqual(value.result)
    await value.bridge.chooseWorkspace()
    await value.bridge.chooseRuntime()
    await value.bridge.chooseNativeHome()
    await value.bridge.chooseSkillsRoot()
    await value.bridge.refresh()
    await value.bridge.start(start)
    await value.bridge.send({ text: "hello" })
    await value.bridge.interrupt()
    await value.bridge.review(review)
    await value.bridge.resolvePermission(permission)
    await value.bridge.resolveInput(input)
    expect(value.calls).toEqual([
      { channel: desktopChannels.getState, input: undefined },
      { channel: desktopChannels.chooseWorkspace, input: undefined },
      { channel: desktopChannels.chooseRuntime, input: undefined },
      { channel: desktopChannels.chooseNativeHome, input: undefined },
      { channel: desktopChannels.chooseSkillsRoot, input: undefined },
      { channel: desktopChannels.refresh, input: undefined },
      { channel: desktopChannels.start, input: start },
      { channel: desktopChannels.send, input: { text: "hello" } },
      { channel: desktopChannels.interrupt, input: undefined },
      { channel: desktopChannels.review, input: review },
      { channel: desktopChannels.resolvePermission, input: permission },
      { channel: desktopChannels.resolveInput, input },
    ])
  })

  test("forwards only state data and unsubscribes exactly its own callback", () => {
    const value = fixture()
    const received: unknown[][] = []
    const stop = value.bridge.onState((...arguments_) => received.push(arguments_))
    const other = value.bridge.onState(() => {})
    const state: DesktopState = {
      revision: 1,
      configuration: {},
      connection: {
        status: "not-configured",
        runtimeName: "Codex",
        authentication: "unknown",
        billing: "unknown",
        providerOverage: "unknown",
      },
      messages: [],
      activity: [],
      permissions: [],
      inputs: [],
      skills: null,
      notices: [],
    }
    const privilegedEvent = { sender: { invoke: () => {} } }
    for (const listener of value.listeners.get(desktopChannels.changed)!) listener(privilegedEvent, state)
    expect(received).toEqual([[state]])
    stop()
    stop()
    expect(value.listeners.get(desktopChannels.changed)!.size).toBe(1)
    other()
    expect(value.listeners.get(desktopChannels.changed)!.size).toBe(0)
  })

  test("bounds subscriptions while allowing unsubscribed capacity to be reused", () => {
    const value = fixture()
    const stops = Array.from({ length: 32 }, () => value.bridge.onState(() => {}))
    expect(() => value.bridge.onState(() => {})).toThrow("Invalid desktop subscription")
    stops[0]!()
    expect(() => value.bridge.onState(() => {})).not.toThrow()
    for (const stop of stops) stop()
  })
})
