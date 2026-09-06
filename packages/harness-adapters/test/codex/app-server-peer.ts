import { createInterface } from "node:readline"
const scenario = process.argv[2] ?? "normal"
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const notification = (method: string, params: unknown) => output({ method, params })
let reads = 0
let turns = 0
let approvals: unknown[] = []
let requests: string[] = []
let initialized = false
const overrides: Record<string, unknown> = {}
for (const argument of process.argv.slice(3)) {
  if (!argument.includes("=")) continue
  const [path, value] = argument.split("=")
  const keys = path!.split(".")
  let table = overrides
  for (const key of keys.slice(0, -1)) table = (table[key] ??= {}) as Record<string, unknown>
  table[keys.at(-1)!] = JSON.parse(value!)
}
let cwd = ""
const thread = (id: string) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "full",
  modelProvider: "openai",
  model: "gpt-5.4",
  reasoningEffort: null,
  createdAt: 1,
  updatedAt: 1,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd,
  cliVersion: "0.153.4",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
})
const turn = (status = "inProgress") => ({
  id: "turn-1",
  items: [],
  itemsView: "full",
  status,
  error:
    status === "failed"
      ? { message: "native error must be sanitized", codexErrorInfo: null, additionalDetails: null }
      : null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: null,
})

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (!message.method) {
    approvals.push(message)
    continue
  }
  requests.push(message.method)
  const reply = (result: unknown) => output({ id: message.id, result })
  if (message.method === "initialize") {
    if (message.params.capabilities?.experimentalApi !== false) process.exit(20)
    reply({
      userAgent: `harness/${scenario === "wrong-version" ? "0.154.0" : "0.153.4"} (Windows 10.0.26200; x86_64) unknown (harness; 0.1.0)`,
      codexHome: "private-home",
      platformFamily: "windows",
      platformOs: "windows",
    })
    continue
  }
  if (message.method === "initialized") {
    initialized = true
    continue
  }
  if (!initialized) process.exit(21)
  if (message.method === "account/read") {
    if (message.params.refreshToken !== false) process.exit(22)
    reads++
    reply({
      account:
        scenario === "api"
          ? { type: "apiKey" }
          : {
              type: "chatgpt",
              email: scenario === "account-switch" && reads > 2 ? "second@example.invalid" : "first@example.invalid",
              planType: "pro",
            },
      requiresOpenaiAuth: true,
    })
  }
  if (message.method === "config/read") {
    reply({
      config: {
        ...overrides,
        model: "gpt-5.4",
        model_provider: scenario === "provider" ? "third-party" : "openai",
        forced_login_method: null,
        ...(scenario === "native-defaults"
          ? {
              cli_auth_credentials_store: "file",
              mcp_oauth_credentials_store: "auto",
              agents: {
                enabled: false,
                max_concurrent_threads_per_session: null,
                max_depth: null,
                default_subagent_model: null,
              },
              hooks: { SessionStart: [], SessionEnd: [], state: {} },
            }
          : {}),
        ...(scenario === "helper" ? { api_key_helper: "do-not-run" } : {}),
        ...(scenario === "profile" ? { profile: "other" } : {}),
        ...(scenario === "config-switch" && reads > 2 ? { model: "gpt-other" } : {}),
        ...(scenario === "mcp" ? { mcp_servers: { hidden: { command: "must-not-start" } } } : {}),
        ...(scenario === "ignored-overrides" ? { features: {} } : {}),
        ...(scenario === "shell-injection"
          ? { shell_environment_policy: { set: { OPENAI_API_KEY: "fixture-do-not-forward" } } }
          : {}),
      },
      origins: {},
      layers: null,
    })
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    cwd = message.params.cwd
    if (message.params.approvalPolicy !== "never" || message.params.modelProvider !== "openai") process.exit(23)
    reply({
      thread: {
        ...thread(message.params.threadId ?? "thread-1"),
        ...(scenario === "active-thread" ? { status: { type: "active", activeFlags: [] } } : {}),
      },
      model: "gpt-5.4",
      modelProvider: scenario === "thread-provider" ? "third-party" : "openai",
      serviceTier: "default",
      cwd,
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: scenario === "thread-network" },
      reasoningEffort: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    })
  }
  if (message.method === "turn/start") {
    turns++
    if (message.params.input[0].type !== "text" || message.params.threadId !== "thread-1") process.exit(24)
    if (
      message.params.sandboxPolicy?.type !== "readOnly" ||
      message.params.sandboxPolicy.networkAccess !== false ||
      message.params.approvalsReviewer !== "user"
    )
      process.exit(26)
    if (scenario === "lost-dispatch") process.exit(25)
    notification("turn/started", { threadId: "thread-1", turn: turn() })
    reply({ turn: turn() })
    if (scenario === "hold") continue
    if (scenario === "approval") {
      output({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "untrusted-content", cwd },
      })
      output({
        id: "file-approval",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2" },
      })
      output({
        id: "permissions-approval",
        method: "item/permissions/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-3" },
      })
    }
    notification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-message",
      delta: "Hello",
    })
    notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-message", text: "Hello", phase: "final_answer" },
    })
    notification("future/event", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "native-safe-id",
      access_token: "never-retain-this",
      text: "unknown-sensitive-body",
    })
    notification("turn/completed", { threadId: "thread-1", turn: turn(scenario === "failed" ? "failed" : "completed") })
  }
  if (message.method === "turn/interrupt") {
    reply({})
    notification("turn/completed", { threadId: "thread-1", turn: turn("interrupted") })
  }
  if (message.method === "thread/unsubscribe") reply({ status: "unsubscribed" })
  if (message.method === "fixture/state") reply({ requests, turns, approvals })
  if (message.method === "fixture/account-updated") {
    notification("account/updated", { authMode: "apiKey", planType: null, token: "never-retain-this" })
    reply({})
  }
  if (message.method === "fixture/stale-events") {
    notification("turn/started", { threadId: "thread-1", turn: { ...turn(), id: "stale-turn" } })
    notification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "stale-turn",
      itemId: "stale-item",
      delta: "wrong-turn-content",
    })
    notification("turn/completed", { threadId: "thread-1", turn: { ...turn("completed"), id: "stale-turn" } })
    reply({})
  }
  if (message.method === "fixture/rate-limits") {
    notification("account/rateLimits/updated", { rateLimits: { limitId: "codex", remaining: 1 } })
    reply({})
  }
  if (message.method === "fixture/request-spoof") {
    output({ id: "spoof", method: "turn/completed", params: { threadId: "thread-1", turn: turn("completed") } })
    reply({})
  }
  if (message.method === "fixture/flood") {
    for (let index = 0; index < 1200; index++)
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-flood",
        delta: "x",
      })
    reply({})
  }
}
