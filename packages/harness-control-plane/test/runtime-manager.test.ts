import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentEventDraft,
  AgentInput,
  AgentSession,
  NativeSessionInspection,
  PermissionDecision,
  PermissionRequest,
  SessionIntent,
  HumanInputRequest,
  HumanInputResponse,
} from "@harness/protocol"
import { AdmissionController } from "../src/admission"
import { hashConfiguration } from "../src/environment"
import { LocalRuntimeManager } from "../src/runtime-manager"
import { SQLiteJournal } from "../src/journal"
import { EncryptedArtifactStore } from "../src/artifacts"
import { admissionFixture, intent, now, removeFixtureDirectory } from "./support"

async function fixture(sessionIntent: SessionIntent = intent) {
  const base = await admissionFixture()
  let clock = now
  const artifactDirectory = await mkdtemp(join(tmpdir(), "harness-review-"))
  const artifacts = await EncryptedArtifactStore.open({
    rootPath: artifactDirectory,
    key: randomBytes(32),
    now: () => clock,
  })
  const journal = new SQLiteJournal(join(base.directory, "journal.sqlite"))
  const streams = new Map<string, EventPeer>()
  const nativeCreate = base.adapter.createSession
  Object.assign(base.adapter, {
    createSession: async (...args: Parameters<typeof nativeCreate>) => {
      const session = await nativeCreate(...args)
      streams.set(session.id, new EventPeer())
      return session
    },
    resume: async (_request: unknown, session: AgentSession) => {
      streams.set(session.id, new EventPeer())
      return { ...session, status: "idle" as const }
    },
    events: (session: AgentSession) => streams.get(session.id)!,
    reviewPermission: async (_context: unknown, requestId: string) => ({
      kind: "patch",
      requestId,
      operationSha256: "a".repeat(64),
      changes: [{ path: join(base.directory, "example.txt"), kind: "add", diff: "+private patch content" }],
    }),
    close: async (session: AgentSession) => {
      streams.get(session.id)?.finish()
    },
    send: async (context: { session: AgentSession }, input: AgentInput) => ({
      commandId: input.commandId,
      sessionId: context.session.id,
      state: "dispatched" as const,
      recordedAt: new Date().toISOString(),
      nativeTurnId: `native-${input.commandId}`,
    }),
  })
  const admission = new AdmissionController({ ...base.options, session: (id) => journal.get(id) })
  const manager = new LocalRuntimeManager({
    admission,
    journal,
    runtime: base.options.runtime,
    workspaces: base.workspaces,
    actorId: "host:user-a",
    now: () => clock,
    artifacts,
  })
  const result = await admission.preflight({ operation: "create", intent: sessionIntent })
  if (result.status !== "ready") throw new Error("missing admission")
  return {
    ...base,
    admission,
    streams,
    journal,
    manager,
    artifacts,
    advance(milliseconds: number) {
      clock += milliseconds
    },
    admissionId: result.admissionId,
    async close() {
      await manager.dispose()
      journal.close()
      artifacts.close()
      await base.close()
      await removeFixtureDirectory(artifactDirectory)
    },
  }
}

test("an exact create retry returns the saved native session without a second creation", async () => {
  const state = await fixture()
  try {
    const first = await state.manager.createSession(state.admissionId, "create-a")
    const second = await state.manager.createSession(state.admissionId, "create-a")
    expect(second.binding.nativeSessionId).toBe(first.binding.nativeSessionId)
    expect((await state.journal.list("workspace")).length).toBe(1)
    expect(await state.journal.recoverPending()).toEqual([])
  } finally {
    await state.close()
  }
})

test("a lost native create response is durably uncertain and never automatically retried", async () => {
  const state = await fixture()
  try {
    const original = state.adapter.createSession
    Object.assign(state.adapter, {
      createSession: async () => {
        throw new Error("native reply lost with secret detail")
      },
    })
    await expect(state.manager.createSession(state.admissionId, "create-a")).rejects.toThrow("uncertain")
    expect((await state.journal.command("create-a"))?.receipt.state).toBe("uncertain")
    Object.assign(state.adapter, { createSession: original })
    await expect(state.manager.createSession(state.admissionId, "create-a")).rejects.toThrow("uncertain")
    expect(await state.journal.list("workspace")).toEqual([])
  } finally {
    await state.close()
  }
})

test("create idempotency keys reject a different admission", async () => {
  const state = await fixture()
  try {
    await state.manager.createSession(state.admissionId, "create-a")
    const result = await state.admission.preflight({ operation: "create", intent })
    if (result.status !== "ready") throw new Error("missing admission")
    await expect(state.manager.createSession(result.admissionId, "create-a")).rejects.toThrow("conflict")
  } finally {
    await state.close()
  }
})

test("a turn's exact retry returns its journal receipt; changed text cannot reuse its command id", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create-a")
    const result = await state.admission.preflight({ operation: "turn", sessionId: session.id, intent })
    if (result.status !== "ready") throw new Error("missing admission")
    const input = {
      commandId: "turn-a",
      messageId: "message-a",
      parts: [{ type: "text", text: "hello" }] as const,
      delivery: "when-idle" as const,
    }
    expect((await state.manager.send(session.id, result.admissionId, input)).state).toBe("dispatched")
    expect((await state.manager.send(session.id, result.admissionId, input)).nativeTurnId).toBe("native-turn-a")
    await expect(
      state.manager.send(session.id, result.admissionId, { ...input, parts: [{ type: "text", text: "different" }] }),
    ).rejects.toThrow("conflict")
  } finally {
    await state.close()
  }
})

