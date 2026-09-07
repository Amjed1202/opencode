import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import type { DesktopAPI, DesktopState } from "../../src/shared/contracts"

const initial: DesktopState = {
  revision: 1,
  configuration: {
    workspace: { id: "workspace-a", name: "Review fixture", path: "C:/fixture" },
    executable: "C:/fixture/codex.exe",
    nativeHome: "C:/fixture/native",
  },
  connection: {
    status: "ready",
    runtimeName: "Codex",
    runtimeVersion: "0.153.4",
    authentication: "subscription",
    billing: "subscription",
    providerOverage: "unknown",
  },
  models: { status: "ready", items: [{ id: "fixture-model", name: "Fixture model" }] },
  messages: [],
  activity: [],
  permissions: [],
  inputs: [],
  skills: null,
  notices: [],
}

async function install(page: Page, state = initial) {
  await page.addInitScript((serialized) => {
    let current = JSON.parse(serialized) as DesktopState
    const calls: { method: string; input?: unknown }[] = []
    const listeners = new Set<(value: DesktopState) => void>()
    let refreshed: DesktopState | undefined
    let finishRefresh: (() => void) | undefined
    const returnState = async () => current
    Object.defineProperty(window, "fixture", {
      value: {
        calls,
        publish(value: DesktopState) {
          current = value
          listeners.forEach((listener) => listener(value))
        },
        deferRefresh(value: DesktopState) {
          refreshed = value
        },
        finishRefresh() {
          finishRefresh?.()
        },
      },
    })
    const api: DesktopAPI = {
      getState: returnState,
      chooseWorkspace: returnState,
      chooseRuntime: returnState,
      async selectRuntime(input) {
        calls.push({ method: "selectRuntime", input })
        if (current.session) throw new Error("A runtime is attached to this conversation")
        current = {
          ...current,
          revision: current.revision + 1,
          configuration: {
            runtime: input.runtime,
            ...(current.configuration.workspace ? { workspace: current.configuration.workspace } : {}),
            ...(current.configuration.userSkillsRoot ? { userSkillsRoot: current.configuration.userSkillsRoot } : {}),
          },
          connection: {
            status: "not-configured",
            runtimeName: input.runtime === "claude" ? "Claude Code" : "Codex",
            authentication: "unknown",
            billing: "unknown",
            providerOverage: "unknown",
          },
          models: { status: input.runtime === "claude" ? "unsupported" : "not-loaded", items: [] },
        }
        return current
      },
      chooseNativeHome: returnState,
      chooseSkillsRoot: returnState,
      async refresh() {
        calls.push({ method: "refresh" })
        if (refreshed) {
          await new Promise<void>((resolve) => {
            finishRefresh = resolve
          })
          current = refreshed
          refreshed = undefined
        }
        return current
      },
      async start(input) {
        calls.push({ method: "start", input })
        current = {
          ...current,
          revision: current.revision + 1,
          session: { id: "session-a", status: "idle", modelId: input.modelId },
        }
        return current
      },
      async send(input) {
        calls.push({ method: "send", input })
        current = {
          ...current,
          revision: current.revision + 1,
          messages: [...current.messages, { id: "user-a", role: "user", text: input.text }],
        }
        return current
      },
      async interrupt() {
        calls.push({ method: "interrupt" })
        return current
      },
      async viewConversation(input) {
        calls.push({ method: "viewConversation", input })
        current = {
          ...current,
          revision: current.revision + 1,
          history: { id: input.sessionId, partial: true, unconfirmedMessages: 1 },
          messages: [{ id: "saved-user", role: "user", text: "Saved attempted message" }],
        }
        return current
      },
      async inspectConversation(input) {
        calls.push({ method: "inspectConversation", input })
        current = {
          ...current,
          revision: current.revision + 1,
          inspection: {
            sessionId: input.sessionId,
            observedAt: new Date().toISOString(),
            nativeState: "idle",
            completeness: "complete",
            turnCount: 1,
            terminalTurns: 1,
            runningTurns: 0,
            unknownTurns: 0,
          },
        }
        return current
      },
      async reconcileConversation(input) {
        calls.push({ method: "reconcileConversation", input })
        current = {
          ...current,
          revision: current.revision + 1,
          conversations: {
            items: current.conversations!.items.map((item) =>
              item.id === input.sessionId ? { ...item, status: "idle" } : item,
            ),
            truncated: false,
          },
        }
        return current
      },
      async resumeConversation(input) {
        calls.push({ method: "resumeConversation", input })
        current = {
          ...current,
          revision: current.revision + 1,
          session: { id: input.sessionId, status: "idle", modelId: "fixture-model" },
        }
        return current
      },
      async detachConversation() {
        calls.push({ method: "detachConversation" })
        const detached = { ...current, revision: current.revision + 1, messages: [], permissions: [], inputs: [] }
        delete detached.session
        delete detached.history
        delete detached.inspection
        current = detached
        return current
      },
      async listFiles() {
        calls.push({ method: "listFiles" })
        return {
          items: [{ id: "opaque-file-a", path: "src/index.ts", bytes: 32, change: "modified" }],
          truncated: true,
          baseline: "session-start",
        }
      },
      async previewFile(input) {
        calls.push({ method: "previewFile", input })
        return {
          path: "src/index.ts",
          text: "<img src=x onerror=alert('unsafe')>",
          before: "Original",
          diff: "+<img src=x onerror=alert('unsafe')>",
          baseline: "session-start",
        }
      },
      async review(input) {
        calls.push({ method: "review", input })
        return {
          artifact: {
            id: "artifact-a",
            sensitivity: "restricted",
            mediaType: "application/json",
            sha256: "a".repeat(64),
            sizeBytes: 40,
          },
          content:
            input.kind === "permission"
              ? {
                  kind: "patch",
                  requestId: input.requestId,
                  operationSha256: "a".repeat(64),
                  changes: [{ path: "C:/fixture/index.ts", kind: "add", diff: "+<img src=x onerror=alert('unsafe')>" }],
                }
              : {
                  kind: "choice-input",
                  requestId: input.requestId,
                  operationSha256: "a".repeat(64),
                  questions: [
                    {
                      id: "question-a",
                      header: "Fixture question",
                      question: "Pick the intended behavior",
                      options: [
                        { id: "option-a", label: "Keep current behavior", description: "Preserves current semantics" },
                        { id: "option-b", label: "Change behavior", description: "Uses the proposed semantics" },
                      ],
                    },
                  ],
                },
          reviewToken: "review-token-fixture",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      },
      async resolvePermission(input) {
        calls.push({ method: "resolvePermission", input })
        current = { ...current, revision: current.revision + 1, permissions: [] }
        return current
      },
      async resolveInput(input) {
        calls.push({ method: "resolveInput", input })
        current = { ...current, revision: current.revision + 1, inputs: [] }
        return current
      },
      onState(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    Object.defineProperty(window, "harness", { value: api })
  }, JSON.stringify(state))
}

const binding = {
  requestId: "request-a",
  sessionId: "session-a",
  runtimeId: "codex",
  nativeSessionId: "native-session-a",
  nativeTurnId: "native-turn-a",
  nativeRequestId: "native-request-a",
  targetId: "local",
  workspaceId: "workspace-a",
  policyId: "desktop-policy",
  policyVersion: "1",
  leaseGeneration: 1,
  operationSha256: "a".repeat(64),
}

const artifact = {
  id: "artifact-a",
  sensitivity: "restricted" as const,
  mediaType: "application/json",
  sha256: "a".repeat(64),
  sizeBytes: 40,
}

test("startup requires explicit native settings and never sends a prompt automatically", async ({ page }) => {
  await install(page)
  await page.goto("/")
  const start = page.getByRole("button", { name: "Start conversation", exact: true })
  await expect(start).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath("desktop-startup.png") })
  await expect(page.getByRole("combobox", { name: "Codex model", exact: true })).toHaveValue("")
  await expect(page.getByRole("option", { name: "Fixture model (fixture-model)", exact: true })).toHaveCount(1)
  await page.getByRole("combobox", { name: "Codex model", exact: true }).selectOption("fixture-model")
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await expect(start).toBeDisabled()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  await start.click()
  await expect(page.getByText("Conversation connected: fixture-model")).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Choose runtime" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await page.getByRole("textbox", { name: "Message to Codex", exact: true }).fill("Inspect the fixture repository")
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls.length))
    .toBe(1)
  await page.getByRole("textbox", { name: "Message to Codex", exact: true }).press("Control+Enter")
  await expect(page.getByText("Inspect the fixture repository", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    {
      method: "start",
      input: {
        modelId: "fixture-model",
        acknowledgeOverage: true,
        allowFileChanges: false,
        acknowledgeUnverifiedBoundary: true,
      },
    },
    { method: "send", input: { text: "Inspect the fixture repository" } },
  ])
})

