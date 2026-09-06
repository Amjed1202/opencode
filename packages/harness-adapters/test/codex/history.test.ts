import { expect, test } from "bun:test"
import type { AgentSession } from "@harness/protocol"
import { inspectCodexHistory } from "../../src/codex/history"

const session: AgentSession = {
  id: "session-1",
  workspaceId: "workspace-1",
  intent: {
    workspaceId: "workspace-1",
    mode: "chat",
    requiredCapabilities: ["chat"],
    selection: {
      runtimeId: "codex-local",
      targetId: "local",
      model: { providerId: "openai", modelId: "gpt-5.4" },
      access: {
        mode: "subscription",
        method: "chatgpt-subscription",
        billing: "subscription",
        overagePolicy: "acknowledge-provider-settings",
      },
      fallback: { automatic: false },
    },
    policy: {
      id: "policy-1",
      version: "1",
      filesystem: "read-only",
      shell: "sandboxed",
      network: "denied",
      allowedMcpServers: [],
      approval: "deny",
      requireEnforcedBoundary: false,
    },
  },
  binding: {
    runtimeId: "codex-local",
    adapterId: "codex-app-server",
    targetId: "local",
    nativeSessionId: "native-thread-1",
    nativeProtocolVersion: "0.153.4",
  },
  effective: {
    auth: { runtimeId: "codex-local", targetId: "local", status: "authenticated", mode: "subscription" },
    billing: { route: "subscription", providerId: "openai", providerOverage: "unknown" },
    capabilities: {},
    enforcement: { mechanism: "none", filesystem: false, shell: false, network: false, limitations: [] },
    checkedAt: "2026-09-06T00:00:00.000Z",
    expiresAt: "2026-09-06T00:01:00.000Z",
    configurationFingerprint: "fixture-fingerprint",
  },
  status: "uncertain",
  createdAt: "2026-09-06T00:00:00.000Z",
  revision: 1,
}

// Complete official-shaped 0.153.4 wire data; all tests pass through unknown decoding.
const metadata = {
  id: "native-thread-1",
  sessionId: "native-thread-1",
  forkedFromId: null,
  parentThreadId: null,
  preview: "private user message",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  model: "gpt-5.4",
  reasoningEffort: null,
  createdAt: 1_788_652_800,
  updatedAt: 1_788_652_810,
  recencyAt: 1_788_652_810,
  status: { type: "idle" },
  path: "private rollout path",
  cwd: import.meta.dir,
  cliVersion: "0.153.4",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "private title",
  turns: [],
}

function turn(id: string, status = "completed", extra: Record<string, unknown> = {}) {
  return {
    id,
    items: [{ type: "agentMessage", id: `item-${id}`, text: "private assistant message", phase: null }],
    itemsView: "summary",
    status,
    error:
      status === "failed"
        ? { message: "private error", codexErrorInfo: null, additionalDetails: "private details", misalignment: null }
        : null,
    startedAt: 1_788_652_801,
    completedAt: status === "inProgress" ? null : 1_788_652_809,
    durationMs: status === "inProgress" ? null : 8000,
    ...extra,
  }
}

function page(data: unknown[], nextCursor: string | null = null) {
  return { data, nextCursor, backwardsCursor: data.length ? "reverse-anchor" : null }
}

function history(pages: readonly unknown[], before: unknown = metadata, after: unknown = before) {
  const calls: { method: string; params: unknown }[] = []
  let reads = 0
  let lists = 0
  return {
    calls,
    request: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params })
      if (method === "thread/read") return JSON.parse(JSON.stringify({ thread: ++reads === 1 ? before : after }))
      if (method === "thread/turns/list") return JSON.parse(JSON.stringify(pages[lists++]))
      throw new Error("Unexpected mutating or inference request")
    },
  }
}