class EventPeer implements AsyncIterable<AgentEventDraft> {
  private readonly queue: AgentEventDraft[] = []
  private readonly waiting: {
    resolve: (result: IteratorResult<AgentEventDraft>) => void
    reject: (error: Error) => void
  }[] = []
  private ended = false
  private failure?: Error
  readonly returned = Promise.withResolvers<void>()

  push(event: AgentEventDraft) {
    if (this.ended) throw new Error("Peer stream closed")
    const waiting = this.waiting.shift()
    if (waiting) return waiting.resolve({ done: false, value: event })
    this.queue.push(event)
  }

  finish() {
    this.ended = true
    this.waiting.splice(0).forEach((waiting) => waiting.resolve({ done: true, value: undefined }))
  }

  fail() {
    this.failure = new Error("Peer stream failed")
    this.ended = true
    this.waiting.splice(0).forEach((waiting) => waiting.reject(this.failure!))
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEventDraft> {
    return {
      next: async () => {
        if (this.failure) throw this.failure
        const event = this.queue.shift()
        if (event) return { done: false, value: event }
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }))
      },
      return: async () => {
        this.finish()
        this.returned.resolve()
        return { done: true, value: undefined }
      },
    }
  }
}

async function waitUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Expected durable state was not reached")
    await Bun.sleep(2)
  }
}

async function send(state: Awaited<ReturnType<typeof fixture>>, session: AgentSession, commandId: string) {
  const admission = await state.admission.preflight({
    operation: "turn",
    sessionId: session.id,
    intent: session.intent,
  })
  if (admission.status !== "ready") throw new Error("Missing turn admission")
  return state.manager.send(session.id, admission.admissionId, {
    commandId,
    messageId: `message-${commandId}`,
    delivery: "when-idle",
    parts: [{ type: "text", text: "Hello" }],
  })
}

function completion(session: AgentSession, commandId: string, eventId = commandId): AgentEventDraft {
  return {
    type: "agent.completed",
    data: { nativeTurnId: `native-${commandId}`, outcome: "succeeded" },
    scope: { sessionId: session.id, targetId: "local", runtimeId: "runtime", workspaceId: "workspace", commandId },
    origin: { streamId: session.binding.nativeSessionId, epoch: "peer-epoch", eventId, identityStrategy: "native" },
    observedAt: "2026-09-06T12:00:00.000Z",
  }
}

test("clean native stream closure makes an active turn and its session uncertain", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await send(state, session, "turn")
    state.streams.get(session.id)!.finish()
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "uncertain")
    expect((await state.journal.command("turn"))!.receipt.state).toBe("uncertain")
  } finally {
    await state.close()
  }
})

test("invalid native completion cannot enter or settle the durable journal", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await send(state, session, "turn")
    const event = completion(session, "foreign-command")
    state.streams.get(session.id)!.push(event)
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "uncertain")
    expect(await state.journal.cursor(session.id)).toBeUndefined()
    expect((await state.journal.command("turn"))!.receipt.state).toBe("uncertain")
  } finally {
    await state.close()
  }
})

test("a late completion for a previous command cannot idle the current native turn", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await send(state, session, "first")
    state.streams.get(session.id)!.push(completion(session, "first"))
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "idle")
    await send(state, session, "second")
    state.streams.get(session.id)!.push(completion(session, "first", "late-first"))
    await waitUntil(async () => (await state.journal.cursor(session.id))?.sequence === 2)
    expect((await state.journal.get(session.id))!.status).toBe("running")
    state.streams.get(session.id)!.push(completion(session, "second"))
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "idle")
    expect(await state.journal.recoverPending()).toEqual([])
  } finally {
    await state.close()
  }
})

test("close preserves uncertainty and resume installs a fresh event pump", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await state.manager.closeSession(session.id)
    const admission = await state.admission.preflight({ operation: "resume", sessionId: session.id, intent })
    if (admission.status !== "ready") throw new Error("Missing resume admission")
    const resumed = await state.manager.resumeSession(session.id, admission.admissionId, "resume")
    await send(state, resumed, "turn")
    state.streams.get(session.id)!.push(completion(resumed, "turn"))
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "idle")
    const current = (await state.journal.get(session.id))!
    await state.journal.save({ ...current, status: "uncertain", revision: current.revision + 1 }, current.revision)
    await state.manager.closeSession(session.id)
    expect((await state.journal.get(session.id))!.status).toBe("uncertain")
  } finally {
    await state.close()
  }
})

test("a stream-construction failure marks the durable session uncertain", async () => {
  const state = await fixture()
  try {
    Object.assign(state.adapter, {
      events: () => {
        throw new Error("Disconnected event peer")
      },
    })
    const session = await state.manager.createSession(state.admissionId, "create")
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "uncertain")
  } finally {
    await state.close()
  }
})

test("a dispatched but unsettled resume receipt cannot masquerade as a completed operation", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await state.journal.reserve({
      id: "resume",
      sessionId: session.id,
      admissionId: "resume-admission",
      requestSha256: hashConfiguration({
        operation: "resume",
        sessionId: session.id,
        admissionId: "resume-admission",
        commandId: "resume",
      }),
      receipt: { commandId: "resume", sessionId: session.id, state: "admitted", recordedAt: new Date().toISOString() },
    })
    await state.journal.markDispatched("resume")
    await expect(state.manager.resumeSession(session.id, "resume-admission", "resume")).rejects.toThrow("uncertain")
  } finally {
    await state.close()
  }
})

