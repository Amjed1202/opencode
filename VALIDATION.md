# Validation and known issues

Executed 2026-09-06 on Windows with Bun **1.3.14**, Node **24.14.1** and Electron **42.3.3**. The newest continuation adds a development desktop and Claude Skills discovery. [Desktop scope](DESKTOP.md) and [host scope](M1A_IMPLEMENTATION.md) distinguish implementation from live-provider, OS execution boundary and distribution acceptance.

## Desktop and Claude Skills continuation

| Final check                                         | Result                                                                  | Evidence                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Complete host suite                                 | **281 pass, 1 platform skip, 0 fail**, 1078 assertions                  | [Log](docs/validation/m1c-desktop-control-plane-tests.log)                                                |
| Complete adapter suite                              | **223 pass, 0 fail**, 582 assertions                                    | [Log](docs/validation/m1c-desktop-adapters-tests.log)                                                     |
| Complete desktop unit/process suite                 | **49 pass, 1 platform skip, 0 fail**, 300 assertions                    | [Log](docs/validation/m1c-desktop-unit-tests.log)                                                         |
| Chromium renderer tests                             | **6 pass**                                                              | [Log](docs/validation/m1c-desktop-ui-tests.log)                                                           |
| Real Electron startup/restart smoke                 | **1 pass**                                                              | [Log](docs/validation/m1c-desktop-electron-tests.log), [screenshot](docs/validation/m1c-desktop.png)      |
| Four Harness package typechecks and desktop build   | **Pass**                                                                | [Commands/logs](docs/validation/m1c-desktop-results.json), [build](docs/validation/m1c-desktop-build.log) |
| Frozen filtered dependency install                  | **Pass; no graph changes**                                              | [Log](docs/validation/m1c-desktop-install.log)                                                            |
| Authored-source format and lint                     | **Format pass; 0 lint errors, 312 warnings** across 83 TypeScript files | [Format](docs/validation/m1c-desktop-format.log), [lint](docs/validation/m1c-desktop-oxlint.json)         |
| Native generated protocol and upstream preservation | **72 hashes match; functional upstream and MIT unchanged**              | [Results](docs/validation/m1c-desktop-results.json)                                                       |
| Independent boundary review                         | **Findings fixed and regression checked**                               | [Review](docs/validation/m1c-desktop-review.md)                                                           |

Total: **553 passing unit/process tests, 2 platform skips, 1960 assertions**, plus **7 browser/Electron tests**. On Windows, the host's open-database directory-rename test and desktop's POSIX permission-mode test skip explicitly. Existing Windows file/sidecar link checks and real OS key wrapping run. Lint warnings are retained in the diagnostics, primarily typed assertions and Bun test typings; this is not a warning-free result.

The Electron smoke uses a fresh private directory, the real built custom origin, sandboxed renderer, fixed preload, private Bun worker and OS safeStorage. It checks that renderer Node globals are absent, CSP and asset restrictions apply, the unconfigured backend contains no session, and the encrypted key envelope survives restart unchanged. The process suites verify protected reviews and native protocol behavior with local peers; no real provider process was configured or invoked. Claude Skills tests use temporary files and do not inspect installed personal skills or credentials. Production includes no fixture response or sample conversation fallback.

The new workspace reuses already-pinned dependencies; bun.lock adds only its workspace/dependency reference. Electron's pinned platform binary was installed separately after a script-disabled dependency install. Compiler/native test subprocesses needed permission outside the default process sandbox. Earlier upstream baseline checks remain historical: no upstream functional code or package resolution changed. All four added package typechecks and the new desktop build were rerun.

This delivery does not establish live subscription billing, disabled provider overage, an attested native OS execution sandbox, cross-process fencing or installer/distribution readiness. One session per launch, model discovery, native history/recovery presentation, Claude/OpenCode adapters and native Claude Skills activation remain explicit limitations. The catalog is metadata only and never grants tool authority. Full command details and results are in [the results record](docs/validation/m1c-desktop-results.json).

## Protected review and fixed-choice input continuation (historical)

