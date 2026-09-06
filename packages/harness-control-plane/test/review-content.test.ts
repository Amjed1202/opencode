import { expect, test } from "bun:test"
import { join, resolve, sep } from "node:path"
import type {
  HumanInputRequest,
  HumanInputReviewContent,
  PermissionBinding,
  PermissionRequest,
  PermissionReviewContent,
} from "@harness/protocol"
import { validateReviewContent } from "../src/review-content"

const root = resolve(import.meta.dir, "review-fixture")
const binding: PermissionBinding = {
  requestId: "request",
  sessionId: "session",
  runtimeId: "runtime",
  targetId: "local",
  workspaceId: "workspace",
  nativeSessionId: "thread",
  nativeTurnId: "turn",
  nativeRequestId: "native-request",
  policyId: "policy",
  policyVersion: "1",
  leaseGeneration: 1,
  operationSha256: "a".repeat(64),
}

function patchRequest(resources = [join(root, "one.txt")]): PermissionRequest {
  return {
    ...binding,
    resources,
    action: "file-change",
    details: {},
    choices: [{ id: "allow", action: "allow", scope: "once", label: "Allow" }],
    expiresAt: "2026-09-06T13:00:00Z",
  }
}

function patch(): PermissionReviewContent {
  return {
    kind: "patch",
    requestId: binding.requestId,
    operationSha256: binding.operationSha256,
    changes: [{ path: join(root, "one.txt"), kind: "add", diff: "+reviewable content\n" }],
  }
}

function inputRequest(): HumanInputRequest {
  return {
    ...binding,
    prompt: "Choose one option for each question.",
    schemaId: "harness.choice-input.v1",
    questions: [{ id: "q1", optionIds: ["o1", "o2"] }],
    expiresAt: "2026-09-06T13:00:00Z",
  }
}

function input(): HumanInputReviewContent {
  return {
    kind: "choice-input",
    requestId: binding.requestId,
    operationSha256: binding.operationSha256,
    questions: [
      {
        id: "q1",
        header: "Approach",
        question: "Which supported approach should be used?",
        options: [
          { id: "o1", label: "First", description: "Use the first approach" },
          { id: "o2", label: "Second", description: "" },
        ],
      },
    ],
  }
}

test("returns detached patch and choice review content without equating operation and artifact digests", () => {
  const source = patch()
  const validated = validateReviewContent(source, patchRequest())
  expect(validated).toEqual(source)
  expect(validated).not.toBe(source)
  if (validated.kind !== "patch") throw new Error("wrong kind")
  expect(validated.changes).not.toBe(source.changes)
  expect(validateReviewContent(input(), inputRequest())).toEqual(input())
})

test("request identity, operation and content kind bind the protected review", () => {
  for (const value of [
    { ...patch(), requestId: "other" },
    { ...patch(), operationSha256: "b".repeat(64) },
    { ...patch(), operationSha256: "A".repeat(64) },
  ]) {
    expect(() => validateReviewContent(value, patchRequest())).toThrow("binding mismatch")
  }
  expect(() => validateReviewContent(input(), patchRequest())).toThrow()
  expect(() => validateReviewContent(patch(), inputRequest())).toThrow()
})

test("rejects unknown or missing keys at every protected content level", () => {
  for (const value of [
    { ...patch(), extra: true },
    { ...patch(), changes: [{ ...patch().changes[0]!, raw: "hidden" }] },
    { ...patch(), changes: [{ path: join(root, "one.txt"), kind: "add" }] },
    { ...input(), questions: [{ ...input().questions[0]!, answer: "hidden" }] },
    {
      ...input(),
      questions: [
        {
          ...input().questions[0]!,
          options: [{ ...input().questions[0]!.options[0]!, value: "hidden" }, input().questions[0]!.options[1]],
        },
      ],
    },
  ])
    expect(() => validateReviewContent(value, "changes" in value ? patchRequest() : inputRequest())).toThrow()
})

test("patch paths and move destinations must equal the exact normalized resource set without duplicates", () => {
  const moved: PermissionReviewContent = {
    ...patch(),
    changes: [
      { path: join(root, "one.txt"), kind: "update", movePath: join(root, "two.txt"), diff: "-before\n+after" },
    ],
  }
  expect(validateReviewContent(moved, patchRequest([join(root, "two.txt"), join(root, "one.txt")]))).toEqual(moved)
  if (process.platform === "win32") {
    const alternate = {
      ...patch(),
      changes: [{ ...patch().changes[0]!, path: join(root, "one.txt").replaceAll(sep, "/") }],
    }
    expect(validateReviewContent(alternate, patchRequest())).toEqual(alternate)
  }
  for (const value of [
    { ...patch(), changes: [] },
    { ...patch(), changes: [{ ...patch().changes[0]!, path: "relative.txt" }] },
    { ...patch(), changes: [{ ...patch().changes[0]!, path: join(root, "other.txt") }] },
    { ...patch(), changes: [patch().changes[0], patch().changes[0]] },
    { ...patch(), changes: [{ ...patch().changes[0]!, movePath: join(root, "two.txt") }] },
    { ...moved, changes: [{ ...moved.changes[0]!, movePath: join(root, "one.txt") }] },
    { ...patch(), changes: [{ ...patch().changes[0]!, kind: "unknown" }] },
    { ...patch(), changes: [{ ...patch().changes[0]!, diff: null }] },
    { ...patch(), changes: [{ ...patch().changes[0]!, path: `${root}\0invalid` }] },
  ])
    expect(() => validateReviewContent(value, patchRequest())).toThrow()
  expect(() =>
    validateReviewContent(patch(), patchRequest([join(root, "one.txt"), join(root, "missing.txt")])),
  ).toThrow("omits")
  expect(() => validateReviewContent(patch(), patchRequest([join(root, "one.txt"), join(root, "one.txt")]))).toThrow(
    "resources",
  )
})

