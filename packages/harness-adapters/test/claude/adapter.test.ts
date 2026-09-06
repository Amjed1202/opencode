import { expect, test } from "bun:test"
import type { AdmittedSessionRequest, AgentSession, RuntimeDescriptor, SessionIntent } from "@harness/protocol"
import type { AgentAdapter } from "../../src/index"
import { ClaudeAdapter } from "../../src/claude/adapter"
import type { ClaudeInspector } from "../../src/claude/adapter"
import { PINNED_CLAUDE_VERSION } from "../../src/claude/inspect"

const target = { id: "local", kind: "local", name: "Local" } as const
const intent: SessionIntent = {
  workspaceId: "workspace",
  mode: "chat",
  requiredCapabilities: ["chat"],
  selection: {
    runtimeId: "claude-local",
    targetId: "local",
    model: { providerId: "anthropic", modelId: "fixture-model" },
    access: {
      mode: "subscription",
      method: "claude-code-subscription",
      billing: "subscription",
      overagePolicy: "require-disabled",
    },
    fallback: { automatic: false },
  },
  policy: {
    id: "policy",
    version: "1",
    filesystem: "read-only",
    shell: "disabled",
    network: "denied",
    allowedMcpServers: [],
    approval: "deny",
    requireEnforcedBoundary: true,
  },
}

function fixture(overrides: Partial<ClaudeInspector> = {}) {
  const calls: string[] = []
  const inspector: ClaudeInspector = {
    version: async () => {
      calls.push("version")
      return PINNED_CLAUDE_VERSION
    },
    authStatus: async () => {
      calls.push("authStatus")
      return { loggedIn: false }
    },
    dispose: async () => {
      calls.push("dispose")
    },
    ...overrides,
  }
  const adapter = new ClaudeAdapter({
    executable: process.execPath,
    cwd: import.meta.dir,
    environment: { HOME: import.meta.dir, USERPROFILE: import.meta.dir },
    target,
    inspectorFactory: () => inspector,
  })
  return {
    adapter,
    calls,
    discover: () => adapter.discover({ target, allowedExecutablePaths: [process.execPath] }),
  }
}

