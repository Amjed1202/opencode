import type { ToolRequestUserInputParams } from "./generated/0.153.4/v2/ToolRequestUserInputParams"
import type { ToolRequestUserInputQuestion } from "./generated/0.153.4/v2/ToolRequestUserInputQuestion"
import { isRecord } from "./stdio"

/** Deliberately supports only bounded nonsecret, blocking, single-choice questions. */
export function decodeHumanInput(value: unknown): ToolRequestUserInputParams | undefined {
  if (
    !isRecord(value) ||
    !exact(value, ["threadId", "turnId", "itemId", "questions", "isBlocking", "autoResolutionMs"]) ||
    !identifier(value.threadId) ||
    !identifier(value.turnId) ||
    !identifier(value.itemId) ||
    value.isBlocking !== true ||
    (value.autoResolutionMs !== null &&
      (typeof value.autoResolutionMs !== "number" ||
        !Number.isSafeInteger(value.autoResolutionMs) ||
        value.autoResolutionMs < 0)) ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > 3 ||
    Buffer.byteLength(JSON.stringify(value)) > 64 * 1024
  )
    return
  const questions: ToolRequestUserInputQuestion[] = []
  for (const question of value.questions) {
    if (
      !isRecord(question) ||
      !exact(question, ["id", "header", "question", "isOther", "isSecret", "options"]) ||
      !identifier(question.id) ||
      questions.some((entry) => entry.id === question.id) ||
      !text(question.header, 128) ||
      !text(question.question, 4096) ||
      question.isOther !== false ||
      question.isSecret !== false ||
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > 8
    )
      return
    const options: { label: string; description: string }[] = []
    for (const option of question.options) {
      if (
        !isRecord(option) ||
        !exact(option, ["label", "description"]) ||
        !text(option.label, 256) ||
        !text(option.description, 1024, true) ||
        options.some((entry) => entry.label === option.label)
      )
        return
      options.push({ label: option.label, description: option.description })
    }
    questions.push({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: false,
      isSecret: false,
      options,
    })
  }
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    itemId: value.itemId,
    isBlocking: true,
    autoResolutionMs: value.autoResolutionMs,
    questions,
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.trim().length > 0) &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
}
