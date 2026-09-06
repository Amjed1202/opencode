import { expect, test } from "bun:test"
import { join } from "node:path"
import type { AgentEventDraft, AgentInput, AgentSession } from "@harness/protocol"
import { AdmissionController } from "../src/admission"
import { hashConfiguration } from "../src/environment"
import { LocalRuntimeManager } from "../src/runtime-manager"
import { SQLiteJournal } from "../src/journal"
import { admissionFixture, intent } from "./support"

async function fixture() {
  const base = await admissionFixture()
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
  })
  const result = await admission.preflight({ operation: "create", intent })
  if (result.status !== "ready") throw new Error("missing admission")
  return {
    ...base,
    admission,
    streams,
    journal,
    manager,
    admissionId: result.admissionId,
    async close() {
      await manager.dispose()
      journal.close()
      await base.close()
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
  const admission = await state.admission.preflight({ operation: "turn", sessionId: session.id, intent })
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
