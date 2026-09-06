# Collaboration

Status: proposed design, 2026-09-06. Harness is a provisional codename. This stage supplies workflow/review contracts, not a scheduler, reviewer sandbox, or working multi-agent loop.

## Workflow and roles

Persist a versioned workflow definition separately from each run. Planner, builder, reviewer, test auditor, security reviewer, researcher, architect, and judge are roles bound to arbitrary compatible runtimes. Claude builder plus Codex reviewer is an editable preset, never a hardcoded topology. Native subagents remain native features; cross-runtime collaboration belongs to the control plane.

The initial sequence is builder -> tests -> reviewer -> builder finding decisions -> accepted fixes -> tests -> optional final review. A step records dependencies, input artifacts, target/workspace, permission profile, resolved runtime/auth/billing choice, attempt identity, and output contract. Unavailable integrations block their role binding; they do not masquerade as successful adapters.

The default maximum is **2 review cycles**. One cycle is one reviewer pass plus its disposition/fix/test phase; an optional final review consumes a remaining cycle. Retries consume attempt/time budgets and cannot bypass cycle limits. Configurable stops include repeated unresolved findings, no material progress, approval, wall time, token/cost limits, and user approval after a specified iteration count.

## Reviewer isolation and evidence

A review is tied to an immutable implementation snapshot: base/head revisions where available, staged/unstaged diff digest, selected untracked files, file manifest, original task, implementation summary, and test/lint/typecheck command/result artifacts. Findings become stale if the implementation changes. A native conversation fork does not isolate filesystem changes. [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

Default reviewers receive a read-only snapshot or enforced read-only mount and no unrestricted shell/MCP path to the builder tree. A Git worktree alone is not isolation: it can expose shared Git metadata and other paths. Removing edit tools, choosing plan mode, or asking an agent not to write cannot guarantee read-only operation. Required enforcement strength is checked before admission.

Where enforceable native isolation is unavailable, use mediated diff/file artifacts with filesystem/terminal disabled, or mark safe review unavailable. Test execution requires a separate scratch workspace with controlled credentials/network and no builder/shared-Git write access. Repository tests and package scripts execute code; a test auditor has a different permission profile from a read-only reviewer.

Each structured finding records ID, severity, title, description, snapshot-bound location, evidence, recommendation, producer/attempt, and optional confidence. Missing confidence is unknown. Findings are proposals, never executable instructions. Builder decisions are append-only audit records: accepted, rejected, or partially accepted, with rationale and linked fix/test evidence. Partial acceptance identifies the addressed claim. Revalidation does not overwrite original findings or decisions.

Finding fingerprints support a repeated-finding stop heuristic using claim, location/symbol, and snapshot lineage; they do not prove semantic equivalence. Repeated disagreement triggers the configured stop/user decision instead of an endless loop.

## Workspace, billing, and budget ownership

Every writer holds an exclusive fenced lease for its working tree, including tool/background sessions. Future parallel builders use separate worktrees or isolated clones and explicit reconciliation against recorded base revisions. Shared Git state and external effects still require policy. Merge conflicts and final reconciliation remain visible; reviewers never inherit the builder's writer lease.

Resolve auth/billing independently for each participant and recheck changes. Subscription capacity facts may be account-scoped and shared across applications. Route only using supported current observations and user-authorized compatible runtimes. If subscription capacity is unavailable, pause or select an authorized subscription/local alternative. Paid API fallback requires a separate explicit, scoped, auditable grant; default is disabled.

A run must select an **unknown-budget policy**. Default: pause when a configured hard token/cost limit cannot be measured or enforced. Unknown is never zero. An explicit advisory policy may proceed with uncertainty shown, but cannot claim a hard spending cap. Track wall time, attempts, cycles, tokens, estimated API cost, actual reported charges, and quota facts separately. Parallel reservations reduce overshoot; late usage and noninstant cancellation prevent exact guarantees.

Persist workflow transitions and command outbox consistently when implemented. Recovery reconciles in-flight native work rather than rerunning it. Replay rebuilds projections; command deduplication separately prevents duplicate reviews, fixes, merges, or charges. Contract fixtures must cover stale snapshots/approvals, repeated findings, restarts, conflicting leases, unavailable telemetry, and denied billing transitions.
