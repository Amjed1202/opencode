import type { ProtocolError } from "@harness/protocol"

/** Display fixed categories only; native error text can contain private account or request data. */
export function runtimeErrorLabel(error: ProtocolError) {
  if (error.code === "capacity-limited" && error.nativeCode === "rate_limit")
    return "Native usage limit reached. Check the provider's reset time."
  if (error.code === "capacity-limited") return "Native capacity is unavailable. Check the selected runtime."
  if (error.code === "auth-required") return "Native authentication needs attention. Check the selected runtime."
  if (error.code === "billing-conflict") return "The native account or billing route is unavailable."
  if (error.code === "invalid-input") return "The native runtime rejected this request."
  if (error.code === "unavailable") return "The selected native service or model is unavailable."
  return "Native execution stopped. This message will not be resent automatically."
}
