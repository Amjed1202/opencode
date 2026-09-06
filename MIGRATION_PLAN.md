# Universal Runtime Foundation implementation plan

**Goal:** add a universal control plane around native harnesses while retaining a maintainable OpenCode fork.

**Architecture:** three additive contract packages now; privileged control-plane worker and native adapters next; a narrow new desktop route after native admission works. Upstream paths and agent engines remain intact.

**Tech stack:** pinned Bun 1.3.14, existing TypeScript/catalog toolchain, Electron/Solid upstream, SQLite/Drizzle planned for application storage.

**Spec:** [ARCHITECTURE.md](ARCHITECTURE.md), [PROTOCOL.md](PROTOCOL.md), [ADAPTERS.md](ADAPTERS.md), and linked policy documents.

## Constraints

- Start at stable v1.18.29 / `16747470f976aca3d362ad730bcd3fe82ecc2c9a`; retain MIT and upstream remote.
- Do not alter the root package workspace patterns: `packages/*` already includes new flat packages.
- Never automatically choose paid API fallback by default; no copied browser/native session tokens.
- Renderer calls the control plane; native harnesses retain their tools, permissions and context engines.
- The first delivery stopped after structural scaffolding. The subsequent continuation implements the initial portions of tasks 4–5; [M1A_IMPLEMENTATION.md](M1A_IMPLEMENTATION.md) records the remaining acceptance work.

## 1. Reconnaissance and provenance — current stage

- [x] Resolve the GitHub stable release metadata and actual tag commit independently.
- [x] Clone the release and create `runtime-foundation`, following upstream's branch naming rules.
- [x] Create the requested GitHub fork and configure `origin` and `upstream` separately.
- [x] Read root/package instructions and trace desktop → preload → server, mixed client generations, native session/permission/event/data paths and CI scripts.
- [x] Document package dispositions, source evidence, unavoidable translation and deferred risk in the nine design files.

No production source edits are needed for this task. Before later merges, fetch missing ancestors and verify the merge base; see [UPSTREAM_STRATEGY.md](UPSTREAM_STRATEGY.md).

## 2. Minimum contracts — current stage

Create these units in order after the design documents:

| File/unit | Responsibility and public types |
| --- | --- |
| `packages/harness-protocol/src/common.ts` | JSON values, identifiers, artifact/native-event references, observation evidence |
| `src/capabilities.ts`, `src/runtime.ts` | Capability states, model/runtime/target selection, auth and billing evidence, explicit fallback preferences |
| `src/session.ts`, `src/permissions.ts` | Session intent/bindings, admission, commands, input, permissions and human questions |
| `src/usage.ts`, `src/events.ts` | Scoped measurements/context/quota, discriminated event drafts and persisted envelopes |
| `src/collaboration.ts`, `src/remote.ts` | Roles/findings/decisions/budgets and node/lease/transport contracts |
| `packages/harness-adapters/src/index.ts` | Native adapter interface and optional capability ports; no concrete adapters |
| `packages/harness-adapters/src/{claude,codex,opencode,generic,remote}/README.md` | Native integration route, evidence required and exact next TODOs |
| `packages/harness-control-plane/src/index.ts` | Public application client plus privileged registry/admission/storage/workspace/process/secret service ports |
| Package manifests/tsconfigs and protocol contract checks | Private ESM packages, existing catalog compiler, strict non-emitting checks |
| `harness.product.json`, `HARNESS.md` | Provisional identity, provenance, explicit safe defaults and entry point to these documents |

Package import direction: adapters → protocol; control-plane → protocol and adapter **types**; protocol → nothing. The renderer may later consume client DTOs from protocol/control-plane but may not import adapters. Avoid extra empty packages for telemetry, permissions, workspace or nodes; split implementations only when needed.

Add compile-time checks that invalid event payloads and mismatched API billing selections fail, and that the three public package surfaces resolve. Do not create fake runtime instances to make a test green. Invoke each package's `bun typecheck` script rather than running `tsc` directly.

## 3. Structural verification — current stage

