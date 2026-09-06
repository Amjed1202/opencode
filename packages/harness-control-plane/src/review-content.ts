import { isAbsolute, resolve } from "node:path"
import type {
  HumanInputRequest,
  HumanInputReviewContent,
  PermissionRequest,
  PermissionReviewContent,
} from "@harness/protocol"

/** Validate protected display content against the exact request; an operation hash is not a content-file hash. */
export function validateReviewContent(
  value: unknown,
  request: PermissionRequest | HumanInputRequest,
): PermissionReviewContent | HumanInputReviewContent {
  const content = object(value, ["kind", "requestId", "operationSha256", "changes", "questions"])
  if (
    content.requestId !== request.requestId ||
    content.operationSha256 !== request.operationSha256 ||
    typeof content.operationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(content.operationSha256)
  )
    throw new Error("Review content binding mismatch")
  if ("questions" in request) {
    exact(content, ["kind", "requestId", "operationSha256", "questions"])
    if (content.kind !== "choice-input") throw new Error("Review content kind mismatch")
    const questions = array(content.questions, 1, 3)
    if (questions.length !== request.questions.length) throw new Error("Review questions do not match request")
    const questionIds = new Set<string>()
    questions.forEach((value, index) => {
      const question = object(value, ["id", "header", "question", "options"])
      exact(question, ["id", "header", "question", "options"])
      const id = text(question.id, 128)
      if (id !== request.questions[index]!.id || questionIds.has(id))
        throw new Error("Review question identity mismatch")
      questionIds.add(id)
      display(question.header, 128)
      display(question.question, 4096)
      const options = array(question.options, 2, 8)
      if (options.length !== request.questions[index]!.optionIds.length)
        throw new Error("Review options do not match request")
      const optionIds = new Set<string>()
      const labels = new Set<string>()
      options.forEach((value, optionIndex) => {
        const option = object(value, ["id", "label", "description"])
        exact(option, ["id", "label", "description"])
        const optionId = text(option.id, 128)
        const label = display(option.label, 256)
        if (
          optionId !== request.questions[index]!.optionIds[optionIndex] ||
          optionIds.has(optionId) ||
          labels.has(label)
        )
          throw new Error("Review option identity or label mismatch")
        optionIds.add(optionId)
        labels.add(label)
        display(option.description, 1024, true)
      })
    })
  } else {
    exact(content, ["kind", "requestId", "operationSha256", "changes"])
    if (content.kind !== "patch") throw new Error("Review content kind mismatch")
    if (!Array.isArray(request.resources) || request.resources.length > 512)
      throw new Error("Invalid request review resources")
    const expected = new Set(request.resources.map(pathIdentity))
    if (!expected.size || expected.size !== request.resources.length)
      throw new Error("Invalid request review resources")
    const actual = new Set<string>()
    let bytes = 0
    array(content.changes, 1, 256).forEach((value) => {
      const change = object(value, ["path", "kind", "diff", "movePath"])
      if (
        !Object.hasOwn(change, "path") ||
        !Object.hasOwn(change, "kind") ||
        !Object.hasOwn(change, "diff") ||
        typeof change.kind !== "string" ||
        !["add", "delete", "update"].includes(change.kind)
      )
        throw new Error("Invalid review patch change")
      text(change.diff, 1024 * 1024, true)
      const paths = [pathIdentity(change.path)]
      if (Object.hasOwn(change, "movePath")) {
        if (change.kind !== "update") throw new Error("Only an update may move a reviewed path")
        paths.push(pathIdentity(change.movePath))
      }
      paths.forEach((path) => {
        if (!expected.has(path) || actual.has(path))
          throw new Error("Review patch paths do not match request resources")
        actual.add(path)
      })
      bytes += Buffer.byteLength(JSON.stringify(change))
      if (bytes > 1024 * 1024) throw new Error("Review content exceeds size limit")
    })
    if (actual.size !== expected.size) throw new Error("Review patch omits request resources")
  }
  if (Buffer.byteLength(JSON.stringify(content)) > 1024 * 1024) throw new Error("Review content exceeds size limit")
  return structuredClone(content) as unknown as PermissionReviewContent | HumanInputReviewContent
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Review content must use plain objects")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(descriptors[key]!, "value") ||
        descriptors[key]!.enumerable !== true,
    )
  )
    throw new Error("Review content contains unknown or non-JSON fields")
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error("Review content has missing or unsupported fields")
}

function array(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw new Error("Invalid review array bounds")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => descriptors[String(index)]).some(
      (descriptor) => !descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true,
    )
  )
    throw new Error("Review arrays must contain plain JSON entries")
  return value
}

function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()))
    throw new Error("Invalid review text bounds")
  return value
}

function display(value: unknown, maximum: number, empty = false) {
  const result = text(value, maximum, empty)
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(result))
    throw new Error("Review display text contains unsupported control characters")
  return result
}

function pathIdentity(value: unknown) {
  const path = text(value, 4096)
  if (
    path.includes("\0") ||
    !isAbsolute(path) ||
    (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(path))
  )
    throw new Error("Review patch paths must be absolute")
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
}