async function fakeAdmission(adapter: ClaudeAdapter): Promise<AdmittedSessionRequest> {
  const [runtime] = await adapter.discover({ target, allowedExecutablePaths: [process.execPath] })
  if (!runtime) throw new Error("Missing fixture runtime")
  return {
    operation: "create",
    admissionId: "forged-admission",
    sessionId: "session",
    intent,
    workspace: {
      id: "workspace",
      projectId: "project",
      targetId: "local",
      rootPath: import.meta.dir,
      kind: "repository",
    },
    lease: {
      id: "lease",
      workspaceId: "workspace",
      targetId: "local",
      ownerId: "host",
      mode: "read",
      generation: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    effective: await adapter.status(runtime),
  }
}

test("discovery checks only the selected local binary version and advertises no execution support", async () => {
  const current = fixture()
  const [runtime] = await current.discover()
  expect(current.calls).toEqual(["version"])
  expect(runtime).toMatchObject({
    id: "claude-local",
    adapterId: "claude-code",
    version: PINNED_CLAUDE_VERSION,
    kind: "native-agent",
    authModes: ["unknown"],
    billingModes: ["unknown"],
    integration: "conditional",
  })
  expect(runtime?.nativeProtocolVersion).toBeUndefined()
  expect(Object.keys(runtime!.capabilities)).toHaveLength(24)
  expect(Object.values(runtime!.capabilities).every((capability) => capability.status === "unsupported")).toBe(true)
  expect(runtime!.capabilities.skills?.status).toBe("unsupported")
  const port: AgentAdapter = current.adapter
  for (const method of ["resume", "inspect", "models", "quota", "usage", "resolvePermission", "resolveInput"] as const)
    expect(port[method]).toBeUndefined()
  await current.adapter.dispose()
})

test("discovery rejects other targets and executable selections without running the inspector", async () => {
  const current = fixture()
  for (const selected of [
    { target, allowedExecutablePaths: [] },
    { target, allowedExecutablePaths: ["claude"] },
    { target: { ...target, id: "other" }, allowedExecutablePaths: [process.execPath] },
    { target: { ...target, name: "other" }, allowedExecutablePaths: [process.execPath] },
    { target: { ...target, kind: "remote-node" as const, nodeId: "node" }, allowedExecutablePaths: [process.execPath] },
  ])
    expect(await current.adapter.discover(selected)).toEqual([])
  expect(current.calls).toEqual([])
  await current.adapter.dispose()
})

test("unsupported versions and diagnostic failures never create a runtime", async () => {
  for (const version of [
    async () => "2.1.252",
    async (): Promise<string> => {
      throw new Error("private-path")
    },
  ]) {
    const current = fixture({ version })
    expect(await current.discover()).toEqual([])
    expect(current.calls).toEqual([])
    await current.adapter.dispose()
  }
})

test("native login status cannot become a subscription, account, policy or billing assertion", async () => {
  for (const loggedIn of [false, true]) {
    const current = fixture({
      authStatus: async () => ({
        loggedIn,
        subscriptionType: "max",
        tokenSource: "secret",
        accountLabel: "private-account",
      }),
    })
    const [runtime] = await current.discover()
    const state = await current.adapter.status(runtime!)
    expect(state.auth).toEqual({
      runtimeId: "claude-local",
      targetId: "local",
      status: loggedIn ? "authenticated" : "unauthenticated",
      mode: "unknown",
      evidence: { source: "native-status", observedAt: state.checkedAt, runtimeVersion: PINNED_CLAUDE_VERSION },
    })
    expect(state.billing).toEqual({ route: "unknown", providerOverage: "unknown" })
    expect(state.enforcement).toMatchObject({ mechanism: "none", filesystem: false, shell: false, network: false })
    expect(state.expiresAt).toBe(state.checkedAt)
    expect(state.configurationFingerprint).toContain("unverified")
    expect(JSON.stringify(state)).not.toMatch(/private-account|secret|subscriptionType/)
    expect(Object.values(state.capabilities).every((value) => value.status === "unsupported")).toBe(true)
    await current.adapter.dispose()
  }
})

test("status rejects mismatched runtime identity before native authentication reads", async () => {
  const current = fixture()
  const [runtime] = await current.discover()
  const missingExecutable = structuredClone(runtime!)
  Reflect.deleteProperty(missingExecutable, "executable")
  const alternatives: RuntimeDescriptor[] = [
    { ...runtime!, id: "other" },
    { ...runtime!, adapterId: "other" },
    { ...runtime!, kind: "api" },
    { ...runtime!, version: "2.1.252" },
    { ...runtime!, nativeProtocolVersion: "invented" },
    { ...runtime!, executable: `${process.execPath}.other` },
    missingExecutable,
    { ...runtime!, target: { ...target, id: "other" } },
    { ...runtime!, target: { ...target, kind: "remote-node", nodeId: "node" } },
    { ...runtime!, target: { ...target, nodeId: "node" } },
    { ...runtime!, providers: [{ id: "other", name: "Other" }] },
  ]
  for (const value of alternatives)
    await expect(current.adapter.status(value)).rejects.toThrow("Invalid Claude native status binding")
  expect(current.calls).toEqual(["version"])
  await current.adapter.dispose()
})

test("status rechecks the pinned version and sanitizes all inspector failures", async () => {
  let version = PINNED_CLAUDE_VERSION as string
  const current = fixture({ version: async () => version })
  const [runtime] = await current.discover()
  version = "2.1.252"
  await expect(current.adapter.status(runtime!)).rejects.toThrow("Claude native status is unavailable")
  expect(current.calls).toEqual([])
  await current.adapter.dispose()
  const failure = fixture({
    authStatus: async () => {
      throw new Error("secret-native-output")
    },
  })
  const [selected] = await failure.discover()
  await expect(failure.adapter.status(selected!)).rejects.toThrow(/^Claude native status is unavailable$/)
  await failure.adapter.dispose()
})

test("all preflight and execution entry points reject forged admissions without native calls", async () => {
  const current = fixture()
  const request = await fakeAdmission(current.adapter)
  const session: AgentSession = {
    id: request.sessionId,
    workspaceId: "workspace",
    intent,
    effective: request.effective,
    binding: {
      runtimeId: "claude-local",
      adapterId: "claude-code",
      targetId: "local",
      nativeSessionId: "forged-native",
    },
    status: "idle",
    createdAt: request.effective.checkedAt,
    revision: 1,
  }
  current.calls.length = 0
  for (const operation of ["create", "resume", "turn"] as const) {
    const result = await current.adapter.preflight({ operation, intent, existingSession: session })
    expect(result).toMatchObject({ status: "blocked", errors: [{ code: "unsupported", retryable: false }] })
    expect("observed" in result).toBe(false)
  }
  const context = { session, admissionId: request.admissionId, leaseGeneration: 1 }
  await expect(current.adapter.createSession(request)).rejects.toThrow("require verified")
  await expect(
    current.adapter.send(context, {
      commandId: "command",
      messageId: "message",
      parts: [{ type: "text", text: "never send" }],
      delivery: "when-idle",
    }),
  ).rejects.toThrow("require verified")
  await expect(current.adapter.interrupt(context)).rejects.toThrow("require verified")
  expect(() => current.adapter.events(session)).toThrow("require verified")
  expect(current.calls).toEqual([])
  await current.adapter.close(session)
  await current.adapter.dispose()
  expect(current.calls).toEqual(["dispose"])
})

test("disposing during a native observation prevents publishing stale status", async () => {
  const pending = Promise.withResolvers<{ loggedIn: boolean }>()
  const started = Promise.withResolvers<void>()
  const current = fixture({
    authStatus: () => {
      started.resolve()
      return pending.promise
    },
  })
  const [runtime] = await current.discover()
  const status = current.adapter.status(runtime!)
  const outcome = status.then(
    () => "unexpected success",
    (error: Error) => error.message,
  )
  await started.promise
  await current.adapter.dispose()
  pending.resolve({ loggedIn: true })
  expect(await outcome).toBe("Claude native status is unavailable")
  expect(await current.discover()).toEqual([])
  await expect(current.adapter.status(runtime!)).rejects.toThrow("Claude native status is unavailable")
  expect(current.calls).toEqual(["version", "version", "dispose"])
})

test("adapter snapshots host configuration and does not reuse mutable status projections", async () => {
  const environment = { HOME: import.meta.dir, USERPROFILE: import.meta.dir }
  const selected = { ...target }
  let inspectedEnvironment: Readonly<Record<string, string>> | undefined
  const adapter = new ClaudeAdapter({
    executable: process.execPath,
    cwd: import.meta.dir,
    environment,
    target: selected,
    inspectorFactory: (options) => {
      inspectedEnvironment = options.environment
      return {
        version: async () => PINNED_CLAUDE_VERSION,
        authStatus: async () => ({ loggedIn: true }),
        dispose: async () => {},
      }
    },
  })
  environment.HOME = "changed"
  selected.name = "changed" as typeof selected.name
  expect(inspectedEnvironment?.HOME).toBe(import.meta.dir)
  const [runtime] = await adapter.discover({ target, allowedExecutablePaths: [process.execPath] })
  expect(runtime?.target.name).toBe("Local")
  const state = await adapter.status(runtime!)
  Object.assign(state.auth, { status: "unknown", accountId: "injected" })
  Object.assign(state.capabilities, { chat: { status: "supported" } })
  const fresh = await adapter.status(runtime!)
  expect(fresh.auth.status).toBe("authenticated")
  expect(fresh.auth.accountId).toBeUndefined()
  expect(fresh.capabilities.chat?.status).toBe("unsupported")
  await adapter.dispose()
})
