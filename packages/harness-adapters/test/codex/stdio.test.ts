import { afterEach, expect, test } from "bun:test"
import { StdioJsonRpc } from "../../src/codex/stdio"

const transports: StdioJsonRpc[] = []
function peer(options: Partial<ConstructorParameters<typeof StdioJsonRpc>[0]> = {}) {
  const transport = new StdioJsonRpc({
    command: [process.execPath, `${import.meta.dir}/peer.ts`],
    cwd: import.meta.dir,
    environment: {},
    requestTimeoutMs: 1000,
    ...options,
  })
  transports.push(transport)
  return transport
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((item) => item.close()))
})

test("stdio correlates requests and preserves UTF-8 text", async () => {
  const transport = peer()
  expect(await transport.request("echo", { text: "héllo" })).toEqual({ text: "héllo" })
})

test("transport never copies arbitrary parent credentials or configuration into its child", async () => {
  const parent = Bun.spawn([process.execPath, `${import.meta.dir}/environment-parent.ts`], {
    env: { OPENAI_API_KEY: "nonsecret-fixture", CODEX_TEST_UNSAFE: "nonsecret-fixture" },
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  const names = JSON.parse(await new Response(parent.stdout).text())
  expect(await parent.exited).toBe(0)
  expect(names).toContain("CODEX_TEST_ALLOWED")
  expect(names).not.toContain("OPENAI_API_KEY")
  expect(names).not.toContain("CODEX_TEST_UNSAFE")
})

test("a timed out request closes the stream and rejects every pending request", async () => {
  const transport = peer({ requestTimeoutMs: 150 })
  const results = await Promise.allSettled([transport.request("hang", {}), transport.request("hang", {})])
  expect(results.map((item) => item.status)).toEqual(["rejected", "rejected"])
  await expect(transport.request("echo", {})).rejects.toThrow("closed")
})

test.each(["invalid", "oversize", "unknown-response", "crash"])(
  "%s closes pending requests without exposing stderr",
  async (method) => {
    const transport = peer({ maxMessageBytes: 4096 })
    const result = await transport.request(method, {}).catch((error: Error) => error)
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).not.toContain("sensitive fixture")
    await expect(transport.request("echo", {})).rejects.toThrow("closed")
  },
)

test("unsupported native server requests are rejected immediately", async () => {
  expect(await peer().request("server-request", {})).toBe(-32601)
})

test("close rejects in-flight work and terminates its owned subprocess", async () => {
  const transport = peer()
  const result = transport.request("hang", {}).catch((error: Error) => error)
  await transport.close()
  expect(await result).toBeInstanceOf(Error)
})