| Final check                          | Result                                                  | Evidence                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete host suite                  | **264 pass, 1 platform skip, 0 fail**, 1,001 assertions | [Log](docs/validation/m1a-review-input-control-plane-tests.log)                                                                                                                                                                        |
| Complete adapter/stdio/input suite   | **214 pass, 0 fail**, 549 assertions                    | [Log](docs/validation/m1a-review-input-adapters-tests.log)                                                                                                                                                                             |
| Three Harness package typechecks     | **3 pass**                                              | [Protocol](docs/validation/m1a-review-input-harness-protocol-typecheck.log), [adapters](docs/validation/m1a-review-input-harness-adapters-typecheck.log), [host](docs/validation/m1a-review-input-harness-control-plane-typecheck.log) |
| Authored-source Prettier             | **Pass**                                                | [Log](docs/validation/m1a-review-input-format.log)                                                                                                                                                                                     |
| Oxlint, 50 authored TypeScript files | **0 errors, 229 warnings**, exit 0                      | [Diagnostics](docs/validation/m1a-review-input-oxlint.json)                                                                                                                                                                            |
| Official generated protocol files    | **72 hashes match**, unmodified                         | [Provenance](packages/harness-adapters/src/codex/generated/0.153.4/provenance.json)                                                                                                                                                    |
| Independent boundary reviews         | **Three findings fixed and rechecked**                  | [Review](docs/validation/m1a-review-input-review.md)                                                                                                                                                                                   |

Total: **478 passing tests, 1 platform skip, 1,550 assertions**. The skipped test renames a directory holding an open SQLite database, which Windows disallows; live database and sidecar replacement/link checks are exercised separately. Warnings remain, primarily Bun assertion typings and typed JSON/test assertions. [Command/results record](docs/validation/m1a-review-input-results.json).

The local end-to-end fixtures use the actual host, encrypted artifact store, journal, Codex adapter and stdio transport. They verify protected patch/question delivery, exact reviewed hashes, once-only native answers, cancellation, native callback retirement, final authorization checks and token/content exclusion from ordinary audit events. Artifact tests inspect ciphertext-only SQLite/WAL data, wrong-key/tamper/cross-session rejection, expiring actor-bound grants and forced-process-kill recovery. Private-root reservations reject overlap with all existing and future registered workspaces, including an in-flight registration. Input journal recovery atomically expires pending handles while retaining claimed uncertainty without replay.

Wire protocol **0.3** adds bound choice input and protected review receipts. Earlier event journals, including 0.2, require an explicit migration or separate database and remain unchanged on rejection. Native Codex remains pinned to **0.153.4** with `experimentalApi: false`; [pinned official source findings](docs/validation/m1a-review-input-native-source.md) explain why the supported request does not require broader experimental negotiation.

This continuation made no native provider thread/turn, login, refresh, account operation or inference call. Final process tests used sandbox-approved local fixture peers. Recurring Windows SQLite cleanup failures were traced to statement-cache eviction in pinned Bun 1.3.14, rather than dismissed as transient file locks. The journal now owns and finalizes its static prepared statements before strict close; a public-workload regression checks immediate cleanup. No retry limit was increased. No new dependencies or upstream functional source changed, so earlier installation and upstream baseline checks were not repeated. There is no desktop approval/question UI, OS vault provisioning, aggregate artifact retention limit, OS isolation attestation or live model-task acceptance. Artifacts are limited to 1 MiB each, with explicit logical deletion; encrypted resolved artifacts persist until the host deletes them.

## Permission and native-history continuation (historical)

| Final check                          | Result                                | Evidence                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete host suite                  | **169 pass, 0 fail**, 544 assertions  | [Log](docs/validation/m1a-permissions-control-plane-tests.log)                                                                                                                                                                      |
| Complete adapter/stdio/history suite | **144 pass, 0 fail**, 360 assertions  | [Log](docs/validation/m1a-permissions-adapter-tests.log)                                                                                                                                                                            |
| Three Harness package typechecks     | **3 pass**                            | [Protocol](docs/validation/m1a-permissions-harness-protocol-typecheck.log), [adapters](docs/validation/m1a-permissions-harness-adapters-typecheck.log), [host](docs/validation/m1a-permissions-harness-control-plane-typecheck.log) |
| Authored-source Prettier             | **Pass**                              | [Log](docs/validation/m1a-permissions-format.log)                                                                                                                                                                                   |
| Oxlint, 41 authored TypeScript files | **0 errors, 152 warnings**, exit 0    | [Diagnostics](docs/validation/m1a-permissions-oxlint.json)                                                                                                                                                                          |
| Official generated protocol files    | **65 hashes match**, unmodified       | [Provenance](packages/harness-adapters/src/codex/generated/0.153.4/provenance.json)                                                                                                                                                 |
| Independent host and native reviews  | **Four findings fixed and rechecked** | [Review](docs/validation/m1a-permissions-review.md)                                                                                                                                                                                 |