test("dispose waits for a native create already in flight and closes the resulting attachment", async () => {
  const state = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    const create = state.adapter.createSession
    Object.assign(state.adapter, {
      createSession: async (...args: Parameters<typeof create>) => {
        started.resolve()
        await release.promise
        return create(...args)
      },
    })
    const creating = state.manager.createSession(state.admissionId, "create")
    await started.promise
    await expect(state.manager.recover()).rejects.toThrow("exclusive")
    const disposing = state.manager.dispose()
    await expect(state.manager.createSession(state.admissionId, "other")).rejects.toThrow("closed")
    release.resolve()
    const session = await creating
    await disposing
    expect((await state.journal.get(session.id))!.status).toBe("closed")
    const lease = await state.workspaces.lease("workspace", "new-owner", "write")
    expect(lease.ownerId).toBe("new-owner")
    await state.workspaces.release(lease.id, lease.generation)
  } finally {
    release.resolve()
    await state.close()
  }
})

test("live event consumers finish when their attachment closes", async () => {
  const state = await fixture()
  const abort = new AbortController()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    const events = state.manager.events(session.id, undefined, abort.signal)[Symbol.asyncIterator]()
    const pending = events.next()
    await state.manager.closeSession(session.id)
    const finished = await Promise.race([pending, Bun.sleep(100).then(() => "still waiting")])
    expect(finished).toEqual({ done: true, value: undefined })
  } finally {
    abort.abort()
    await state.close()
  }
})

test("a paused event consumer receives a final persisted error after the native pump ends", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await send(state, session, "turn")
    const peer = state.streams.get(session.id)!
    peer.push({
      ...completion(session, "turn", "started"),
      type: "agent.started",
      data: { nativeTurnId: "native-turn" },
    })
    const events = state.manager.events(session.id)[Symbol.asyncIterator]()
    const started = await events.next()
    expect(started.value).toMatchObject({ kind: "event", event: { type: "agent.started", sequence: 1 } })

    // Leave the consumer suspended at its first yield until the final event is durable
    // and the native pump has been removed. The journal replay is a finite snapshot.
    peer.push({
      ...completion(session, "turn", "error"),
      type: "agent.error",
      data: {
        nativeTurnId: "native-turn",
        error: {
          code: "capacity-limited",
          message: "Native usage limit reached",
          nativeCode: "rate_limit",
          retryable: false,
        },
      },
    })
    peer.finish()
    await peer.returned.promise
    expect((await state.journal.cursor(session.id))?.sequence).toBe(2)
    expect((await state.journal.get(session.id))?.status).toBe("uncertain")

    const error = await events.next()
    expect(error.value).toMatchObject({
      kind: "event",
      event: { type: "agent.error", sequence: 2, data: { error: { nativeCode: "rate_limit" } } },
    })
    expect(await events.next()).toEqual({ done: true, value: undefined })
  } finally {
    await state.close()
  }
})

test("a native session reporting changed intent or effective billing is not persisted as admitted", async () => {
  const state = await fixture()
  try {
    const create = state.adapter.createSession
    Object.assign(state.adapter, {
      createSession: async (...args: Parameters<typeof create>) => {
        const session = await create(...args)
        return {
          ...session,
          effective: { ...session.effective, billing: { ...session.effective.billing, route: "api-payg" } },
        }
      },
    })
    await expect(state.manager.createSession(state.admissionId, "create")).rejects.toThrow("uncertain")
    expect(await state.journal.list("workspace")).toEqual([])
  } finally {
    await state.close()
  }
})

test("mutating a returned session cannot redirect the native event pump", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    const authoritative = structuredClone(session)
    Object.assign(session.binding, { targetId: "foreign" })
    await send(state, authoritative, "turn")
    state.streams.get(authoritative.id)!.push(completion(authoritative, "turn"))
    await waitUntil(async () => (await state.journal.get(authoritative.id))?.status !== "running")
    expect((await state.journal.get(authoritative.id))!.status).toBe("idle")
  } finally {
    await state.close()
  }
})

test("adapter mutation cannot change the admission used to validate its returned session", async () => {
  const state = await fixture()
  try {
    const create = state.adapter.createSession
    Object.assign(state.adapter, {
      createSession: async (...args: Parameters<typeof create>) => {
        Object.assign(args[0].effective.billing, { route: "api-payg" })
        return create(...args)
      },
    })
    await expect(state.manager.createSession(state.admissionId, "create")).rejects.toThrow("uncertain")
    expect(await state.journal.list("workspace")).toEqual([])
  } finally {
    await state.close()
  }
})

test("admission revocation after the durable dispatch marker prevents the native create", async () => {
  const state = await fixture()
  try {
    const mark = state.journal.markDispatched.bind(state.journal)
    Object.assign(state.journal, {
      markDispatched: async (...args: Parameters<typeof mark>) => {
        const result = await mark(...args)
        await state.admission.invalidate("runtime", "Revoked while persisting command")
        return result
      },
    })
    await expect(state.manager.createSession(state.admissionId, "create")).rejects.toThrow("uncertain")
    expect(state.streams.size).toBe(0)
    expect((await state.journal.command("create"))!.receipt.state).toBe("uncertain")
  } finally {
    await state.close()
  }
})

test("native completion reconciles a lost turn acknowledgement without sending again", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    Object.assign(state.adapter, {
      send: async (_context: unknown, input: AgentInput) => {
        state.streams.get(session.id)!.push(completion(session, input.commandId))
        return {
          commandId: input.commandId,
          sessionId: session.id,
          state: "uncertain",
          recordedAt: new Date().toISOString(),
        }
      },
    })
    expect((await send(state, session, "turn")).state).toBe("uncertain")
    await waitUntil(async () => (await state.journal.get(session.id))?.status === "idle")
    expect((await state.journal.command("turn"))!.receipt.nativeTurnId).toBe("native-turn")
    expect(await state.journal.isComplete("turn")).toBe(true)
  } finally {
    await state.close()
  }
})

