import { expect, test } from "bun:test"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { ClaudeAdapter } from "@harness/adapters/claude"
import type { ClaudeRuntime, ClaudeRuntimeOptions } from "../../../harness-adapters/src/claude/runtime"
import { removeFixtureDirectory } from "../../../harness-control-plane/test/support"
import type { InteractionReview } from "@harness/protocol"
import { DesktopBackend } from "../../src/host/backend"
import type {
  DesktopConfiguration,
  DesktopState,
  WorkspaceFileList,
  WorkspaceFilePreview,
} from "../../src/shared/contracts"

type NativeUser = Parameters<ClaudeRuntime["send"]>[0]
type NativeEvent = ReturnType<ClaudeRuntime["events"]> extends AsyncIterable<infer Event> ? Event : never

/** The real adapter and host run unchanged; only the native account/process seam is synthetic. */
class DesktopClaudePeer implements ClaudeRuntime {
  readonly messages: NativeUser[] = []
  readonly queue: NativeEvent[] = []
  readonly grants = new Map<
    string,
    { authorize: () => void; delivered: ReturnType<typeof Promise.withResolvers<void>> }
  >()
  readonly decisions: string[] = []
  guardCalls = 0
  closed = false
  wake: (() => void) | undefined
  constructor(readonly options: ClaudeRuntimeOptions) {}
  id() {
    return this.options.sessionId ?? this.options.resume ?? "diagnostic"
  }
  async initialize() {
    const commands = []
    for (const path of this.options.pluginPaths ?? []) {
      for (const name of await readdir(join(path, "skills")))
        commands.push({ name: `${basename(path)}:${name}`, description: "Fixture skill", argumentHint: "" })
    }
    return {
      commands,
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [{ value: "sonnet", displayName: "Sonnet", description: "Fixture" }],
      account: {
        email: "fixture@example.invalid",
        subscriptionType: "max",
        apiProvider: "firstParty",
        apiKeySource: "none",
      },
      hooks_applied: true,
      fast_mode_state: "off",
    } as Awaited<ReturnType<ClaudeRuntime["initialize"]>>
  }
  send(message: NativeUser) {
    this.messages.push(message)
    this.emit({
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: this.id(),
      model: "claude-sonnet-4-6",
      apiKeySource: "none",
      permissionMode: "default",
      cwd: this.options.cwd,
      claude_code_version: "2.1.251",
      tools: [...this.options.tools],
      mcp_servers: [],
      skills: [...(this.options.modelSkills ?? [])],
      plugins: [],
      slash_commands: [],
    })
    this.emit({ ...message, isReplay: true })
  }
  emit(message: unknown) {
    this.queue.push(message as NativeEvent)
    this.wake?.()
  }
  async *events() {
    while (true) {
      const message = this.queue.shift()
      if (message) {
        yield message
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
  async interrupt() {}
  authorizePermission(requestId: string, authorize: () => void) {
    const delivered = Promise.withResolvers<void>()
    this.grants.set(requestId, { authorize, delivered })
    return delivered.promise
  }
  async close() {
    this.closed = true
    for (const grant of this.grants.values()) grant.delivered.reject(new Error("Fixture closed"))
    this.grants.clear()
    this.wake?.()
  }
  async tool(tool: "Write" | "Edit", input: Record<string, unknown>, id: string) {
    const decision = await this.options.canUseTool(tool, input, {
      signal: new AbortController().signal,
      requestId: id,
      toolUseID: id,
    })
    if (decision?.behavior === "allow") {
      const grant = this.grants.get(id)
      if (!grant) throw new Error("Fixture received an unguarded allowance")
      try {
        grant.authorize()
        this.guardCalls++
        const file = String(input.file_path)
        if (tool === "Write") await writeFile(file, String(input.content))
        else
          await writeFile(
            file,
            (await readFile(file, "utf8")).replace(String(input.old_string), String(input.new_string)),
          )
        grant.delivered.resolve()
      } catch (error) {
        grant.delivered.reject(error)
        throw error
      } finally {
        this.grants.delete(id)
      }
    }
    this.decisions.push(decision?.behavior ?? "unanswered")
    return decision
  }
  toolResult(id: string, denied = false) {
    this.emit({
      type: "user",
      session_id: this.id(),
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "Fixture result", is_error: denied }],
      },
    })
  }
  text() {
    const envelope = { session_id: this.id(), parent_tool_use_id: null, user_message_uuid: this.messages.at(-1)!.uuid }
    this.emit({
      ...envelope,
      type: "stream_event",
      uuid: randomUUID(),
      event: { type: "message_start", message: { id: "fixture-response", model: "claude-sonnet-4-6" } },
    })
    for (const text of ["First paragraph.", "Second paragraph."]) {
      this.emit({
        ...envelope,
        type: "stream_event",
        uuid: randomUUID(),
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      })
      this.emit({
        ...envelope,
        type: "assistant",
        uuid: randomUUID(),
        message: {
          id: "fixture-response",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text }],
        },
      })
    }
  }
  finish() {
    this.emit({
      type: "result",
      subtype: "success",
      uuid: randomUUID(),
      session_id: this.id(),
      user_message_uuid: this.messages.at(-1)!.uuid,
      is_error: false,
      result: "Second paragraph.",
      usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      total_cost_usd: 0.25,
      modelUsage: {},
      queued_turn_count: 0,
      permission_denials: [],
    })
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-desktop-claude-"))
  const workspace = join(directory, "workspace")
  const storage = join(directory, "storage")
  const home = join(directory, "native-home")
  const skills = join(workspace, ".claude", "skills", "brief")
  for (const path of [workspace, storage, home, skills]) await mkdir(path, { recursive: true })
  await writeFile(
    join(skills, "SKILL.md"),
    "---\nname: brief\ndescription: Reply briefly\n---\nUse short paragraphs.\n",
  )
  const peers: DesktopClaudePeer[] = []
  const published: DesktopState[] = []
  const options = {
    directory: storage,
    key: randomBytes(32),
    environment: {},
    toolPath: dirname(process.execPath),
    changed: (state: DesktopState) => {
      published.push(state)
    },
    claudeAdapterFactory: (options: ConstructorParameters<typeof ClaudeAdapter>[0]) =>
      new ClaudeAdapter({
        ...options,
        inspectorFactory: () => ({
          version: async () => "2.1.251",
          authStatus: async () => ({ loggedIn: true }),
          subscriptionStatus: async () => ({
            accountId: "a".repeat(64),
            emailHash: createHash("sha256").update("fixture@example.invalid").digest("hex"),
            personalSubscription: true,
          }),
          dispose: async () => {},
        }),
        policyCheck: async () => {},
        runtimeFactory: (options) => {
          const peer = new DesktopClaudePeer(options)
          peers.push(peer)
          return peer
        },
      }),
  }
  let backend = await DesktopBackend.open(options)
  const configuration: DesktopConfiguration = {
    runtime: "claude",
    workspace: { id: "fixture", name: "Fixture", path: workspace },
    executable: process.execPath,
    nativeHome: home,
  }
  return {
    directory,
    workspace,
    peers,
    published,
    backend: () => backend,
    state: async () => (await backend.dispatch("getState")) as DesktopState,
    configure: async () => (await backend.dispatch("configure", configuration)) as DesktopState,
    reopen: async () => {
      await backend.close()
      backend = await DesktopBackend.open(options)
    },
    close: async () => {
      try {
        await backend.close()
      } finally {
        await removeFixtureDirectory(directory)
      }
    },
  }
}

