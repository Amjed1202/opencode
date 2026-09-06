export {}

const decoder = new TextDecoder("utf-8", { fatal: true })
let buffered = ""

for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true })
  while (buffered.includes("\n")) {
    const index = buffered.indexOf("\n")
    const frame: { id: string; operation: string; input?: unknown } = JSON.parse(buffered.slice(0, index))
    buffered = buffered.slice(index + 1)
    if (frame.operation === "shutdown") {
      await Bun.write(Bun.stdout, JSON.stringify({ id: frame.id, result: {} }) + "\n")
      process.exit(0)
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "incomplete-response") {
      await Bun.write(Bun.stdout, JSON.stringify({ id: frame.id }) + "\n")
      continue
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "late-state") {
      await Bun.write(
        Bun.stdout,
        "{bad}\n" + " ".repeat(64 * 1024) + JSON.stringify({ event: "state", state: { revision: 999 } }) + "\n",
      )
      continue
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "both-result-error") {
      await Bun.write(Bun.stdout, JSON.stringify({ id: frame.id, result: {}, error: "error" }) + "\n")
      continue
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "exit") process.exit(0)
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "unknown-response") {
      await Bun.write(Bun.stdout, JSON.stringify({ id: "unknown", result: {} }) + "\n")
      continue
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "oversized") {
      await Bun.write(Bun.stdout, "x".repeat(4 * 1024 * 1024 + 1))
      continue
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "invalid-utf8") {
      await Bun.write(
        Bun.stdout,
        Buffer.concat([Buffer.from(`{"id":"${frame.id}","result":"`), Buffer.from([0xff]), Buffer.from('"}\n')]),
      )
      continue
    }
    if (process.env.HARNESS_HOST_FIXTURE_SCENARIO === "split-utf8") {
      const bytes = Buffer.from(JSON.stringify({ id: frame.id, result: { text: "hé🙂" } }) + "\n")
      const split = bytes.indexOf(Buffer.from("🙂")) + 1
      await Bun.write(Bun.stdout, bytes.subarray(0, split))
      await new Promise((resolve) => setTimeout(resolve, 10))
      await Bun.write(Bun.stdout, bytes.subarray(split))
      continue
    }
    await Bun.write(Bun.stdout, JSON.stringify({ id: frame.id, result: frame.input ?? {} }) + "\n")
  }
}