test("reads metadata and bounded summary pages, emitting only native IDs and terminal statuses", async () => {
  const native = history([
    page([turn("turn-4"), turn("turn-3", "failed")], "older"),
    page([turn("turn-2", "interrupted"), turn("turn-1")]),
  ])
  const result = await inspectCodexHistory({ ...native, session, cwd: import.meta.dir, maxTurns: 4 })
  expect(result).toEqual({
    sessionId: "session-1",
    binding: session.binding,
    observedAt: expect.any(String),
    nativeState: "idle",
    completeness: "complete",
    turns: [
      { nativeTurnId: "turn-4", status: "succeeded" },
      { nativeTurnId: "turn-3", status: "failed" },
      { nativeTurnId: "turn-2", status: "interrupted" },
      { nativeTurnId: "turn-1", status: "succeeded" },
    ],
  })
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true)
  expect(JSON.stringify(result)).not.toContain("private")
  expect(native.calls).toEqual([
    { method: "thread/read", params: { threadId: "native-thread-1", includeTurns: false } },
    {
      method: "thread/turns/list",
      params: { threadId: "native-thread-1", cursor: null, limit: 4, sortDirection: "desc", itemsView: "summary" },
    },
    {
      method: "thread/turns/list",
      params: { threadId: "native-thread-1", cursor: "older", limit: 2, sortDirection: "desc", itemsView: "summary" },
    },
    { method: "thread/read", params: { threadId: "native-thread-1", includeTurns: false } },
  ])
})