test("restart recovery catches a running session projection even after its completion receipt settled", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await state.manager.dispose()
    const current = (await state.journal.get(session.id))!
    await state.journal.save({ ...current, status: "running", revision: current.revision + 1 }, current.revision)
    const recovered = new LocalRuntimeManager({
      admission: state.admission,
      journal: state.journal,
      runtime: state.options.runtime,
      workspaces: state.workspaces,
    })
    try {
      expect(await recovered.recover()).toEqual([])
      expect((await state.journal.get(session.id))!.status).toBe("uncertain")
    } finally {
      await recovered.dispose()
    }
  } finally {
    await state.close()
  }
})

test("account changes between preflight and create produce no durable dispatch", async () => {
  const state = await fixture()
  try {
    state.change("account-swap")
    await expect(state.manager.createSession(state.admissionId, "create-a")).rejects.toThrow()
    expect(await state.journal.command("create-a")).toBeUndefined()
    expect(await state.journal.list("workspace")).toEqual([])
  } finally {
    await state.close()
  }
})

test("adapter close mutation cannot clear a running turn's uncertainty or release its lease", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    await send(state, session, "turn")
    Object.assign(state.adapter, {
      close: async (snapshot: AgentSession) => {
        Object.assign(snapshot, { status: "idle" })
        state.streams.get(snapshot.id)?.finish()
      },
    })
    await state.manager.closeSession(session.id)
    expect((await state.journal.get(session.id))!.status).toBe("uncertain")
    expect((await state.journal.command("turn"))!.receipt.state).toBe("uncertain")
    await expect(state.workspaces.lease("workspace", "other-owner", "write")).rejects.toThrow("conflict")
  } finally {
    await state.close()
  }
})

test("adapter close mutation cannot change the native thread selected for resume", async () => {
  const state = await fixture()
  try {
    const session = await state.manager.createSession(state.admissionId, "create")
    const admission = await state.admission.preflight({ operation: "resume", sessionId: session.id, intent })
    if (admission.status !== "ready") throw new Error("Missing resume admission")
    Object.assign(state.adapter, {
      close: async (snapshot: AgentSession) => {
        state.streams.get(snapshot.id)?.finish()
        Object.assign(snapshot.binding, { nativeSessionId: "different-native-thread" })
      },
    })
    const resumed = await state.manager.resumeSession(session.id, admission.admissionId, "resume")
    expect(resumed.binding.nativeSessionId).toBe(session.binding.nativeSessionId)
    expect((await state.journal.get(session.id))!.binding.nativeSessionId).toBe(session.binding.nativeSessionId)
  } finally {
    await state.close()
  }
})

test.each(["EOF", "error"] as const)(
  "an old pump's queued %s cannot make a resumed attachment uncertain",
  async (termination) => {
    const state = await fixture()
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const session = await state.manager.createSession(state.admissionId, "create")
      const oldPeer = state.streams.get(session.id)!
      const admission = await state.admission.preflight({ operation: "resume", sessionId: session.id, intent })
      if (admission.status !== "ready") throw new Error("Missing resume admission")
      const require = state.admission.require.bind(state.admission)
      Object.assign(state.admission, {
        require: async (...args: Parameters<typeof require>) => {
          const request = await require(...args)
          held.resolve()
          await release.promise
          return request
        },
      })
      const resuming = state.manager.resumeSession(session.id, admission.admissionId, "resume")
      await held.promise
      if (termination === "EOF") oldPeer.finish()
      else oldPeer.fail()
      // Flush the terminated stream continuation while resume still owns the session lock.
      await Bun.sleep(0)
      release.resolve()
      const resumed = await resuming
      await oldPeer.returned.promise
      expect(resumed.status).toBe("idle")
      expect((await state.journal.get(session.id))!.status).toBe("idle")
      expect(await state.journal.isComplete("resume")).toBe(true)
      await send(state, resumed, "turn")
      state.streams.get(session.id)!.push(completion(resumed, "turn"))
      await waitUntil(async () => (await state.journal.get(session.id))?.status === "idle")
    } finally {
      release.resolve()
      await state.close()
    }
  },
)

const asking: SessionIntent = {
  ...intent,
  policy: { ...intent.policy, approval: "ask", filesystem: "workspace-write" },
}

async function permissionFixture() {
  const state = await fixture(asking)
  const session = await state.manager.createSession(state.admissionId, "create")
  await send(state, session, "turn")
  const lease = await state.workspaces.lease("workspace", session.id, "write")
  const request: PermissionRequest = {
    requestId: "permission-a",
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
    action: "file-change",
    resources: [join(state.directory, "example.txt")],
    details: { patch: "example" },
    choices: [
      { id: "allow-once", action: "allow", scope: "once", label: "Allow once" },
      { id: "deny", action: "deny", scope: "once", label: "Deny" },
    ],
    expiresAt: new Date(now + 60_000).toISOString(),
  }
  const draft: AgentEventDraft = {
    type: "permission.requested",
    data: request,
    scope: {
      sessionId: session.id,
      workspaceId: "workspace",
      runtimeId: "runtime",
      targetId: "local",
      commandId: "turn",
      turnId: "native-turn",
    },
    origin: {
      streamId: session.binding.nativeSessionId,
      epoch: "peer",
      eventId: "permission-a",
      identityStrategy: "native",
    },
    observedAt: new Date(now).toISOString(),
  }
  const decision: PermissionDecision = { ...request, choiceId: "allow-once" }
  return { ...state, session, request, draft, decision, lease }
}

