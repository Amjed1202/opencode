import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentAdapter } from "@harness/adapters"
import type { AgentEventDraft, HumanInputRequest, PermissionRequest } from "@harness/protocol"
import { AdmissionController } from "../src/admission"
import { EncryptedArtifactStore } from "../src/artifacts"
import { SQLiteJournal } from "../src/journal"
import { LocalRuntimeManager } from "../src/runtime-manager"
import { admissionFixture, intent, now, removeFixtureDirectory } from "./support"

async function fixture(kind: "input" | "permission") {
  const base = await admissionFixture()
  let clock = now
  const directory = await mkdtemp(join(tmpdir(), "harness-review-race-"))
  const artifacts = await EncryptedArtifactStore.open({ rootPath: directory, key: randomBytes(32), now: () => clock })
  const journal = new SQLiteJournal(join(base.directory, "journal.sqlite"))
  const admission = new AdmissionController({ ...base.options, session: (id) => journal.get(id) })
  const manager = new LocalRuntimeManager({
    admission,
    journal,
    runtime: base.options.runtime,
    workspaces: base.workspaces,
    actorId: "host:reviewer",
    now: () => clock,
    artifacts,
  })
  const event = Promise.withResolvers<AgentEventDraft>()
  const closed = Promise.withResolvers<void>()
  base.adapter.events = async function* () {
    yield await event.promise
    await closed.promise
  }
  base.adapter.close = async () => closed.resolve()
  const sessionIntent = {
    ...intent,
    policy: { ...intent.policy, approval: "ask" as const, filesystem: "workspace-write" as const },
  }
  const create = await admission.preflight({ operation: "create", intent: sessionIntent })
  if (create.status !== "ready") throw new Error("Create admission failed")
  const session = await manager.createSession(create.admissionId, "create")
  const turn = await admission.preflight({ operation: "turn", sessionId: session.id, intent: sessionIntent })
  if (turn.status !== "ready") throw new Error("Turn admission failed")
  await manager.send(session.id, turn.admissionId, {
    commandId: "turn",
    messageId: "message",
    delivery: "when-idle",
    parts: [{ type: "text", text: "Hello" }],
  })
  const lease = await base.workspaces.lease("workspace", session.id, "write")
  const binding = {
    requestId: "review-request",
    sessionId: session.id,
    runtimeId: "runtime",
    targetId: "local",
    workspaceId: "workspace",
    nativeSessionId: session.binding.nativeSessionId,
    nativeTurnId: "native-turn",
    nativeRequestId: "number:7",
    policyId: "policy",
    policyVersion: "1",
    leaseGeneration: lease.generation,
    operationSha256: "a".repeat(64),
  }
  const input: HumanInputRequest = {
    ...binding,
    expiresAt: new Date(now + 120_000).toISOString(),
    prompt: "Choose one option for each question.",
    schemaId: "harness.choice-input.v1",
    questions: [{ id: "q1", optionIds: ["o1", "o2"] }],
  }
  const permission: PermissionRequest = {
    ...binding,
    expiresAt: input.expiresAt,
    action: "file-change",
    resources: [join(base.directory, "example.txt")],
    details: {},
    choices: [
      { id: "allow", action: "allow", scope: "once", label: "Allow once" },
      { id: "deny", action: "deny", scope: "once", label: "Deny" },
    ],
  }
  Object.assign(base.adapter, {
    reviewInput: async () => ({
      kind: "choice-input",
      requestId: binding.requestId,
      operationSha256: binding.operationSha256,
      questions: [
        {
          id: "q1",
          header: "Plan",
          question: "Private question",
          options: [
            { id: "o1", label: "First", description: "" },
            { id: "o2", label: "Second", description: "" },
          ],
        },
      ],
    }),
    reviewPermission: async () => ({
      kind: "patch",
      requestId: binding.requestId,
      operationSha256: binding.operationSha256,
      changes: [{ path: permission.resources[0]!, kind: "add", diff: "+private patch" }],
    }),
  })
  const context = {
    scope: {
      sessionId: session.id,
      targetId: "local",
      runtimeId: "runtime",
      workspaceId: "workspace",
      turnId: "native-turn",
      commandId: "turn",
    },
    origin: {
      streamId: session.binding.nativeSessionId,
      epoch: "peer",
      eventId: "request",
      identityStrategy: "native" as const,
    },
    observedAt: new Date(now).toISOString(),
  }
  event.resolve(
    kind === "input"
      ? { ...context, type: "input.requested", data: input }
      : { ...context, type: "permission.requested", data: permission },
  )
  const deadline = Date.now() + 2000
  while ((await journal.get(session.id))?.status !== (kind === "input" ? "awaiting-input" : "awaiting-permission")) {
    if (Date.now() > deadline) throw new Error("Interaction was not admitted")
    await Bun.sleep(2)
  }
  return {
    ...base,
    journal,
    artifacts,
    manager,
    admission,
    session,
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
    review: () =>
      kind === "input" ? manager.reviewInput(binding.requestId) : manager.reviewPermission(binding.requestId),
    resolve: (reviewToken: string) =>
      kind === "input"
        ? manager.resolveInput({
            ...binding,
            action: "answer",
            selections: [{ questionId: "q1", optionId: "o1" }],
            reviewToken,
          })
        : manager.resolvePermission({ ...binding, choiceId: "allow", reviewToken }),
    record: () => (kind === "input" ? journal.input(binding.requestId) : journal.permission(binding.requestId)),
    async close() {
      closed.resolve()
      await manager.dispose()
      journal.close()
      artifacts.close()
      await base.close()
      await removeFixtureDirectory(directory)
    },
  }
}

for (const kind of ["input", "permission"] as const) {
  test(`${kind} review proof must remain live at a delayed native write`, async () => {
    const state = await fixture(kind)
    try {
      let writes = 0
      const reply = async (context: Parameters<NonNullable<AgentAdapter["resolveInput"]>>[0]) => {
        state.advance(60_001)
        context.authorizeReply?.()
        writes++
      }
      Object.assign(state.adapter, kind === "input" ? { resolveInput: reply } : { resolvePermission: reply })
      const review = await state.review()
      await expect(state.resolve(review.reviewToken)).rejects.toThrow("uncertain")
      expect(writes).toBe(0)
      expect((await state.record())?.state).toBe("uncertain")
      await expect(state.resolve(review.reviewToken)).rejects.toThrow("replay")
      expect(writes).toBe(0)
    } finally {
      await state.close()
    }
  })
}

for (const boundary of ["read", "audit"] as const) {
  test(`authority revocation during protected ${boundary} prevents review delivery`, async () => {
    const state = await fixture("input")
    try {
      if (boundary === "read") {
        const read = state.artifacts.read.bind(state.artifacts)
        state.artifacts.read = async (request) => {
          const result = await read(request)
          await state.admission.invalidate("runtime", "Account changed during protected read")
          return result
        }
      } else {
        const append = state.journal.append.bind(state.journal)
        state.journal.append = async (...args) => {
          const result = await append(...args)
          if (args[1].some((event) => event.type === "interaction.reviewed"))
            await state.admission.invalidate("runtime", "Account changed during review audit")
          return result
        }
      }
      await expect(state.review()).rejects.toThrow()
      expect((await state.record())?.state).toBe("pending")
      await expect(state.resolve("invented-token")).rejects.toThrow("review")
    } finally {
      await state.close()
    }
  })
}
