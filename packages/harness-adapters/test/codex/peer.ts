import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin })
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ id, result }) + "\n")
let serverCaller: unknown
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.method === "echo") reply(message.id, message.params)
  if (message.method === "environment") reply(message.id, Object.keys(process.env))
  if (message.method === "hang") continue
  if (message.method === "crash") {
    process.stderr.write("sensitive fixture stderr must never escape")
    process.exit(3)
  }
  if (message.method === "oversize") process.stdout.write("x".repeat(8192))
  if (message.method === "invalid") process.stdout.write("{broken}\n")
  if (message.method === "unknown-response") reply(999999, {})
  if (message.method === "server-request" || message.method === "duplicate-request") {
    serverCaller = message.id
    process.stdout.write(JSON.stringify({ id: "approval-1", method: "approval", params: {} }) + "\n")
    if (message.method === "duplicate-request")
      process.stdout.write(JSON.stringify({ id: "approval-1", method: "approval", params: {} }) + "\n")
  }
  if (message.id === "approval-1") reply(serverCaller, message.error?.code ?? message.result)
}
