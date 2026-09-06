import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { HostClient } from "../../src/main/host-client"

function fixture(scenario = "echo") {
  const state = { failures: 0, changes: 0 }
  const host = new HostClient({
    executable: process.execPath,
    worker: join(import.meta.dir, "../fixtures/host-peer.ts"),
    environment: {
      HARNESS_HOST_FIXTURE_SCENARIO: scenario,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    },
    changed: () => {
      state.changes++
    },
    failed: () => {
      state.failures++
    },
  })
  return { host, state }
}

async function boundedOutcome(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), 1000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("private desktop host process transport", () => {
  test("correlates concurrent requests over inherited private pipes", async () => {
    const value = fixture()
    try {
      const replies = await Promise.all(
        Array.from({ length: 8 }, (_, id) => value.host.request("send", { text: `text-${id}` })),
      )
      expect(replies).toEqual(Array.from({ length: 8 }, (_, id) => ({ text: `text-${id}` })))
      expect(value.state.failures).toBe(0)
    } finally {
      await value.host.close()
    }
  })

  test("reassembles UTF-8 characters split across native stdout chunks", async () => {
    const value = fixture("split-utf8")
    try {
      expect(await value.host.request("getState")).toEqual({ text: "hé🙂" })
    } finally {
      await value.host.close()
    }
  })

  test("rejects every pending promise if a correlated response omits its result and error", async () => {
    const value = fixture("incomplete-response")
    try {
      const pending = value.host.request("getState")
      expect(await boundedOutcome(pending)).toBe("rejected")
      await expect(value.host.request("getState")).rejects.toThrow("unavailable")
      expect(value.state.failures).toBe(1)
    } finally {
      await value.host.close()
    }
  })

  test("rejects unknown response IDs and child exit without automatically replaying", async () => {
    for (const scenario of ["unknown-response", "exit"]) {
      const value = fixture(scenario)
      try {
        await expect(value.host.request("send", { text: "one authorized send" })).rejects.toThrow(
          "automatic replay is disabled",
        )
        await expect(value.host.request("send", { text: "never dispatched" })).rejects.toThrow("unavailable")
        expect(value.state.failures).toBe(1)
      } finally {
        await value.host.close()
      }
    }
  })

  test("fails closed for oversized unterminated output and malformed UTF-8", async () => {
    for (const scenario of ["oversized", "invalid-utf8"]) {
      const value = fixture(scenario)
      try {
        await expect(value.host.request("getState")).rejects.toThrow("automatic replay is disabled")
        expect(value.state.failures).toBe(1)
      } finally {
        await value.host.close()
      }
    }
  })

  test("rejects ambiguous result/error frames as protocol failures", async () => {
    const value = fixture("both-result-error")
    try {
      await expect(value.host.request("getState")).rejects.toThrow("automatic replay is disabled")
      expect(value.state.failures).toBe(1)
    } finally {
      await value.host.close()
    }
  })

  test("ignores state output already buffered after the transport has failed", async () => {
    const value = fixture("late-state")
    try {
      await expect(value.host.request("getState")).rejects.toThrow("automatic replay is disabled")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(value.state.failures).toBe(1)
      expect(value.state.changes).toBe(0)
    } finally {
      await value.host.close()
    }
  })

  test("bounds outgoing frames before writing to the child", async () => {
    const value = fixture()
    try {
      await expect(value.host.request("send", { text: "x".repeat(1024 * 1024) })).rejects.toThrow("exceeded limit")
      expect(await value.host.request("getState")).toEqual({})
    } finally {
      await value.host.close()
    }
  })
})
