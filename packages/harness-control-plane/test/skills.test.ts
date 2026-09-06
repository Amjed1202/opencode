import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverClaudeSkills } from "../src/skills"
import { removeFixtureDirectory } from "./support"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-skills-"))
  const rootPath = join(directory, "workspace")
  const userRoot = join(directory, "personal-skills")
  await mkdir(rootPath)
  await mkdir(userRoot)
  const workspace = {
    id: "workspace-a",
    projectId: "project-a",
    targetId: "local",
    kind: "repository" as const,
    rootPath,
  }
  return {
    directory,
    rootPath,
    userRoot,
    workspace,
    async skill(name: string, content: string | Uint8Array, scope: "workspace" | "user" = "workspace") {
      const directory = join(scope === "workspace" ? join(rootPath, ".claude", "skills") : userRoot, name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "SKILL.md"), content)
      return directory
    },
    close: () => removeFixtureDirectory(directory),
  }
}

describe("explicit Claude skill file catalog", () => {
  test("reports only selected workspace metadata and never executes or returns skill content", async () => {
    const state = await fixture()
    try {
      const text = [
        "---",
        "name: Review display label",
        "description: Review the selected changes",
        "disable-model-invocation: true",
        "user-invocable: yes",
        "allowed-tools: Read Grep",
        "context: fork",
        "agent: Explore",
        "model: inherit",
        "argument-hint: '[branch]'",
        "---",
        "private body instructions",
        "!`touch never-created`",
        "@../private.txt",
        "$ARGUMENTS",
      ].join("\n")
      const path = await state.skill("review-code", text)
      await mkdir(join(path, "scripts"))
      await writeFile(join(path, "scripts", "evil.js"), 'throw new Error("never import resources")')
      await state.skill("personal", "---\ndescription: Must not discover implicitly\n---", "user")
      const catalog = await discoverClaudeSkills({ workspace: state.workspace })
      expect(catalog.roots).toEqual([{ scope: "workspace", status: "scanned" }])
      expect(catalog.skills).toHaveLength(1)
      expect(catalog.skills[0]).toMatchObject({
        format: "claude-skill",
        scope: "workspace",
        workspaceId: "workspace-a",
        commandName: "review-code",
        declaredName: "Review display label",
        description: "Review the selected changes",
        relativePath: ".claude/skills/review-code/SKILL.md",
        metadataStatus: "parsed",
        sha256: createHash("sha256").update(text).digest("hex"),
        sizeBytes: Buffer.byteLength(text),
        invocation: { model: "disabled-by-metadata", user: "allowed-by-metadata" },
        declared: {
          allowedTools: ["Read Grep"],
          argumentHint: "[branch]",
          context: "fork",
          agent: "Explore",
          model: "inherit",
        },
        activation: { status: "disabled", reason: "native-adapter-required" },
      })
      expect(catalog.skills[0]!.observedFeatures).toEqual([
        "dynamic-shell",
        "file-reference",
        "substitutions",
        "tool-policy",
        "forked-context",
      ])
      expect(JSON.stringify(catalog)).not.toContain("private body instructions")
      expect(JSON.stringify(catalog)).not.toContain(state.rootPath)
      expect(
        await access(join(path, "never-created")).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await state.close()
    }
  })

  test("keeps same-name user and workspace entries distinct without claiming native precedence", async () => {
    const state = await fixture()
    try {
      await state.skill("review", "---\ndescription: Workspace\n---")
      await state.skill("review", "---\ndescription: User\n---", "user")
      const options = { workspace: state.workspace, userSkillsRoot: state.userRoot }
      const catalog = await discoverClaudeSkills(options)
      expect(catalog.skills).toHaveLength(2)
      expect(new Set(catalog.skills.map((skill) => skill.id)).size).toBe(2)
      expect(catalog.roots).toEqual([
        { scope: "workspace", status: "scanned" },
        { scope: "user", status: "scanned" },
      ])
      expect((await discoverClaudeSkills(options)).skills).toEqual(catalog.skills)
      await state.skill("review", "---\ndescription: Changed\n---")
      const changed = (await discoverClaudeSkills(options)).skills.find((skill) => skill.scope === "workspace")!
      const previous = catalog.skills.find((skill) => skill.scope === "workspace")!
      expect(changed.id).toBe(previous.id)
      expect(changed.sha256).not.toBe(previous.sha256)
    } finally {
      await state.close()
    }
  })

  test("accepts absent frontmatter without exposing a body-derived description", async () => {
    const state = await fixture()
    try {
      await state.skill("plain", "Private instructions\n---\nname: Not metadata\n---")
      const entry = (await discoverClaudeSkills({ workspace: state.workspace })).skills[0]!
      expect(entry.metadataStatus).toBe("absent")
      expect(entry.description).toBeUndefined()
      expect(entry.declaredName).toBeUndefined()
      expect(entry.invocation).toEqual({ model: "allowed-by-metadata", user: "allowed-by-metadata" })
      expect(entry.activation.status).toBe("disabled")
    } finally {
      await state.close()
    }
  })

  test("reads quoted and multiline display fields and tool lists while leaving complex metadata opaque", async () => {
    const state = await fixture()
    try {
      await state.skill(
        "yaml",
        [
          "---",
          "name: 'Developer''s helper'",
          "description: >-",
          "  First line",
          "  second line",
          "allowed-tools: [Read, 'Bash(echo a,b)', \"Grep\"]",
          "disallowed-tools:",
          "  - Bash",
          "  - 'Write'",
          "hooks:",
          "  PreToolUse:",
          "    - command: secrets must stay private",
          "metadata:",
          "  sensitive: also private",
          "user-invocable: OFF",
          "---",
          "Private body",
        ].join("\n"),
      )
      const entry = (await discoverClaudeSkills({ workspace: state.workspace })).skills[0]!
      expect(entry.declaredName).toBe("Developer's helper")
      expect(entry.description).toBe("First line second line")
      expect(entry.declared.allowedTools).toEqual(["Read", "Bash(echo a,b)", "Grep"])
      expect(entry.declared.disallowedTools).toEqual(["Bash", "Write"])
      expect(entry.declared.unknownFields).toEqual(["hooks", "metadata"])
      expect(entry.metadataStatus).toBe("partial")
      expect(entry.invocation.user).toBe("disabled-by-metadata")
      expect(entry.observedFeatures).toContain("hooks")
      expect(JSON.stringify(entry)).not.toContain("secrets")
    } finally {
      await state.close()
    }
  })

  test("flags plugin components without loading plugin manifests, scripts or nested skills", async () => {
    const state = await fixture()
    try {
      const path = await state.skill("plugin", "---\ndescription: Plugin bundle\n---")
      await mkdir(join(path, ".claude-plugin"))
      await writeFile(join(path, ".claude-plugin", "plugin.json"), "not even valid JSON")
      await mkdir(join(path, "nested", ".claude", "skills", "hidden"), { recursive: true })
      await writeFile(join(path, "nested", ".claude", "skills", "hidden", "SKILL.md"), "Never discover this")
      const catalog = await discoverClaudeSkills({ workspace: state.workspace })
      expect(catalog.skills).toHaveLength(1)
      expect(catalog.skills[0]!.observedFeatures).toContain("plugin-components")
      expect(catalog.skills[0]!.activation.status).toBe("disabled")
    } finally {
      await state.close()
    }
  })

  test.each([
    ["duplicate", "---\nname: first\nname: second\n---"],
    ["unterminated", "---\nname: first"],
    ["alias", "---\nname: &run execute\ndescription: *run\n---"],
    ["tag", "---\nname: !!js/function evil\n---"],
    ["bad-list", "---\nallowed-tools: [Read,,Write]\n---"],
    ["control", '---\nname: "hidden\\u001bcommand"\n---'],
    ["control-list", '---\nallowed-tools: ["hidden\\u001bcommand"]\n---'],
  ])("rejects malformed or unsafe %s metadata without exposing source text", async (name, content) => {
    const state = await fixture()
    try {
      await state.skill(name, content)
      const catalog = await discoverClaudeSkills({ workspace: state.workspace })
      expect(catalog.skills).toEqual([])
      expect(catalog.diagnostics).toEqual([
        { scope: "workspace", code: "invalid-metadata", relativePath: `.claude/skills/${name}/SKILL.md` },
      ])
      expect(JSON.stringify(catalog)).not.toContain("execute")
    } finally {
      await state.close()
    }
  })

  test("bounds directory enumeration, skill bytes, frontmatter bytes and invalid UTF-8", async () => {
    const state = await fixture()
    try {
      await state.skill("a", "---\nname: a\n---")
      await state.skill("b", "---\nname: b\n---")
      expect((await discoverClaudeSkills({ workspace: state.workspace, limits: { maxEntries: 1 } })).roots).toEqual([
        { scope: "workspace", status: "limit-reached" },
      ])
      const bytes = await discoverClaudeSkills({ workspace: state.workspace, limits: { maxFileBytes: 3 } })
      expect(bytes.skills).toEqual([])
      expect(bytes.diagnostics.every((item) => item.code === "too-large")).toBe(true)
      const frontmatter = await discoverClaudeSkills({ workspace: state.workspace, limits: { maxFrontmatterBytes: 3 } })
      expect(frontmatter.skills).toEqual([])
      expect(frontmatter.diagnostics.every((item) => item.code === "invalid-metadata")).toBe(true)
      await state.skill("invalid-utf8", new Uint8Array([0xff, 0xfe, 0xff]))
      expect(
        (await discoverClaudeSkills({ workspace: state.workspace })).diagnostics.some(
          (item) => item.code === "invalid-metadata",
        ),
      ).toBe(true)
    } finally {
      await state.close()
    }
  })

  test("skips synced and unsupported names without traversing their contents", async () => {
    const state = await fixture()
    try {
      await state.skill("synced", "Private synced content")
      await state.skill("unsafe name", "Private content")
      const catalog = await discoverClaudeSkills({ workspace: state.workspace })
      expect(catalog.skills).toEqual([])
      expect(catalog.diagnostics).toEqual([
        { scope: "workspace", code: "unsupported-name" },
        { scope: "workspace", code: "unsupported-name" },
      ])
    } finally {
      await state.close()
    }
  })

  test("rejects hardlinked SKILL.md files", async () => {
    const state = await fixture()
    try {
      await mkdir(join(state.rootPath, ".claude", "skills", "linked"), { recursive: true })
      const source = join(state.directory, "outside.md")
      await writeFile(source, "---\ndescription: Outside confidential text\n---")
      await link(source, join(state.rootPath, ".claude", "skills", "linked", "SKILL.md"))
      const catalog = await discoverClaudeSkills({ workspace: state.workspace })
      expect(catalog.skills).toEqual([])
      expect(catalog.diagnostics[0]!.code).toBe("unsafe-path")
      expect(JSON.stringify(catalog)).not.toContain("confidential")
    } finally {
      await state.close()
    }
  })

  test("rejects directory junctions or symlinks at the skills root and skill folder", async () => {
    const state = await fixture()
    try {
      await state.skill("outside", "---\ndescription: Outside confidential text\n---", "user")
      await mkdir(join(state.rootPath, ".claude"))
      await symlink(
        state.userRoot,
        join(state.rootPath, ".claude", "skills"),
        process.platform === "win32" ? "junction" : "dir",
      )
      const catalog = await discoverClaudeSkills({ workspace: state.workspace })
      expect(catalog.skills).toEqual([])
      expect(catalog.roots).toEqual([{ scope: "workspace", status: "rejected" }])
      expect(catalog.diagnostics[0]!.code).toBe("unsafe-path")
      await symlink(
        join(state.userRoot, "outside"),
        join(state.userRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      )
      const personal = await discoverClaudeSkills({ workspace: state.workspace, userSkillsRoot: state.userRoot })
      expect(personal.skills.map((skill) => skill.commandName)).toEqual(["outside"])
      expect(
        personal.diagnostics.some((item) => item.relativePath === "linked/SKILL.md" && item.code === "unsafe-path"),
      ).toBe(true)
    } finally {
      await state.close()
    }
  })

  test("reports missing roots and rejects unselected relative/traversing paths and invalid limits", async () => {
    const state = await fixture()
    try {
      expect((await discoverClaudeSkills({ workspace: state.workspace })).roots).toEqual([
        { scope: "workspace", status: "missing" },
      ])
      for (const rootPath of ["relative", `${state.rootPath}/../personal-skills`, `${state.rootPath}\0`])
        await expect(discoverClaudeSkills({ workspace: { ...state.workspace, rootPath } })).rejects.toThrow(
          "Invalid selected",
        )
      await expect(discoverClaudeSkills({ workspace: state.workspace, userSkillsRoot: "relative" })).rejects.toThrow(
        "Invalid authorized",
      )
      for (const maxEntries of [0, -1, 0.5, Number.NaN, 2049])
        await expect(discoverClaudeSkills({ workspace: state.workspace, limits: { maxEntries } })).rejects.toThrow(
          "Invalid skill discovery limit",
        )
    } finally {
      await state.close()
    }
  })
})