test.each([
  { maxPages: 1, maxTurns: 4 },
  { maxPages: 4, maxTurns: 1 },
])("truncation preserves observed turns but never claims idle (%j)", async (limits) => {
  const native = history([page([turn("known-turn")], "older")])
  const result = await inspectCodexHistory({ ...native, session, cwd: import.meta.dir, ...limits })
  expect(result.completeness).toBe("partial")
  expect(result.nativeState).toBe("unknown")
  expect(result.turns).toEqual([{ nativeTurnId: "known-turn", status: "succeeded" }])
  expect(native.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(1)
})

test.each([
  [{ type: "active", activeFlags: [] }, "completed", "running"],
  [{ type: "active", activeFlags: ["waitingOnApproval"] }, "inProgress", "running"],
  [{ type: "idle" }, "inProgress", "running"],
  [{ type: "notLoaded" }, "completed", "unknown"],
  [{ type: "systemError" }, "completed", "unknown"],
] as const)(
  "decodes native runtime state %j and turn status %s conservatively",
  async (status, turnStatus, expected) => {
    const native = history([page([turn("turn-1", turnStatus)])], { ...metadata, status })
    const result = await inspectCodexHistory({ ...native, session, cwd: import.meta.dir })
    expect(result.nativeState).toBe(expected)
    expect(result.turns[0]?.status).toBe(turnStatus === "inProgress" ? "running" : "succeeded")
  },
)

test("an empty exhaustive history can be idle but does not invent a native turn for an unacknowledged command", async () => {
  const result = await inspectCodexHistory({ ...history([page([])]), session, cwd: import.meta.dir })
  expect(result.nativeState).toBe("idle")
  expect(result.turns).toEqual([])
})

test.each([
  { id: "another-thread" },
  { cwd: `${import.meta.dir}/other` },
  { cwd: "relative" },
  { modelProvider: "other-provider" },
  { updatedAt: "yesterday" },
  { status: { type: "new-status" } },
  { status: { type: ["idle"] } },
  { status: { type: "active" } },
  { status: { type: "active", activeFlags: ["new-flag"] } },
  { turns: [turn("unexpected-hydration")] },
])("rejects malformed or mismatched thread metadata %j", async (override) => {
  await expect(
    inspectCodexHistory({ ...history([page([])], { ...metadata, ...override }), session, cwd: import.meta.dir }),
  ).rejects.toThrow("Codex history")
})

test("revalidates thread identity after paging", async () => {
  await expect(
    inspectCodexHistory({
      ...history([page([turn("turn-1")])], metadata, { ...metadata, cwd: `${import.meta.dir}/other` }),
      session,
      cwd: import.meta.dir,
    }),
  ).rejects.toThrow("Codex history")
})

test("changed metadata makes an otherwise exhaustive read partial", async () => {
  const result = await inspectCodexHistory({
    ...history([page([turn("turn-1")])], metadata, { ...metadata, updatedAt: metadata.updatedAt + 1 }),
    session,
    cwd: import.meta.dir,
  })
  expect(result.completeness).toBe("partial")
  expect(result.nativeState).toBe("unknown")
})

test.each([
  null,
  { data: [], nextCursor: null },
  { data: [], nextCursor: 1, backwardsCursor: null },
  { data: [], nextCursor: "", backwardsCursor: null },
  { data: [], nextCursor: null, backwardsCursor: {} },
  page([turn("turn-1", "unknown")]),
  page([turn("private token\n", "completed")]),
  page([turn("turn-1", "completed", { items: null })]),
  page([turn("turn-1", "completed", { itemsView: "full" })]),
  page([turn("turn-1", "completed", { completedAt: "yesterday" })]),
  page([turn("turn-1", "completed", { durationMs: -1 })]),
  page([turn("turn-1", "completed", { error: "private error" })]),
  page([turn("turn-1", "completed", { error: { message: "private error" } })]),
  page([turn("turn-1", "failed", { error: {} })]),
  page([turn("turn-1", "completed", { completedAt: 1_788_652_800 })]),
])("rejects malformed native pagination and turn evidence %j", async (response) => {
  await expect(inspectCodexHistory({ ...history([response]), session, cwd: import.meta.dir })).rejects.toThrow(
    "Codex history",
  )
})

test("conflicting duplicate turn IDs cannot be reconciled", async () => {
  await expect(
    inspectCodexHistory({
      ...history([page([turn("turn-1")], "older"), page([turn("turn-1", "failed")])]),
      session,
      cwd: import.meta.dir,
    }),
  ).rejects.toThrow("Codex history")
})

test("a conflicting timestamp for one native ID cannot establish reliable evidence", async () => {
  await expect(
    inspectCodexHistory({
      ...history([page([turn("turn-1")], "older"), page([turn("turn-1", "completed", { startedAt: 1_788_652_802 })])]),
      session,
      cwd: import.meta.dir,
    }),
  ).rejects.toThrow("Codex history")
})

test("an active thread remains running when page limits leave history partial", async () => {
  const result = await inspectCodexHistory({
    ...history([page([turn("turn-1")], "older")], { ...metadata, status: { type: "active", activeFlags: [] } }),
    session,
    cwd: import.meta.dir,
    maxPages: 1,
  })
  expect(result.nativeState).toBe("running")
  expect(result.completeness).toBe("partial")
})

test("matching duplicate IDs deduplicate evidence and mark the traversal partial", async () => {
  const result = await inspectCodexHistory({
    ...history([page([turn("turn-1")], "older"), page([turn("turn-1")])]),
    session,
    cwd: import.meta.dir,
  })
  expect(result.completeness).toBe("partial")
  expect(result.nativeState).toBe("unknown")
  expect(result.turns).toEqual([{ nativeTurnId: "turn-1", status: "succeeded" }])
})

test("cursor loops fail instead of repeatedly consuming history", async () => {
  const native = history([page([turn("turn-2")], "older"), page([turn("turn-1")], "older")])
  await expect(inspectCodexHistory({ ...native, session, cwd: import.meta.dir })).rejects.toThrow("Codex history")
  expect(native.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(2)
})

test("native pages cannot overrun the requested turn limit", async () => {
  await expect(
    inspectCodexHistory({
      ...history([page([turn("turn-2"), turn("turn-1")])]),
      session,
      cwd: import.meta.dir,
      maxTurns: 1,
    }),
  ).rejects.toThrow("Codex history")
})

test("the total response byte bound includes discarded private message bodies", async () => {
  const native = history([page([turn("turn-1", "completed", { items: [{ text: "private".repeat(1000) }] })])])
  const result = await inspectCodexHistory({ ...native, session, cwd: import.meta.dir, maxBytes: 2000 }).catch(
    (error: Error) => error,
  )
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).not.toContain("private")
})

test("native transport errors are redacted", async () => {
  const result = await inspectCodexHistory({
    session,
    cwd: import.meta.dir,
    request: async () => {
      throw new Error("private native message and account details")
    },
  }).catch((error: Error) => error)
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).not.toContain("private")
})

test.each([{ maxPages: 0 }, { maxPages: 33 }, { maxTurns: NaN }, { maxTurns: 2001 }, { maxBytes: 0 }])(
  "invalid resource limits fail before reading native history %j",
  async (limits) => {
    const native = history([page([])])
    await expect(inspectCodexHistory({ ...native, session, cwd: import.meta.dir, ...limits })).rejects.toThrow()
    expect(native.calls).toEqual([])
  },
)