Total: **313 tests, 904 assertions**, all passing. Lint warnings are retained, predominantly Bun promise-assertion typings and typed JSON/test assertions; the result is not warning-free. [Command/results record](docs/validation/m1a-permissions-results.json).

The new host integration tests exercise real stdio transport, the Codex adapter, admission, permission claims, SQLite audit events, completion and read-only history reconciliation together. They use only local Bun peers. Restart tests kill local SQLite writers, contend from separate processes and verify that uncertain decisions never replay. Pending expiry and its replay event commit atomically, with original stream/command scope preserved and rollback tested. Six compatibility cases verify that old or malformed event journals are rejected before schema changes, remain byte-identical, and require an explicit migration; compatible command-only databases can emit protocol 0.2 events.

Earlier red tests exposed the missing implementations and review defects. Windows briefly held a closed fixture SQLite file during integration cleanup; a bounded asynchronous EBUSY retry resolved that cleanup failure. No production cleanup exception was suppressed. The full final suite above is green. Subprocess fixtures required permission outside the default process sandbox. No real Codex thread, turn, login, refresh, account operation or inference was performed in this continuation; the prior read-only native smoke remains historical evidence below.

Wire protocol 0.2 adds required native/runtime/policy permission bindings; it does not change native Codex version 0.153.4. No dependencies or upstream functional source changed in this continuation, so the earlier frozen filtered install and upstream baseline checks were not repeated. Live billing, OS isolation, desktop UI, complete transcript/patch retention and cross-process host ownership remain unverified or unimplemented as described in [M1A_IMPLEMENTATION.md](M1A_IMPLEMENTATION.md).

## Initial host continuation

| Final check                          | Result                                | Evidence                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host suite                           | **115 pass, 0 fail**, 238 assertions  | [Log](docs/validation/m1a-control-plane-tests.log)                                                                                                                                              |
| Codex adapter/stdio suite            | **43 pass, 0 fail**, 87 assertions    | [Log](docs/validation/m1a-adapter-tests.log)                                                                                                                                                    |
| Three Harness package typechecks     | **3 pass**                            | [Protocol](docs/validation/m1a-harness-protocol-typecheck.log), [adapters](docs/validation/m1a-harness-adapters-typecheck.log), [host](docs/validation/m1a-harness-control-plane-typecheck.log) |
| Frozen filtered dependency install   | **Pass**, no version changes          | [Log](docs/validation/m1a-install.log)                                                                                                                                                          |
| Authored-source Prettier             | **Pass**                              | [Log](docs/validation/m1a-format.log)                                                                                                                                                           |
| Oxlint, 35 authored TypeScript files | **0 errors, 75 warnings**, exit 0     | [Diagnostics](docs/validation/m1a-oxlint.json)                                                                                                                                                  |
| Official generated protocol files    | **50 hashes match**, unmodified       | [Provenance](packages/harness-adapters/src/codex/generated/0.153.4/provenance.json)                                                                                                             |
| Final independent host review        | **Both findings fixed and rechecked** | [Review summary](docs/validation/m1a-review.md)                                                                                                                                                 |

Total: **158 tests, 325 assertions**. Lint warnings are retained, not suppressed; most concern Bun's promise-assertion typings, with additional typed JSON/test assertions and style warnings. This is not a warning-free lint result. Generated native sources are excluded from authored-source formatting/lint and remain included in typechecking and hash verification.

The host tests exercise billing/auth/provider conflicts, stale and changing evidence, scoped consent, command identity, lease ownership, SQLite transactions and forced process termination. Native integration tests spawn a local JSON-RPC peer through the actual stdio transport; the full integration test uses admission, the runtime manager, SQLite and the Codex adapter together. These are not real provider responses or subscription inference tests.

