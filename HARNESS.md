# Harness — Universal Runtime Foundation

**Implemented: a Windows desktop candidate with native Codex and Claude conversations, explicit models, protected file review, saved history/resume, files/diffs, observed usage and selected native Claude Skills.** Harness is a provisional codename. RC2 corrects native Codex automatic patch approval and passes its bounded live acceptance. Codex currently requires supplied file contents and disables native shell commands. Claude's live task and Skill checks await restored native sign-in. See [V1 acceptance](V1_STATUS.md), [desktop setup](DESKTOP.md), [Claude execution](V1_CLAUDE.md) and [Windows packaging](packages/harness-desktop/PACKAGING.md).

Based on stable OpenCode **v1.18.29**, commit `16747470f976aca3d362ad730bcd3fe82ecc2c9a`. [Fork](https://github.com/Amjed1202/opencode), working branch `runtime-foundation`; `upstream` remains the original repository. Preserve OpenCode's [MIT license](LICENSE).

The sandboxed renderer calls our control plane through a restricted preload and private Bun child process. Independent Claude Code, Codex App Server, OpenCode and future runtime adapters translate native capabilities into a shared session/event model. Model, runtime, authentication, billing and execution target remain separate. Subscription runtimes are preferred; automatic API fallback defaults off. Current Claude rules provide a conditional unmodified-native-binary route, distinct from direct SDK subscription login. Provider overage and unknown billing remain explicit.

The Codex **0.153.4** picker requires an explicit choice from its native `model/list` catalog and repeats listing before session admission. There is no default, manual-ID entry or fallback selection. Native listing can fetch metadata and update Codex's cache; a repeated request can return cached data and does not lock availability through dispatch. Catalog membership is separate from entitlement and billing checks.

## Read the architecture

| Document                                     | Contents                                                              |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)           | Boundaries, ownership, UI direction, persistence and alternatives     |
| [UPSTREAM_STRATEGY.md](UPSTREAM_STRATEGY.md) | Every major package classified; merge/divergence strategy             |
| [PROTOCOL.md](PROTOCOL.md)                   | Events, commands, admission, permissions, replay and versioning       |
| [DESKTOP.md](DESKTOP.md)                     | Development desktop setup, boundaries and remaining acceptance work   |
| [CLAUDE_SKILLS.md](CLAUDE_SKILLS.md)         | Local skill discovery and native activation gates                     |
| [ADAPTERS.md](ADAPTERS.md)                   | Official native integration routes and implementation gates           |
| [COLLABORATION.md](COLLABORATION.md)         | Arbitrary roles, read-only reviews, findings, budgets and loop limits |
| [REMOTE_NODES.md](REMOTE_NODES.md)           | Madar/node identity, secure transport, workspace grants and recovery  |
| [SECURITY.md](SECURITY.md)                   | Trust boundaries and original upstream policy preserved               |
| [TELEMETRY.md](TELEMETRY.md)                 | Observed versus reported usage, estimates, quotas and aggregation     |
| [MILESTONES.md](MILESTONES.md)               | Stage 0, working M1 acceptance, collaboration and remote rollout      |

[Migration plan](MIGRATION_PLAN.md) · [Source evidence](docs/UPSTREAM_RECONNAISSANCE.md) · [Validation and known issues](VALIDATION.md) · [Exact changed-file inventory](FILES_CHANGED.md)

## Resulting structure

```text
OpenCode fork/                       original monorepo retained
├── HARNESS.md                       start here; upstream README remains intact
├── ARCHITECTURE.md                  plus the other eight architecture documents
├── MIGRATION_PLAN.md
├── VALIDATION.md
├── FILES_CHANGED.md
├── harness.product.json             provisional identity/intended defaults only
├── docs/
│   ├── UPSTREAM_RECONNAISSANCE.md    pinned source anchors
│   └── validation/                  command records and selected logs
└── packages/
    ├── desktop/, app/, ui/, ...     upstream packages, unchanged
    ├── protocol/, core/, ...        upstream native domains, unchanged
    ├── harness-desktop/            Electron main/preload, Solid renderer, private Bun worker
    ├── harness-protocol/
    │   ├── src/
    │   │   ├── common.ts, capabilities.ts, runtime.ts
    │   │   ├── session.ts, permissions.ts, events.ts, usage.ts
    │   │   └── collaboration.ts, remote.ts, index.ts
    │   └── type-tests/contracts.ts
    ├── harness-adapters/
    │   └── src/
    │       ├── index.ts             adapter interface
    │       ├── codex/               pinned stdio adapter, mapping and generated wire types
    │       ├── claude/              official SDK + pinned native CLI, restricted execution and Skills
    │       └── opencode/, generic/, remote/  integration TODOs
    └── harness-control-plane/
        ├── src/index.ts            client and privileged service ports
        ├── src/host.ts             admission, leases, journal, protected artifacts and orchestration
        ├── src/codex-probe.ts       diagnostic command; no inference
        ├── test/                   behavioral and local process integration tests
        └── type-tests/public-contracts.ts
```

Each added package has its own manifest and strict tsconfig. Existing `packages/*` discovery includes them, so root workspace configuration is unchanged. The Claude adapter adds the official SDK and pinned peers. Only `bun.lock` and an additive `SECURITY.md` section modify preexisting tracked files; functional upstream source, root workspace manifests and prior dependency resolutions remain intact.

## Check the packages

Use the repository's Bun **1.3.14**. From the repository root in PowerShell:

```powershell
bun install --frozen-lockfile --ignore-scripts --filter '@harness/*'
Set-Location packages/harness-protocol
bun run typecheck
Set-Location ../harness-adapters
bun run typecheck
Set-Location ../harness-control-plane
bun run typecheck
Set-Location ../harness-desktop
bun run typecheck
Set-Location ../..
```

The filtered, script-disabled install prepares package dependencies. The new desktop also needs the pinned Electron binary; see [desktop setup](DESKTOP.md). This is separate from the upstream desktop dependency build. See the recorded Windows dependency issues before running upstream development scripts. Git must materialize tracked symlinks correctly on Windows; this checkout has `core.symlinks=true` and the tracked links restored without source changes.

## Remaining acceptance

Restore native Claude sign-in, then complete its already approved bounded live task and standalone Skill checks using fresh subscription/model evidence. Codex completed its four-prompt allowance with live permission, interruption, history and exact resume proof. Local tests and package startup remain separate from provider acceptance. The current app supports one attached conversation at a time with explicit switching after close. OpenCode execution, OS sandbox attestation, cross-process fencing, collaboration, remote nodes, installers, signing and updates remain later work. [Current evidence](VALIDATION.md).
