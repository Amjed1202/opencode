# V1 Claude independent review

Reviewed on 2026-09-07 against the selected unmodified Claude Code **2.1.251** executable contract and official `@anthropic-ai/claude-agent-sdk` **0.3.251**. This review used local files, synthetic account observations, and a compiled provider-free protocol peer. It sent no provider prompts, used no real-account transcript or credential files, and made no native configuration writes.

## Findings resolved

- **Windows workspace admission:** Bun returns a bare drive letter from `realpath` at the volume root. Root normalization now prevents all ordinary workspace/file checks from failing there. Workspace paths reject traversal, metadata directories, alternate streams and ambiguous Windows names; reviewed writes recheck the ordinary file preimage at the final allow write.
- **Permission lifetime:** Native callbacks capture the current turn and epoch before asynchronous file or Skill checks. Interrupts, aborted requests and stale epochs cannot inherit later authority. The official SDK reply is guarded synchronously at the stdin write, and the host authorization callback remains in that guard. Unbound allows and revoked authority are blocked. Write callback failures reject the corresponding delivery promise.
- **Input and response identity:** A previously acknowledged user UUID cannot be reused by another command. Child-role replays cannot acknowledge the main input. Foreign input UUIDs and different native model families fail closed. Stream identity is reset between turns. Completed native frames sharing a response ID retain all text instead of overwriting earlier blocks.
- **Shutdown:** Runtime close retains its shutdown promise and requires direct-child termination before success. Native inspector cleanup also rejects unconfirmed direct-child shutdown. The wire fixture checks that its exact child PID is no longer live after successful cleanup.
- **Host integration:** Conditional discovery includes supported subscription access modes, while current account and policy evidence remains required. The validated capability subset satisfies admission without weakening the global admission gate. Session creation preserves the exact admitted effective snapshot. Native events do not replace host session authority. Protected review uses absolute file paths while diff labels remain relative. An active owned permission recheck is distinct from starting a clean saved resume.
- **Usage:** Bounded per-turn main-loop token observations are retained. Native cumulative query costs are omitted from this projection, preventing repeated counting as separate turn charges.
- **Interrupt outcome:** Only native result `terminal_reason` values `aborted_streaming` and `aborted_tools` attest an interrupted turn. A requested stop or its control acknowledgment cannot complete a turn or relabel a natural successful finish. The interrupt receipt is matched against the sent UUID captured before awaiting it; if that input remains queued, the runtime confirms direct-child shutdown and rejects the operation so the host retains uncertainty instead of allowing it to run later.

## Verification

All commands ran from their package directories with Bun 1.3.14.

| Check                                                      | Final result                   |
| ---------------------------------------------------------- | ------------------------------ |
| Adapter review, Skills review and official-SDK wire review | 23 tests passed, 53 assertions |
| Actual `DesktopBackend` + `ClaudeAdapter` integration      | 1 test passed, 34 assertions   |
| `packages/harness-adapters`: `bun run typecheck`           | Passed                         |
| `packages/harness-desktop`: `bun run typecheck`            | Passed                         |

The desktop test follows the actual admission, manager, journal, protected-review and history paths. Only the native inspector/runtime seams are synthetic. It verifies a selected native model and standalone Skill with both user and model invocation, user-command rewriting, rejection of an allow without a protected review token, guarded Write allowance, Edit denial without a file mutation, multi-block streaming text, token display, file preview, detach, restart, saved history and clean resume using the exact native UUID with no message replay.

The wire tests compile a local executable that implements the SDK's JSON-line peer contract. They exercise the real official SDK serialization and process wrapper, including revocation between callback resolution and the actual stdin write. Initial execution of the freshly compiled test executable is a separate setup step so cold-start overhead does not consume protocol-case timing.

Six focused interrupt regressions cover acknowledgment without a terminal result, both native abort reasons, natural completion before and after the control acknowledgment, no cancellation carryover into a later turn, a receipt retaining the sent UUID, and an unrelated internal queued UUID. The result mapping follows the pinned SDK's public `TerminalReason` contract; it does not infer cancellation from a local request flag.

Review-owned tests:

- `packages/harness-adapters/test/claude/review.test.ts`
- `packages/harness-adapters/test/claude/runtime-review.test.ts`
- `packages/harness-adapters/test/claude/skills-review.test.ts`
- `packages/harness-adapters/test/claude/fixtures/runtime-peer.ts`
- `packages/harness-desktop/test/unit/claude-backend.test.ts`

## Exact boundary

This verifies the bounded host/adapter contract and SDK transport with local fixtures. A real subscription inference, real native Skill execution and real native resume remain separate live validation; they were not exercised by this review. Capability verification denotes this tested pinned subset, not a successful provider response or verified remaining entitlement.

Provider extra usage, quota and charges remain unknown. Token data covers the native main loop, not every internal or auxiliary model call. Cost and context occupancy are not invented from incomplete evidence.

When a native result omits an abort reason, the adapter retains its reported success/error outcome and does not claim that an interrupt was confirmed. A real-provider interruption race was not exercised by this review.

Execution permits mediated ordinary repository Read/Edit/Write operations and explicitly selected standalone `SKILL.md` files. Dynamic Skill shells, external resources, hooks, forked context and added plugin components are rejected. There is no OS sandbox attestation and no general process-tree termination claim. Account, native policy, source files and preimages are checked at the declared observational boundaries; this does not prevent arbitrary privileged external filesystem or account changes afterward.

Only a clean, unchanged, host-known saved conversation can resume. Uncertain native history inspection/reconciliation is unsupported. Unknown or unacknowledged work cannot be replayed as recovery. No remaining defect was found in this bounded final review; the live-provider boundaries above remain unverified.
