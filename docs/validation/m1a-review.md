# Initial host review record

Reviewed against migration tasks 4–5 and the limited scope in [M1A_IMPLEMENTATION.md](../../M1A_IMPLEMENTATION.md). No live model task was used as review evidence.

## Admission and workspace review

Behavioral regressions reproduced and corrected invalidation during preflight, consent/evidence expiry across asynchronous checks, replaced runtime descriptors, mutable inputs, blended subscription/API payloads, missing account identity, unverified enforcement, invalid command hashes, outstanding-token limits, overlapping workspace roots and replaced directories. Dispatch revalidates admission and workspace ownership after durable bookkeeping. Explicit advisory sandbox intent remains permitted; enforced reviewer requests remain blocked.

## Native adapter review

Corrected duplicate-send reservation release, stale/foreign native turn attribution, delayed events across turns, routine quota notifications incorrectly invalidating account state, unsafe native server-request routing, parent/native shell environment reintroduction, startup telemetry controls and direct adapter environment validation. Tests use actual local child processes speaking the pinned native protocol. A separate installed-native smoke confirms the final process-only settings but performs no inference.

## Journal and orchestration review

Corrected unacknowledged command reuse, stream-loss handling, completion validation before journal settlement, active-turn correlation, pump replacement, dispose/recovery races, mutable request/result/event authority, snapshot-gap delivery and interrupted session projection recovery. Actual killed writer processes verify conservative recovery at both durable dispatch boundaries.

A final independent reviewer then reproduced two remaining defects:

1. Passing an authoritative mutable session into `adapter.close` could permit lease release or change the expected resumed native ID. Both call sites now pass clones.
2. An old pump's queued EOF/error callback could mark a newly resumed attachment uncertain. Both callbacks now recheck attachment identity and stopping state inside the session lock.

Four new regressions failed before those fixes and passed afterward. The final reviewer independently checked both code paths and reran all four focused tests: **4 pass, 11 assertions, exit 0**, with no remaining issue in that scoped rereview.

## Limits retained

This review does not certify OS isolation, descendant-process termination, cross-process workspace ownership, provider-side billing atomicity, interactive permission grants, native history reconciliation or a production renderer/network boundary. Uncertain commands are not replayed; unresolved native ownership retains leases. The broader M1a acceptance gates remain open.