1. Install the unchanged upstream lockfile with the pinned runtime: `bun install --frozen-lockfile`. Record baseline failures before editing dependency records.
2. Add only the new workspace entries to `bun.lock` using Bun, inspect the diff, and reject unrelated version churn. Repeat frozen installation for the final graph.
3. From each added package directory run `bun typecheck`. Run package-level upstream checks for `schema`, `protocol`, `core`, `server`, `client`, `sdk-next`, `opencode`, `app`, `session-ui`, `ui`, `desktop` as dependencies permit.
4. Run existing package tests from package directories, never root `bun test`. Start with core/opencode and existing app/session-ui/ui scripts. Set isolated XDG/test/config/cache/state roots before imports, remove provider-key inheritance, disable telemetry and model network fetching. Preserve failures as evidence; do not alter unrelated upstream code to hide them.
5. Run `git diff --check`; compare the MIT notice and all preexisting functional source against the pinned commit; inspect dependency boundaries and final files. Record pass/fail/blocked, commands and exit codes in `VALIDATION.md`.

Use full CI/e2e and native packaging once UI or transport behavior changes. This structural stage must not call a model to claim native integration works.

## 4. Billing-safe admission — initial implementation delivered

Create `packages/harness-control-plane/src/admission.ts`, `runtime-manager.ts`, `environment.ts`, and tests alongside them. Implement `preflight`/admission ports declared in `src/index.ts`.

Fixtures: subscription native status + inherited API key; API profile/helper override; unknown billing; expired evidence; capacity exhaustion; explicit API consent; account switch after preflight. Assert that only matching, current, enforceable intent reaches adapter creation and that failure never instantiates an API adapter. Build the environment from permitted OS/runtime variables, not by deleting only two API keys from a copied environment. No auth-secret values in assertions/logs. Admission state is bound to workspace, target, policy and command digest.

Then implement local process supervision and the SQLite command/event journal. Verify crash-before-dispatch, crash-after-dispatch and native completion reconciliation; uncertain commands are not automatically repeated. This is required before a coding session can be called resumable.

## 5. Codex vertical slice — initial local protocol implementation delivered

Create `packages/harness-adapters/src/codex/adapter.ts` and versioned mapping fixtures. Generate official wire types from a pinned supported executable into an adapter-private generated directory, retaining provenance. Use App Server stdio, initialize, native account read/login UI, thread start/resume, turn start/interrupt and native server approval requests. Bind native request/turn/item IDs and preserve unknown native events. Test subscription/API conflicts and effective account updates before a separately authorized real task. Expose only verified model/capability fields.

## 6. Claude and OpenCode vertical slices

Claude: install/select an unmodified supported binary, verify official integration conditions, collect documented auth-status/stream/permission-host schemas, then implement `claude/adapter.ts` without touching provider-owned tokens. Preserve native login choices; add explicitly selected API/approved SDK routes separately. Prove interruption, native subagents/usage attribution and required permissions before advertising support.

OpenCode: implement `opencode/adapter.ts` using pinned SDK/server APIs. Keep version/capability probing inside this folder. Use separate state/config/database roots; do not import core into the universal domain. Test one session generation end-to-end before considering current `/api` migration. Cover tool/permission and SSE disconnect behavior with real upstream server fixtures isolated from user data.

## 7. Desktop integration and identity

Add a dedicated control-plane channel in `packages/desktop/src/preload/{index,types}.ts` and validated handlers in `src/main/ipc.ts`; launch a separate supervised worker from main. Add a Harness session route/context in `packages/app/src` that depends on application DTOs. Reuse UI and session presentation through view models. Add runtime/account/billing/target selector, approvals and diff inspection; no provider SDK imports in components.

Before packaging, wire `harness.product.json` into a distinct build profile affecting `electron-builder.config.ts`, main app/data IDs, scheme, assets, updater, telemetry and i18n. Keep upstream development as a separate profile. Verify two installations coexist and a Harness update can never install upstream OpenCode. Use existing performance baseline and accessibility/e2e workflows when timeline/UI code changes.

## 8. Follow-on work

Implement the collaboration state machine in [COLLABORATION.md](COLLABORATION.md) only after both native slices pass; then implement [REMOTE_NODES.md](REMOTE_NODES.md) with the same host policy and protocol. Neither worktree creation nor private-network membership alone establishes a security boundary. Each task ends with independent behavior tests and a reviewable commit, never a broad monorepo relocation.
