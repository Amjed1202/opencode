# V1 acceptance

The local Windows desktop candidate implements the requested V1 feature set. **Live subscription acceptance remains open:** no provider prompt has been sent, and unknown provider extra usage still requires explicit acknowledgment. This is not completion of the wider modular platform. OpenCode execution, remote nodes, multi-agent collaboration, arbitrary native extensions, installers, signing and updates remain later milestones.

| Requirement                                         | Implemented and locally verified                                                                                                             | Remaining acceptance                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Subscription-first Codex execution and model choice | Pinned 0.153.4 adapter, protected review, native catalog and launch-only isolation; installed account reports subscription and seven models  | Live repository coding, allow/deny, interruption and resume                        |
| Native Claude execution                             | Official SDK 0.3.251 with unmodified CLI 2.1.251; unmanaged personal Pro/Max, restricted Read/Edit/Write; actual host/adapter fixture passes | Live provider task and permissions                                                 |
| Claude Skills                                       | Explicit hash/policy/invocation selection; unchanged standalone native plugin staging; installed CLI loads fixture Skill without a prompt    | Live native Skill invocation; broader Skill features unsupported                   |
| Saved conversations and recovery                    | Bounded SQLite history, immutable host bindings, explicit clean resume, Codex native inspect/reconcile; desktop restart fixture              | Live native resume; Claude uncertain inspection unsupported                        |
| Files and diffs                                     | Bounded inert workspace text previews; link/identity/truncation checks; changes against session-start memory snapshot                        | No Git HEAD baseline or baseline restoration after restart                         |
| Usage and context                                   | Codex cumulative tokens/capacity and Claude per-turn main-loop tokens; actual host event projection and renderer fixtures                    | Live telemetry observation; charges, quota and unreported occupancy remain unknown |
| Windows portable application                        | Electron, bundled Bun, legal notices, SHA-256 manifest and ZIP; isolated packaged launch/restart                                             | Unsigned local candidate; no installer, signing or update channel                  |

Exact commands, counts, artifact hashes and limitations are in [VALIDATION.md](VALIDATION.md) and [package evidence](docs/validation/v1-package-results.json). [Run the desktop](DESKTOP.md), [Claude contract](V1_CLAUDE.md), [Skills compatibility](CLAUDE_SKILLS.md).

History is a partial local preview. Opening it never resumes or replays a message. Native inspection precedes explicit uncertain-state reconciliation. Unknown creates without a saved native session remain blocked; clean Claude resume is limited to trusted settled sessions with unchanged bindings.

File previews exclude dependency/build/runtime directories, `.env` files, binary and oversized content. Scans report partial results when bounds or unreadable entries prevent completeness. Diffs compare text against the current launch's session-start snapshot; resumed sessions cannot reconstruct that baseline.

Usage counters preserve their reported scope. Cumulative snapshots replace earlier totals; they are not summed as per-turn values or treated as current context occupancy. No displayed token count is a subscription charge or quota guarantee. SDK cumulative monetary estimates are omitted because their scope differs from per-turn token counts.

The package keeps native Codex and Claude user-installed and authenticated through their own interfaces. Tool mediation and process-local leases do not attest an OS sandbox or cross-process fencing. Source upload and public distribution remain separate actions.

To close live acceptance, the prepared bounded fixture run must prove a real denied edit, one exact approved `sum.ts` change with fixed tests, interruption, history/exact resume and native Skill invocation. Those checks consume subscription usage. Local fixtures and no-prompt diagnostics are explicitly recorded as such.
