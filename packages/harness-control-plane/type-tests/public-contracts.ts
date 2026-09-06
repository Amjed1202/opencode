import type { AgentAdapter } from "@harness/adapters"
import type { EventDelivery, AgentEventDraft, CommandReceipt, PreflightResult } from "@harness/protocol"
import type { ControlPlaneClient } from "../src/index"

type Assert<T extends true> = T
type Extends<A, B> = A extends B ? true : false

export type NativeStreamHasDrafts = Assert<Extends<ReturnType<AgentAdapter["events"]>, AsyncIterable<AgentEventDraft>>>
export type ApplicationStreamHasDurableEvents = Assert<
  Extends<ReturnType<ControlPlaneClient["events"]>, AsyncIterable<EventDelivery>>
>
export type SendingIsAdmissionNotCompletion = Assert<Extends<Awaited<ReturnType<AgentAdapter["send"]>>, CommandReceipt>>
export type PreflightCanBlock = Assert<
  Extends<Extract<PreflightResult, { status: "blocked" }>["errors"], readonly unknown[]>
>
