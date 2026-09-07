# Milestones and acceptance gates

The current desktop V1 candidate is tracked in [V1_STATUS.md](V1_STATUS.md). The broader platform milestones below remain separate from the local desktop feature set.

## Stage 0 — architecture delivery

Architecture reconnaissance of pinned stable OpenCode; package/component classifications; nine requested documents; an actionable migration plan; independent universal protocol, adapter and control-plane contracts; provider TODO folders; provisional identity/default configuration; fork and upstream provenance; checks and an honest validation report.

Acceptance: upstream functional source remains intact; universal types import no native runtime; authentication, billing, capabilities, sessions, events, usage, collaboration and node identity are distinct; no pretend adapters or successful fake sessions. `VALIDATION.md` records actual checks and limitations. This does **not** complete Milestone 1 or produce a new working desktop application.

## M1a — admission and Codex vertical slice

Current progress: the local host, admission, SQLite command/permission/input journals and pinned Codex adapter are implemented and exercised with spawned protocol peers. Bounded once-only file decisions, blocking fixed-choice input, encrypted patch/question review, expiry, native history inspection and exact-turn reconciliation are available through host APIs. Grants and answers require a current actor-bound review token and final authorization at the native write boundary. M1a is **not complete**: broader action/raw-artifact handling, OS boundary verification and a user-authorized live repository task remain acceptance work. The new [desktop](DESKTOP.md) now supplies protected review presentation and OS-protected review keys. See [implementation status](M1A_IMPLEMENTATION.md).

Implement runtime discovery and nonsecret preflight, provider-specific environment construction, session registry/command ledger and one private local transport. Add Codex App Server using managed native ChatGPT login with API fallback disabled. Pin and test actual executable protocol versions. Keep existing native credentials provider managed; account reads must not mutate login.

Acceptance: one real repository session can run a user-authorized task through control-plane APIs, stream text/actions, handle accept/deny/expiry, interrupt, resume after restart and retain raw events safely. Conflicting API configuration blocks before inference. No silent billing-route changes on capacity errors, retries or reconnection. Fixtures cover protocol behavior; a separately authorized live session validates subscription routing evidence. Unknown provider overage remains explicit.

## M1b — Claude native integration and OpenCode adapter

Current progress: Claude Code **2.1.251**, through official SDK **0.3.251**, supports a restricted personal native subscription path with streaming, protected writes, standalone Skills, tokens and exact settled resume. Full desktop/adapter fixtures and native no-prompt initialization cover the implemented boundaries. Live repository acceptance remains pending, and OpenCode execution remains unimplemented. [Claude scope](V1_CLAUDE.md).

After the required evidence is available, extend the permitted unmodified Claude Code route with a structured stream and native permission host. Keep direct SDK subscription use conditional on current official permission; explicit API mode uses its own route. Verify stream schemas and permission ordering on installed versions, including Windows process cancellation. Implement OpenCode via one pinned supported API generation, including its own native permissions/history, with capabilities limited to proven functions.

Acceptance: the same application session commands and event projections operate all three harnesses. Native features remain available by capability/extension. Claude and Codex subscription intent is verified separately; inability to verify or legally support a route is a blocking gate, never a reason to silently substitute an API integration. No OpenCode provider plugin stands in for native Claude/Codex.

## M1c — desktop foundation proof

Current progress: the additive Electron/Solid desktop now supplies native Codex and Claude selection, protected review, saved local conversations, explicit recovery/resume, files/diffs, usage/context presentation and selected standalone Claude Skills. Windows portable packaging includes Bun; native agents remain user-installed. Model and billing selection are explicit, and the renderer owns no native orchestration. Live two-runtime repository acceptance remains pending. [Current scope](V1_STATUS.md).

Continue the restricted preload/control-plane client and session presentation in this separate Electron/Solid application. Introduce the new identity, account/runtime settings, repository picker, conversation activity, normalized approvals, billing labels and basic token/context information. Reuse upstream markdown, diff/file viewer and terminal presentation through domain-specific view models. Ship Files/Diff and minimum tool visibility before the full inspector set.

Before packaging, isolate data/config, app IDs and deep links; disable upstream updater/share/telemetry destinations in the Harness distribution and configure owned signing/update channels. Keep upstream development behavior available and clearly separate.

Acceptance: open the desktop, open a repository, choose Claude or Codex, perform an explicitly authorized coding task, inspect changes and available usage, interrupt/resume, then create a session with the other runtime without provider orchestration in the renderer. Show verified subscription route where supported; unsupported/unknown fields remain absent or labelled. Test keyboard navigation, accessible approvals, closed-inspector layout and long streaming conversations. Windows first, then macOS/Linux build smoke tests. This is the full Milestone 1 success criterion.

## M2 — bounded collaboration

Role assignments are arbitrary runtime/model/auth/target selections. Implement builder → tests → immutable review bundle → read-only reviewer → structured findings → builder decisions/fixes → tests → optional final review. Default maximum two review cycles; explicit token/cost/time/approval/recurrence stops. Unknown enforced budgets block or pause according to configured policy. Reviewers cannot alter the builder's tree, including through shell/MCP.

Acceptance: each finding and accept/reject/partial decision is auditable, both runtime billing routes stay explicit, repeated findings stop, disconnects do not duplicate work, and shared workspaces never gain concurrent uncoordinated writers.

## M3 — remote Madar node

Authenticated/encrypted private-network `harness-node`, initially through Tailscale with node/device authorization; optional SSH bootstrap/recovery. Native login occurs on Madar. Reuse local protocol, node-local workspaces and permissions; bind sessions to node identity and execution lease. Implement replay, revocation and uncertain-command recovery before unattended execution.

Acceptance: select Madar, open a repository there, use its authenticated native runtime, inspect results locally and reconnect without credential transfer, public unauthenticated ports, duplicate execution or stale approvals. Remote terminal is a typed node service, not screen scraping.

## M4 — broader platform

Add isolated parallel worktrees and explicit reconciliation, usage aggregates, context inspection, richer MCP/skills/hooks, explicit API/local runtime adapters, attachments/images, additional targets and reviewed extension APIs. Promote new packages only when independently testable implementations justify them. Native feature parity is tracked per runtime/version rather than promised universally.

## Remaining foundation acceptance

Run the bounded live repository scenarios through both native subscriptions after explicit acknowledgment of unknown provider extra usage. Verify real protected allow/deny, interruption, Skill invocation and exact resume without replay. The Windows local candidate and fixture tests do not certify those provider outcomes. An attested OS execution boundary, cross-process fencing and OpenCode execution remain broader foundation work; collaboration and remote nodes follow their own acceptance gates.
