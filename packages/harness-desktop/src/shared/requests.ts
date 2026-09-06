import type { DesktopOperation } from "./contracts"

const noInput = new Set(["getState", "refresh", "interrupt", "shutdown"])
export function decodeDesktopRequest(operation: DesktopOperation, value: unknown): Record<string, unknown> {
  if (noInput.has(operation)) {
    if (value === undefined || value === null) return {}
    return object(value, [])
  }
  if (operation === "start") {
    const input = object(value, ["modelId", "acknowledgeOverage", "allowFileChanges", "acknowledgeUnverifiedBoundary"])
    text(input.modelId, 128)
    if (
      ![input.acknowledgeOverage, input.allowFileChanges, input.acknowledgeUnverifiedBoundary].every(
        (value) => typeof value === "boolean",
      )
    )
      throw new Error("Invalid session options")
    return structuredClone(input)
  }
  if (operation === "send") {
    const input = object(value, ["text"])
    text(input.text, 64 * 1024)
    return structuredClone(input)
  }
  if (operation === "review") {
    const input = object(value, ["kind", "requestId"])
    if (input.kind !== "permission" && input.kind !== "input") throw new Error("Invalid review kind")
    identifier(input.requestId)
    return structuredClone(input)
  }
  if (operation === "resolvePermission") {
    const input = object(value, ["requestId", "choiceId", "reviewToken"], ["reviewToken"])
    identifier(input.requestId)
    identifier(input.choiceId)
    if (input.reviewToken !== undefined) identifier(input.reviewToken)
    return structuredClone(input)
  }
  if (operation === "resolveInput") {
    const input = object(value, ["requestId", "action", "selections", "reviewToken"], ["reviewToken"])
    identifier(input.requestId)
    if (input.reviewToken !== undefined) identifier(input.reviewToken)
    if (input.action !== "answer" && input.action !== "cancel") throw new Error("Invalid input action")
    if (
      !Array.isArray(input.selections) ||
      input.selections.length > 3 ||
      Object.getPrototypeOf(input.selections) !== Array.prototype ||
      Reflect.ownKeys(input.selections).length !== input.selections.length + 1
    )
      throw new Error("Invalid selections")
    const descriptors = Object.getOwnPropertyDescriptors(input.selections)
    if (
      Array.from({ length: input.selections.length }, (_, index) => descriptors[index]).some(
        (value) => !value || !Object.hasOwn(value, "value"),
      )
    )
      throw new Error("Invalid selection entries")
    input.selections.forEach((value) => {
      const selection = object(value, ["questionId", "optionId"])
      identifier(selection.questionId)
      identifier(selection.optionId)
    })
    if (input.action === "cancel" && input.selections.length) throw new Error("Cancellation has no selections")
    if (
      input.action === "answer" &&
      (!input.selections.length ||
        new Set(input.selections.map((value) => value.questionId)).size !== input.selections.length)
    )
      throw new Error("Answer requires distinct questions")
    return structuredClone(input)
  }
  if (operation === "configure") {
    const input = object(
      value,
      ["workspace", "executable", "nativeHome", "userSkillsRoot"],
      ["workspace", "executable", "nativeHome", "userSkillsRoot"],
    )
    for (const key of ["executable", "nativeHome", "userSkillsRoot"])
      if (input[key] !== undefined) text(input[key], 4096)
    if (input.workspace !== undefined) {
      const workspace = object(input.workspace, ["id", "name", "path"])
      identifier(workspace.id)
      text(workspace.name, 256)
      text(workspace.path, 4096)
    }
    return structuredClone(input)
  }
  throw new Error("Unsupported desktop operation")
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Invalid request object")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(descriptors[key]!, "value") ||
        !descriptors[key]!.enumerable,
    ) ||
    keys.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))
  )
    throw new Error("Unknown or missing request fields")
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > maximum ||
    value.includes("\0")
  )
    throw new Error("Invalid text input")
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value))
    throw new Error("Invalid request identity")
}
