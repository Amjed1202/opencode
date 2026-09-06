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
      "Native activation will be available with the Claude Code adapter. These skills are not active in Codex.",
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
