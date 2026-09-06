# Upstream strategy

Status: architectural baseline, 2026-09-06. This stage documents the fork and adds contracts; it does not implement native adapters or replace the working OpenCode desktop.

## Provenance and ownership

| Item | Recorded value |
| --- | --- |
| Foundation | Stable OpenCode `v1.18.29` |
| Resolved tag commit | `16747470f976aca3d362ad730bcd3fe82ecc2c9a` |
| Fork / `origin` | [Amjed1202/opencode](https://github.com/Amjed1202/opencode), configured as `https://github.com/Amjed1202/opencode.git` |
| Original / `upstream` | [anomalyco/opencode](https://github.com/anomalyco/opencode), configured as `https://github.com/anomalyco/opencode.git` |
| Local branch | `runtime-foundation` |
| Checkout | Shallow, partial clone using `blob:none`; the initial full clone stalled |

Treat the resolved commit as the baseline, not GitHub release `target_commitish`. Track explicit stable releases; `dev` remains upstream's development branch and is not our automatic update source. Fork creation and remotes are configured; this document does not claim local product changes have been pushed.

OpenCode is one native runtime behind an adapter. Harness owns application sessions, admission, cross-runtime permissions, collaboration and billing intent. Do not convert Claude Code or Codex into OpenCode agent configurations. The existing Schema → Core/Protocol → Server dependency direction stays intact, as specified in [upstream AGENTS.md](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/AGENTS.md#L1).

## Package decisions

These are reuse relationships, not instructions to delete upstream directories. **KEEP** preserves native implementation; **WRAP** accesses it through an adapter/service; **MODIFY** means a future localized seam; **REPLACE** replaces the product-facing responsibility; **REMOVE/IGNORE** excludes deployment/product scope while leaving source tracked. Exact package manifests and deep source anchors appear in the [reconnaissance evidence](docs/UPSTREAM_RECONNAISSANCE.md#complete-packagedirectory-classification).

| Package/directory under `packages/` | Decision | Reason |
| --- | --- | --- |
| `desktop` | MODIFY | Retain Electron, preload, utility-process lifecycle and packaging; introduce distinct product profile later. |
| `app` | MODIFY | Reuse Solid renderer mechanics; add universal session/client seam and product UI. |
| `ui` | KEEP | Reuse generic controls, i18n, theme and accessibility primitives. |
| `session-ui` | WRAP | Project universal events into reusable conversation/tool/diff view models. |
| `schema` | KEEP | Canonical OpenCode contracts remain OpenCode-owned. |
| `protocol` | KEEP | Existing OpenCode HttpApi; do not rename or overload with universal contracts. |
| `core` | WRAP | Preserve native engine; wrap selected filesystem/Git/PTY/storage services. |
| `server` | WRAP | Native OpenCode service, not universal control plane. |
| `client` | WRAP | Generated current client stays private to OpenCode integration. |
| `sdk-next` | WRAP | Optional embedded current runtime; feature parity must be verified. |
| `sdk/js` | WRAP | Initial compatibility SDK surface; pin and test its native session generation. |
| `llm` | WRAP | Provider-turn machinery for explicit generic API/local integrations. |
| `plugin` | KEEP | Native OpenCode extension contracts; not universal adapter interface. |
| `opencode` | WRAP | Shipping bootstrap, legacy sessions, server, MCP and agent infrastructure. |
| `cli` | KEEP | Separate evolving CLI/daemon framework; root dev still uses `opencode`. |
| `tui` | KEEP | Preserve upstream terminal client and debugging workflow. |
| `codemode` | KEEP | Internal OpenCode tool-code interpreter; no orchestration duplication. |
| `effect-drizzle-sqlite` | KEEP | Reuse low-level storage bridge without sharing product schema ownership. |
| `effect-sqlite-node` | KEEP | Preserve Node/Bun SQLite implementation boundary. |
| `httpapi-codegen` | KEEP | Upstream generated-client pipeline remains independently owned. |
| `http-recorder` | KEEP | Replay fixtures support validation without paid model calls. |
| `script` | KEEP | Retain build/version helpers; do not run upstream publishing defaults. |
| `storybook` | KEEP | Component development and visual verification. |
| `identity` | REPLACE | New product assets later; retain original tracked assets/notices. |
| `containers` | KEEP | CI recipe references; historical Tauri recipe does not define desktop stack. |
| `docs` | REMOVE/IGNORE | Upstream documentation scaffold/reference, including separate Mintlify license. |
| `web` | REMOVE/IGNORE | Astro marketing/docs site, not desktop renderer. |
| `enterprise` | REMOVE/IGNORE | Upstream team/share/cloud product is outside foundation scope. |
| `function` | REMOVE/IGNORE | Hosted/GitHub service infrastructure is outside local control plane. |
| `slack` | REMOVE/IGNORE | Separate integration outside desktop foundation. |
| `console/app` | REMOVE/IGNORE | Hosted account/billing UI is not native subscription authentication. |
| `console/core` | REMOVE/IGNORE | Hosted commercial backend must not become implicit API fallback. |
| `console/function` | REMOVE/IGNORE | Upstream hosted function deployment. |
| `console/mail` | REMOVE/IGNORE | Hosted service mail templates. |
| `console/resource` | REMOVE/IGNORE | SST hosted resource declarations. |
| `console/support` | REMOVE/IGNORE | Upstream production support dashboard. |
| `stats/app` | REMOVE/IGNORE | Hosted analytics UI differs from local usage dashboard. |
| `stats/core` | REMOVE/IGNORE | Hosted stats/Honeycomb aggregation is not product telemetry storage. |
| `stats/server` | REMOVE/IGNORE | Upstream analytics ingestion is not required. |

This covers every top-level package directory and nested workspace manifest at the baseline; `console`, `stats` and `sdk` are parent directories. Keep native tool loops, MCP clients, skills, hooks, context management and subagents inside each harness. Reuse OpenCode Git/worktree, PTY, file/diff and SQLite mechanics through privileged services; add application writer leases, account/billing admission and workflow state rather than duplicating native execution.

## Controlled divergence

Add only `packages/harness-protocol`, `packages/harness-adapters` and `packages/harness-control-plane` for this stage. Existing `packages/*` discovery already includes them, so root `package.json` remains untouched. Bun may add new workspace records to `bun.lock`; reject unrelated resolution/version churn. Keep new domain types independent of upstream Core, Server and SDK imports.

Preserve upstream source paths, package names, migrations, generated clients and tests. Product docs/configuration are additive. The original `SECURITY.md` policy text must remain intact with a clearly separated Harness section; do not silently replace upstream reporting instructions or present them as Harness ownership. `harness.product.json` records intent, not an already-wired desktop identity.

The initial patch budget is **zero changes to preexisting functional source**. Later work targets desktop entrypoint/profile, narrow IPC and adapter mappings. Every upstream-file patch should record purpose, owner, affected source/version, verification and removal condition. Review file count and changed lines per subsystem each release; broad rename/reformat/dependency churn needs a concrete necessity. Prefer an extension seam, then a small upstreamable patch, before a maintained fork-only rewrite.

## Compatibility and release hazards

The active desktop is Electron, not Tauri. Current/legacy APIs coexist; App and session-ui use a vendored client alongside other SDKs. Current session `shell`, `skill`, `compact` and `wait` return unavailable errors; full MCP remains in the legacy package. Start the OpenCode adapter on one verified compatibility surface and migrate deliberately. Do not mix two native session engines under one application binding. [Source findings](docs/UPSTREAM_RECONNAISSANCE.md#decisions-with-architectural-impact)

Isolate OpenCode data/config/state/cache and database paths **before imports or launch**. Global path initialization uses the OpenCode namespace; core applies migrations automatically. The pinned [V2 reset migration](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts#L1) deletes event and session projection state. Keep Harness migrations separate, test upgrades on disposable copies and retain backups; reverting code does not reverse a migration.

Upstream SQLite credential JSON is not secure storage. Parent environment inheritance is not subscription-safe. Retain native authentication ownership and implement provider-specific environments with no default paid fallback. Upstream OTLP/Sentry activation must not become unapproved product telemetry export. [Security and persistence evidence](docs/UPSTREAM_RECONNAISSANCE.md#persistence-events-telemetry-and-credentials)

Before distributing, wire distinct app/data IDs, assets, URL scheme, signing, update feed and telemetry together. Upstream beta/prod feeds target anomalyco; Windows disables update signature verification and the updater permits downgrade at this pin. Keep the product updater disabled until its own verified policy exists. Preserve [root MIT notice](LICENSE), package notices and third-party notices, including [Mintlify's license](packages/docs/LICENSE). Do not publish under upstream package names or credentials.

## Updating the fork

1. Select a candidate stable tag explicitly; inspect release notes, changed contracts, migrations, native dependencies, security fixes and licensing. Record candidate commit and native Claude/Codex supported versions separately.
2. Fetch tags and missing ancestry from `upstream`. A shallow boundary is not evidence of unrelated history. Deepen incrementally; if necessary fetch unshallow history. Partial-clone blobs may still be fetched on demand.
3. Verify `git merge-base runtime-foundation <candidate-stable-tag>` returns a common ancestor. Stop if it does not; fetch missing history and investigate. Never use `--allow-unrelated-histories` to mask the shallow checkout.
4. Create a temporary integration branch/worktree, merge the candidate stable tag, preserve local changes and resolve conflicts by ownership. Do not reinitialize Git, mass replace directories or advance the foundation pointer first.
5. Run compatibility gates, review native auth policy changes and validate disposable database upgrades. Remove obsolete patches, update evidence/provenance and review the final diff.
6. Promote only after checks and explicit merge/release authorization appropriate to that operation. Retain previous signed artifacts and tested data-backup recovery procedures.

Illustrative ancestry preparation, executed only during a later upgrade:

```text
git fetch upstream --tags --filter=blob:none
git fetch upstream --deepen=1000
git rev-parse --is-shallow-repository
# If ancestry is still insufficient and the repository remains shallow:
git fetch upstream --unshallow --tags --filter=blob:none
git merge-base runtime-foundation <candidate-stable-tag>
```

## Per-release compatibility gates

Validate Linux and Windows; add macOS packaging/native tests when distributing there. Track a version matrix for OpenCode tag/API generation, Electron/Node/Bun, Claude executable/integration route, Codex App Server protocol, adapter mappings and UAP version. Never infer capabilities from a newer version number.

Run package `bun typecheck` scripts and relevant existing tests, generated-client checks, HttpApi exercisers, renderer/e2e and packaging checks according to changed surfaces. Root `bun test` intentionally fails; desktop has colocated tests but no package test script, so run its relevant tests explicitly. CI's Blacksmith runners and release secrets are upstream-specific; prepare fork-owned verification/release jobs before enabling deployment. Exact commands are in the [command inventory](docs/UPSTREAM_RECONNAISSANCE.md#actual-commands-and-test-constraints-observed-not-claimed-executed-here).

Adapter contract gates cover streaming/unknown events, resume, interruption, permissions, usage provenance, disconnect/replay and billing preflight. Test inherited API variables, account changes, quota exhaustion and absent telemetry without live paid calls. UI gates verify capability-driven controls and the same application session model across runtimes. Migration gates prove backup/restore and schema compatibility. Record actual pass/fail/blocked results in `VALIDATION.md`; this strategy is not a test result. The next implementation slice is billing-safe admission followed by native adapters, as sequenced in [MIGRATION_PLAN.md](MIGRATION_PLAN.md).
