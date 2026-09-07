import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { CodexAdapter } from "@harness/adapters/codex"
import { ClaudeAdapter } from "@harness/adapters/claude"
import { NativeClaudeInspector } from "../../../harness-adapters/src/claude/inspect"
import { spawn } from "node:child_process"
import type { InteractionReview } from "@harness/protocol"
import { StdioJsonRpc } from "../../../harness-adapters/src/codex/stdio"
import { removeFixtureDirectory } from "../../../harness-control-plane/test/support"
import { DesktopBackend } from "../../src/host/backend"
import type { DesktopConfiguration, DesktopState, StartSessionInput } from "../../src/shared/contracts"

const start: StartSessionInput = {
  modelId: "gpt-5.4",
  acknowledgeOverage: true,
  acknowledgeUnverifiedBoundary: true,
  allowFileChanges: true,
}

async function fixture(scenario = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "harness-desktop-backend-"))
  const workspace = join(directory, "workspace")
  const storage = join(directory, "storage")
  const home = join(directory, "native-home")
  await mkdir(workspace)
  await mkdir(storage)
  await mkdir(home)
  const published: DesktopState[] = []
  const transports: StdioJsonRpc[] = []
  const inspections: { command: readonly string[]; cwd: string }[] = []
  let disposals = 0
  class TrackedCodexAdapter extends CodexAdapter {
    override async dispose() {
      disposals++
      await super.dispose()
    }
  }
  const options = {
    directory: storage,
    key: randomBytes(32),
    environment: {},
    toolPath: dirname(process.execPath),
    changed(state: DesktopState) {
      published.push(state)
    },
    claudeAdapterFactory: (options: ConstructorParameters<typeof ClaudeAdapter>[0]) =>
      new ClaudeAdapter({
        ...options,
        inspectorFactory: (options) =>
          new NativeClaudeInspector({
            ...options,
            launch: (command, launch) => {
              inspections.push({ command: command.slice(1), cwd: launch.cwd })
              return spawn(
                process.execPath,
                [resolve(import.meta.dir, "../fixtures/claude-status-peer.ts"), ...command.slice(1)],
                { ...launch, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true },
              )
            },
          }),
      }),
    adapterFactory: (options: ConstructorParameters<typeof CodexAdapter>[0]) =>
      new TrackedCodexAdapter({
        ...options,
        requestTimeoutMs: 2000,
        transportFactory: (options) => {
          const transport = new StdioJsonRpc({
            ...options,
            command: [
              process.execPath,
              resolve(import.meta.dir, "../../../harness-adapters/test/codex/app-server-peer.ts"),
              scenario,
              ...options.command.slice(1),
            ],
          })
          transports.push(transport)
          return transport
        },
      }),
  }
  let backend = await DesktopBackend.open(options)
  const configuration: DesktopConfiguration = {
    workspace: { id: "fixture-workspace", name: "Fixture", path: workspace },
    executable: process.execPath,
    nativeHome: home,
  }
  return {
    directory,
    workspace,
    storage,
    home,
    configuration,
    published,
    transports,
    inspections,
    disposals: () => disposals,
    backend: () => backend,
    async configure() {
      return (await backend.dispatch("configure", configuration)) as DesktopState
    },
    async state() {
      return (await backend.dispatch("getState")) as DesktopState
    },
    async nativeState() {
      return (await transports.at(-1)!.request("fixture/state", {})) as {
        requests: string[]
        turns: number
        approvals: { id: string | number; result?: unknown }[]
        startedModels: string[]
      }
    },
    async reopen() {
      await backend.close()
      backend = await DesktopBackend.open(options)
      return backend
    },
    async close() {
      try {
        await backend.close()
      } finally {
        await removeFixtureDirectory(directory)
      }
    },
  }
}

