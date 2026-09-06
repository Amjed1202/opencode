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
    const returnState = async () => current
    Object.defineProperty(window, "fixture", {
      value: {
        calls,
        publish(value: DesktopState) {
          current = value
          listeners.forEach((listener) => listener(value))
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
        }
        return current
      },
      chooseNativeHome: returnState,
      chooseSkillsRoot: returnState,
      refresh: returnState,
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
  await page.getByLabel("Native model ID", { exact: true }).fill("fixture-model")
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
  await page.getByLabel("Native model ID", { exact: true }).fill("fixture-model")
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
  await expect(page.getByLabel("Native model ID", { exact: true })).toHaveValue("")
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
