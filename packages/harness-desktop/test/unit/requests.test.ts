import { describe, expect, test } from "bun:test"
import { decodeDesktopRequest } from "../../src/shared/requests"
import type { DesktopOperation } from "../../src/shared/contracts"

const start = {
  modelId: "model-id",
  acknowledgeOverage: true,
  allowFileChanges: false,
  acknowledgeUnverifiedBoundary: true,
}
const answer = {
  requestId: "input-a",
  action: "answer",
  selections: [{ questionId: "question-a", optionId: "option-a" }],
}

describe("desktop request decoder", () => {
  test("V1 accepts only opaque file/history IDs and explicit bounded native skill activations", () => {
    for (const operation of ["viewConversation", "inspectConversation", "reconcileConversation"] as const) {
      expect(decodeDesktopRequest(operation, { sessionId: "session-a" })).toEqual({ sessionId: "session-a" })
      expect(() => decodeDesktopRequest(operation, { sessionId: "../outside" })).toThrow()
      expect(() => decodeDesktopRequest(operation, { sessionId: "session-a", replay: true })).toThrow()
    }
    expect(() => decodeDesktopRequest("previewFile", { path: "C:/secret" })).toThrow()
    expect(() =>
      decodeDesktopRequest("resumeConversation", {
        sessionId: "session-a",
        acknowledgeOverage: "yes",
        acknowledgeUnverifiedBoundary: true,
      }),
    ).toThrow()
    const skill = { skillId: "skill-a", sha256: "a".repeat(64), invocation: "model" }
    expect(decodeDesktopRequest("start", { ...start, skills: [skill] })).toMatchObject({ skills: [skill] })
    for (const skills of [
      [skill, skill],
      Array(17).fill(skill),
      [{ ...skill, sha256: "new" }],
      [{ ...skill, root: "C:/secret" }],
      [{ ...skill, invocation: "automatic" }],
    ])
      expect(() => decodeDesktopRequest("start", { ...start, skills })).toThrow()
    let calls = 0
    const skills = [skill]
    Object.defineProperty(skills, 0, {
      get() {
        calls++
        return skill
      },
      enumerable: true,
    })
    expect(() => decodeDesktopRequest("start", { ...start, skills })).toThrow()
    expect(calls).toBe(0)
  })
  test("accepts only a named runtime selection without paths or account overrides", () => {
    expect(decodeDesktopRequest("selectRuntime", { runtime: "claude" })).toEqual({ runtime: "claude" })
    expect(decodeDesktopRequest("selectRuntime", { runtime: "codex" })).toEqual({ runtime: "codex" })
    for (const input of [
      { runtime: "api" },
      { runtime: "claude", executable: "untrusted.exe" },
      {},
      { runtime: "Claude" },
    ])
      expect(() => decodeDesktopRequest("selectRuntime", input)).toThrow()
  })
  test("accepts bounded operation-specific requests and detaches nested caller state", () => {
    for (const operation of ["getState", "refresh", "interrupt", "shutdown"] as const) {
      for (const value of [undefined, null, {}]) expect(decodeDesktopRequest(operation, value)).toEqual({})
    }
    for (const [operation, input] of [
      ["start", start],
      ["send", { text: "hello\nthere" }],
      ["review", { kind: "permission", requestId: "request-a" }],
      ["resolvePermission", { requestId: "request-a", choiceId: "deny" }],
      ["resolveInput", answer],
      ["resolveInput", { requestId: "input-a", action: "cancel", selections: [] }],
      [
        "configure",
        { workspace: { id: "workspace-a", name: "Project", path: "C:/workspace" }, executable: "C:/tools/codex.exe" },
      ],
    ] satisfies [DesktopOperation, unknown][])
      expect(decodeDesktopRequest(operation, input)).toEqual(input)
    const source = structuredClone(answer)
    const decoded = decodeDesktopRequest("resolveInput", source)
    source.selections[0]!.optionId = "changed"
    expect(decoded).toEqual(answer)
  })

  test("requires explicit booleans and rejects unknown or missing start fields", () => {
    for (const key of ["acknowledgeOverage", "allowFileChanges", "acknowledgeUnverifiedBoundary"]) {
      for (const value of [undefined, null, "true", 1, {}])
        expect(() => decodeDesktopRequest("start", { ...start, [key]: value })).toThrow()
    }
    for (const input of [
      { ...start, modelId: "" },
      { ...start, modelId: "m".repeat(129) },
      { ...start, bypass: true },
      { modelId: "model" },
    ])
      expect(() => decodeDesktopRequest("start", input)).toThrow()
    expect(() => decodeDesktopRequest("start", { ...start, modelId: "m".repeat(128) })).not.toThrow()
  })

  test("bounds text by UTF-8 bytes and rejects empty or NUL input", () => {
    for (const text of ["", " \n\t", "hello\0there", "x".repeat(65537), "é".repeat(32769)])
      expect(() => decodeDesktopRequest("send", { text })).toThrow()
    for (const text of ["x".repeat(65536), "é".repeat(32768)])
      expect(() => decodeDesktopRequest("send", { text })).not.toThrow()
  })

  test("rejects unsupported operations, scalar requests and unrecognized privilege fields", () => {
    expect(() => decodeDesktopRequest("spawn" as DesktopOperation, {})).toThrow()
    for (const value of [[], 1, "x", true, Object.create(null)])
      expect(() => decodeDesktopRequest("send", value)).toThrow()
    for (const input of [{ path: "C:/secret" }, { shell: "cmd" }, { actorId: "other" }, { key: "secret" }])
      expect(() => decodeDesktopRequest("getState", input)).toThrow()
    expect(() => decodeDesktopRequest("send", { text: "hello", runtimeMethod: "thread/start" })).toThrow()
  })

  test("accepts only explicit review kinds and safe bounded opaque identities", () => {
    expect(() => decodeDesktopRequest("review", { kind: "other", requestId: "request" })).toThrow()
    for (const requestId of ["", "../request", "request\n", "a".repeat(257), "token secret", null]) {
      expect(() => decodeDesktopRequest("review", { kind: "input", requestId })).toThrow()
      expect(() => decodeDesktopRequest("resolvePermission", { requestId, choiceId: "deny" })).toThrow()
    }
    expect(() =>
      decodeDesktopRequest("resolvePermission", { requestId: "request", choiceId: "deny", reviewToken: "" }),
    ).toThrow()
    expect(() =>
      decodeDesktopRequest("resolvePermission", { requestId: "request", choiceId: "deny", actorId: "forged" }),
    ).toThrow()
  })

  test("requires one to three distinct question selections for answers and none for cancellation", () => {
    const selections = answer.selections
    for (const input of [
      { ...answer, action: "grant" },
      { ...answer, selections: [] },
      { ...answer, selections: [...selections, ...selections] },
      {
        ...answer,
        selections: Array.from({ length: 4 }, (_, index) => ({
          questionId: `question-${index}`,
          optionId: "option-a",
        })),
      },
      { ...answer, action: "cancel" },
      { ...answer, selections: [{ questionId: "question-a", optionId: "option-a", text: "unoffered raw answer" }] },
      { ...answer, selections: [{ questionId: "question-a", optionId: "" }] },
      { ...answer, selections: new Array(1) },
    ])
      expect(() => decodeDesktopRequest("resolveInput", input)).toThrow()
  })

  test("rejects accessors at each object boundary without executing them", () => {
    let reads = 0
    const top = Object.defineProperty({}, "text", {
      enumerable: true,
      get: () => {
        reads++
        return "hello"
      },
    })
    expect(() => decodeDesktopRequest("send", top)).toThrow()
    const selection = Object.defineProperty({ questionId: "question-a" }, "optionId", {
      enumerable: true,
      get: () => {
        reads++
        return "option-a"
      },
    })
    expect(() => decodeDesktopRequest("resolveInput", { ...answer, selections: [selection] })).toThrow()
    expect(reads).toBe(0)
  })
})
