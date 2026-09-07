import { createInterface } from "node:readline"
import { basename, resolve } from "node:path"
import type { Model } from "../../src/codex/generated/0.153.4/v2/Model"
import { isRecord } from "../../src/codex/stdio"
const scenario = process.argv[2] ?? "normal"
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const notification = (method: string, params: unknown) => output({ method, params })
let reads = 0
let turns = 0
let approvals: unknown[] = []
let requests: string[] = []
let initialized = false
let historyRead = false
let modelLists = 0
const modelRequests: unknown[] = []
const startedModels: string[] = []
const executionSettings: { method: string; approval: string; sandbox: string }[] = []
const pendingWrites = new Map<string, { path: string; content: string }>()
function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => {
      const before = left[key]
      const after = right[key]
      return [
        key,
        after === undefined
          ? before
          : before &&
              after &&
              typeof before === "object" &&
              typeof after === "object" &&
              !Array.isArray(before) &&
              !Array.isArray(after)
            ? merge(before as Record<string, unknown>, after as Record<string, unknown>)
            : after,
      ]
    }),
  )
}
const overrides = process.argv
  .slice(3)
  .filter((argument) => argument.includes("="))
  .reduce<Record<string, unknown>>(
    (config, argument) => merge(config, Bun.TOML.parse(argument) as Record<string, unknown>),
    {},
  )