test("connection checks load models without selecting or starting one automatically", async ({ page }) => {
  await install(page, { ...initial, models: { status: "not-loaded", items: [] } })
  await page.goto("/")
  const model = page.getByRole("combobox", { name: "Codex model", exact: true })
  const start = page.getByRole("button", { name: "Start conversation", exact: true })
  await expect(model).toBeDisabled()
  await expect(page.getByText("Check connection to load models from your selected Codex runtime.")).toBeVisible()
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  await expect(start).toBeDisabled()
  await page.evaluate(
    (serialized) => {
      const fixture = (window as unknown as { fixture: { deferRefresh(value: DesktopState): void } }).fixture
      fixture.deferRefresh(JSON.parse(serialized) as DesktopState)
    },
    JSON.stringify({ ...initial, revision: 2 }),
  )
  await page.getByRole("button", { name: "Check connection", exact: true }).click()
  await expect(page.locator("#model-status")).toHaveText("Loading models from Codex…")
  await expect(model).toBeDisabled()
  await expect(start).toBeDisabled()
  await page.evaluate(() => (window as unknown as { fixture: { finishRefresh(): void } }).fixture.finishRefresh())
  await expect(model).toBeEnabled()
  await expect(model).toHaveValue("")
  await expect(page.locator("#model-status")).toHaveText(
    "Models reported by Codex. Availability does not confirm plan access or billing.",
  )
  await expect(start).toBeDisabled()
  await expect(page.getByRole("textbox", { name: "Codex model", exact: true })).toHaveCount(0)
  await model.focus()
  await page.keyboard.press("ArrowDown")
  await expect(model).toHaveValue("fixture-model")
  await expect(start).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    { method: "refresh" },
  ])
})