test("input review must retain exact question and option identity order", () => {
  const two = { ...inputRequest(), questions: [...inputRequest().questions, { id: "q2", optionIds: ["o3", "o4"] }] }
  const content: HumanInputReviewContent = {
    ...input(),
    questions: [
      ...input().questions,
      {
        ...input().questions[0]!,
        id: "q2",
        options: [
          { id: "o3", label: "Third", description: "" },
          { id: "o4", label: "Fourth", description: "" },
        ],
      },
    ],
  }
  expect(validateReviewContent(content, two)).toEqual(content)
  expect(() => validateReviewContent({ ...content, questions: [...content.questions].reverse() }, two)).toThrow(
    "identity",
  )
  for (const questions of [
    [],
    [{ ...input().questions[0]!, id: "other" }],
    [{ ...input().questions[0]!, options: [...input().questions[0]!.options].reverse() }],
    [{ ...input().questions[0]!, options: [input().questions[0]!.options[0]] }],
    [{ ...input().questions[0]!, options: [input().questions[0]!.options[0], input().questions[0]!.options[0]] }],
    [
      {
        ...input().questions[0]!,
        options: [input().questions[0]!.options[0], { ...input().questions[0]!.options[1]!, label: "First" }],
      },
    ],
    Array.from({ length: 4 }, () => input().questions[0]),
  ])
    expect(() => validateReviewContent({ ...input(), questions }, inputRequest())).toThrow()
})

test("display strings are bounded and nonempty, descriptions may be empty, and controls are rejected", () => {
  for (const question of [
    { ...input().questions[0]!, header: " " },
    { ...input().questions[0]!, header: "x".repeat(129) },
    { ...input().questions[0]!, question: "x".repeat(4097) },
    { ...input().questions[0]!, question: "secret\ncontrol" },
    { ...input().questions[0]!, question: "\u202ereversed" },
    {
      ...input().questions[0]!,
      options: [{ ...input().questions[0]!.options[0]!, label: "x".repeat(257) }, input().questions[0]!.options[1]],
    },
    {
      ...input().questions[0]!,
      options: [
        { ...input().questions[0]!.options[0]!, description: "x".repeat(1025) },
        input().questions[0]!.options[1],
      ],
    },
  ])
    expect(() => validateReviewContent({ ...input(), questions: [question] }, inputRequest())).toThrow()
  expect(validateReviewContent(input(), inputRequest())).toEqual(input())
})

test("JSON byte, change count and option count limits are enforced before returning content", () => {
  const changes = Array.from({ length: 256 }, (_, index) => ({
    path: join(root, `${index}.txt`),
    kind: "add" as const,
    diff: "",
  }))
  expect(
    validateReviewContent({ ...patch(), changes }, patchRequest(changes.map((change) => change.path))),
  ).toMatchObject({ changes })
  expect(() =>
    validateReviewContent(
      { ...patch(), changes: [...changes, changes[0]] },
      patchRequest(changes.map((change) => change.path)),
    ),
  ).toThrow("bounds")
  for (const diff of ["x".repeat(1024 * 1024), "\0".repeat(200_000), "😀".repeat(300_000)]) {
    expect(() =>
      validateReviewContent({ ...patch(), changes: [{ ...patch().changes[0]!, diff }] }, patchRequest()),
    ).toThrow("size limit")
  }
  const options = Array.from({ length: 9 }, (_, index) => ({
    id: `o${index}`,
    label: `Option ${index}`,
    description: "",
  }))
  expect(() =>
    validateReviewContent(
      { ...input(), questions: [{ ...input().questions[0]!, options }] },
      { ...inputRequest(), questions: [{ id: "q1", optionIds: options.map((option) => option.id) }] },
    ),
  ).toThrow("bounds")
})

test("validation rejects accessors, serialization hooks, sparse arrays and inherited fields without invoking them", () => {
  let calls = 0
  const accessor = Object.defineProperty({ ...patch() }, "changes", {
    enumerable: true,
    get() {
      calls++
      return []
    },
  })
  const hooked = {
    ...patch(),
    toJSON() {
      calls++
      return patch()
    },
  }
  const kind = {
    toString() {
      calls++
      return "add"
    },
  }
  const inherited = Object.assign(Object.create({ extra: "hidden" }), patch())
  for (const value of [
    accessor,
    hooked,
    inherited,
    { ...patch(), changes: new Array(1) },
    { ...patch(), changes: [{ ...patch().changes[0]!, kind }] },
  ]) {
    expect(() => validateReviewContent(value, patchRequest())).toThrow()
  }
  expect(calls).toBe(0)
})
