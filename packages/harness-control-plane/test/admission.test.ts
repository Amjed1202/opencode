import { describe, expect, test } from "bun:test"
import { AdmissionController } from "../src/admission"
import type { AdapterPreflight, WorkspaceLease } from "@harness/protocol"
import { admissionFixture, effective, intent, now } from "./support"

describe("billing-safe admission", () => {
  test("accepts current native subscription evidence with matching provider", async () => {
    const fixture = await admissionFixture()
    try {
      expect((await fixture.admission.preflight({ operation: "create", intent })).status).toBe("ready")
    } finally {
      await fixture.close()
    }
  })

  for (const change of [
    "api-auth",
    "unknown-route",
    "different-provider",
    "stale",
    "future",
    "overage",
    "account-swap",
    "fingerprint-swap",
    "capacity",
  ] as const) {
    test(`blocks ${change} evidence before dispatch`, async () => {
      const fixture = await admissionFixture()
      try {
        const first = await fixture.admission.preflight({ operation: "create", intent })
        expect(first.status).toBe("ready")
        fixture.change(change)
        if (first.status !== "ready") throw new Error("missing admission")
        await expect(fixture.admission.require(first.admissionId, "session-a", "create")).rejects.toThrow()
      } finally {
        await fixture.close()
      }
    })
  }

  test("an API consent id alone is insufficient and never falls back", async () => {
    const fixture = await admissionFixture()
    try {
      const api = {
        ...intent,
        selection: {
          ...intent.selection,
          access: { mode: "api", method: "api-key", billing: "api-payg", consentId: "invented" } as const,
        },
      }
      expect((await fixture.admission.preflight({ operation: "create", intent: api })).status).toBe("blocked")
      const fallback = {
        ...intent,
        selection: {
          ...intent.selection,
          fallback: {
            automatic: true,
            consentId: "invented",
            providerIds: ["openai"],
            scope: { kind: "provider", id: "openai" },
            expiresAt: "2099-01-01T00:00:00Z",
          } as const,
        },
      }
      expect((await fixture.admission.preflight({ operation: "create", intent: fallback })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("API access requires a current consent bound to workspace, target, runtime and provider", async () => {
    const fixture = await admissionFixture()
    try {
      fixture.change("api-auth")
      const api = {
        ...intent,
        selection: {
          ...intent.selection,
          access: { mode: "api", method: "api-key", billing: "api-payg", consentId: "approved" } as const,
        },
      }
      const consent = {
        id: "approved",
        workspaceId: "workspace",
        runtimeId: "runtime",
        targetId: "local",
        providerId: "openai",
        billing: "api-payg" as const,
        expiresAt: "2026-09-06T12:01:00Z",
      }
      const admission = new AdmissionController({ ...fixture.options, consent: async () => consent })
      expect((await admission.preflight({ operation: "create", intent: api })).status).toBe("ready")
      const wrong = new AdmissionController({
        ...fixture.options,
        consent: async () => ({ ...consent, workspaceId: "other" }),
      })
      expect((await wrong.preflight({ operation: "create", intent: api })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("unknown overage is blocked unless intent explicitly acknowledges provider settings", async () => {
    const fixture = await admissionFixture()
    try {
      fixture.change("overage")
      const acknowledged = {
        ...intent,
        selection: {
          ...intent.selection,
          access: {
            mode: "subscription",
            method: "chatgpt-subscription",
            billing: "subscription",
            overagePolicy: "acknowledge-provider-settings",
          } as const,
        },
      }
      expect((await fixture.admission.preflight({ operation: "create", intent: acknowledged })).status).toBe("ready")
    } finally {
      await fixture.close()
    }
  })

  test("binds one admission to one session and operation", async () => {
    const fixture = await admissionFixture()
    try {
      const result = await fixture.admission.preflight({ operation: "create", intent })
      if (result.status !== "ready") throw new Error("missing admission")
      await fixture.admission.require(result.admissionId, "session-a", "create")
      await expect(fixture.admission.require(result.admissionId, "session-b", "create")).rejects.toThrow()
      await expect(fixture.admission.require(result.admissionId, "session-a", "turn")).rejects.toThrow()
      fixture.admission.bindCommand(result.admissionId, "command-a", "a".repeat(64))
      expect(() => fixture.admission.bindCommand(result.admissionId, "command-a", "b".repeat(64))).toThrow()
      expect(() => fixture.admission.bindCommand(result.admissionId, "command-b", "a".repeat(64))).toThrow()
    } finally {
      await fixture.close()
    }
  })

  test("does not trust caller mutation of the admitted intent or returned evidence", async () => {
    const fixture = await admissionFixture()
    try {
      const mutable = structuredClone(intent)
      const result = await fixture.admission.preflight({ operation: "create", intent: mutable })
      if (result.status !== "ready") throw new Error("missing admission")
      Object.assign(mutable.selection.model, { providerId: "attacker" })
      Object.assign(result.effective.auth, { accountId: "attacker" })
      const admitted = await fixture.admission.require(result.admissionId, "session", "create")
      expect(admitted.intent.selection.model.providerId).toBe("openai")
      expect(admitted.effective.auth.accountId).toBe("account-a")
    } finally {
      await fixture.close()
    }
  })

  test("rejects advisory enforcement when an enforced review boundary is required", async () => {
    const fixture = await admissionFixture()
    try {
      fixture.change("advisory")
      expect((await fixture.admission.preflight({ operation: "create", intent })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("invalidating a runtime revokes previously issued admissions", async () => {
    const fixture = await admissionFixture()
    try {
      const result = await fixture.admission.preflight({ operation: "create", intent })
      if (result.status !== "ready") throw new Error("missing admission")
      await fixture.admission.invalidate("runtime", "account changed")
      await expect(fixture.admission.require(result.admissionId, "session", "create")).rejects.toThrow()
    } finally {
      await fixture.close()
    }
  })
})

describe("admission security regressions", () => {
  test("rejects wire input mixing subscription authentication with API billing", async () => {
    const fixture = await admissionFixture()
    try {
      const requested = structuredClone(intent)
      Object.assign(requested.selection.access, { billing: "api-payg" })
      const snapshot = effective()
      Object.assign(snapshot.billing, { route: "api-payg" })
      fixture.adapter.preflight = async () => ({ status: "ready", effective: snapshot })
      expect((await fixture.admission.preflight({ operation: "create", intent: requested })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("unrecognized mechanisms cannot claim a mandatory enforcement boundary", async () => {
    const fixture = await admissionFixture()
    try {
      const snapshot = effective()
      Object.assign(snapshot.enforcement, { mechanism: "unrecognized" })
      fixture.adapter.preflight = async () => ({ status: "ready", effective: snapshot })
      expect((await fixture.admission.preflight({ operation: "create", intent })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("native evidence from another runtime version cannot authorize the selected executable", async () => {
    const fixture = await admissionFixture()
    try {
      Object.assign(fixture.options.runtime().descriptor, { version: "current" })
      const snapshot = effective()
      Object.assign(snapshot.auth.evidence!, { runtimeVersion: "old" })
      fixture.adapter.preflight = async () => ({ status: "ready", effective: snapshot })
      expect((await fixture.admission.preflight({ operation: "create", intent })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("explicit advisory mode remains available and cannot admit enforced review", async () => {
    const fixture = await admissionFixture()
    try {
      fixture.change("advisory")
      const advisory = { ...intent, policy: { ...intent.policy, requireEnforcedBoundary: false } }
      expect((await fixture.admission.preflight({ operation: "create", intent: advisory })).status).toBe("ready")
      const review = { ...advisory, requiredCapabilities: ["review-mode"] as const }
      expect((await fixture.admission.preflight({ operation: "create", intent: review })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test.each(["invalidate", "release", "expire", "revoke"] as const)(
    "dispatch validation catches %s during the final consent await",
    async (change) => {
      const fixture = await admissionFixture()
      try {
        fixture.change("api-auth")
        const requested = {
          ...intent,
          selection: {
            ...intent.selection,
            access: { mode: "api", method: "api-key", billing: "api-payg", consentId: "approved" } as const,
          },
        }
        const state: { checking: boolean; time: number; lease?: WorkspaceLease } = { checking: false, time: now }
        const consent = {
          id: "approved",
          workspaceId: "workspace",
          runtimeId: "runtime",
          targetId: "local",
          providerId: "openai",
          billing: "api-payg" as const,
          expiresAt: "2026-09-06T12:01:00Z",
        }
        const admission = new AdmissionController({
          ...fixture.options,
          now: () => state.time,
          consent: async () => {
            if (state.checking) {
              if (change === "invalidate") await admission.invalidate("runtime", "changed")
              if (change === "release" && state.lease)
                await fixture.workspaces.release(state.lease.id, state.lease.generation)
              if (change === "expire") state.time += 61_000
              if (change === "revoke") return undefined
            }
            return consent
          },
        })
        const result = await admission.preflight({ operation: "create", intent: requested })
        if (result.status !== "ready") throw new Error("missing admission")
        const admitted = await admission.require(result.admissionId, "session", "create")
        state.lease = admitted.lease
        state.checking = true
        await expect(admission.validate(admitted)).rejects.toThrow()
      } finally {
        await fixture.close()
      }
    },
  )

  test("invalidating while native preflight is pending prevents a new admission", async () => {
    const fixture = await admissionFixture()
    try {
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<AdapterPreflight>()
      fixture.adapter.preflight = async () => {
        started.resolve()
        return pending.promise
      }
      const result = fixture.admission.preflight({ operation: "create", intent })
      await started.promise
      await fixture.admission.invalidate("runtime", "account changed")
      pending.resolve({ status: "ready", effective: effective() })
      expect((await result).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test.each(["missing-account", "auth-source", "auth-mode", "billing-mode", "provider-method"] as const)(
    "blocks %s mismatches",
    async (change) => {
      const fixture = await admissionFixture()
      try {
        const snapshot = effective()
        const runtime = fixture.options.runtime()
        if (change === "missing-account") delete (snapshot.auth as { accountId?: string }).accountId
        if (change === "auth-source")
          Object.assign(snapshot.auth, { evidence: { source: "local-observation", observedAt: snapshot.checkedAt } })
        if (change === "auth-mode") Object.assign(runtime.descriptor, { authModes: ["api"] })
        if (change === "billing-mode") Object.assign(runtime.descriptor, { billingModes: ["api-payg"] })
        if (change === "provider-method")
          Object.assign(runtime.descriptor, { providers: [{ id: "other", name: "Other" }] })
        const requested =
          change === "provider-method"
            ? {
                ...intent,
                selection: { ...intent.selection, model: { providerId: "other", modelId: "selected-model" } },
              }
            : intent
        if (change === "provider-method") Object.assign(snapshot.billing, { providerId: "other" })
        fixture.adapter.preflight = async () => ({ status: "ready", effective: snapshot })
        expect((await fixture.admission.preflight({ operation: "create", intent: requested })).status).toBe("blocked")
      } finally {
        await fixture.close()
      }
    },
  )

  test("blocks evidence that expires during capacity verification", async () => {
    const fixture = await admissionFixture()
    try {
      const clock = { time: now }
      const admission = new AdmissionController({
        ...fixture.options,
        now: () => clock.time,
        capacity: async () => {
          clock.time += 61_000
          return "available"
        },
      })
      expect((await admission.preflight({ operation: "create", intent })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test.each(["revoke", "expire"] as const)("rechecks billing consent after native work can %s it", async (change) => {
    const fixture = await admissionFixture()
    try {
      fixture.change("api-auth")
      const requested = {
        ...intent,
        selection: {
          ...intent.selection,
          access: { mode: "api", method: "api-key", billing: "api-payg", consentId: "approved" } as const,
        },
      }
      const state = { approved: true, time: now }
      const consent = {
        id: "approved",
        workspaceId: "workspace",
        runtimeId: "runtime",
        targetId: "local",
        providerId: "openai",
        billing: "api-payg" as const,
        expiresAt: "2026-09-06T12:00:10Z",
      }
      const admission = new AdmissionController({
        ...fixture.options,
        now: () => state.time,
        consent: async () => (state.approved ? consent : undefined),
        capacity: async () => {
          if (change === "revoke") state.approved = false
          else state.time += 11_000
          return "available"
        },
      })
      expect((await admission.preflight({ operation: "create", intent: requested })).status).toBe("blocked")
    } finally {
      await fixture.close()
    }
  })

  test("adapter mutations cannot replace the caller's admitted model or policy", async () => {
    const fixture = await admissionFixture()
    try {
      fixture.adapter.preflight = async (request) => {
        Object.assign(request.intent.selection.model, { modelId: "mutated-model" })
        Object.assign(request.intent.policy, { version: "mutated-version" })
        return { status: "ready", effective: effective() }
      }
      const result = await fixture.admission.preflight({ operation: "create", intent })
      if (result.status !== "ready") throw new Error("missing admission")
      const admitted = await fixture.admission.require(result.admissionId, "session", "create")
      expect(admitted.intent.selection.model.modelId).toBe("selected-model")
      expect(admitted.intent.policy.version).toBe("1")
    } finally {
      await fixture.close()
    }
  })

  test("a runtime executable change cannot reuse account and configuration evidence", async () => {
    const fixture = await admissionFixture()
    try {
      const result = await fixture.admission.preflight({ operation: "create", intent })
      if (result.status !== "ready") throw new Error("missing admission")
      Object.assign(fixture.options.runtime().descriptor, { executable: "changed-runtime" })
      await expect(fixture.admission.require(result.admissionId, "session", "create")).rejects.toThrow()
    } finally {
      await fixture.close()
    }
  })

  test("rejects malformed command fingerprints", async () => {
    const fixture = await admissionFixture()
    try {
      const result = await fixture.admission.preflight({ operation: "create", intent })
      if (result.status !== "ready") throw new Error("missing admission")
      expect(() => fixture.admission.bindCommand(result.admissionId, "command", "invented")).toThrow()
    } finally {
      await fixture.close()
    }
  })

  test("rejects non-string command identifiers before binding the token", async () => {
    const fixture = await admissionFixture()
    try {
      const result = await fixture.admission.preflight({ operation: "create", intent })
      if (result.status !== "ready") throw new Error("missing admission")
      expect(() =>
        fixture.admission.bindCommand(result.admissionId, { id: "command" } as never, "a".repeat(64)),
      ).toThrow()
    } finally {
      await fixture.close()
    }
  })

  test("caps retained admission tokens and makes expired capacity available again", async () => {
    const fixture = await admissionFixture()
    try {
      const clock = { time: now }
      const admission = new AdmissionController({
        ...fixture.options,
        now: () => clock.time,
        lifetimeMilliseconds: 1000,
        maxAdmissions: 1,
      })
      expect((await admission.preflight({ operation: "create", intent })).status).toBe("ready")
      expect((await admission.preflight({ operation: "create", intent })).status).toBe("blocked")
      clock.time += 1001
      fixture.adapter.preflight = async () => {
        const snapshot = effective()
        const timestamp = new Date(clock.time).toISOString()
        Object.assign(snapshot, { checkedAt: timestamp })
        Object.assign(snapshot.auth, { evidence: { source: "native-status", observedAt: timestamp } })
        Object.assign(snapshot.billing, { evidence: { source: "native-status", observedAt: timestamp } })
        Object.assign(snapshot.capabilities, {
          chat: {
            status: "supported",
            verification: "verified",
            evidence: { source: "native-status", observedAt: timestamp },
            limitations: [],
          },
        })
        return { status: "ready", effective: snapshot }
      }
      expect((await admission.preflight({ operation: "create", intent })).status).toBe("ready")
    } finally {
      await fixture.close()
    }
  })
})
