import { StdioJsonRpc } from "../../src/codex/stdio"
const transport = new StdioJsonRpc({
  command: [process.execPath, `${import.meta.dir}/peer.ts`],
  cwd: import.meta.dir,
  environment: { CODEX_TEST_ALLOWED: "fixture", PATH: "" },
})
process.stdout.write(JSON.stringify(await transport.request("environment", {})))
await transport.close()