test("a disappearing model clears the selection and requires another explicit choice", async ({ page }) => {
  await install(page)
  await page.goto("/")
  const model = page.getByRole("combobox", { name: "Codex model", exact: true })
  const start = page.getByRole("button", { name: "Start conversation", exact: true })
  await model.selectOption("fixture-model")
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  await expect(start).toBeEnabled()
  await page.evaluate(
    (serialized) =>
      (window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
        JSON.parse(serialized) as DesktopState,
      ),
    JSON.stringify({
      ...initial,
      revision: 2,
      models: { status: "ready", items: [{ id: "second-model", name: "Second model" }] },
    }),
  )
  await expect(model).toHaveValue("")
  await expect(page.getByRole("option", { name: "Fixture model (fixture-model)", exact: true })).toHaveCount(0)
  await expect(start).toBeDisabled()
  await model.selectOption("second-model")
  await expect(start).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
})

test("unavailable and empty catalogs prevent starting and recovery never restores an old selection", async ({
  page,
}) => {
  await install(page)
  await page.goto("/")
  const model = page.getByRole("combobox", { name: "Codex model", exact: true })
  const start = page.getByRole("button", { name: "Start conversation", exact: true })
  await model.selectOption("fixture-model")
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  await expect(start).toBeEnabled()
  for (const [index, status] of ["unavailable", "ready"].entries()) {
    await page.evaluate(
      (serialized) =>
        (window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
          JSON.parse(serialized) as DesktopState,
        ),
      JSON.stringify({ ...initial, revision: index + 2, models: { status, items: [] } }),
    )
    await expect(model).toBeDisabled()
    await expect(model).toHaveValue("")
    await expect(model.locator("option")).toHaveCount(1)
    await expect(page.locator("#model-status")).toHaveText(
      "No model catalog is available. Check connection again before starting.",
    )
    await expect(start).toBeDisabled()
  }
  await page.evaluate(
    (serialized) =>
      (window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
        JSON.parse(serialized) as DesktopState,
      ),
    JSON.stringify({ ...initial, revision: 4 }),
  )
  await expect(model).toBeEnabled()
  await expect(model).toHaveValue("")
  await expect(start).toBeDisabled()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
})

