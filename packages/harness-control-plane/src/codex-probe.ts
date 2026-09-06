import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { realpath } from "node:fs/promises"
import { CodexAdapter } from "@harness/adapters/codex"
import { buildNativeEnvironment } from "./environment"

/** Diagnostic only: no admission token, native thread, turn, login or model request is created. */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      executable: { type: "string" },
      home: { type: "string" },
      workspace: { type: "string" },
      path: { type: "string" },
      model: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  })
  if (values.help) {
    process.stdout.write(
      "Usage: bun run probe --executable <codex.exe> --home <native-account-home> --workspace <directory> --path <approved-tool-path> --model <native-model-id>\nReads pinned Codex status only. Never starts a thread, turn or login.\n",
    )
    return
  }
  if (!values.executable || !values.home || !values.workspace || values.path === undefined || !values.model)
    throw new Error("Missing required diagnostic arguments; run with --help")
  const executable = await realpath(resolve(values.executable))
  const workspace = await realpath(resolve(values.workspace))
  const home = await realpath(resolve(values.home))
  const target = { id: "local", kind: "local" as const, name: "This computer" }
  const adapter = new CodexAdapter({
    executable,
    cwd: workspace,
    environment: buildNativeEnvironment({ inherited: process.env, home, path: values.path }),
    target,
  })
  try {
    const runtimes = await adapter.discover({ target, allowedExecutablePaths: [executable] })
    if (!runtimes.length) {
      process.stdout.write(
        JSON.stringify(
          {
            diagnosticOnly: true,
            executionAdmission: "not-requested",
            status: "unavailable",
            reason: "Pinned Codex App Server 0.153.4 could not be initialized",
          },
          null,
          2,
        ) + "\n",
      )
      process.exitCode = 2
      return
    }
    const result = await adapter.preflight({
      operation: "create",
      intent: {
        workspaceId: "diagnostic",
        mode: "chat",
        requiredCapabilities: ["chat", "streaming"],
        selection: {
          runtimeId: "codex-local",
          targetId: "local",
          model: { providerId: "openai", modelId: values.model },
          access: {
            mode: "subscription",
            method: "chatgpt-subscription",
            billing: "subscription",
            overagePolicy: "acknowledge-provider-settings",
          },
          fallback: { automatic: false },
        },
        policy: {
          id: "diagnostic",
          version: "1",
          filesystem: "read-only",
          shell: "sandboxed",
          network: "denied",
          allowedMcpServers: [],
          approval: "deny",
          requireEnforcedBoundary: false,
        },
      },
    })
    const output =
      result.status === "ready"
        ? {
            diagnosticOnly: true,
            executionAdmission: "not-requested",
            runtimeVersion: "0.153.4",
            routeStatus: "verified",
            authentication: result.effective.auth.mode,
            billing: result.effective.billing.route,
            providerOverage: result.effective.billing.providerOverage,
            enforcementVerified: false,
            liveInferenceTested: false,
          }
        : {
            diagnosticOnly: true,
            executionAdmission: "not-requested",
            runtimeVersion: "0.153.4",
            routeStatus: "blocked",
            errors: result.errors,
          }
    process.stdout.write(JSON.stringify(output, null, 2) + "\n")
    if (result.status === "blocked") process.exitCode = 2
  } finally {
    await adapter.dispose()
  }
}

main().catch(() => {
  process.stderr.write(
    "Codex diagnostic could not complete. Check explicit arguments and native setup; no model task was requested.\n",
  )
  process.exitCode = 1
})
