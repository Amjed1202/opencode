import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { SessionIntent, SkillScope, WorkspaceDescriptor } from "@harness/protocol"
import { claudeFile, ordinaryClaudePath } from "./files"

export interface ClaudeSkillSource {
  readonly root: string
  readonly scope: SkillScope
}
export interface StagedClaudeSkill {
  readonly id: string
  readonly sha256: string
  readonly source: string
  readonly staged: string
  readonly pluginPath: string
  readonly manifestSha256: string
  readonly command: string
  readonly nativeCommand: string
  readonly user: boolean
  readonly model: boolean
}

export async function stageClaudeSkills(options: {
  readonly workspace: WorkspaceDescriptor
  readonly directory: string
  readonly sources: readonly ClaudeSkillSource[]
  readonly intent: SessionIntent
}) {
  const selections = options.intent.skills ?? []
  if (selections.length > 16) throw new Error("Too many Claude Skills selected")
  if (new Set(selections.map((selection) => `${selection.skillId}:${selection.invocation}`)).size !== selections.length)
    throw new Error("Duplicate Claude Skill invocation binding")
  for (const selection of selections) {
    if (
      selection.workspaceId !== options.workspace.id ||
      selection.runtimeId !== options.intent.selection.runtimeId ||
      selection.targetId !== options.workspace.targetId ||
      selection.policyId !== options.intent.policy.id ||
      selection.policyVersion !== options.intent.policy.version ||
      !["user", "model"].includes(selection.invocation)
    )
      throw new Error("Claude Skill admission binding mismatch")
  }
  if (!selections.length) return []
  const selected = new Map(selections.map((selection) => [selection.skillId, selection]))
  const staged: StagedClaudeSkill[] = []
  const names = new Set<string>()
  const stagingRoot = join(options.directory, "claude-skills", randomUUID())
  for (const source of options.sources) {
    const exists = await readdir(source.root).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (!exists) continue
    await ordinaryClaudePath(source.root, true)
    const entries = await readdir(source.root, { withFileTypes: true })
    if (entries.length > 256) throw new Error("Claude Skill source exceeds bounds")
    for (const entry of entries) {
      const id = createHash("sha256")
        .update(`${source.scope}\0${options.workspace.id}\0${resolve(source.root)}\0${entry.name}`)
        .digest("hex")
      const selection = selected.get(id)
      if (!selection) continue
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name) ||
        entry.name === "synced" ||
        !entry.isDirectory() ||
        names.has(entry.name.toLowerCase())
      )
        throw new Error("Ambiguous Claude Skill source")
      const path = join(source.root, entry.name, "SKILL.md")
      const siblings = await readdir(join(source.root, entry.name))
      if (siblings.length !== 1 || siblings[0] !== "SKILL.md")
        throw new Error("V1 supports standalone Claude SKILL.md files only")
      const content = await claudeFile(path)
      if (
        content.sha256 !== selection.sha256 ||
        selections.some((item) => item.skillId === id && item.sha256 !== content.sha256)
      )
        throw new Error("Claude Skill content changed")
      const metadata = plainSkill(content.text, entry.name)
      const user = selections.some((item) => item.skillId === id && item.invocation === "user")
      const model = selections.some((item) => item.skillId === id && item.invocation === "model")
      if ((user && !metadata.user) || (model && !metadata.model))
        throw new Error("Claude Skill invocation is disabled by native metadata")
      const pluginName = `harness-${id.slice(0, 16)}`
      const pluginPath = join(stagingRoot, pluginName)
      const skillDirectory = join(pluginPath, "skills", entry.name)
      await mkdir(join(pluginPath, ".claude-plugin"), { recursive: true })
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(
        join(pluginPath, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: pluginName, version: "1.0.0" }),
        { flag: "wx" },
      )
      const stagedPath = join(skillDirectory, "SKILL.md")
      await writeFile(stagedPath, content.text, { flag: "wx" })
      if ((await claudeFile(stagedPath)).sha256 !== content.sha256)
        throw new Error("Claude Skill staging verification failed")
      const manifestSha256 = (await claudeFile(join(pluginPath, ".claude-plugin", "plugin.json"))).sha256
      staged.push({
        id,
        sha256: content.sha256,
        source: path,
        staged: stagedPath,
        pluginPath,
        manifestSha256,
        command: entry.name,
        nativeCommand: `${pluginName}:${entry.name}`,
        user,
        model,
      })
      names.add(entry.name.toLowerCase())
      selected.delete(id)
    }
  }
  if (selected.size) throw new Error("Selected Claude Skill is outside authorized sources")
  return staged
}

