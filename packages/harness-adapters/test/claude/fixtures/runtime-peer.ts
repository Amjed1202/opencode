import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

// Provider-free executable fixture: accepts the official SDK's actual JSON-line protocol.
// No account files, network calls, shell tools or repository work occur here.
const directory = process.env.HARNESS_CLAUDE_REVIEW_DIRECTORY!
const scenario = process.env.HARNESS_CLAUDE_REVIEW_SCENARIO ?? "allow"
await writeFile(join(directory, "process.json"), JSON.stringify({ pid: process.pid }))
if (scenario === "warmup") process.exit(0)
const keepAlive = setInterval(() => {}, 1000)
process.once("exit", () => clearInterval(keepAlive))
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
let lastUser: string | undefined
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line)
  if (message.type === "control_request") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response:
          message.request.subtype === "initialize"
            ? {
                commands: [],
                models: [{ value: "sonnet", displayName: "Sonnet", description: "Fixture" }],
                account: {
                  email: "fixture@example.invalid",
                  subscriptionType: "max",
                  apiProvider: "firstParty",
                  apiKeySource: "none",
                },
                hooks_applied: scenario !== "invalid-controls",
                fast_mode_state: "off",
              }
            : message.request.subtype === "interrupt" && scenario === "queued-interrupt"
              ? { still_queued: [lastUser] }
              : message.request.subtype === "interrupt" && scenario === "unknown-interrupt"
                ? { still_queued: ["unknown-internal-uuid"] }
                : {},
      },
    })
  } else if (message.type === "user") {
    lastUser = message.uuid
    send({ ...message, isReplay: true })
    send({
      type: "control_request",
      request_id: "fixture-permission",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: join(directory, "fixture.txt"), content: "fixture" },
        tool_use_id: "fixture-call",
      },
    })
  } else if (message.type === "control_response" && message.response.request_id === "fixture-permission") {
    await writeFile(join(directory, "permission.json"), JSON.stringify(message.response))
    send({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: randomUUID(),
      session_id: "fixture-session",
    })
  }
}
