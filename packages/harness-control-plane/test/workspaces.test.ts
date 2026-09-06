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