async function publishPermission(state: Awaited<ReturnType<typeof permissionFixture>>, review = true) {
  state.streams.get(state.session.id)!.push(state.draft)
  await waitUntil(async () => (await state.journal.permission(state.request.requestId)) !== undefined)
  if (review)
    state.decision = {
      ...state.decision,
      reviewToken: (await state.manager.reviewPermission(state.request.requestId)).reviewToken,
    }
}

test("permission is durable before delivery and a trusted claim precedes the native reply", async () => {
  const state = await permissionFixture()
  try {
    let calls = 0
    Object.assign(state.adapter, {
      resolvePermission: async () => {
        calls++
        const record = await state.journal.permission(state.request.requestId)
        expect(record?.state).toBe("claimed")
        expect(record?.intent?.actorId).toBe("host:user-a")
        expect(record?.resolution).toBeUndefined()
      },
    })
    await publishPermission(state)
    expect((await state.journal.get(state.session.id))?.status).toBe("awaiting-permission")
    await state.manager.resolvePermission({ ...state.decision, actorId: "renderer-forged" } as PermissionDecision)
    await state.manager.resolvePermission(state.decision)
    expect(calls).toBe(1)
    expect((await state.journal.permission(state.request.requestId))?.resolution?.outcome).toBe("allowed")
    expect((await state.journal.get(state.session.id))?.status).toBe("running")
  } finally {
    await state.close()
  }
})

for (const change of ["account-swap", "fingerprint-swap", "api-auth", "overage", "advisory", "stale"] as const) {
  test(`permission grant fails after ${change} and cannot be retried`, async () => {
    const state = await permissionFixture()
    try {
      let calls = 0
      Object.assign(state.adapter, {
        resolvePermission: async () => {
          calls++
        },
      })
      await publishPermission(state)
      state.change(change)
      await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow()
      await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow()
      expect(calls).toBe(0)
      expect((await state.journal.permission(state.request.requestId))?.state).toBe("uncertain")
    } finally {
      await state.close()
    }
  })
}

test("revoked admission or released lease cannot authorize a pending permission", async () => {
  for (const failure of ["revoke", "release"]) {
    const state = await permissionFixture()
    try {
      let calls = 0
      Object.assign(state.adapter, {
        resolvePermission: async () => {
          calls++
        },
      })
      await publishPermission(state)
      if (failure === "revoke") await state.admission.invalidate("runtime", "test")
      else await state.workspaces.release(state.lease.id, state.lease.generation)
      await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow()
      expect(calls).toBe(0)
    } finally {
      await state.close()
    }
  }
})

test("lost permission reply stays uncertain across an exact retry", async () => {
  const state = await permissionFixture()
  try {
    let calls = 0
    Object.assign(state.adapter, {
      resolvePermission: async () => {
        calls++
        throw new Error("private transport failure")
      },
    })
    await publishPermission(state)
    await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow("uncertain")
    await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow("uncertain")
    expect(calls).toBe(1)
    expect((await state.journal.permission(state.request.requestId))?.state).toBe("uncertain")
  } finally {
    await state.close()
  }
})

test("native autonomous denial has a host-assigned actor and can never grant permission", async () => {
  const state = await permissionFixture()
  try {
    await publishPermission(state)
    state.streams.get(state.session.id)!.push({
      ...state.draft,
      type: "permission.resolved",
      data: {
        ...state.request,
        outcome: "denied",
        actorId: "untrusted-native-actor",
        decidedAt: new Date(now).toISOString(),
      },
      origin: { ...state.draft.origin, eventId: "denial" },
    })
    await waitUntil(async () => (await state.journal.permission(state.request.requestId))?.state === "resolved")
    expect((await state.journal.permission(state.request.requestId))?.resolution?.actorId).toBe("host:native-policy")
    await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow()
  } finally {
    await state.close()
  }
})

test("permission with a foreign turn never enters the host ledger", async () => {
  const state = await permissionFixture()
  try {
    state.streams
      .get(state.session.id)!
      .push({ ...state.draft, type: "permission.requested", data: { ...state.request, nativeTurnId: "foreign" } })
    await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "uncertain")
    expect(await state.journal.permission(state.request.requestId)).toBeUndefined()
  } finally {
    await state.close()
  }
})

function inspection(session: AgentSession): NativeSessionInspection {
  return {
    sessionId: session.id,
    binding: session.binding,
    observedAt: new Date(now).toISOString(),
    nativeState: "idle",
    completeness: "complete",
    turns: [{ nativeTurnId: "native-turn", status: "succeeded" }],
  }
}

async function recoveryFixture() {
  const state = await fixture()
  const session = await state.manager.createSession(state.admissionId, "create")
  await send(state, session, "turn")
  state.streams.get(session.id)!.finish()
  await waitUntil(async () => (await state.journal.get(session.id))?.status === "uncertain")
  return { ...state, session }
}

test("read-only inspection changes no commands; reconciliation settles only the exact known completed native turn", async () => {
  const state = await recoveryFixture()
  try {
    let calls = 0
    Object.assign(state.adapter, {
      inspect: async () => {
        calls++
        return inspection(state.session)
      },
    })
    expect((await state.manager.inspectSession(state.session.id)).nativeState).toBe("idle")
    expect((await state.journal.command("turn"))?.receipt.state).toBe("uncertain")
    expect((await state.manager.reconcileSession(state.session.id)).status).toBe("idle")
    expect(await state.journal.isComplete("turn")).toBe(true)
    expect(calls).toBe(2)
    await expect(send(state, state.session, "next")).rejects.toThrow("not attached")
  } finally {
    await state.close()
  }
})

