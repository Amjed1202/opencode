import { describe, expect, test } from "bun:test"
import { assertTrustedSender, createSenderGuard } from "../../src/main/security"

function fixture() {
  const documentUrl = "harness://desktop/index.html"
  const frame = { url: documentUrl }
  const state = { destroyed: false, url: documentUrl }
  const contents = { mainFrame: frame, getURL: () => state.url, isDestroyed: () => state.destroyed }
  return { documentUrl, frame, state, contents, event: { sender: contents, senderFrame: frame } }
}

describe("desktop IPC sender boundary", () => {
  test("only accepts the registered live web contents and its exact top-level document", () => {
    const value = fixture()
    expect(() => assertTrustedSender(value.event, value.contents, value.documentUrl)).not.toThrow()
    for (const event of [
      { ...value.event, sender: fixture().contents },
      { ...value.event, senderFrame: { url: value.documentUrl } },
      { ...value.event, senderFrame: null },
    ])
      expect(() => assertTrustedSender(event, value.contents, value.documentUrl)).toThrow(
        "Untrusted desktop IPC sender",
      )
  })

  test("rejects navigation, fragments, subframes, destroyed windows, and malformed document URLs", () => {
    for (const url of [
      "https://example.test/",
      "harness://desktop/other.html",
      "harness://desktop/index.html#other",
      "harness://desktop/index.html?x=1",
    ]) {
      const value = fixture()
      value.frame.url = url
      expect(() => assertTrustedSender(value.event, value.contents, value.documentUrl)).toThrow()
      value.frame.url = value.documentUrl
      value.state.url = url
      expect(() => assertTrustedSender(value.event, value.contents, value.documentUrl)).toThrow()
    }
    const value = fixture()
    value.state.destroyed = true
    expect(() => assertTrustedSender(value.event, value.contents, value.documentUrl)).toThrow()
    for (const url of [
      "",
      "not-a-url",
      "https://example.test/",
      "file:///tmp/index.html",
      "harness://desktop/index.html#fragment",
    ]) {
      expect(() => createSenderGuard(value.contents, url)).toThrow()
    }
  })

  test("guard rechecks the live document after an asynchronous privileged operation", async () => {
    const value = fixture()
    const guard = createSenderGuard(value.contents, value.documentUrl)
    guard(value.event)
    await Promise.resolve()
    value.state.url = "harness://desktop/untrusted.html"
    expect(() => guard(value.event)).toThrow()
  })
})