test("Claude desktop: selected Skill/model, guarded file changes, streaming tokens and exact clean resume", async () => {
  const state = await fixture()
  try {
    await state.configure()
    const ready = (await state.backend().dispatch("refresh")) as DesktopState
    expect(ready.connection).toMatchObject({
      status: "ready",
      authentication: "subscription",
      billing: "subscription",
      providerOverage: "unknown",
    })
    expect(ready.models.items).toEqual([{ id: "sonnet", name: "Sonnet" }])
    expect(ready.runtimeFeatures).toEqual({ resume: true, inspection: false })
    const skill = ready.skills!.skills.find((skill) => skill.commandName === "brief")!
    expect(skill).toBeDefined()
    const started = (await state.backend().dispatch("start", {
      modelId: "sonnet",
      acknowledgeOverage: true,
      acknowledgeUnverifiedBoundary: true,
      allowFileChanges: true,
      skills: ["user", "model"].map((invocation) => ({ skillId: skill.id, sha256: skill.sha256, invocation })),
    })) as DesktopState
    expect(started.session).toMatchObject({ status: "idle", modelId: "sonnet" })
    const sessionId = started.session!.id
    const peer = state.peers.find((peer) => peer.options.sessionId)!
    expect(peer.options.modelSkills).toHaveLength(1)
    expect(peer.options.pluginPaths).toHaveLength(1)
    await state.backend().dispatch("send", { text: "/brief Help with the fixture." })
    expect(peer.messages).toHaveLength(1)
    expect(peer.messages[0]!.message.content).toBe(`/${peer.options.modelSkills![0]} Help with the fixture.`)
    const file = join(state.workspace, "note.txt")
    const allowed = peer.tool("Write", { file_path: file, content: "Reviewed fixture text.\n" }, "write-one")
    const waiting = await until(state.state, (state) => state.permissions.length === 1)
    const requestId = waiting.permissions[0]!.requestId
    expect(peer.guardCalls).toBe(0)
    await expect(state.backend().dispatch("resolvePermission", { requestId, choiceId: "allow-once" })).rejects.toThrow()
    expect(peer.guardCalls).toBe(0)
    const review = (await state.backend().dispatch("review", { kind: "permission", requestId })) as InteractionReview
    expect(review.content.kind).toBe("patch")
    if (review.content.kind === "patch") expect(review.content.changes[0]!.diff).toContain("+Reviewed fixture text.")
    await state
      .backend()
      .dispatch("resolvePermission", { requestId, choiceId: "allow-once", reviewToken: review.reviewToken })
    expect((await allowed)?.behavior).toBe("allow")
    expect(peer.guardCalls).toBe(1)
    expect(await readFile(file, "utf8")).toBe("Reviewed fixture text.\n")
    peer.toolResult("write-one")
    const denied = peer.tool("Edit", { file_path: file, old_string: "Reviewed", new_string: "Unapproved" }, "edit-one")
    const next = await until(state.state, (state) =>
      state.permissions.some((permission) => permission.nativeRequestId === "edit-one"),
    )
    await state.backend().dispatch("resolvePermission", {
      requestId: next.permissions.find((permission) => permission.nativeRequestId === "edit-one")!.requestId,
      choiceId: "deny-once",
    })
    expect((await denied)?.behavior).toBe("deny")
    expect(peer.guardCalls).toBe(1)
    expect(await readFile(file, "utf8")).toBe("Reviewed fixture text.\n")
    peer.toolResult("edit-one", true)
    peer.text()
    peer.finish()
    const completed = await until(
      state.state,
      (state) => state.session?.status === "idle" && state.usage?.tokens?.input === 12,
    )
    expect(completed.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual(
      ["First paragraph.\n\nSecond paragraph."],
    )
    expect(completed.usage).toMatchObject({
      accountingScope: "turn",
      tokens: { input: 12, output: 8, cacheRead: 3, cacheWrite: 2 },
    })
    expect(completed.usage?.costs).toBeUndefined()
    expect(JSON.stringify(completed)).not.toContain(review.reviewToken)
    const files = (await state.backend().dispatch("listFiles")) as WorkspaceFileList
    const note = files.items.find((file) => file.path === "note.txt")!
    expect(note.change).toBe("added")
    expect(((await state.backend().dispatch("previewFile", { fileId: note.id })) as WorkspaceFilePreview).text).toBe(
      "Reviewed fixture text.\n",
    )
    const detached = (await state.backend().dispatch("detachConversation")) as DesktopState
    expect(peer.closed).toBe(true)
    expect(detached.conversations!.items.find((item) => item.id === sessionId)).toMatchObject({
      status: "closed",
      compatible: true,
    })
    await state.reopen()
    await state.configure()
    const history = (await state.backend().dispatch("viewConversation", { sessionId })) as DesktopState
    expect(history.messages.map((message) => message.text)).toEqual([
      "/brief Help with the fixture.",
      "First paragraph.\n\nSecond paragraph.",
    ])
    expect(history.history).toMatchObject({ partial: true, unconfirmedMessages: 0 })
    await state.backend().dispatch("refresh")
    const resumed = (await state.backend().dispatch("resumeConversation", {
      sessionId,
      acknowledgeOverage: true,
      acknowledgeUnverifiedBoundary: true,
    })) as DesktopState
    const resumedPeer = state.peers.find((candidate) => candidate.options.resume)!
    expect(resumed.session).toMatchObject({ id: sessionId, status: "idle" })
    expect(resumedPeer.options.resume).toBe(peer.options.sessionId)
    expect(resumedPeer.messages).toHaveLength(0)
    expect(state.peers.reduce((total, peer) => total + peer.messages.length, 0)).toBe(1)
  } finally {
    await state.close()
  }
}, 15000)

test("Claude desktop retains a safe rate-limit explanation through uncertainty and saved history", async () => {
  const state = await fixture()
  try {
    await state.configure()
    await state.backend().dispatch("refresh")
    const started = (await state.backend().dispatch("start", {
      modelId: "sonnet",
      acknowledgeOverage: true,
      acknowledgeUnverifiedBoundary: true,
      allowFileChanges: false,
    })) as DesktopState
    const sessionId = started.session!.id
    await state.backend().dispatch("send", { text: "Explain addition without tools." })
    const peer = state.peers.find((peer) => peer.options.sessionId)!
    peer.emit({
      type: "assistant",
      session_id: peer.id(),
      uuid: randomUUID(),
      parent_tool_use_id: null,
      user_message_uuid: peer.messages[0]!.uuid,
      error: "rate_limit",
      message: {
        id: "synthetic-limit",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Private account secret@example.invalid <script>secret</script>" }],
        stop_reason: "stop_sequence",
      },
    })
    const label = "Native usage limit reached. Check the provider's reset time."
    const stopped = await until(
      state.state,
      (value) => value.session?.status === "uncertain" && value.activity.some((entry) => entry.label === label),
    )
    expect(stopped.notices).toContain(label)
    expect(stopped.messages.map((message) => message.role)).toEqual(["user"])
    expect(stopped.usage).toBeUndefined()
    expect(stopped.permissions).toEqual([])
    expect(peer.closed).toBe(true)
    await expect(state.backend().dispatch("send", { text: "Do not actually resend." })).rejects.toThrow()
    expect(peer.messages).toHaveLength(1)
    await state.backend().dispatch("detachConversation")
    await state.reopen()
    await state.configure()
    const history = (await state.backend().dispatch("viewConversation", { sessionId })) as DesktopState
    expect(history.activity.some((entry) => entry.kind === "agent.error" && entry.label === label)).toBe(true)
    expect(history.messages.map((message) => message.role)).toEqual(["user"])
    expect(JSON.stringify([...state.published, history])).not.toContain("secret@example.invalid")
    expect(JSON.stringify([...state.published, history])).not.toContain("<script>")
    await state.backend().dispatch("refresh")
    await expect(
      state.backend().dispatch("resumeConversation", {
        sessionId,
        acknowledgeOverage: true,
        acknowledgeUnverifiedBoundary: true,
      }),
    ).rejects.toThrow()
    expect(state.peers.reduce((total, entry) => total + entry.messages.length, 0)).toBe(1)
  } finally {
    await state.close()
  }
}, 15000)

async function until(read: () => Promise<DesktopState>, accept: (state: DesktopState) => boolean) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const state = await read()
    if (accept(state)) return state
    await Bun.sleep(5)
  }
  throw new Error("Claude desktop fixture did not settle")
}
