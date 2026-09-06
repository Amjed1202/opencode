import { randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { WorkspaceDescriptor, WorkspaceLease } from "@harness/protocol"

/** Single host ownership. Expiry blocks use; it never transfers a running writer's lease. */
export class LocalWorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceDescriptor>()
  private readonly leases = new Map<string, WorkspaceLease>()
  private readonly generations = new Map<string, number>()
  private readonly identities = new Map<string, { dev: bigint; ino: bigint }>()
  private readonly privateRoots = new Set<string>()
  private readonly now: () => number
  private readonly lifetime: number

  constructor(options: { now?: () => number; leaseMilliseconds?: number } = {}) {
    this.now = options.now ?? Date.now
    this.lifetime = options.leaseMilliseconds ?? 300_000
    if (!Number.isFinite(this.lifetime) || this.lifetime <= 0) throw new Error("Invalid lease lifetime")
  }

  /** Permanent for this registry lifetime: stored artifacts may outlive the manager reserving their root. */
  reservePrivateRoot(rootPath: string): void {
    try {
      if (
        typeof rootPath !== "string" ||
        rootPath.includes("\0") ||
        !isAbsolute(rootPath) ||
        (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(rootPath))
      )
        throw new Error("Invalid root")
      const selected = resolve(rootPath)
      let current = selected
      while (true) {
        const identity = lstatSync(current, { bigint: true })
        const canonical = realpathSync(current)
        if (
          !identity.isDirectory() ||
          identity.isSymbolicLink() ||
          (process.platform === "win32" ? canonical.toLowerCase() !== current.toLowerCase() : canonical !== current)
        )
          throw new Error("Linked root")
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
      const canonical = realpathSync(selected)
      for (const workspace of this.workspaces.values())
        if (contains(workspace.rootPath, canonical) || contains(canonical, workspace.rootPath))
          throw new Error("Existing workspace overlaps private storage")
      this.privateRoots.add(canonical)
    } catch {
      throw new Error("Cannot reserve private storage: invalid root or overlapping workspace")
    }
  }

  /** Host calls this only after an authorized directory selection. */
  async register(workspace: WorkspaceDescriptor): Promise<void> {
    const selected = structuredClone(workspace)
    if (!selected.id || !selected.targetId || !selected.projectId || !isAbsolute(selected.rootPath))
      throw new Error("Invalid workspace")
    const rootPath = await realpath(selected.rootPath)
    const identity = await stat(rootPath, { bigint: true })
    if (!identity.isDirectory()) throw new Error("Workspace is not a directory")
    const previous = this.workspaces.get(selected.id)
    const descriptor = Object.freeze({ ...selected, rootPath })
    if (previous && JSON.stringify(previous) !== JSON.stringify(descriptor))
      throw new Error("Workspace identity cannot change")
    const registered = this.identities.get(selected.id)
    if (registered && (registered.dev !== identity.dev || registered.ino !== identity.ino))
      throw new Error("Workspace directory changed")
    for (const value of this.workspaces.values()) {
      if (value.id !== selected.id && (contains(value.rootPath, rootPath) || contains(rootPath, value.rootPath)))
        throw new Error("Workspace directory overlaps an existing workspace")
    }
    // Check after filesystem awaits so an in-flight registration cannot race a new reservation.
    for (const root of this.privateRoots)
      if (contains(root, rootPath) || contains(rootPath, root))
        throw new Error("Workspace directory overlaps reserved private storage")
    this.workspaces.set(selected.id, descriptor)
    this.identities.set(selected.id, { dev: identity.dev, ino: identity.ino })
  }

  async get(id: string): Promise<WorkspaceDescriptor | undefined> {
    const workspace = this.workspaces.get(id)
    if (!workspace) return undefined
    if ((await realpath(workspace.rootPath)) !== workspace.rootPath) throw new Error("Workspace path changed")
    const identity = await stat(workspace.rootPath, { bigint: true })
    const registered = this.identities.get(id)
    if (!identity.isDirectory() || !registered || registered.dev !== identity.dev || registered.ino !== identity.ino)
      throw new Error("Workspace directory changed")
    return { ...workspace }
  }

  async lease(workspaceId: string, ownerId: string, mode: "read" | "write"): Promise<WorkspaceLease> {
    const workspace = await this.get(workspaceId)
    if (!workspace || !ownerId || !["read", "write"].includes(mode)) throw new Error("Unknown workspace or owner")
    const current = [...this.leases.values()].filter((lease) => lease.workspaceId === workspaceId)
    const own = current.find((lease) => lease.ownerId === ownerId)
    if (own) {
      if (own.mode !== mode || Date.parse(own.expiresAt) <= this.now())
        throw new Error("Lease must be released before replacement")
      return { ...own }
    }
    if (current.some((lease) => mode === "write" || lease.mode === "write")) throw new Error("Workspace lease conflict")
    const generation = (this.generations.get(workspaceId) ?? 0) + 1
    this.generations.set(workspaceId, generation)
    const lease: WorkspaceLease = {
      id: randomUUID(),
      workspaceId,
      targetId: workspace.targetId,
      ownerId,
      mode,
      generation,
      expiresAt: new Date(this.now() + this.lifetime).toISOString(),
    }
    this.leases.set(lease.id, lease)
    return { ...lease }
  }

  async valid(lease: WorkspaceLease): Promise<boolean> {
    const snapshot = { ...lease }
    if (!this.current(snapshot)) return false
    const workspace = await this.get(snapshot.workspaceId).catch(() => undefined)
    return Boolean(workspace && this.current(snapshot))
  }

  current(lease: WorkspaceLease): boolean {
    const stored = this.leases.get(lease.id)
    return Boolean(
      stored &&
        stored.generation === lease.generation &&
        stored.ownerId === lease.ownerId &&
        stored.workspaceId === lease.workspaceId &&
        stored.targetId === lease.targetId &&
        stored.mode === lease.mode &&
        stored.expiresAt === lease.expiresAt &&
        Date.parse(stored.expiresAt) > this.now(),
    )
  }

  async release(id: string, generation: number): Promise<void> {
    const lease = this.leases.get(id)
    if (!lease) return
    if (lease.generation !== generation) throw new Error("Stale lease generation")
    this.leases.delete(id)
  }
}

function contains(parent: string, child: string): boolean {
  const relation = relative(
    process.platform === "win32" ? parent.toLowerCase() : parent,
    process.platform === "win32" ? child.toLowerCase() : child,
  )
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}
