import { expect, test } from "bun:test"
import { decodeHumanInput } from "../../src/codex/human-input"

const request = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  isBlocking: true,
  autoResolutionMs: null,
  questions: [
    {
      id: "native-choice",
      header: "Storage",
      question: "Which storage should this use?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Local", description: "Keep data on this device." },
        { label: "Remote", description: "Store data remotely." },
      ],
    },
  ],
}

test("decodes exact blocking native choices into a private cloned payload", () => {
  const decoded = decodeHumanInput(request)
  expect(decoded).toEqual(request)
  expect(decoded).not.toBe(request)
  expect(decoded?.questions).not.toBe(request.questions)
})

test.each(
  [
    null,
    [],
    { ...request, unknown: true },
    { ...request, isBlocking: false },
    { ...request, isBlocking: "true" },
    { ...request, turnId: ["turn-1"] },
    { ...request, itemId: "bad\nidentifier" },
    { ...request, autoResolutionMs: -1 },
    { ...request, autoResolutionMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...request, questions: [] },
    { ...request, questions: Array(4).fill(request.questions[0]) },
    { ...request, questions: [request.questions[0], request.questions[0]] },
  ].map((value, index) => ({ value, index })),
)("rejects unsupported, malformed or unbounded native input %#", ({ value }) => {
  expect(decodeHumanInput(value)).toBeUndefined()
})

test.each([
  { isSecret: true },
  { isSecret: undefined },
  { isOther: true },
  { options: null },
  { options: [] },
  { options: [{ label: "Only one", description: "invalid" }] },
  {
    options: [
      { label: "Same", description: "first" },
      { label: "Same", description: "second" },
    ],
  },
  { options: Array.from({ length: 9 }, (_, index) => ({ label: `Choice ${index}`, description: "too many" })) },
  { question: "\u202eHidden direction" },
  { question: "x".repeat(4097) },
  { header: "x".repeat(129) },
  { futureField: true },
])("rejects private/freeform/malformed questions without normalizing content %#", (override) => {
  expect(decodeHumanInput({ ...request, questions: [{ ...request.questions[0], ...override }] })).toBeUndefined()
})
