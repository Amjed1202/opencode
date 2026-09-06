# Claude continuation review

Reviewed 2026-09-07 against changes based on `4a1aef96f5132bf86dcab0e6e0f801c71b8b3713`. The increment adds native Claude 2.1.251 connection checks and desktop runtime selection. It does not admit Claude execution or native Skills activation.

## Process boundary

An independent review of the native inspector and local process fixtures reproduced a cleanup defect: a diagnostic configured for a 150 ms timeout took about 1913 ms to reject when a short-lived descendant retained stdout/stderr. The command timeout fired, but the inspector awaited the parent `close` event without a cleanup bound.

The fix destroys the host's output streams, requests direct-child termination, bounds the close wait to 250 ms, and disables further inspection when shutdown remains unconfirmed. Outstanding children remain tracked until close. Separate timeout and disposal regressions cover inherited output handles. This bounds the host operation; it does not prove descendant termination.

The inspector fixture suite passes **45 tests and 121 assertions**. It covers fixed commands and environment, immediate stdin EOF, immutable inputs, malformed and private native output, shared byte limits, UTF-8 decoding, version/exit-code checks, timeout/disposal, concurrent calls, path identity and spawn failures. No remaining material finding was identified in this scoped review.

## Desktop integration

A separate source review examined backend state transitions, private worker dispatch, contracts/decoder, picker and sender guards, preload, renderer snapshots and the corresponding unit/browser/Electron regressions. It reported no actionable finding.

Runtime selection accepts only `codex` or `claude`. Switching clears executable, native account home, connection evidence, model and admission acknowledgments, draft and protected review state. It cannot change an attached session or race a pending picker. Claude inspection uses the private host directory. A signed-in result stays separate from subscription billing, and both host and renderer reject Claude execution. Skills remain a read-only catalog with no activation operation.

The primary agent also reviewed the adapter's target/path/version binding, disabled capabilities, sanitized status projection, lifecycle checks and blocked direct execution methods. Adapter behavior is covered by **9 tests and 73 assertions**. The real native smoke uses an isolated signed-out profile and no provider prompt. Complete final suites, build, browser/Electron checks and remaining acceptance limits are recorded in [VALIDATION.md](../../VALIDATION.md).

These source and fixture reviews do not establish live subscription entitlement, effective managed policy, provider charge prevention, a native execution sandbox or distribution readiness.
