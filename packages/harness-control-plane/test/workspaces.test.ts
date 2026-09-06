import { expect, test } from "bun:test"
import { mkdir, rename, symlink } from "node:fs/promises"
import { join } from "node:path"
import { LocalWorkspaceRegistry } from "../src/workspaces"
import { admissionFixture, now } from "./support"

test("write leases exclude other owners; stale releases cannot release a newer lease", async () => {
  const fixture = await admissionFixture()
  try {
    const first = await fixture.workspaces.lease("workspace", "owner-a", "write")
    await expect(fixture.workspaces.lease("workspace", "owner-b", "read")).rejects.toThrow()
    await fixture.workspaces.release(first.id, first.generation)
    const second = await fixture.workspaces.lease("workspace", "owner-b", "write")
    expect(second.generation).toBeGreaterThan(first.generation)
    await expect(fixture.workspaces.release(second.id, first.generation)).rejects.toThrow()
    expect(await fixture.workspaces.valid(second)).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("nested roots cannot bypass an existing workspace's ownership locks", async () => {
  const fixture = await admissionFixture()
  try {
    const rootPath = join(fixture.directory, "nested")
    await mkdir(rootPath)
    await fixture.workspaces.lease("workspace", "owner", "write")
    await expect(
      fixture.workspaces.register({
        id: "nested",
        projectId: "project",
        targetId: "local",
        kind: "repository",
        rootPath,
      }),
    ).rejects.toThrow()
  } finally {
    await fixture.close()
  }
})

test("directory aliases cannot register a second workspace", async () => {
  const fixture = await admissionFixture()
  try {
    const rootPath = join(fixture.directory, "alias")
    await symlink(fixture.directory, rootPath, "junction")
    await expect(
      fixture.workspaces.register({
        id: "alias",
        projectId: "project",
        targetId: "local",
        kind: "repository",
        rootPath,
      }),
    ).rejects.toThrow()
  } finally {
    await fixture.close()
  }
})

test("replacing a workspace directory invalidates existing leases", async () => {
  const fixture = await admissionFixture()
  try {
    const original = join(fixture.directory, "original")
    const replacement = join(fixture.directory, "replacement")
    await mkdir(original)
    const registry = new LocalWorkspaceRegistry({ now: () => now })
    await registry.register({
      id: "workspace",
      projectId: "project",
      targetId: "local",
      kind: "repository",
      rootPath: original,
    })
    const lease = await registry.lease("workspace", "owner", "write")
    await rename(original, replacement)
    await mkdir(original)
    expect(await registry.valid(lease)).toBe(false)
    await expect(registry.lease("workspace", "owner", "write")).rejects.toThrow()
  } finally {
    await fixture.close()
  }
})

test("expiry blocks the owner without transferring a running writer's lease", async () => {
  const fixture = await admissionFixture()
  try {
    const clock = { time: now }
    const registry = new LocalWorkspaceRegistry({ now: () => clock.time, leaseMilliseconds: 1000 })
    await registry.register({
      id: "workspace",
      projectId: "project",
      targetId: "local",
      kind: "repository",
      rootPath: fixture.directory,
    })
    const lease = await registry.lease("workspace", "owner", "write")
    clock.time += 1001
    expect(await registry.valid(lease)).toBe(false)
    await expect(registry.lease("workspace", "other", "write")).rejects.toThrow()
    await expect(registry.lease("workspace", "owner", "write")).rejects.toThrow()
    await registry.release(lease.id, lease.generation)
    expect((await registry.lease("workspace", "other", "write")).generation).toBeGreaterThan(lease.generation)
  } finally {
    await fixture.close()
  }
})

test("registration captures the authorized selection before filesystem awaits", async () => {
  const fixture = await admissionFixture()
  try {
    const registry = new LocalWorkspaceRegistry()
    const selected = {
      id: "workspace",
      projectId: "project",
      targetId: "local",
      kind: "repository" as const,
      rootPath: fixture.directory,
    }
    const registration = registry.register(selected)
    selected.id = "changed"
    selected.targetId = "changed"
    await registration
    expect((await registry.get("workspace"))?.targetId).toBe("local")
    expect(await registry.get("changed")).toBeUndefined()
  } finally {
    await fixture.close()
  }
})

test("read leases coexist while a writer is excluded", async () => {
  const fixture = await admissionFixture()
  try {
    await fixture.workspaces.lease("workspace", "reader-a", "read")
    await fixture.workspaces.lease("workspace", "reader-b", "read")
    await expect(fixture.workspaces.lease("workspace", "writer", "write")).rejects.toThrow()
  } finally {
    await fixture.close()
  }
})

test("private storage reservation rejects an overlap with any registered workspace", async () => {
  const fixture = await admissionFixture()
  try {
    const registry = new LocalWorkspaceRegistry()
    const first = join(fixture.directory, "first")
    const second = join(fixture.directory, "second")
    const storage = join(second, "storage")
    await mkdir(first)
    await mkdir(storage, { recursive: true })
    await registry.register({
      id: "first",
      projectId: "project",
      targetId: "local",
      kind: "repository",
      rootPath: first,
    })
    await registry.register({
      id: "second",
      projectId: "project",
      targetId: "local",
      kind: "repository",
      rootPath: second,
    })
    expect(() => registry.reservePrivateRoot(storage)).toThrow("workspace")
  } finally {
    await fixture.close()
  }
})

test.each(["equal", "parent", "child"] as const)(
  "later %s workspace registration cannot expose reserved private storage",
  async (relationship) => {
    const fixture = await admissionFixture()
    try {
      const registry = new LocalWorkspaceRegistry()
      const storage = join(fixture.directory, "storage")
      const nested = join(storage, "nested")
      await mkdir(nested, { recursive: true })
      expect(() => registry.reservePrivateRoot(storage)).not.toThrow()
      expect(() => registry.reservePrivateRoot(storage)).not.toThrow()
      const rootPath = relationship === "parent" ? fixture.directory : relationship === "child" ? nested : storage
      await expect(
        registry.register({ id: "workspace", projectId: "project", targetId: "local", kind: "repository", rootPath }),
      ).rejects.toThrow("private")
      const sibling = join(fixture.directory, "sibling")
      await mkdir(sibling)
      await registry.register({
        id: "sibling",
        projectId: "project",
        targetId: "local",
        kind: "repository",
        rootPath: sibling,
      })
      expect((await registry.get("sibling"))?.rootPath).toBe(sibling)
    } finally {
      await fixture.close()
    }
  },
)

test("a reservation made during registration filesystem checks still rejects the workspace", async () => {
  const fixture = await admissionFixture()
  try {
    const registry = new LocalWorkspaceRegistry()
    const registration = registry.register({
      id: "workspace",
      projectId: "project",
      targetId: "local",
      kind: "repository",
      rootPath: fixture.directory,
    })
    registry.reservePrivateRoot(fixture.directory)
    await expect(registration).rejects.toThrow("private")
    expect(await registry.get("workspace")).toBeUndefined()
  } finally {
    await fixture.close()
  }
})

test("private storage reservation requires an existing absolute directory without linked ancestors", async () => {
  const fixture = await admissionFixture()
  try {
    const registry = new LocalWorkspaceRegistry()
    expect(() => registry.reservePrivateRoot("relative/storage")).toThrow("private")
    expect(() => registry.reservePrivateRoot(join(fixture.directory, "missing"))).toThrow("private")
    const actual = join(fixture.directory, "actual")
    const nested = join(actual, "nested")
    const alias = join(fixture.directory, "alias")
    await mkdir(nested, { recursive: true })
    await symlink(actual, alias, "junction")
    expect(() => registry.reservePrivateRoot(alias)).toThrow("private")
    expect(() => registry.reservePrivateRoot(join(alias, "nested"))).toThrow("private")
  } finally {
    await fixture.close()
  }
})