test("workspace, executable and account-home changes clear an otherwise available model", async ({ page }) => {
  await install(page)
  await page.goto("/")
  const model = page.getByRole("combobox", { name: "Codex model", exact: true })
  const start = page.getByRole("button", { name: "Start conversation", exact: true })
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  const configurations = [
    { ...initial.configuration, workspace: { id: "workspace-b", name: "Review fixture", path: "C:/fixture" } },
    { ...initial.configuration, workspace: { id: "workspace-b", name: "Review fixture", path: "C:/another" } },
    {
      ...initial.configuration,
      workspace: { id: "workspace-b", name: "Review fixture", path: "C:/another" },
      executable: "C:/another/codex.exe",
    },
    {
      ...initial.configuration,
      workspace: { id: "workspace-b", name: "Review fixture", path: "C:/another" },
      executable: "C:/another/codex.exe",
      nativeHome: "C:/another/native",
    },
  ]
  for (const [index, configuration] of configurations.entries()) {
    await page.getByLabel("I have checked my provider’s spending settings").check()
    await page.getByLabel("I understand the operating-system execution boundary").check()
    await model.selectOption("fixture-model")
    await expect(start).toBeEnabled()
    await page.evaluate(
      (serialized) =>
        (window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
          JSON.parse(serialized) as DesktopState,
        ),
      JSON.stringify({ ...initial, revision: index + 2, configuration }),
    )
    await expect(model).toHaveValue("")
    await expect(start).toBeDisabled()
  }
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
})

test("patch approval requires opening protected text and never renders it as HTML", async ({ page }) => {
  await install(page, {
    ...initial,
    session: { id: "session-a", status: "awaiting-permission", modelId: "fixture-model" },
    permissions: [
      {
        ...binding,
        action: "file-change",
        resources: ["C:/fixture/index.ts"],
        details: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reviewArtifact: artifact,
        choices: [
          { id: "allow-once", action: "allow", scope: "once", label: "Allow once" },
          { id: "deny", action: "deny", scope: "once", label: "Deny" },
        ],
      },
    ],
  })
  await page.goto("/")
  await page.getByRole("tab", { name: "Review" }).click()
  await expect(page.getByRole("button", { name: "Allow once" })).toBeDisabled()
  await page.getByRole("button", { name: "Open protected review" }).click()
  await expect(page.locator(".review-diff")).toHaveText("+<img src=x onerror=alert('unsafe')>")
  await expect(page.locator(".review-diff img")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("desktop-patch-review.png") })
  await page.getByRole("button", { name: "Allow once" }).click()
  await expect(page.getByText("Nothing waiting for review")).toBeVisible()
  const calls = await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)
  expect(calls).toEqual([
    { method: "review", input: { kind: "permission", requestId: "request-a" } },
    {
      method: "resolvePermission",
      input: { requestId: "request-a", choiceId: "allow-once", reviewToken: "review-token-fixture" },
    },
  ])
})

test("fixed-choice questions send offered IDs after review", async ({ page }) => {
  await install(page, {
    ...initial,
    session: { id: "session-a", status: "awaiting-input", modelId: "fixture-model" },
    inputs: [
      {
        ...binding,
        prompt: "Choose one option for each question.",
        schemaId: "harness.choice-input.v1",
        questions: [{ id: "question-a", optionIds: ["option-a", "option-b"] }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reviewArtifact: artifact,
      },
    ],
  })
  await page.goto("/")
  await page.getByRole("tab", { name: "Review" }).click()
  await expect(page.getByRole("button", { name: "Send answers" })).toBeDisabled()
  await page.getByRole("button", { name: "Open protected review" }).click()
  await expect(page.getByRole("button", { name: "Send answers" })).toBeDisabled()
  await page.getByRole("radio", { name: "Keep current behavior Preserves current semantics" }).check()
  await page.getByRole("button", { name: "Send answers" }).click()
  const calls = await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)
  expect(calls).toEqual([
    { method: "review", input: { kind: "input", requestId: "request-a" } },
    {
      method: "resolveInput",
      input: {
        requestId: "request-a",
        action: "answer",
        selections: [{ questionId: "question-a", optionId: "option-a" }],
        reviewToken: "review-token-fixture",
      },
    },
  ])
})

test("expired protected content is removed and approval becomes unavailable", async ({ page }) => {
  await page.clock.install()
  await install(page, {
    ...initial,
    session: { id: "session-a", status: "awaiting-permission", modelId: "fixture-model" },
    permissions: [
      {
        ...binding,
        action: "file-change",
        resources: ["C:/fixture/index.ts"],
        details: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reviewArtifact: artifact,
        choices: [
          { id: "allow-once", action: "allow", scope: "once", label: "Allow once" },
          { id: "deny", action: "deny", scope: "once", label: "Deny" },
        ],
      },
    ],
  })
  await page.goto("/")
  await page.getByRole("tab", { name: "Review" }).click()
  await page.getByRole("button", { name: "Open protected review" }).click()
  await expect(page.getByRole("button", { name: "Allow once" })).toBeEnabled()
  await page.clock.runFor(61_000)
  await expect(page.getByRole("button", { name: "Allow once" })).toBeDisabled()
  await expect(page.locator(".review-diff")).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      (window as unknown as { fixture: { calls: { method: string }[] } }).fixture.calls.map((call) => call.method),
    ),
  ).toEqual(["review"])
})