for (const mode of ["partial", "running", "missing", "unknown", "lost-ack"] as const) {
  test(`recovery stays uncertain with ${mode} native evidence`, async () => {
    const state = await recoveryFixture()
    try {
      const value = inspection(state.session)
      if (mode === "lost-ack") {
        const record = (await state.journal.command("turn"))!
        await state.journal.reserve({
          ...record,
          id: "lost",
          receipt: {
            commandId: "lost",
            sessionId: state.session.id,
            state: "admitted",
            recordedAt: new Date(now).toISOString(),
          },
        })
        await state.journal.markDispatched("lost")
        await state.journal.recoverPending()
      }
      Object.assign(state.adapter, {
        inspect: async () => ({
          ...value,
          ...(mode === "partial"
            ? { completeness: "partial", nativeState: "unknown" }
            : mode === "running"
              ? { nativeState: "running" }
              : mode === "missing"
                ? { turns: [] }
                : mode === "unknown"
                  ? { turns: [{ nativeTurnId: "native-turn", status: "unknown" }] }
                  : {}),
        }),
      })
      expect((await state.manager.reconcileSession(state.session.id)).status).toBe("uncertain")
    } finally {
      await state.close()
    }
  })
}

for (const mode of ["binding", "stale", "duplicate"] as const) {
  test(`invalid ${mode} inspection cannot reconcile a session`, async () => {
    const state = await recoveryFixture()
    try {
      const value = inspection(state.session)
      Object.assign(state.adapter, {
        inspect: async () => ({
          ...value,
          ...(mode === "binding"
            ? { binding: { ...value.binding, nativeSessionId: "other" } }
            : mode === "stale"
              ? { observedAt: new Date(now - 120_000).toISOString() }
              : { turns: [...value.turns, ...value.turns] }),
        }),
      })
      await expect(state.manager.reconcileSession(state.session.id)).rejects.toThrow()
      expect(await state.journal.isComplete("turn")).toBe(false)
    } finally {
      await state.close()
    }
  })
}

for (const failure of ["revoke", "release"] as const) {
  test(`final permission write guard blocks ${failure} during adapter checks`, async () => {
    const state = await permissionFixture()
    try {
      let writes = 0
      Object.assign(state.adapter, {
        resolvePermission: async (context: { authorizeReply: () => void }) => {
          if (failure === "revoke") await state.admission.invalidate("runtime", "changed during native check")
          else await state.workspaces.release(state.lease.id, state.lease.generation)
          context.authorizeReply()
          writes++
        },
      })
      await publishPermission(state)
      await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow("uncertain")
      expect(writes).toBe(0)
    } finally {
      await state.close()
    }
  })
}

test("replayed native denial and request preserve the durable audit and live stream", async () => {
  const state = await permissionFixture()
  try {
    await publishPermission(state)
    const denial: AgentEventDraft = {
      ...state.draft,
      type: "permission.resolved",
      data: { ...state.request, outcome: "denied", actorId: "adapter", decidedAt: new Date(now).toISOString() },
      origin: { ...state.draft.origin, eventId: "denial" },
    }
    state.streams.get(state.session.id)!.push(denial)
    await waitUntil(async () => (await state.journal.permission(state.request.requestId))?.state === "resolved")
    const first = await state.journal.permission(state.request.requestId)
    state.streams.get(state.session.id)!.push(denial)
    state.streams.get(state.session.id)!.push(state.draft)
    state.streams.get(state.session.id)!.push(completion(state.session, "turn"))
    await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "idle")
    expect(await state.journal.permission(state.request.requestId)).toEqual(first)
    expect((await state.journal.cursor(state.session.id))?.sequence).toBe(4)
  } finally {
    await state.close()
  }
})

test("a file grant requires delivery of its exact protected review, and review tokens never enter the audit", async () => {
  const state = await permissionFixture()
  try {
    let writes = 0
    Object.assign(state.adapter, {
      resolvePermission: async (context: { authorizeReply: () => void }) => {
        context.authorizeReply()
        writes++
      },
    })
    await publishPermission(state, false)
    await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow("review")
    expect(writes).toBe(0)
    expect((await state.journal.permission(state.request.requestId))?.state).toBe("pending")
    const review = await state.manager.reviewPermission(state.request.requestId)
    expect(JSON.stringify(review.content)).toContain("private patch content")
    expect(review.artifact.sensitivity).toBe("restricted")
    await state.manager.resolvePermission({ ...state.decision, reviewToken: review.reviewToken })
    const record = (await state.journal.permission(state.request.requestId))!
    expect(record.intent?.reviewArtifactSha256).toBe(review.artifact.sha256)
    expect(JSON.stringify(record)).not.toContain(review.reviewToken)
    const audit = []
    for await (const event of state.journal.read(state.session.id)) audit.push(event)
    expect(JSON.stringify(audit)).not.toContain("private patch content")
    expect(JSON.stringify(audit)).not.toContain(review.reviewToken)
    expect(JSON.stringify(audit)).toContain("interaction.reviewed")
    expect(writes).toBe(1)
  } finally {
    await state.close()
  }
})

for (const failure of ["missing-store", "bad-binding", "changed-content"] as const) {
  test(`unavailable or invalid review (${failure}) cannot offer a file grant`, async () => {
    const state = await permissionFixture()
    try {
      if (failure === "missing-store") state.artifacts.close()
      if (failure === "bad-binding")
        Object.assign(state.adapter, {
          reviewPermission: async () => ({
            kind: "patch",
            requestId: state.request.requestId,
            operationSha256: "f".repeat(64),
            changes: [],
          }),
        })
      if (failure === "changed-content")
        Object.assign(state.adapter, {
          reviewPermission: async () => ({
            kind: "patch",
            requestId: state.request.requestId,
            operationSha256: state.request.operationSha256,
            changes: [{ path: "foreign-path", kind: "add", diff: "private patch content" }],
          }),
        })
      await publishPermission(state, false)
      expect(
        (await state.journal.permission(state.request.requestId))?.request.choices.every(
          (choice) => choice.action === "deny",
        ),
      ).toBe(true)
      await expect(state.manager.reviewPermission(state.request.requestId)).rejects.toThrow()
      await expect(state.manager.resolvePermission(state.decision)).rejects.toThrow()
    } finally {
      await state.close()
    }
  })
}