export async function verifyClaudeSkills(skills: readonly StagedClaudeSkill[]) {
  for (const skill of skills) {
    for (const [path, entries] of [
      [skill.pluginPath, [".claude-plugin", "skills"]],
      [join(skill.pluginPath, ".claude-plugin"), ["plugin.json"]],
      [join(skill.pluginPath, "skills"), [skill.command]],
      [join(skill.pluginPath, "skills", skill.command), ["SKILL.md"]],
    ] as const) {
      if (JSON.stringify((await readdir(path)).sort()) !== JSON.stringify([...entries].sort()))
        throw new Error("Claude Skill plugin contents changed")
    }
    if ((await claudeFile(join(skill.pluginPath, ".claude-plugin", "plugin.json"))).sha256 !== skill.manifestSha256)
      throw new Error("Claude Skill plugin identity changed")
    if (
      (await claudeFile(skill.source)).sha256 !== skill.sha256 ||
      (await claudeFile(skill.staged)).sha256 !== skill.sha256
    )
      throw new Error("Admitted Claude Skill changed")
  }
}

export function claudePrompt(text: string, skills: readonly StagedClaudeSkill[]) {
  if (/^\s*!/.test(text)) throw new Error("Native shell input is unsupported")
  if (!/^\s*\//.test(text)) return text
  const match = /^\s*\/([a-zA-Z0-9_-]+)(?=\s|$)/.exec(text)
  const skill = match && skills.find((item) => item.command === match[1] && item.user)
  if (!skill || !match || /^\s*\//.test(text.slice(match[0].length)))
    throw new Error("Native command has no admitted user Skill binding")
  return `/${skill.nativeCommand}${text.slice(match[0].length)}`
}

function plainSkill(text: string, name: string) {
  if (/!`|^\s*```!|\$\{CLAUDE_|(?:^|\s)@[^\s]+/m.test(text))
    throw new Error("Dynamic Claude Skill resources are not supported in V1")
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { user: true, model: true }
  const end = /\r?\n---(?:\r?\n|$)/.exec(text.slice(3))
  if (!end || end.index > 16 * 1024) throw new Error("Unsupported Claude Skill frontmatter")
  const fields = new Map<string, string>()
  for (const line of text
    .slice(3, end.index + 3)
    .split(/\r?\n/)
    .filter((line) => line.trim())) {
    const match = /^(name|description|argument-hint|disable-model-invocation|user-invocable):\s*(.*)$/.exec(line)
    if (!match || fields.has(match[1]!) || !match[2] || /^[>|&*[{]/.test(match[2]))
      throw new Error("V1 supports plain Claude Skill frontmatter only")
    fields.set(match[1]!, match[2].replace(/^(["'])(.*)\1$/, "$2"))
  }
  if (fields.has("name") && fields.get("name") !== name)
    throw new Error("Claude Skill command name would change in plugin scope")
  for (const key of ["disable-model-invocation", "user-invocable"])
    if (fields.has(key) && !["true", "false"].includes(fields.get(key)!))
      throw new Error("Invalid Claude Skill invocation metadata")
  return { user: fields.get("user-invocable") !== "false", model: fields.get("disable-model-invocation") !== "true" }
}
