import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { approvalPlan, fileApprovalEvidence } from "../../src/codex/permissions"

test("file approval checks real paths, junctions and hardlinks before offering a once grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-permission-paths-"))
  const workspace = join(directory, "workspace")
  const outside = join(directory, "outside")
  await mkdir(workspace)
  await mkdir(outside)
  const plan = async (path: string) =>
    approvalPlan(
      {
        id: 1,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "file",
          startedAtMs: Date.now(),
        },
      },
      {
        id: "policy",
        version: "1",
        filesystem: "workspace-write",
        shell: "sandboxed",
        network: "denied",
        approval: "ask",
        allowedMcpServers: [],
        requireEnforcedBoundary: false,
      },
      workspace,
      fileApprovalEvidence([{ path, kind: { type: "add" }, diff: "+fixture" }]),
    )
  try {
    expect((await plan(join(workspace, "new-file.txt"))).allow).toBe(true)
    await symlink(outside, join(workspace, "linked-directory"), process.platform === "win32" ? "junction" : "dir")
    expect((await plan(join(workspace, "linked-directory", "outside.txt"))).allow).toBe(false)
    await writeFile(join(outside, "hardlinked-file.txt"), "fixture")
    await link(join(outside, "hardlinked-file.txt"), join(workspace, "hardlink.txt"))
    expect((await plan(join(workspace, "hardlink.txt"))).allow).toBe(false)
    expect((await plan(join(workspace, "file.txt:stream"))).allow).toBe(false)
    expect((await plan(join(workspace, ".codex", "config.toml"))).allow).toBe(false)
  } finally {
    if (relative(tmpdir(), directory).startsWith("harness-permission-paths-"))
      await rm(directory, { recursive: true, force: true })
  }
})