async function inputFixture() {
  const state = await permissionFixture()
  const request: HumanInputRequest = {
    requestId: "input-a",
    sessionId: state.session.id,
    runtimeId: "runtime",
    targetId: "local",
    workspaceId: "workspace",
    nativeSessionId: state.session.binding.nativeSessionId,
    nativeTurnId: "native-turn",
    nativeRequestId: "string:question-a",
    policyId: "policy",
    policyVersion: "1",
    leaseGeneration: state.lease.generation,
    operationSha256: "b".repeat(64),
    prompt: "Choose one option for each question.",
    schemaId: "harness.choice-input.v1",
    questions: [{ id: "question-a", optionIds: ["option-a", "option-b"] }],
    expiresAt: new Date(now + 60_000).toISOString(),
  }
  Object.assign(state.adapter, {
    reviewInput: async () => ({
      kind: "choice-input",
      requestId: request.requestId,
      operationSha256: request.operationSha256,
      questions: [
        {
          id: "question-a",
          header: "Plan",
          question: "Private question text",
          options: [
            { id: "option-a", label: "Private first label", description: "first" },
            { id: "option-b", label: "Private second label", description: "second" },
          ],
        },
      ],
    }),
  })
  const draft: AgentEventDraft = {
    ...state.draft,
    type: "input.requested",
    data: request,
    origin: { ...state.draft.origin, eventId: "input-a" },
  }
  const response: HumanInputResponse = {
    ...request,
    action: "answer",
    selections: [{ questionId: "question-a", optionId: "option-a" }],
  }
  return { ...state, inputRequest: request, inputDraft: draft, response }
}

async function publishInput(state: Awaited<ReturnType<typeof inputFixture>>) {
  state.streams.get(state.session.id)!.push(state.inputDraft)
  await waitUntil(async () => (await state.journal.input(state.inputRequest.requestId)) !== undefined)
  await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "awaiting-input")
}

test("input choices require protected review, claim before reply, and persist only option IDs", async () => {
  const state = await inputFixture()
  try {
    let writes = 0
    Object.assign(state.adapter, {
      resolveInput: async (context: { authorizeReply: () => void }) => {
        expect((await state.journal.input(state.inputRequest.requestId))?.state).toBe("claimed")
        context.authorizeReply()
        writes++
      },
    })
    await publishInput(state)
    await expect(state.manager.resolveInput(state.response)).rejects.toThrow("review")
    const review = await state.manager.reviewInput(state.inputRequest.requestId)
    expect(JSON.stringify(review.content)).toContain("Private question text")
    const response = { ...state.response, reviewToken: review.reviewToken }
    await state.manager.resolveInput(response)
    await state.manager.resolveInput(response)
    const record = (await state.journal.input(state.inputRequest.requestId))!
    expect(record.state).toBe("resolved")
    expect(record.resolution?.outcome).toBe("answered")
    expect(record.intent?.actorId).toBe("host:user-a")
    expect(record.intent?.reviewArtifactSha256).toBe(review.artifact.sha256)
    expect(JSON.stringify(record)).not.toContain("Private")
    expect(JSON.stringify(record)).not.toContain(review.reviewToken)
    expect(writes).toBe(1)
    expect((await state.journal.get(state.session.id))?.status).toBe("running")
  } finally {
    await state.close()
  }
})

for (const failure of ["lost-reply", "revoked-before-write"] as const) {
  test(`input outcome stays uncertain after ${failure} and never replays`, async () => {
    const state = await inputFixture()
    try {
      let writes = 0
      Object.assign(state.adapter, {
        resolveInput: async (context: { authorizeReply: () => void }) => {
          if (failure === "revoked-before-write") await state.admission.invalidate("runtime", "revoked")
          context.authorizeReply()
          writes++
          if (failure === "lost-reply") throw new Error("private transport failure")
        },
      })
      await publishInput(state)
      const response = {
        ...state.response,
        reviewToken: (await state.manager.reviewInput(state.inputRequest.requestId)).reviewToken,
      }
      await expect(state.manager.resolveInput(response)).rejects.toThrow("uncertain")
      await expect(state.manager.resolveInput(response)).rejects.toThrow("uncertain")
      expect((await state.journal.input(state.inputRequest.requestId))?.state).toBe("uncertain")
      expect(writes).toBe(failure === "lost-reply" ? 1 : 0)
    } finally {
      await state.close()
    }
  })
}

test("cancelling input needs no review and closing expires unanswered input without losing uncertainty", async () => {
  const state = await inputFixture()
  try {
    Object.assign(state.adapter, { resolveInput: async () => {} })
    await publishInput(state)
    await state.manager.resolveInput({ ...state.response, action: "cancel", selections: [] })
    expect((await state.journal.input(state.inputRequest.requestId))?.resolution?.outcome).toBe("cancelled")
    const next: AgentEventDraft = {
      ...state.inputDraft,
      type: "input.requested",
      data: { ...state.inputRequest, requestId: "input-b", nativeRequestId: "string:question-b" },
      origin: { ...state.inputDraft.origin, eventId: "input-b" },
    }
    state.streams.get(state.session.id)!.push(next)
    await waitUntil(async () => (await state.journal.input("input-b")) !== undefined)
    await state.manager.closeSession(state.session.id)
    expect((await state.journal.input("input-b"))?.resolution?.outcome).toBe("expired")
    expect((await state.journal.get(state.session.id))?.status).toBe("uncertain")
  } finally {
    await state.close()
  }
})