async function until(read: () => Promise<DesktopState>, accept: (state: DesktopState) => boolean) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const state = await read()
    if (accept(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Desktop fixture state did not settle")
}

async function rejection(promise: Promise<unknown>) {
  const result: unknown = await promise.catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
}

describe("desktop backend through the pinned local stdio fixture", () => {
  test("runtime switching clears native roots and Claude sign-in never enables execution or exposes native status fields", async () => {
    const state = await fixture()
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      expect((await state.state()).connection.status).toBe("ready")
      const switched = (await state.backend().dispatch("selectRuntime", { runtime: "claude" })) as DesktopState
      expect(switched.configuration.runtime).toBe("claude")
      expect(switched.configuration.executable).toBeUndefined()
      expect(switched.configuration.nativeHome).toBeUndefined()
      expect(switched.models).toEqual({ status: "unsupported", items: [] })
      expect(switched.connection).toEqual({
        runtimeName: "Claude Code",
        status: "not-checked",
        authentication: "unknown",
        billing: "unknown",
        providerOverage: "unknown",
      })
      expect(state.inspections).toHaveLength(0)
      await state
        .backend()
        .dispatch("configure", { ...switched.configuration, executable: process.execPath, nativeHome: state.home })
      const checked = (await state.backend().dispatch("refresh")) as DesktopState
      expect(checked.connection).toMatchObject({
        runtimeName: "Claude Code",
        runtimeVersion: "2.1.251",
        status: "blocked",
        authentication: "authenticated",
        billing: "unknown",
        providerOverage: "unknown",
      })
      expect(JSON.stringify(checked)).not.toContain("private-fixture")
      expect(JSON.stringify(checked)).not.toContain("claimed-plan")
      expect(state.inspections.map((value) => value.command)).toEqual([
        ["--version"],
        ["--version"],
        ["auth", "status"],
      ])
      expect(state.inspections.every((value) => value.cwd === state.storage)).toBe(true)
      await rejection(state.backend().dispatch("start", start))
      await rejection(state.backend().dispatch("send", { text: "Must never reach Claude" }))
      expect(state.inspections).toHaveLength(3)
      expect((await state.state()).session).toBeUndefined()
      const back = (await state.backend().dispatch("selectRuntime", { runtime: "codex" })) as DesktopState
      expect(back.configuration.executable).toBeUndefined()
      expect(back.configuration.nativeHome).toBeUndefined()
      expect(back.connection.status).toBe("not-checked")
      expect(back.models).toEqual({ status: "not-loaded", items: [] })
      expect(back.connection.runtimeName).toBe("Codex")
    } finally {
      await state.close()
    }
  })
  test("recovery failure closes both storage databases before rejecting startup", async () => {
    const state = await fixture()
    try {
      await state.backend().close()
      const database = new Database(join(state.storage, "journal.sqlite"))
      try {
        database.run("INSERT INTO journal_sessions (id, workspace_id, revision, session) VALUES (?, ?, ?, ?)", [
          "malformed-session",
          "workspace",
          0,
          "not valid JSON",
        ])
      } finally {
        database.close()
      }
      await rejection(state.reopen())
      await removeFixtureDirectory(state.storage)
      await mkdir(state.storage)
    } finally {
      await state.close()
    }
  })

  test.each(["", "Incomplete streamed answer"])(
    "authoritative final text replaces the preview after initial text %j",
    async (initial) => {
      const state = await fixture("hold")
      try {
        await state.configure()
        await state.backend().dispatch("refresh")
        await state.backend().dispatch("start", start)
        await state.backend().dispatch("send", { text: "Fixture final message only" })
        if (initial) {
          await state.transports.at(-1)!.request("fixture/notification", {
            method: "item/agentMessage/delta",
            params: { threadId: "thread-1", turnId: "turn-1", itemId: "final-message", delta: initial },
          })
          await until(state.state, (value) =>
            value.messages.some((message) => message.id === "final-message" && message.text === initial),
          )
        }
        const final = "Complete authoritative answer with the missing details."
        await state.transports.at(-1)!.request("fixture/notification", {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "final-message", text: final, phase: "final_answer" },
          },
        })
        const shown = await until(state.state, (value) =>
          value.activity.some((item) => item.kind === "assistant.text.completed"),
        )
        expect(shown.messages.filter((message) => message.id === "final-message")).toEqual([
          { id: "final-message", role: "assistant", text: final },
        ])
        expect((await state.nativeState()).turns).toBe(1)
      } finally {
        await state.close()
      }
    },
  )

  test("authoritative final-only content respects serialized preview bounds", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture bounded final message" })
      const final = "🙂".repeat(100_000)
      await state.transports.at(-1)!.request("fixture/notification", {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "large-final-message", text: final, phase: "final_answer" },
        },
      })
      const shown = await until(state.state, (value) =>
        value.activity.some((item) => item.kind === "assistant.text.completed"),
      )
      const message = shown.messages.find((message) => message.id === "large-final-message")!
      expect(message).toBeDefined()
      expect(message.text.length).toBeGreaterThan(0)
      expect(message.text.length).toBeLessThan(final.length)
      expect(final.startsWith(message.text)).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(256 * 1024)
      expect(shown.notices.join(" ")).toContain("truncated")
    } finally {
      await state.close()
    }
  })

  test("configuration starts no native process and refresh reads status and models without a session", async () => {
    const state = await fixture()
    try {
      await mkdir(join(state.workspace, ".claude", "skills", "review"), { recursive: true })
      await writeFile(
        join(state.workspace, ".claude", "skills", "review", "SKILL.md"),
        "---\ndescription: Local skill\n---\nprivate body",
      )
      const configured = await state.configure()
      expect(state.transports).toHaveLength(0)
      expect(configured.models).toEqual({ status: "not-loaded", items: [] })
      expect(configured.skills?.skills[0]).toMatchObject({ commandName: "review", activation: { status: "disabled" } })
      expect(JSON.stringify(configured)).not.toContain("private body")
      const refreshed = (await state.backend().dispatch("refresh")) as DesktopState
      expect(refreshed.connection).toMatchObject({
        status: "ready",
        authentication: "subscription",
        billing: "subscription",
        providerOverage: "unknown",
      })
      const native = await state.nativeState()
      expect(refreshed.models.status).toBe("ready")
      expect(refreshed.models.items).toContainEqual({ id: "gpt-5.4", name: "GPT-5.4" })
      expect(refreshed.models.checkedAt).toBeDefined()
      expect(native.requests).toContain("model/list")
      expect(native.turns).toBe(0)
      expect(
        native.requests.filter(
          (method) =>
            !["initialize", "initialized", "account/read", "config/read", "model/list", "fixture/state"].includes(
              method,
            ),
        ),
      ).toEqual([])
      expect(refreshed.session).toBeUndefined()
    } finally {
      await state.close()
    }
  })

  test.each(["models-empty", "models-error", "models-malformed"])(
    "unavailable model catalog %s never enables native thread creation",
    async (scenario) => {
      const state = await fixture(scenario)
      try {
        await state.configure()
        const refreshed = (await state.backend().dispatch("refresh")) as DesktopState
        expect(refreshed.models).toEqual({ status: "unavailable", items: [] })
        await rejection(state.backend().dispatch("start", start))
        expect((await state.nativeState()).requests).not.toContain("thread/start")
        expect((await state.state()).session).toBeUndefined()
      } finally {
        await state.close()
      }
    },
  )

  test("an arbitrary model is rejected without another native catalog read", async () => {
    const state = await fixture()
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      const before = (await state.nativeState()).requests.filter((method) => method === "model/list").length
      await rejection(state.backend().dispatch("start", { ...start, modelId: "not-offered-by-codex" }))
      const after = await state.nativeState()
      expect(after.requests.filter((method) => method === "model/list")).toHaveLength(before)
      expect(after.requests).not.toContain("thread/start")
    } finally {
      await state.close()
    }
  })

  test("an explicitly chosen alternate catalog model reaches native creation unchanged", async () => {
    const state = await fixture()
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      const selected = "gpt-5.4-mini"
      expect((await state.state()).models.items.some((model) => model.id === selected)).toBe(true)
      const started = (await state.backend().dispatch("start", { ...start, modelId: selected })) as DesktopState
      expect(started.session?.modelId).toBe(selected)
      expect((await state.nativeState()).startedModels).toEqual([selected])
      expect((await state.nativeState()).turns).toBe(0)
    } finally {
      await state.close()
    }
  })

  test("a disappeared model updates the desktop catalog and blocks native creation", async () => {
    const state = await fixture("models-disappear")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      expect((await state.state()).models.items.some((model) => model.id === start.modelId)).toBe(true)
      await rejection(state.backend().dispatch("start", start))
      expect((await state.state()).models.items.some((model) => model.id === start.modelId)).toBe(false)
      expect(state.published.at(-1)?.models.items.some((model) => model.id === start.modelId)).toBe(false)
      const native = await state.nativeState()
      expect(native.requests.filter((method) => method === "model/list")).toHaveLength(2)
      expect(native.requests).not.toContain("thread/start")
      expect((await state.state()).session).toBeUndefined()
    } finally {
      await state.close()
    }
  })

  test("changing account home or workspace clears model observations until another explicit check", async () => {
    const state = await fixture()
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      const configured = (await state
        .backend()
        .dispatch("configure", { ...state.configuration, nativeHome: state.directory })) as DesktopState
      expect(configured.models).toEqual({ status: "not-loaded", items: [] })
      expect(configured.connection.status).toBe("not-checked")
      expect(state.transports).toHaveLength(1)
      await rejection(state.backend().dispatch("start", start))
    } finally {
      await state.close()
    }
  })

  test("starts only after both acknowledgements and streams one explicitly sent message", async () => {
    const state = await fixture()
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      for (const input of [
        { ...start, acknowledgeOverage: false },
        { ...start, acknowledgeUnverifiedBoundary: false },
      ])
        await rejection(state.backend().dispatch("start", input))
      expect((await state.nativeState()).requests).not.toContain("thread/start")
      const started = (await state.backend().dispatch("start", start)) as DesktopState
      expect(started.session?.status).toBe("idle")
      expect((await state.nativeState()).requests.filter((method) => method === "model/list")).toHaveLength(2)
      expect((await state.nativeState()).turns).toBe(0)
      await state.backend().dispatch("send", { text: "Fixture message only" })
      const completed = await until(
        state.state,
        (value) => value.session?.status === "idle" && value.messages.some((message) => message.role === "assistant"),
      )
      expect(completed.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Fixture message only"],
        ["assistant", "Hello"],
      ])
      expect((await state.nativeState()).turns).toBe(1)
      expect(JSON.stringify(completed)).not.toContain("unknown-sensitive-body")
      expect(JSON.stringify(completed)).not.toContain("never-retain-this")
      await rejection(state.backend().dispatch("configure", state.configuration))
      await rejection(state.backend().dispatch("selectRuntime", { runtime: "claude" }))
      expect((await state.state()).connection.runtimeName).toBe("Codex")
      expect(state.inspections).toHaveLength(0)
    } finally {
      await state.close()
    }
  })

  test("requires protected patch review before one native file approval", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture approval only" })
      const path = join(state.workspace, "proposed.txt")
      await state.transports.at(-1)!.request("fixture/native-request", {
        notifications: [
          {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                type: "fileChange",
                id: "file-item",
                status: "inProgress",
                changes: [{ path, kind: { type: "add" }, diff: "+protected desktop patch" }],
              },
            },
          },
        ],
        request: {
          id: "file-approval",
          method: "item/fileChange/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-item", startedAtMs: Date.now() },
        },
      })
      const pending = await until(state.state, (value) => value.permissions.length === 1)
      const permission = pending.permissions[0]!
      const choiceId = permission.choices.find((choice) => choice.action === "allow")!.id
      expect(JSON.stringify(pending)).not.toContain("protected desktop patch")
      await rejection(state.backend().dispatch("resolvePermission", { requestId: permission.requestId, choiceId }))
      const review = (await state
        .backend()
        .dispatch("review", { kind: "permission", requestId: permission.requestId })) as InteractionReview
      expect(review.content.kind).toBe("patch")
      expect(JSON.stringify(review.content)).toContain("protected desktop patch")
      await state
        .backend()
        .dispatch("resolvePermission", { requestId: permission.requestId, choiceId, reviewToken: review.reviewToken })
      expect((await state.nativeState()).approvals).toEqual([{ id: "file-approval", result: { decision: "accept" } }])
      await state
        .backend()
        .dispatch("resolvePermission", { requestId: permission.requestId, choiceId, reviewToken: review.reviewToken })
      expect((await state.nativeState()).approvals).toHaveLength(1)
      expect(JSON.stringify(await state.state())).not.toContain(review.reviewToken)
    } finally {
      await state.close()
    }
  })

  test("keeps native question labels protected and maps reviewed opaque options once", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture choices only" })
      await state.transports.at(-1)!.request("fixture/native-request", {
        request: {
          id: "question",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "question-item",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "storage",
                header: "Storage",
                question: "Private storage question",
                isOther: false,
                isSecret: false,
                options: [
                  { label: "Private first choice", description: "On this device" },
                  { label: "Private second choice", description: "Elsewhere" },
                ],
              },
            ],
          },
        },
      })
      const pending = await until(state.state, (value) => value.inputs.length === 1)
      const input = pending.inputs[0]!
      const selections = [{ questionId: input.questions[0]!.id, optionId: input.questions[0]!.optionIds[0]! }]
      expect(JSON.stringify(pending)).not.toContain("Private storage question")
      expect(JSON.stringify(pending)).not.toContain("Private first choice")
      await rejection(
        state.backend().dispatch("resolveInput", { requestId: input.requestId, action: "answer", selections }),
      )
      const review = (await state
        .backend()
        .dispatch("review", { kind: "input", requestId: input.requestId })) as InteractionReview
      expect(review.content.kind).toBe("choice-input")
      const answer = { requestId: input.requestId, action: "answer", selections, reviewToken: review.reviewToken }
      await state.backend().dispatch("resolveInput", answer)
      await state.backend().dispatch("resolveInput", answer)
      expect((await state.nativeState()).approvals).toEqual([
        { id: "question", result: { answers: { storage: { answers: ["Private first choice"] } } } },
      ])
      expect(JSON.stringify(await state.state())).not.toContain(review.reviewToken)
    } finally {
      await state.close()
    }
  })

  test("interrupt reaches the native session and cannot change native roots while attached", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture held turn" })
      await state.backend().dispatch("interrupt")
      expect((await until(state.state, (value) => value.session?.status === "interrupted")).session?.status).toBe(
        "interrupted",
      )
      expect((await state.nativeState()).requests).toContain("turn/interrupt")
      await rejection(state.backend().dispatch("configure", { ...state.configuration, userSkillsRoot: state.home }))
    } finally {
      await state.close()
    }
  })

  test("recovery does not automatically resume or replay a turn with an uncertain outcome", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture uncertain turn" })
      await state.reopen()
      const configured = await state.configure()
      expect(configured.notices.join(" ")).toContain("native inspection")
      await state.backend().dispatch("refresh")
      await rejection(state.backend().dispatch("start", start))
      const native = await state.nativeState()
      expect(native.turns).toBe(0)
      expect(native.requests).not.toContain("thread/start")
      expect(native.requests).not.toContain("thread/resume")
    } finally {
      await state.close()
    }
  })

  test("a fresh display workspace identity cannot bypass uncertain work in the same directory", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture uncertain physical workspace" })
      await state.reopen()
      await state.backend().dispatch("configure", {
        ...state.configuration,
        workspace: { ...state.configuration.workspace!, id: "fresh-display-identity" },
      })
      await state.backend().dispatch("refresh")
      await rejection(state.backend().dispatch("start", start))
      expect((await state.nativeState()).requests).not.toContain("thread/start")
    } finally {
      await state.close()
    }
  })

  test("lost native send acknowledgement keeps one uncertain message and rejects automatic continuation", async () => {
    const state = await fixture("lost-dispatch")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture lost acknowledgement" })
      const uncertain = await until(state.state, (value) => value.session?.status === "uncertain")
      expect(uncertain.messages.filter((message) => message.role === "user")).toHaveLength(1)
      await rejection(state.backend().dispatch("send", { text: "Must not dispatch again" }))
      expect((await state.state()).messages.filter((message) => message.role === "user")).toHaveLength(1)
      expect(state.transports).toHaveLength(1)
      await state.backend().close()
      expect(state.disposals()).toBe(1)
    } finally {
      await state.close()
    }
  })

  test("an uncertain native create with no saved session blocks other workspaces across restarts", async () => {
    const state = await fixture("thread-provider")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await rejection(state.backend().dispatch("start", start))
      expect((await state.state()).session).toBeUndefined()
      const secondWorkspace = join(state.directory, "another-workspace")
      await mkdir(secondWorkspace)
      for (let restart = 0; restart < 2; restart++) {
        await state.reopen()
        const configured = (await state.backend().dispatch("configure", {
          ...state.configuration,
          workspace: { id: `changed-${restart}`, name: "Another", path: secondWorkspace },
        })) as DesktopState
        expect(configured.notices.join(" ")).toContain("native inspection")
        await state.backend().dispatch("refresh")
        await rejection(state.backend().dispatch("start", start))
        expect((await state.nativeState()).requests).not.toContain("thread/start")
      }
    } finally {
      await state.close()
    }
  })

  test.each(["journal.sqlite-wal", "journal.sqlite-shm", "journal.sqlite-journal"])(
    "rejects linked SQLite sidecar %s before opening the database",
    async (name) => {
      const state = await fixture()
      try {
        await state.backend().close()
        const target = join(state.directory, "outside-sensitive-file")
        const content = "Must not become a SQLite sidecar"
        await writeFile(target, content)
        await link(target, join(state.storage, name))
        await rejection(state.reopen())
        expect(await readFile(target, "utf8")).toBe(content)
      } finally {
        await state.close()
      }
    },
  )

  test("bounds serialized UTF-8 and escaped previews beneath private IPC limits without dropping native work", async () => {
    const state = await fixture("hold")
    try {
      await Promise.all(
        Array.from({ length: 96 }, async (_, index) => {
          const path = join(state.workspace, ".claude", "skills", `skill-${index}`)
          await mkdir(path, { recursive: true })
          await writeFile(join(path, "SKILL.md"), `---\ndescription: ${"🙂".repeat(2048)}\n---`)
        }),
      )
      const configured = await state.configure()
      expect(configured.skills!.skills.length).toBeLessThan(96)
      expect(configured.skills!.roots).toContainEqual({ scope: "workspace", status: "limit-reached" })
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture display bounds" })
      for (let index = 0; index < 6; index++)
        await state.transports.at(-1)!.request("fixture/notification", {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: `large-message-${index}`,
            delta: "\u0001".repeat(64 * 1024),
          },
        })
      const shown = await until(state.state, (value) =>
        value.messages.some((message) => message.id === "large-message-5"),
      )
      expect(shown.messages.find((message) => message.id === "large-message-5")!.text.length).toBeLessThan(64 * 1024)
      expect(shown.notices.join(" ")).toContain("truncated")
      expect(
        state.published.every(
          (value) => Buffer.byteLength(JSON.stringify({ event: "state", state: value })) < 3 * 1024 * 1024,
        ),
      ).toBe(true)
      expect(shown.session!.status).toBe("running")
      expect((await state.nativeState()).turns).toBe(1)
      await state.backend().dispatch("interrupt")
    } finally {
      await state.close()
    }
  })

  test("concurrent state reads do not replace newly streamed deltas with older snapshots", async () => {
    const state = await fixture("hold")
    try {
      await state.configure()
      await state.backend().dispatch("refresh")
      await state.backend().dispatch("start", start)
      await state.backend().dispatch("send", { text: "Fixture concurrent snapshots" })
      const text = Array.from({ length: 40 }, (_, index) => `${index}|`)
      await Promise.all(
        text.map(async (delta) => {
          await Promise.all([
            state.transports.at(-1)!.request("fixture/notification", {
              method: "item/agentMessage/delta",
              params: { threadId: "thread-1", turnId: "turn-1", itemId: "concurrent-message", delta },
            }),
            state.state(),
          ])
        }),
      )
      const shown = await until(state.state, (value) =>
        value.messages.some((message) => message.id === "concurrent-message" && message.text === text.join("")),
      )
      expect(shown.messages.find((message) => message.id === "concurrent-message")!.text).toBe(text.join(""))
      expect(
        state.published.every((value, index) => index === 0 || value.revision > state.published[index - 1]!.revision),
      ).toBe(true)
    } finally {
      await state.close()
    }
  })
})
