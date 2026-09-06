import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ExecutionPolicy, JsonValue } from "@harness/protocol"
import type { FileUpdateChange } from "./generated/0.153.4/v2/FileUpdateChange"
import type { FileChangeRequestApprovalParams } from "./generated/0.153.4/v2/FileChangeRequestApprovalParams"
import type { NativeReply, NativeRequest } from "./stdio"
import { isRecord } from "./stdio"
import type { CommandExecutionRequestApprovalResponse } from "./generated/0.153.4/v2/CommandExecutionRequestApprovalResponse"
import type { FileChangeRequestApprovalResponse } from "./generated/0.153.4/v2/FileChangeRequestApprovalResponse"
import type { PermissionsRequestApprovalResponse } from "./generated/0.153.4/v2/PermissionsRequestApprovalResponse"

export interface FileApprovalEvidence {
  readonly changes: readonly FileUpdateChange[]
  readonly sha256: string
}

export function fileApprovalEvidence(value: unknown): FileApprovalEvidence | undefined {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 64 ||
    Buffer.byteLength(JSON.stringify(value)) > 128 * 1024
  )
    return
  const changes: FileUpdateChange[] = []
  for (const change of value) {
    if (
      !isRecord(change) ||
      typeof change.path !== "string" ||
      !change.path ||
      change.path.length > 4096 ||
      typeof change.diff !== "string" ||
      !isRecord(change.kind) ||
      typeof change.kind.type !== "string" ||
      !["add", "delete", "update"].includes(change.kind.type)
    )
      return
    const kind = change.kind
    if (
      Object.keys(change).some((key) => !["path", "kind", "diff"].includes(key)) ||
      Object.keys(kind).some((key) => !(kind.type === "update" ? ["type", "move_path"] : ["type"]).includes(key))
    )
      return
    if (change.kind.type === "update" && change.kind.move_path !== null && typeof change.kind.move_path !== "string")
      return
    changes.push({
      path: change.path,
      diff: change.diff,
      kind:
        change.kind.type === "update"
          ? { type: "update", move_path: change.kind.move_path as string | null }
          : { type: change.kind.type as "add" | "delete" },
    })
  }
  return { changes, sha256: permissionHash(changes) }
}

export function approvalDenial(method: string): NativeReply | undefined {
  if (method === "item/commandExecution/requestApproval")
    return { result: { decision: "decline" } satisfies CommandExecutionRequestApprovalResponse }
  if (method === "item/fileChange/requestApproval")
    return { result: { decision: "decline" } satisfies FileChangeRequestApprovalResponse }
  if (method === "item/permissions/requestApproval")
    return { result: { permissions: {}, scope: "turn" } satisfies PermissionsRequestApprovalResponse }
}

/** Only the immutable, observed file operation has a once-only native decision. */
export async function approvalPlan(
  message: NativeRequest,
  policy: ExecutionPolicy,
  cwd: string,
  files?: FileApprovalEvidence,
) {
  const params = isRecord(message.params) ? message.params : {}
  const reason =
    message.method === "item/commandExecution/requestApproval"
      ? "Command approval can bypass the requested sandbox; shell and policy expansions are denied."
      : message.method === "item/permissions/requestApproval"
        ? "Additional permissions apply beyond this one operation; network and permission-profile expansions are denied."
        : policy.filesystem !== "workspace-write"
          ? "File writes exceed the read-only policy."
          : !fileRequest(params)
            ? "Native file approval fields are unsupported or incomplete."
            : params.grantRoot != null
              ? "A native session-wide write root cannot be approved once."
              : !files
                ? "No complete pending native file-change item was observed."
                : (await workspaceFiles(cwd, files))
                  ? undefined
                  : "File paths exceed the workspace, use links, protected metadata, or could not be verified."
  const resources =
    files?.changes.flatMap((change) => [
      change.path,
      ...(change.kind.type === "update" && change.kind.move_path ? [change.kind.move_path] : []),
    ]) ?? []
  const details: JsonValue = {
    nativeMethod: message.method,
    ...(reason ? { denialReason: reason } : {}),
    ...(files
      ? {
          changes: files.changes.map((change) => ({
            path: change.path,
            kind: change.kind.type,
            diffSha256: permissionHash(change.diff),
            ...(change.kind.type === "update" ? { movePath: change.kind.move_path } : {}),
          })),
        }
      : {}),
    ...(typeof params.command === "string"
      ? { commandSha256: permissionHash(params.command), commandContent: "omitted: commands may contain credentials" }
      : {}),
  }
  return { allow: !reason && policy.approval === "ask", resources, details }
}

async function workspaceFiles(cwd: string, evidence: FileApprovalEvidence): Promise<boolean> {
  try {
    const root = await realpath(cwd)
    if (!same(root, cwd)) return false
    for (const change of evidence.changes) {
      for (const value of [
        change.path,
        ...(change.kind.type === "update" && change.kind.move_path ? [change.kind.move_path] : []),
      ]) {
        if (
          value.includes("\0") ||
          value.includes(":", process.platform === "win32" && /^[A-Za-z]:/.test(value) ? 2 : 0) ||
          value.includes("~")
        )
          return false
        const path = resolve(cwd, value)
        const local = relative(root, path)
        if (!local || local.startsWith(`..${sep}`) || local === ".." || isAbsolute(local)) return false
        if (local.split(/[\\/]/).some((part) => /^(?:\.git|\.codex|\.agents)$/i.test(part) || /[. ]$/.test(part)))
          return false
        let current = path
        while (!same(current, root)) {
          const stat = await lstat(current).catch((error: unknown) => {
            if (isRecord(error) && error.code === "ENOENT") return undefined
            throw error
          })
          if (
            stat?.isSymbolicLink() ||
            (stat && !stat.isFile() && !stat.isDirectory()) ||
            (stat?.isFile() && stat.nlink > 1)
          )
            return false
          if (stat && !same(await realpath(current), current)) return false
          current = dirname(current)
        }
      }
    }
    return true
  } catch {
    return false
  }
}

function fileRequest(value: Record<string, unknown>): value is FileChangeRequestApprovalParams {
  return (
    Object.keys(value).every((key) =>
      ["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot"].includes(key),
    ) &&
    [value.threadId, value.turnId, value.itemId].every((item) => typeof item === "string" && !!item) &&
    typeof value.startedAtMs === "number" &&
    Number.isSafeInteger(value.startedAtMs) &&
    (value.reason == null || typeof value.reason === "string") &&
    (value.grantRoot == null || typeof value.grantRoot === "string")
  )
}

function same(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

export function permissionHash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        isRecord(item)
          ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
          : item,
      ),
    )
    .digest("hex")
}
