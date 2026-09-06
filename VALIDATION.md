# Validation and known issues

Executed 2026-09-06 on Windows with Bun **1.3.14** and Node **24.14.1**. This validates architecture scaffolding and selected existing upstream behavior. It does not validate real Claude/Codex execution, subscription billing, the new desktop UI, security enforcement, collaboration or remote nodes; none is implemented in this stage.

## Typechecks and static checks

`bun typecheck` was executed from each package directory:

| Packages | Final result |
| --- | --- |
| harness-protocol, harness-adapters, harness-control-plane | **3 passed**, including compile-time contract checks |
| schema, protocol, core, server, client, sdk-next, opencode, session-ui, ui | **9 passed** |
| app, desktop | **2 passed** after fixing local Git symlink materialization |

The initial app/desktop failure was TS1128 because Windows checked out a tracked symlink as the literal target text. Restoring the tracked links with local `core.symlinks=true` resolved it. Git reports no upstream source changes. Initial adapter/control-plane checks before workspace linking failed module resolution; the final frozen filtered install and all subsequent checks passed.

- New-package Oxlint: **0 warnings, 0 errors**, 14 TypeScript files.
- Prettier applied only to added packages/product manifest; formatting check passes.
- `git diff --check`: passed.
- `git diff --exit-code HEAD -- LICENSE package.json turbo.json` and checked upstream package paths: passed against the pinned baseline before the delivery commit.
- Native/protocol import review: new contracts have no OpenCode/Electron/provider runtime import; adapter/control-plane dependencies are type-only.
- Independent architecture/contract review: five identified gaps corrected (source identity, replay gaps, permission audit, collaboration attribution, operation-bound preflight); follow-up review found no material inconsistency in that scope.

## Existing tests exercised

| Package / command | Original result | Targeted recovery |
| --- | --- | --- |
| core: eight existing schema/event/permission/policy/session contract files | 111 pass | None needed |
| opencode: four existing session-schema/decoding/ACP-usage/event-manifest files | 40 pass | None needed |
| app: `bun run test:unit` | 724 pass | None needed |
| app: `bun run test:browser` | 41 pass | None needed; HappyDOM, not E2E |
| session-ui: `bun run test` | 83 pass | None needed |
| ui: `bun run test` | 27 pass | None needed |
| client: `bun run test` | 15 pass, 1 fail | Failed import-boundary case passed with approved child-process permission |
| sdk-next: `bun run test` | 3 pass, 2 fail | Import-boundary case passed with approved child-process permission; SQLite cleanup case remains failed |

**1,047 unique cases exercised: 1,044 passed initially; two failed cases passed targeted reruns; one unresolved failure remains.** Reruns are not additional coverage, and the original client/sdk-next suite invocations were not clean passes.

Core command:

```sh
bun test --timeout 5000 --only-failures ./test/shared-schema.test.ts ./test/event.test.ts ./test/permission.test.ts ./test/policy.test.ts ./test/session-create.test.ts ./test/session-projector.test.ts ./test/session-history.test.ts ./test/session-run-coordinator.test.ts
```

OpenCode command:

```sh
bun test --timeout 5000 --only-failures ./test/session/session-schema.test.ts ./test/session/schema-decoding.test.ts ./test/acp/usage.test.ts ./test/event-manifest.test.ts
```

Each failed import-boundary case was rerun from its owning package with `bun test --timeout 5000 --only-failures ./test/import-boundaries.test.ts`. The sandbox had blocked `Bun.spawn`/`uv_spawn` with EPERM. Narrow approved reruns passed. The remaining SDK Next failure is `embedded client uses the real router and handlers`, reported at `packages/sdk-next/test/embedded.test.ts:103` while deleting its temporary SQLite directory (`EBUSY`). No unrelated upstream implementation was changed to conceal it.

## Dependency installation

| Command | Result |
| --- | --- |
| Unchanged upstream `bun install --frozen-lockfile` | Failed: tree-sitter-powershell native node-gyp build could not create a generated `.vcxproj.filters` path on Windows |
| `bun install --frozen-lockfile --ignore-scripts` | Failed: electron-winstaller tarball extraction |
| `bun install --lockfile-only --ignore-scripts` after adding contracts | Passed with network access; **only 37 added lockfile lines for the three workspaces**, no dependency-version churn |
| `bun install --frozen-lockfile --ignore-scripts --filter '@harness/*'` | Passed with network access; contract workspaces linked |

The first sandboxed lock/link attempts lacked network access; their network errors were resolved by the approved retries. These do not turn the full native dependency installation into a pass. Core/OpenCode full suites, HttpApi exercisers, generated-client regeneration, full Turbo matrix, desktop packaging and Playwright E2E were not run. No relevant generated API source was changed.

## Isolation and evidence

Tests used isolated XDG data/config/cache/state, test home, managed config and temp directories under task scratch space, with in-memory DB and fixture model metadata. Provider/auth/API/OTEL environment values were removed without printing them. Model fetching, sharing, updates and filewatching were disabled; recording mode was off. Several sandbox suites emitted a nonfatal home-path EPERM warning, retained in logs. Native login, provider credential reads and paid inference were not performed.

See [command records](docs/validation/upstream-results.json), [final typecheck records](docs/validation/final-typechecks.json) and logs in the same directory. Stored records use workspace-relative placeholders for local paths. The validation wrapper records the actual child exit code separately; wrapper completion alone is not a passing result.

## Remaining implementation gates

- Claude was not found on PATH; both native adapters are still unimplemented. Recheck official authentication conditions/versioned schemas before integration.
- All permission, environment, quota, replay, storage, secret and remote controls are contracts/designs only.
- The provisional product configuration does not change upstream identity, updater, telemetry or data handling; do not distribute the unchanged upstream executable as Harness.
- The local clone is shallow; fetch sufficient history before merging another stable release.
- Repair the recorded native Windows dependency-build issues and SDK Next cleanup failure in a separate focused setup/upstream compatibility task before claiming a clean full build.

Recommended next work: M1a billing-safe admission plus native Codex App Server session/events/approvals, with a separately authorized real subscription-session demonstration after fixture checks.