test("older snapshots cannot replace current state and mobile context remains accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await install(page)
  await page.goto("/")
  await page.evaluate((serialized) => {
    const next = JSON.parse(serialized) as DesktopState
    const fixture = (window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture
    fixture.publish({ ...next, revision: 3, notices: ["Current projection"] })
    fixture.publish({ ...next, revision: 2, notices: ["Stale projection"] })
  }, JSON.stringify(initial))
  await expect(page.getByText("Current projection")).toBeVisible()
  await expect(page.getByText("Stale projection")).toHaveCount(0)
  await page.getByRole("button", { name: "Open runtime and context" }).click()
  await expect(page.getByRole("heading", { name: "Runtime & context" })).toBeVisible()
  await page.getByRole("tab", { name: "Activity", exact: true }).focus()
  await page.keyboard.press("End")
  await expect(page.getByRole("tab", { name: "Skills", exact: true })).toBeFocused()
  await expect(
    page.getByText(
      "Skills are cataloged only. Native activation is disabled until runtime execution and policy checks are supported.",
    ),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath("mobile-skills.png") })
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Open runtime and context" })).toBeFocused()
})

test("browser preview reports a missing desktop bridge and keeps execution disabled", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("alert")).toContainText("The desktop connection is unavailable")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeDisabled()
})

test("switching runtime invalidates Codex readiness and clears execution acknowledgments", async ({ page }) => {
  await install(page)
  await page.goto("/")
  await page.getByRole("combobox", { name: "Codex model", exact: true }).selectOption("fixture-model")
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  await page.getByLabel("Allow file changes in this repository").check()
  await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeEnabled()
  await page.getByRole("combobox", { name: "Choose runtime" }).selectOption("claude")
  await expect(page.getByRole("button", { name: "Choose Claude Code executable" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Connect your Claude Code account." })).toBeVisible()
  await expect(page.getByText("Subscription observed", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Connection ready", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Executable: C:/fixture/codex.exe", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Native account home: C:/fixture/native", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Check connection", exact: true })).toBeDisabled()
  await expect(page.getByRole("textbox", { name: "Message to Claude Code", exact: true })).toBeDisabled()
  await expect(page.getByRole("checkbox")).toHaveCount(0)
  await page.getByRole("combobox", { name: "Choose runtime" }).selectOption("codex")
  await page.evaluate(
    (serialized) =>
      (window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
        JSON.parse(serialized) as DesktopState,
      ),
    JSON.stringify({ ...initial, revision: 4 }),
  )
  await expect(page.getByRole("combobox", { name: "Codex model", exact: true })).toHaveValue("")
  await expect(page.getByLabel("I have checked my provider’s spending settings")).not.toBeChecked()
  await expect(page.getByLabel("I understand the operating-system execution boundary")).not.toBeChecked()
  await expect(page.getByLabel("Allow file changes in this repository")).not.toBeChecked()
  await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeDisabled()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    { method: "selectRuntime", input: { runtime: "claude" } },
    { method: "selectRuntime", input: { runtime: "codex" } },
  ])
})