test("a review token cannot authorize another interaction and expires before the native write", async () => {
  const state = await inputFixture()
  try {
    let writes = 0
    Object.assign(state.adapter, {
      resolveInput: async () => {
        writes++
      },
    })
    await publishPermission(state)
    state.streams.get(state.session.id)!.push(state.inputDraft)
    await waitUntil(async () => (await state.journal.input(state.inputRequest.requestId)) !== undefined)
    await expect(
      state.manager.resolveInput({ ...state.response, reviewToken: state.decision.reviewToken! }),
    ).rejects.toThrow("review")
    const review = await state.manager.reviewInput(state.inputRequest.requestId)
    state.advance(60_001)
    await expect(state.manager.resolveInput({ ...state.response, reviewToken: review.reviewToken })).rejects.toThrow(
      "review",
    )
    await expect(state.manager.reviewInput(state.inputRequest.requestId)).rejects.toThrow()
    expect((await state.journal.input(state.inputRequest.requestId))?.state).toBe("pending")
    expect(writes).toBe(0)
  } finally {
    await state.close()
  }
})

test("input with unavailable protected storage remains cancellable and never offers an answer", async () => {
  const state = await inputFixture()
  try {
    let writes = 0
    Object.assign(state.adapter, {
      resolveInput: async (_context: unknown, response: HumanInputResponse) => {
        expect(response.action).toBe("cancel")
        writes++
      },
    })
    state.artifacts.close()
    await publishInput(state)
    await expect(state.manager.reviewInput(state.inputRequest.requestId)).rejects.toThrow()
    await expect(state.manager.resolveInput(state.response)).rejects.toThrow("review")
    await state.manager.resolveInput({ ...state.response, action: "cancel", selections: [] })
    expect(writes).toBe(1)
  } finally {
    await state.close()
  }
})

test("revoking account authority prevents protected review disclosure", async () => {
  const state = await inputFixture()
  try {
    await publishInput(state)
    await state.admission.invalidate("runtime", "account changed")
    await expect(state.manager.reviewInput(state.inputRequest.requestId)).rejects.toThrow()
    const events = []
    for await (const event of state.journal.read(state.session.id)) events.push(event)
    expect(JSON.stringify(events)).not.toContain("interaction.reviewed")
  } finally {
    await state.close()
  }
})

test("duplicate input requests and cancellations preserve the audit and active stream", async () => {
  const state = await inputFixture()
  try {
    await publishInput(state)
    const review = await state.manager.reviewInput(state.inputRequest.requestId)
    const {
      prompt: _prompt,
      schemaId: _schemaId,
      questions: _questions,
      expiresAt: _expiresAt,
      ...binding
    } = state.inputRequest
    const cancel: AgentEventDraft = {
      ...state.inputDraft,
      type: "input.resolved",
      data: { ...binding, outcome: "cancelled", actorId: "native", decidedAt: new Date(now).toISOString() },
      origin: { ...state.inputDraft.origin, eventId: "cancel" },
    }
    state.streams.get(state.session.id)!.push(cancel)
    await waitUntil(async () => (await state.journal.input(state.inputRequest.requestId))?.state === "resolved")
    const first = await state.journal.input(state.inputRequest.requestId)
    state.streams.get(state.session.id)!.push(cancel)
    state.streams.get(state.session.id)!.push(state.inputDraft)
    state.streams.get(state.session.id)!.push(completion(state.session, "turn"))
    await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "idle")
    expect(await state.journal.input(state.inputRequest.requestId)).toEqual(first)
    await expect(state.manager.resolveInput({ ...state.response, reviewToken: review.reviewToken })).rejects.toThrow()
    expect((await state.journal.cursor(state.session.id))?.sequence).toBe(4)
  } finally {
    await state.close()
  }
})

for (const forged of ["artifact", "source", "review-event", "answered"] as const) {
  test(`native ${forged} cannot acquire host interaction authority`, async () => {
    const state = await inputFixture()
    try {
      await publishInput(state)
      const review = await state.manager.reviewInput(state.inputRequest.requestId)
      const draft: AgentEventDraft =
        forged === "review-event"
          ? {
              ...state.inputDraft,
              type: "interaction.reviewed",
              data: {
                requestId: state.inputRequest.requestId,
                artifactId: review.artifact.id,
                artifactSha256: review.artifact.sha256,
                actorId: "native",
                reviewedAt: new Date(now).toISOString(),
              },
            }
          : forged === "answered"
            ? {
                ...state.inputDraft,
                type: "input.resolved",
                data: {
                  ...state.inputRequest,
                  outcome: "answered",
                  actorId: "native",
                  decidedAt: new Date(now).toISOString(),
                },
              }
            : {
                ...state.inputDraft,
                type: "input.requested",
                data: {
                  ...state.inputRequest,
                  ...(forged === "source"
                    ? { sourceRequestSha256: "a".repeat(64) }
                    : { reviewArtifact: review.artifact }),
                },
              }
      state.streams.get(state.session.id)!.push(draft)
      await waitUntil(async () => (await state.journal.get(state.session.id))?.status === "uncertain")
      expect((await state.journal.input(state.inputRequest.requestId))?.state).toBe("pending")
      await expect(state.manager.resolveInput({ ...state.response, reviewToken: review.reviewToken })).rejects.toThrow(
        "review",
      )
    } finally {
      await state.close()
    }
  })
}
