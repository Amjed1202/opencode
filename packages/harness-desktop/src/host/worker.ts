import { DesktopBackend } from "./backend"
import type { DesktopOperation } from "../shared/contracts"

let backend: DesktopBackend | undefined
let buffered = ""
const decoder = new TextDecoder("utf-8", { fatal: true })
let queuedBytes = 0
let output = Promise.resolve()
function send(frame: unknown) {
  const line = JSON.stringify(frame) + "\n"
  const size = Buffer.byteLength(line)
  if (size > 4 * 1024 * 1024 || queuedBytes + size > 16 * 1024 * 1024) process.exit(1)
  queuedBytes += size
  output = output.then(async () => {
    await Bun.write(Bun.stdout, line)
    queuedBytes -= size
  })
  void output.catch(() => process.exit(1))
}

async function handle(line: string) {
  const frame: unknown = JSON.parse(line)
  if (
    typeof frame !== "object" ||
    !frame ||
    Array.isArray(frame) ||
    Object.keys(frame).some((key) => !["id", "operation", "input"].includes(key)) ||
    !("id" in frame) ||
    typeof frame.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(frame.id) ||
    !("operation" in frame) ||
    typeof frame.operation !== "string"
  )
    throw new Error("Invalid private host request")
  const input: unknown = "input" in frame ? frame.input : undefined
  try {
    if (frame.operation === "initialize") {
      if (
        backend ||
        typeof input !== "object" ||
        !input ||
        !("key" in input) ||
        typeof input.key !== "string" ||
        !("directory" in input) ||
        typeof input.directory !== "string" ||
        !("environment" in input) ||
        typeof input.environment !== "object" ||
        !input.environment ||
        !("toolPath" in input) ||
        typeof input.toolPath !== "string"
      )
        throw new Error("Invalid private host initialization")
      if (
        Object.keys(input).length !== 4 ||
        Array.isArray(input.environment) ||
        Object.entries(input.environment).some(
          ([name, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0"),
        )
      )
        throw new Error("Invalid host environment")
      const key = Buffer.from(input.key, "base64")
      if (key.length !== 32 || key.toString("base64") !== input.key) throw new Error("Invalid host key")
      try {
        backend = await DesktopBackend.open({
          directory: input.directory,
          key,
          environment: input.environment as Record<string, string>,
          toolPath: input.toolPath,
          changed: (state) => send({ event: "state", state }),
        })
      } finally {
        key.fill(0)
      }
      send({ id: frame.id, result: await backend.dispatch("getState") })
      return
    }
    if (!backend) throw new Error("Desktop host is not initialized")
    const result = await backend.dispatch(frame.operation as DesktopOperation, input)
    send({ id: frame.id, result })
    if (frame.operation === "shutdown") {
      await output
      process.exit(0)
    }
  } catch {
    send({
      id: frame.id,
      error: "The operation could not complete. Check the connection and session state; no automatic retry was sent.",
    })
  }
}

try {
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true })
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n")
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Private input limit exceeded")
      await handle(line)
    }
    if (Buffer.byteLength(buffered) > 1024 * 1024) throw new Error("Private input limit exceeded")
  }
  buffered += decoder.decode()
  if (buffered.length) throw new Error("Truncated private request")
} finally {
  await backend?.close()
  await output
}