test("Claude sign-in status never enables execution or native Skills when billing remains unknown", async ({
  page,
}) => {
  await install(page, {
    ...initial,
    configuration: { ...initial.configuration, runtime: "claude", executable: "C:/fixture/claude.exe" },
    connection: {
      status: "blocked",
      runtimeName: "Claude Code",
      runtimeVersion: "2.1.251",
      authentication: "authenticated",
      billing: "unknown",
      providerOverage: "unknown",
      reason: "Native billing and managed policy evidence is unavailable. Execution is disabled.",
    },
    models: { status: "unsupported", items: [] },
  })
  await page.goto("/")
  await expect(page.getByRole("combobox", { name: "Choose runtime" })).toHaveValue("claude")
  await expect(page.getByText("Signed in", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Native billing and managed policy evidence is unavailable. Execution is disabled.", {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByText("Subscription observed", { exact: true })).toHaveCount(0)
  await expect(page.getByText(/home folder containing \.claude/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await expect(page.getByRole("combobox", { name: "Codex model", exact: true })).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Message to Claude Code", exact: true })).toBeDisabled()
  await page.getByRole("tab", { name: "Skills", exact: true }).click()
  await expect(
    page.getByText(
      "Skills are cataloged only. Native activation is disabled until runtime execution and policy checks are supported.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /activate|enable/i })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
})

const saved = {
  id: "saved-a",
  workspaceId: "workspace-a",
  runtimeId: "codex-local",
  modelId: "fixture-model",
  status: "uncertain",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:05:00.000Z",
  compatible: true,
}

for (const status of ["closed", "uncertain"] as const)
  test(`Claude ${status} history respects native resume and inspection support`, async ({ page }) => {
    await install(page, {
      ...initial,
      configuration: { ...initial.configuration, runtime: "claude" },
      connection: { ...initial.connection, runtimeName: "Claude Code", runtimeVersion: "2.1.251" },
      runtimeFeatures: { resume: true, inspection: false },
      conversations: { items: [{ ...saved, runtimeId: "claude-local", status }], truncated: false },
    })
    await page.goto("/")
    await page.locator(".session-item").click()
    const recovery = page.getByRole("region", { name: "Saved conversation" })
    await expect(recovery.getByRole("button", { name: "Inspect native state", exact: true })).toBeDisabled()
    await expect(recovery.getByRole("button", { name: "Reconcile uncertain work", exact: true })).toBeDisabled()
    await expect(recovery.getByText(/cannot verify uncertain native history/)).toBeVisible()
    await recovery.getByLabel("I have checked my provider’s spending settings").check()
    await recovery.getByLabel("I understand the operating-system execution boundary").check()
    if (status === "closed") {
      await expect(recovery.getByRole("button", { name: "Resume conversation", exact: true })).toBeEnabled()
      await recovery.getByRole("button", { name: "Resume conversation", exact: true }).click()
    } else await expect(recovery.getByRole("button", { name: "Resume conversation", exact: true })).toBeDisabled()
    const calls = await page.evaluate(
      () => (window as unknown as { fixture: { calls: { method: string }[] } }).fixture.calls,
    )
    expect(calls.map((call) => call.method)).toEqual(
      status === "closed" ? ["viewConversation", "resumeConversation"] : ["viewConversation"],
    )
  })

test("saved history requires explicit inspection, reconciliation and fresh consent before resume", async ({ page }) => {
  await install(page, { ...initial, conversations: { items: [saved], truncated: false } })
  await page.goto("/")
  await page.locator(".session-item").click()
  const recovery = page.getByRole("region", { name: "Saved conversation" })
  await expect(
    recovery.getByText("Partial local history. Viewing this conversation does not resume native work."),
  ).toBeVisible()
  await expect(page.getByText("Saved attempted message")).toBeVisible()
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await expect(recovery.getByRole("button", { name: "Resume conversation", exact: true })).toBeDisabled()
  await recovery.getByRole("button", { name: "Inspect native state", exact: true }).click()
  await expect(recovery.getByRole("status")).toContainText("Native state: idle")
  await expect(recovery.getByRole("button", { name: "Resume conversation", exact: true })).toBeDisabled()
  await recovery.getByRole("button", { name: "Reconcile uncertain work", exact: true }).click()
  await recovery.getByLabel("I have checked my provider’s spending settings").check()
  await recovery.getByLabel("I understand the operating-system execution boundary").check()
  await page.screenshot({ path: test.info().outputPath("desktop-conversation-recovery.png") })
  await recovery.getByRole("button", { name: "Resume conversation", exact: true }).click()
  await expect(recovery).toHaveCount(0)
  await page.getByRole("textbox", { name: "Message to Codex", exact: true }).fill("Unsent after resume")
  await page.getByRole("button", { name: "Close conversation", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message to Codex", exact: true })).toHaveValue("")
  await expect(page.locator(".session-item")).toHaveCount(1)
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    { method: "viewConversation", input: { sessionId: "saved-a" } },
    { method: "inspectConversation", input: { sessionId: "saved-a" } },
    { method: "reconcileConversation", input: { sessionId: "saved-a" } },
    {
      method: "resumeConversation",
      input: { sessionId: "saved-a", acknowledgeOverage: true, acknowledgeUnverifiedBoundary: true },
    },
    { method: "detachConversation" },
  ])
})

test("incompatible conversations stay readable while native recovery controls remain disabled", async ({ page }) => {
  await install(page, { ...initial, conversations: { items: [{ ...saved, compatible: false }], truncated: true } })
  await page.goto("/")
  await page.locator(".session-item").click()
  await expect(page.getByText("Saved attempted message")).toBeVisible()
  await expect(page.getByRole("button", { name: "Inspect native state" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Reconcile uncertain work" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Resume conversation" })).toBeDisabled()
  await expect(page.getByText(/select the original repository, runtime executable/)).toBeVisible()
  await expect(page.getByText("Showing the 100 most recently updated conversations.")).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    { method: "viewConversation", input: { sessionId: "saved-a" } },
  ])
})

test("file browsing is explicit, previews remain inert and workspace changes clear cached content", async ({
  page,
}) => {
  await install(page)
  await page.goto("/")
  await page.getByRole("tab", { name: "Files", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
  await page.getByRole("button", { name: "Refresh files", exact: true }).click()
  await expect(page.getByText("The file list reached its preview limit. Some files are omitted.")).toBeVisible()
  await page.getByRole("button", { name: "src/index.ts Modified", exact: true }).click()
  await expect(page.locator(".file-content")).toHaveText("+<img src=x onerror=alert('unsafe')>")
  await expect(page.locator(".file-content img")).toHaveCount(0)
  await page.getByRole("button", { name: "Current text", exact: true }).click()
  await expect(page.locator(".file-content")).toHaveText("<img src=x onerror=alert('unsafe')>")
  await page.screenshot({ path: test.info().outputPath("desktop-file-preview.png") })
  await page.evaluate(
    (serialized) => {
      ;(window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
        JSON.parse(serialized) as DesktopState,
      )
    },
    JSON.stringify({
      ...initial,
      revision: 2,
      configuration: {
        ...initial.configuration,
        workspace: { id: "workspace-b", name: "Another", path: "C:/another" },
      },
    }),
  )
  await expect(page.locator(".file-content")).toHaveCount(0)
  await expect(page.locator(".file-list")).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    { method: "listFiles" },
    { method: "previewFile", input: { fileId: "opaque-file-a" } },
  ])
})

test("usage shows reported cumulative tokens and native context without inventing unknown charges or counts", async ({
  page,
}) => {
  await install(page, {
    ...initial,
    usage: {
      id: "usage-a",
      sourceEventId: "usage-event",
      scope: { targetId: "local", sessionId: "session-a" },
      providerId: "openai",
      accountingScope: "session",
      accountingId: "accounting-a",
      epoch: "1",
      basis: "cumulative",
      includesSubagents: "unknown",
      completeness: "partial",
      evidence: { source: "native-status", observedAt: "2026-09-06T12:00:00Z" },
      billing: {
        route: "subscription",
        providerId: "openai",
        providerOverage: "unknown",
        evidence: { source: "native-status", observedAt: "2026-09-06T12:00:00Z" },
      },
      tokens: {
        input: 1234,
        output: 56,
        cacheRead: 100,
        cacheWrite: null,
        reasoning: null,
        cacheRelation: "included-in-input",
        reasoningRelation: "unknown",
      },
    },
    context: {
      sessionId: "session-a",
      epoch: "1",
      usedTokens: 1290,
      capacityTokens: 128000,
      basis: "native-context",
      compactions: null,
      evidence: { source: "native-status", observedAt: "2026-09-06T12:00:00Z" },
    },
  })
  await page.goto("/")
  await page.getByRole("tab", { name: "Usage", exact: true }).click()
  const usage = page.getByRole("tabpanel", { name: "Usage", exact: true })
  await expect(usage).toContainText("1,234")
  await expect(usage).toContainText("128,000")
  await expect(usage.locator("dt", { hasText: "Reasoning tokens" }).locator("+ dd")).toHaveText("Unknown")
  await expect(usage).toContainText("Cumulative counts reported by the native runtime")
  await expect(usage).toContainText("Unknown values are not zero")
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
})

test("Claude skill permissions are explicit, bounded, and cleared when the selected repository changes", async ({
  page,
}) => {
  const skill = {
    id: "skill-0",
    format: "claude-skill" as const,
    scope: "workspace" as const,
    workspaceId: "workspace-a",
    commandName: "plain-0",
    relativePath: ".claude/skills/plain-0/SKILL.md",
    sha256: "a".repeat(64),
    sizeBytes: 100,
    metadataStatus: "parsed" as const,
    invocation: { user: "allowed-by-metadata" as const, model: "allowed-by-metadata" as const },
    declared: { unknownFields: [] },
    observedFeatures: [],
    activation: { status: "disabled" as const, reason: "native-adapter-required" as const },
  }
  const configured: DesktopState = {
    ...initial,
    configuration: { ...initial.configuration, runtime: "claude" },
    connection: { ...initial.connection, runtimeName: "Claude Code", runtimeVersion: "2.1.251" },
    skills: {
      workspaceId: "workspace-a",
      roots: [{ scope: "workspace", status: "scanned" }],
      diagnostics: [],
      skills: [
        ...Array.from({ length: 9 }, (_value, index) => ({
          ...skill,
          id: `skill-${index}`,
          commandName: `plain-${index}`,
        })),
        { ...skill, id: "unsupported", commandName: "unsupported", observedFeatures: ["dynamic-shell"] },
      ],
    },
  }
  await install(page, configured)
  await page.goto("/")
  await page.getByRole("tab", { name: "Skills", exact: true }).click()
  await expect(page.getByLabel("Allow user invocation of /unsupported", { exact: true })).toBeDisabled()
  for (let index = 0; index < 8; index++) {
    await page.getByLabel(`Allow user invocation of /plain-${index}`, { exact: true }).check()
    await page.getByLabel(`Allow model invocation of /plain-${index}`, { exact: true }).check()
  }
  await expect(page.getByText("16/16 skill permissions selected", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Allow user invocation of /plain-8", { exact: true })).toBeDisabled()
  await page.getByLabel("Allow user invocation of /plain-0", { exact: true }).uncheck()
  await expect(page.getByLabel("Allow user invocation of /plain-8", { exact: true })).toBeEnabled()
  await page.evaluate(
    (serialized) => {
      ;(window as unknown as { fixture: { publish(value: DesktopState): void } }).fixture.publish(
        JSON.parse(serialized) as DesktopState,
      )
    },
    JSON.stringify({
      ...configured,
      revision: 2,
      configuration: { ...configured.configuration, workspace: { id: "workspace-b", name: "Other", path: "C:/other" } },
    }),
  )
  await expect(page.getByText("0/16 skill permissions selected", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Allow model invocation of /plain-0", { exact: true })).not.toBeChecked()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([])
})

test("verified Claude connection starts only with explicit model, billing and skill choices and sends separately", async ({
  page,
}) => {
  await install(page, {
    ...initial,
    configuration: { ...initial.configuration, runtime: "claude", executable: "C:/fixture/claude.exe" },
    connection: { ...initial.connection, runtimeName: "Claude Code", runtimeVersion: "2.1.251" },
    skills: {
      workspaceId: "workspace-a",
      roots: [{ scope: "workspace", status: "scanned" }],
      diagnostics: [],
      skills: [
        {
          id: "plain-skill",
          format: "claude-skill",
          scope: "workspace",
          workspaceId: "workspace-a",
          commandName: "plain",
          relativePath: ".claude/skills/plain/SKILL.md",
          sha256: "a".repeat(64),
          sizeBytes: 100,
          metadataStatus: "parsed",
          invocation: { user: "allowed-by-metadata", model: "allowed-by-metadata" },
          declared: { unknownFields: [] },
          observedFeatures: [],
          activation: { status: "disabled", reason: "native-adapter-required" },
        },
      ],
    },
  })
  await page.goto("/")
  const start = page.getByRole("button", { name: "Start conversation", exact: true })
  await expect(start).toBeDisabled()
  await page.getByRole("combobox", { name: "Claude Code model", exact: true }).selectOption("fixture-model")
  await page.getByLabel("I have checked my provider’s spending settings").check()
  await page.getByLabel("I understand the operating-system execution boundary").check()
  await page.getByRole("tab", { name: "Skills", exact: true }).click()
  await page.getByLabel("Allow user invocation of /plain", { exact: true }).check()
  await page.getByLabel("Allow model invocation of /plain", { exact: true }).check()
  await start.click()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls)).toEqual([
    {
      method: "start",
      input: {
        modelId: "fixture-model",
        acknowledgeOverage: true,
        acknowledgeUnverifiedBoundary: true,
        allowFileChanges: false,
        skills: [
          { skillId: "plain-skill", sha256: "a".repeat(64), invocation: "user" },
          { skillId: "plain-skill", sha256: "a".repeat(64), invocation: "model" },
        ],
      },
    },
  ])
  await page.getByRole("textbox", { name: "Message to Claude Code", exact: true }).fill("Explicit Claude message")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  expect(
    await page.evaluate(() => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls.at(-1)),
  ).toEqual({ method: "send", input: { text: "Explicit Claude message" } })
  await expect(page.getByText("Skill choices are fixed when the conversation starts.", { exact: true })).toBeVisible()
})
