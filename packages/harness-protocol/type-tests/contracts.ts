import type { AgentEventPayload, RuntimeAccess, NativeEventReference } from "../src/index"

type Assert<T extends true> = T
type NotAssignable<A, B> = A extends B ? false : true

/** Compile-time checks only; no runtime behavior or paid integration is exercised. */
export type RejectApiLabelOnSubscription = Assert<
  NotAssignable<
    {
      mode: "subscription"
      method: "chatgpt-subscription"
      billing: "api-payg"
      overagePolicy: "require-disabled"
    },
    RuntimeAccess
  >
>

export type RejectWrongTextPayload = Assert<
  NotAssignable<
    {
      type: "assistant.text.delta"
      data: { terminalId: string; output: string }
    },
    AgentEventPayload
  >
>

export type RejectUnmarkedInlineNativePayload = Assert<
  NotAssignable<
    {
      namespace: "codex"
      nativeType: "unknown"
      storage: "inline"
      payload: { text: string }
    },
    NativeEventReference
  >
>
