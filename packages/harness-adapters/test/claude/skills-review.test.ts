import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import type { SessionIntent } from "@harness/protocol"
import { stageClaudeSkills, verifyClaudeSkills } from "../../src/claude/skills"

async function fixture(text: string, invocation: "user" | "model" = "model") {
  const directory = await mkdtemp(join(tmpdir(), "harness-claude-skill-review-"))
  const source = join(directory, "source")
  await mkdir(join(source, "brief"), { recursive: true })
  const path = join(source, "brief", "SKILL.md")
  await writeFile(path, text)
  const workspace = {
    id: "workspace",
    projectId: "project",
    targetId: "local",
    kind: "repository",
    rootPath: directory,
  } as const
  const skillId = createHash("sha256")
    .update(`workspace\0${workspace.id}\0${resolve(source)}\0brief`)
    .digest("hex")
  const selection = {
    skillId,
    sha256: createHash("sha256").update(text).digest("hex"),
    invocation,
    workspaceId: workspace.id,
    runtimeId: "claude-local",
    targetId: workspace.targetId,
    policyId: "policy",
    policyVersion: "1",
  }
  const intent: SessionIntent = {
    workspaceId: workspace.id,
    mode: "chat",
    requiredCapabilities: ["chat"],
    selection: {
      runtimeId: "claude-local",
      targetId: "local",
      model: { providerId: "anthropic", modelId: "sonnet" },
      access: {
        mode: "subscription",
        method: "claude-code-subscription",
        billing: "subscription",
        overagePolicy: "acknowledge-provider-settings",
      },
      fallback: { automatic: false },
    },
    policy: {
      id: "policy",
      version: "1",
      filesystem: "read-only",
      shell: "disabled",
      network: "denied",
      allowedMcpServers: [],
      approval: "deny",
      requireEnforcedBoundary: false,
    },
    skills: [selection],
  }
  return {
    path,
    source,
    directory,
    selection,
    intent,
    stage: () => stageClaudeSkills({ workspace, directory, sources: [{ root: source, scope: "workspace" }], intent }),
    close: async () => {
      const path = relative(tmpdir(), directory)
      if (!path.startsWith("harness-claude-skill-review-") || path.startsWith(".."))
        throw new Error("Unexpected fixture cleanup path")
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("skill review: dynamic shell, external resources and executable metadata fail admission", async () => {
  for (const text of [
    "Run !`echo unsafe`",
    "Read @private.txt",
    "Use ${CLAUDE_SKILL_DIR}",
    "---\nhooks: command\n---\nText",
    "---\ncontext: fork\n---\nText",
    "---\nallowed-tools: Bash\n---\nText",
  ]) {
    const state = await fixture(text)
    try {
      await expect(state.stage()).rejects.toThrow()
    } finally {
      await state.close()
    }
  }
})

test("skill review: native invocation metadata cannot be overridden by the selected binding", async () => {
  for (const [invocation, field] of [
    ["user", "user-invocable: false"],
    ["model", "disable-model-invocation: true"],
  ] as const) {
    const state = await fixture(`---\n${field}\n---\nText`, invocation)
    try {
      await expect(state.stage()).rejects.toThrow("invocation")
    } finally {
      await state.close()
    }
  }
})

test("skill review: source hash and policy binding must match the admitted selection", async () => {
  const state = await fixture("Reply briefly.")
  try {
    state.selection.sha256 = "0".repeat(64)
    await expect(state.stage()).rejects.toThrow("content changed")
    state.selection.policyVersion = "different"
    await expect(state.stage()).rejects.toThrow("binding")
  } finally {
    await state.close()
  }
})

test("skill review: standalone admission rejects source siblings and detects later source mutation", async () => {
  const state = await fixture("Reply briefly.")
  try {
    const staged = await state.stage()
    await writeFile(state.path, "A changed instruction.")
    await expect(verifyClaudeSkills(staged)).rejects.toThrow("changed")
    await writeFile(join(state.source, "brief", "helper.ts"), "fixture")
    await expect(state.stage()).rejects.toThrow("standalone")
  } finally {
    await state.close()
  }
})

test("skill review: staged plugins cannot acquire hooks or support files after admission", async () => {
  const state = await fixture("Reply briefly.")
  try {
    const staged = await state.stage()
    await writeFile(join(staged[0]!.pluginPath, "hooks.json"), "{}")
    await expect(verifyClaudeSkills(staged)).rejects.toThrow("contents changed")
  } finally {
    await state.close()
  }
})