Independent reviews hardened admission invalidation/expiry races, directory identity, token limits, stream closure, active-turn correlation, durable completion, resume and shutdown. Native launch review covers credential/environment overrides and supported process-only configuration controls.

The installed **Codex 0.153.4** completed a read-only handshake and managed account/configuration reads. Existing endpoint, plugin, MCP and notification configuration intentionally blocked subscription preflight because this adapter does not verify those settings. Presence alone does not establish that an endpoint is custom. All 29 final process-only isolation overrides matched native effective configuration. No native thread, turn, login or refresh request was made. No user configuration or authentication file was edited. See [native smoke evidence](docs/validation/m1a-native-smoke.json).

The two Bun implementation packages use `skipLibCheck` for incompatible declarations in the unchanged catalog's `bun-types@1.3.13`; all Harness source/tests and generated `.ts` wire types are checked. Windows sandbox denial of fixture child processes was resolved by running only those local tests with process permission. The unchanged upstream suites below were not repeated because their functional source did not change.

## Foundation baseline (previous delivery)

The checks below were recorded for architecture scaffolding and existing upstream behavior before the host implementation. Their original limitations and failures remain visible.

## Typechecks and static checks

`bun typecheck` was executed from each package directory:

| Packages                                                                   | Final result                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| harness-protocol, harness-adapters, harness-control-plane                  | **3 passed**, including compile-time contract checks        |
| schema, protocol, core, server, client, sdk-next, opencode, session-ui, ui | **9 passed**                                                |
| app, desktop                                                               | **2 passed** after fixing local Git symlink materialization |

The initial app/desktop failure was TS1128 because Windows checked out a tracked symlink as the literal target text. Restoring the tracked links with local `core.symlinks=true` resolved it. Git reports no upstream source changes. Initial adapter/control-plane checks before workspace linking failed module resolution; the final frozen filtered install and all subsequent checks passed.

- New-package Oxlint: **0 warnings, 0 errors**, 14 TypeScript files.
- Prettier applied only to added packages/product manifest; formatting check passes.
- `git diff --check`: passed.
- `git diff --exit-code HEAD -- LICENSE package.json turbo.json` and checked upstream package paths: passed against the pinned baseline before the delivery commit.
- Native/protocol import review: new contracts have no OpenCode/Electron/provider runtime import; adapter/control-plane dependencies are type-only.
- Independent architecture/contract review: five identified gaps corrected (source identity, replay gaps, permission audit, collaboration attribution, operation-bound preflight); follow-up review found no material inconsistency in that scope.

## Existing tests exercised

| Package / command                                                              | Original result | Targeted recovery                                                                                      |
| ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------ |
| core: eight existing schema/event/permission/policy/session contract files     | 111 pass        | None needed                                                                                            |
| opencode: four existing session-schema/decoding/ACP-usage/event-manifest files | 40 pass         | None needed                                                                                            |
| app: `bun run test:unit`                                                       | 724 pass        | None needed                                                                                            |
| app: `bun run test:browser`                                                    | 41 pass         | None needed; HappyDOM, not E2E                                                                         |
| session-ui: `bun run test`                                                     | 83 pass         | None needed                                                                                            |
| ui: `bun run test`                                                             | 27 pass         | None needed                                                                                            |
| client: `bun run test`                                                         | 15 pass, 1 fail | Failed import-boundary case passed with approved child-process permission                              |
| sdk-next: `bun run test`                                                       | 3 pass, 2 fail  | Import-boundary case passed with approved child-process permission; SQLite cleanup case remains failed |

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

| Command                                                                | Result                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Unchanged upstream `bun install --frozen-lockfile`                     | Failed: tree-sitter-powershell native node-gyp build could not create a generated `.vcxproj.filters` path on Windows |
| `bun install --frozen-lockfile --ignore-scripts`                       | Failed: electron-winstaller tarball extraction                                                                       |
| `bun install --lockfile-only --ignore-scripts` after adding contracts  | Passed with network access; **only 37 added lockfile lines for the three workspaces**, no dependency-version churn   |
| `bun install --frozen-lockfile --ignore-scripts --filter '@harness/*'` | Passed with network access; contract workspaces linked                                                               |

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
