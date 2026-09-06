import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentAdapter } from "@harness/adapters"
import type { AgentSession, RuntimePreflight, SessionIntent } from "@harness/protocol"
import { AdmissionController } from "../src/admission"
import { LocalWorkspaceRegistry } from "../src/workspaces"

export const now = Date.parse("2026-09-06T12:00:00Z")
export const intent: SessionIntent = {
  workspaceId: "workspace",
  selection: {
    runtimeId: "runtime",
    targetId: "local",
    model: { providerId: "openai", modelId: "selected-model" },
    access: {
      mode: "subscription",
      method: "chatgpt-subscription",
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
  requiredCapabilities: ["chat"],
  mode: "chat",
}
export function effective(): RuntimePreflight {
  const evidence = { source: "native-status" as const, observedAt: "2026-09-06T12:00:00Z" }
  return {
    auth: {
      runtimeId: "runtime",
      targetId: "local",
      status: "authenticated",
      mode: "subscription",
      method: "chatgpt-subscription",
      accountId: "account-a",
      evidence,
    },
    billing: { route: "subscription", providerId: "openai", providerOverage: "disabled", evidence },
    capabilities: { chat: { status: "supported", verification: "verified", evidence, limitations: [] } },
    enforcement: { mechanism: "native-enforcement", filesystem: true, shell: true, network: true, limitations: [] },
    checkedAt: "2026-09-06T12:00:00Z",
    expiresAt: "2026-09-06T12:01:00Z",
    configurationFingerprint: "config-a",
  }
}

export async function admissionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-admission-"))
  const workspaces = new LocalWorkspaceRegistry({ now: () => now })
  await workspaces.register({
    id: "workspace",
    projectId: "project",
    targetId: "local",
    rootPath: directory,
    kind: "repository",
  })
  const state = { effective: effective(), capacity: "available" as "available" | "exhausted" }
  const sessions = new Map<string, AgentSession>()
  const descriptor = {
    id: "runtime",
    adapterId: "fixture",
    name: "Test native boundary",
    kind: "native-agent" as const,
    providers: [{ id: "openai", name: "OpenAI" }],
    target: { id: "local", kind: "local" as const, name: "Local" },
    authModes: ["subscription", "api"] as const,
    billingModes: ["subscription", "api-payg"] as const,
    capabilities: state.effective.capabilities,
    integration: "conditional" as const,
  }
  const adapter: AgentAdapter = {
    id: "fixture",
    version: "1",
    discover: async () => [descriptor],
    capabilities: () => state.effective.capabilities,
    preflight: async () => ({ status: "ready", effective: structuredClone(state.effective) }),
    createSession: async (request) => ({
      id: request.sessionId,
      workspaceId: request.workspace.id,
      intent: request.intent,
      binding: {
        runtimeId: "runtime",
        adapterId: "fixture",
        targetId: "local",
        nativeSessionId: `native-${request.sessionId}`,
      },
      effective: request.effective,
      status: "idle",
      createdAt: new Date(now).toISOString(),
      revision: 0,
    }),
    send: async (context, input) => ({
      commandId: input.commandId,
      sessionId: context.session.id,
      state: "dispatched",
      recordedAt: new Date(now).toISOString(),
      nativeTurnId: "native-turn",
    }),
    async *events() {},
    interrupt: async () => {},
    close: async () => {},
  }
  const options = {
    now: () => now,
    workspaces,
    runtime: () => ({ descriptor, adapter }),
    session: async (id: string) => sessions.get(id),
    capacity: async () => state.capacity,
  }
  return {
    directory,
    workspaces,
    sessions,
    adapter,
    options,
    admission: new AdmissionController(options),
    change(
      change:
        | "api-auth"
        | "unknown-route"
        | "different-provider"
        | "stale"
        | "future"
        | "overage"
        | "account-swap"
        | "fingerprint-swap"
        | "capacity"
        | "advisory",
    ) {
      const current = state.effective
      if (change === "api-auth")
        state.effective = {
          ...current,
          auth: { ...current.auth, mode: "api", method: "api-key" },
          billing: { ...current.billing, route: "api-payg", providerOverage: "not-applicable" },
        }
      if (change === "unknown-route")
        state.effective = { ...current, billing: { ...current.billing, route: "unknown" } }
      if (change === "different-provider")
        state.effective = { ...current, billing: { ...current.billing, providerId: "other" } }
      if (change === "stale") state.effective = { ...current, checkedAt: "2026-09-06T11:00:00Z" }
      if (change === "future") state.effective = { ...current, checkedAt: "2026-09-06T13:00:00Z" }
      if (change === "overage")
        state.effective = { ...current, billing: { ...current.billing, providerOverage: "unknown" } }
      if (change === "account-swap") state.effective = { ...current, auth: { ...current.auth, accountId: "account-b" } }
      if (change === "fingerprint-swap") state.effective = { ...current, configurationFingerprint: "config-b" }
      if (change === "capacity") state.capacity = "exhausted"
      if (change === "advisory")
        state.effective = { ...current, enforcement: { ...current.enforcement, mechanism: "advisory" } }
    },
    close: () => removeFixtureDirectory(directory),
  }
}

/** Windows may briefly retain SQLite handles after all fixture owners have closed. */
export async function removeFixtureDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 40 || typeof error !== "object" || error === null || !("code" in error) || error.code !== "EBUSY")
        throw error
      await Bun.sleep(50)
    }
  }
}