let cwd = process.cwd()
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
const model = (name: string): Model => ({
  id: `catalog-${name}`,
  model: name,
  displayName: name === "gpt-5.4" ? "GPT-5.4" : name === "gpt-5.4-mini" ? "GPT-5.4 mini" : name,
  description: "Native fixture description must not be retained",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: name === "gpt-5.4",
})

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (!message.method) {
    approvals.push(message)
    const pending = pendingWrites.get(message.id)
    pendingWrites.delete(message.id)
    if (pending && message.result?.decision === "accept") await Bun.write(pending.path, pending.content)
    continue
  }
  requests.push(message.method)
  const reply = (result: unknown) => output({ id: message.id, result })
  if (message.method === "initialize") {
    if (message.params.capabilities?.experimentalApi !== false) process.exit(20)
    reply({
      userAgent: `harness/${scenario === "wrong-version" || (scenario === "isolation-wrong-version" && isRecord(overrides.plugins)) ? "0.154.0" : "0.153.4"} (Windows 10.0.26200; x86_64) unknown (harness; 0.1.0)`,
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
              email:
                (scenario === "account-switch" && reads > 2) ||
                (scenario === "history-account-switch" && historyRead) ||
                (scenario === "models-account-switch" && modelLists > 0)
                  ? "second@example.invalid"
                  : "first@example.invalid",
              planType: "pro",
            },
      requiresOpenaiAuth: true,
    })
  }
  if (message.method === "config/read") {
    if (scenario === "isolation-early-callbacks") {
      output({ id: `early-auth-${reads}`, method: "account/chatgptAuthTokens/refresh", params: {} })
      output({
        id: `early-command-${reads}`,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "unowned", turnId: "unowned", itemId: "unowned" },
      })
    }
    const source = scenario.startsWith("isolation-")
      ? {
          shell_environment_policy: {
            set: { FIXTURE_ENV: "fixture-do-not-forward", FIXTURE_OTHER: "fixture-do-not-forward" },
          },
          mcp_servers: { "fixture.server": { command: "fixture-must-not-start", enabled: true } },
          plugins: { "fixture.plugin@market": { enabled: true, mcp_servers: { hidden: { enabled: true } } } },
          notify: ["fixture-must-not-start", "fixture-private-argument"],
        }
      : {}
    const effective = scenario === "isolation-ignored" ? merge(overrides, source) : merge(source, overrides)
    if (scenario === "isolation-malformed")
      effective.shell_environment_policy = { set: { "BAD.KEY": "fixture-never-forward" } }
    const changed = startedModels.length > 0
    const isolated =
      isRecord(effective.shell_environment_policy) &&
      isRecord(effective.shell_environment_policy.set) &&
      effective.shell_environment_policy.set.FIXTURE_ENV === ""
    if (
      scenario === "isolation-new-key" &&
      isolated &&
      isRecord(effective.shell_environment_policy) &&
      isRecord(effective.shell_environment_policy.set)
    )
      effective.shell_environment_policy.set.NEW_ENTRY = ""
    if (
      scenario === "isolation-env-change" &&
      changed &&
      isRecord(effective.shell_environment_policy) &&
      isRecord(effective.shell_environment_policy.set)
    )
      effective.shell_environment_policy.set.FIXTURE_ENV = "fixture-new-value"
    if (
      scenario === "isolation-plugin-change" &&
      changed &&
      isRecord(effective.plugins) &&
      isRecord(effective.plugins["fixture.plugin@market"])
    )
      effective.plugins["fixture.plugin@market"].enabled = true
    if (scenario === "isolation-mcp-addition" && changed && isRecord(effective.mcp_servers))
      effective.mcp_servers.NEW_ENTRY = { command: "fixture-must-not-start", enabled: false }
    if (scenario === "isolation-notify-change" && changed) effective.notify = ["fixture-must-not-start"]
    if (
      (scenario === "shell-tool-ignored" || (scenario === "shell-tool-change" && changed)) &&
      isRecord(effective.features)
    )
      effective.features.shell_tool = true
    if (scenario === "isolation-delay-config") await new Promise((resolve) => setTimeout(resolve, 100))
    reply({
      config: {
        ...effective,
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
        ...(scenario === "custom-endpoint" ? { chatgpt_base_url: "https://fixture.invalid/backend-api/" } : {}),
        ...(scenario === "endpoint-suffix"
          ? { chatgpt_base_url: "https://chatgpt.com.fixture.invalid/backend-api/" }
          : {}),
        ...(scenario === "endpoint-path" ? { chatgpt_base_url: "https://chatgpt.com/backend-api/other" } : {}),
        ...(scenario === "config-switch" && reads > 2 ? { model: "gpt-other" } : {}),
        ...(scenario === "history-config-switch" && historyRead ? { model: "gpt-other" } : {}),
        ...(scenario === "models-config-switch" && modelLists > 0 ? { model: "gpt-other" } : {}),
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
  if (message.method === "model/list") {
    modelLists++
    modelRequests.push(message.params)
    if (
      message.params.includeHidden !== false ||
      !Number.isInteger(message.params.limit) ||
      message.params.limit < 1 ||
      message.params.limit > 100
    )
      process.exit(27)
    const data: unknown[] = [
      { ...model("gpt-5.4"), token: "private-model-token", privatePath: "private-model-path" },
      model("gpt-5.4-mini"),
    ]
    if (scenario === "models-error") {
      output({
        id: message.id,
        error: { code: -32601, message: "private-model-error", data: { token: "private-token" } },
      })
      continue
    }
    if (scenario === "models-delay") {
      setTimeout(() => reply({ data, nextCursor: null }), 1000)
      continue
    }
    if (scenario === "models-no-response") continue
    if (scenario === "models-account-event") notification("account/updated", { authMode: "chatgpt", planType: "pro" })
    if (scenario === "models-config-event") notification("config/updated", { private: "must-not-retain" })
    if (scenario === "models-empty") data.length = 0
    if (scenario === "models-disappear" && modelLists > 1) data.splice(0, 1)
    if (scenario === "models-hidden") data.push({ ...model("gpt-hidden"), hidden: true })
    if (scenario === "models-all-hidden") data.splice(0, data.length, { ...model("gpt-hidden"), hidden: true })
    if (scenario === "models-duplicate") data.push(model("gpt-5.4"))
    if (scenario === "models-malformed") data[0] = { ...model("gpt-5.4"), model: 42 }
    if (scenario === "models-malformed-id") data[0] = { ...model("gpt-5.4"), model: "../private-model" }
    if (scenario === "models-long-id") data[0] = { ...model("gpt-5.4"), model: "x".repeat(129) }
    if (scenario === "models-malformed-name") data[0] = { ...model("gpt-5.4"), displayName: "Model\nPrivate" }
    if (scenario === "models-blank-name") data[0] = { ...model("gpt-5.4"), displayName: " " }
    if (scenario === "models-padded-name") data[0] = { ...model("gpt-5.4"), displayName: " Model " }
    if (scenario === "models-long-name") data[0] = { ...model("gpt-5.4"), displayName: "x".repeat(257) }
    if (scenario === "models-malformed-hidden") data[0] = { ...model("gpt-5.4"), hidden: "false" }
    if (scenario === "models-missing-hidden") data[0] = { model: "gpt-5.4", displayName: "GPT-5.4" }
    if (scenario === "models-paginated" || scenario === "models-duplicate-pages") {
      if (modelLists === 1) reply({ data: [data[0]], nextCursor: "opaque:page/2+=" })
      else {
        if (message.params.cursor !== "opaque:page/2+=") process.exit(28)
        reply({ data: [data[scenario === "models-paginated" ? 1 : 0]], nextCursor: null })
      }
      continue
    }
    if (["models-total", "models-limit", "models-byte-limit"].includes(scenario)) {
      const count = scenario === "models-total" && modelLists === 3 ? 57 : message.params.limit
      reply({
        data: Array.from({ length: count }, (_entry, index) => ({
          ...model(`gpt-page-${modelLists}-${index}`),
          ...(scenario === "models-byte-limit" ? { displayName: "測".repeat(256) } : {}),
        })),
        nextCursor: modelLists === 3 ? null : `page-${modelLists + 1}`,
      })
      continue
    }
    if (scenario === "models-too-many") {
      reply({ data: Array.from({ length: 101 }, (_entry, index) => model(`gpt-${index}`)), nextCursor: null })
      continue
    }
    if (scenario === "models-page-limit" || scenario === "models-cursor-loop") {
      reply({
        data: [model(`gpt-page-${modelLists}`)],
        nextCursor: scenario === "models-cursor-loop" ? "loop" : `page-${modelLists}`,
      })
      continue
    }
    if (scenario === "models-malformed-response") {
      reply({ data: "not-an-array", nextCursor: null })
      continue
    }
    if (scenario === "models-missing-cursor") {
      reply({ data })
      continue
    }
    reply({
      data,
      nextCursor:
        scenario === "models-invalid-cursor" ? 42 : scenario === "models-long-cursor" ? "x".repeat(4097) : null,
      private: "native-model-catalog-metadata",
    })
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    cwd = message.params.cwd
    if (
      !["never", "on-request", "untrusted"].includes(message.params.approvalPolicy) ||
      message.params.modelProvider !== "openai"
    )
      process.exit(23)
    executionSettings.push({
      method: message.method,
      approval: message.params.approvalPolicy,
      sandbox: message.params.sandbox,
    })
    if (typeof message.params.model !== "string") process.exit(29)
    startedModels.push(message.params.model)
    reply({
      thread: {
        ...thread(message.params.threadId ?? "thread-1"),
        model: message.params.model,
        ...(scenario === "active-thread" ? { status: { type: "active", activeFlags: [] } } : {}),
      },
      model: message.params.model,
      modelProvider: scenario === "thread-provider" ? "third-party" : "openai",
      serviceTier: "default",
      cwd,
      instructionSources: [],
      approvalPolicy: scenario === "thread-approval-fallback" ? "on-request" : message.params.approvalPolicy,
      approvalsReviewer: scenario === "thread-reviewer" ? "auto_review" : "user",
      sandbox:
        message.params.sandbox === "workspace-write" || scenario === "thread-writable"
          ? {
              type: "workspaceWrite",
              networkAccess: false,
              writableRoots: [cwd],
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : {
              type: "readOnly",
              networkAccess: scenario === "thread-network",
              ...(scenario === "thread-extra-root" ? { writableRoots: [cwd] } : {}),
            },
      reasoningEffort: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    })
  }
  if (message.method === "turn/start") {
    turns++
    executionSettings.push({
      method: message.method,
      approval: message.params.approvalPolicy,
      sandbox: message.params.sandboxPolicy?.type,
    })
    if (message.params.input[0].type !== "text" || message.params.threadId !== "thread-1") process.exit(24)
    if (
      !["readOnly", "workspaceWrite"].includes(message.params.sandboxPolicy?.type) ||
      message.params.sandboxPolicy.networkAccess !== false ||
      message.params.approvalsReviewer !== "user"
    )
      process.exit(26)
    if (scenario === "lost-dispatch") process.exit(25)
    notification("turn/started", { threadId: "thread-1", turn: turn() })
    reply({ turn: turn() })
    if (scenario === "hold" || scenario === "write-gate") continue
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
  if (message.method === "thread/read") {
    historyRead = true
    reply({ thread: thread(message.params.threadId) })
  }
  if (message.method === "thread/turns/list")
    reply({ data: [{ ...turn("completed"), itemsView: "summary" }], nextCursor: null, backwardsCursor: null })
  if (message.method === "fixture/state")
    reply({ requests, turns, approvals, modelRequests, startedModels, executionSettings })
  if (message.method === "fixture/propose-write") {
    // A deterministic tool peer follows pinned native safety.rs routing, then performs a real fixture write.
    // This deliberately auto-applies on-request/workspaceWrite: unconditional approval mocks hid that defect.
    const { id, path, content, shell } = message.params
    if (
      scenario !== "write-gate" ||
      !/^gate-[a-f0-9-]+\.txt$/.test(basename(path)) ||
      resolve(path) !== resolve(cwd, basename(path))
    )
      process.exit(30)
    const settings = executionSettings.at(-1)!
    if (settings.sandbox === "workspaceWrite" && (shell || settings.approval !== "untrusted")) {
      await Bun.write(path, content)
      reply({ outcome: "auto-applied" })
      continue
    }
    if (settings.approval === "never") {
      reply({ outcome: "blocked" })
      continue
    }
    if (!shell) {
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id,
          status: "inProgress",
          changes: [
            { path, kind: { type: "update", move_path: null }, diff: `@@ -1 +1 @@\n-before\n+${content.trim()}\n` },
          ],
        },
      })
    }
    pendingWrites.set(id, { path, content })
    output({
      id,
      method: shell ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: id,
        startedAtMs: Date.now(),
        ...(shell ? { command: "fixture-write", cwd } : {}),
      },
    })
    reply({ outcome: "pending" })
  }
  if (message.method === "fixture/native-request") {
    for (const item of message.params.notifications ?? []) notification(item.method, item.params)
    output(message.params.request)
    reply({})
  }
  if (message.method === "fixture/notification") {
    notification(message.params.method, message.params.params)
    reply({})
  }
  if (message.method === "fixture/terminal-notification") {
    notification("turn/completed", { threadId: "thread-1", turn: { ...turn(), status: message.params.status } })
    reply({})
  }
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
