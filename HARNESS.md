# Harness — Universal Runtime Foundation

**Delivered: a development desktop with a Codex conversation screen, protected patch/question review, OS-protected review keys and a Claude Skills catalog.** The host retains subscription admission, durable decisions and bounded history recovery. Harness is a provisional codename. See [desktop setup and limits](DESKTOP.md) and [host implementation](M1A_IMPLEMENTATION.md). Claude Skills execution awaits the Claude native adapter.

Based on stable OpenCode **v1.18.29**, commit `16747470f976aca3d362ad730bcd3fe82ecc2c9a`. [Fork](https://github.com/Amjed1202/opencode), working branch `runtime-foundation`; `upstream` remains the original repository. Preserve OpenCode's [MIT license](LICENSE).

The sandboxed renderer calls our control plane through a restricted preload and private Bun child process. Independent Claude Code, Codex App Server, OpenCode and future runtime adapters translate native capabilities into a shared session/event model. Model, runtime, authentication, billing and execution target remain separate. Subscription runtimes are preferred; automatic API fallback defaults off. Current Claude rules provide a conditional unmodified-native-binary route, distinct from direct SDK subscription login. Provider overage and unknown billing remain explicit.

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
    │       └── claude/, opencode/, generic/, remote/  integration TODOs
    └── harness-control-plane/
        ├── src/index.ts            client and privileged service ports
        ├── src/host.ts             admission, leases, journal, protected artifacts and orchestration
        ├── src/codex-probe.ts       diagnostic command; no inference
        ├── test/                   behavioral and local process integration tests
        └── type-tests/public-contracts.ts
```

Each added package has its own manifest and strict tsconfig. Existing `packages/*` discovery includes them, so root workspace configuration is unchanged. No native SDK dependency was added. Only `bun.lock` workspace records and an additive `SECURITY.md` section modify preexisting tracked files; all functional upstream source remains intact.

## Check the packages

Use the repository's Bun **1.3.14**. From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts --filter '@harness/*'
bun --cwd packages/harness-protocol typecheck
bun --cwd packages/harness-adapters typecheck
bun --cwd packages/harness-control-plane typecheck
bun --cwd packages/harness-desktop typecheck
```

The filtered, script-disabled install prepares package dependencies. The new desktop also needs the pinned Electron binary; see [desktop setup](DESKTOP.md). This is separate from the upstream desktop dependency build. See the recorded Windows dependency issues before running upstream development scripts. Git must materialize tracked symlinks correctly on Windows; this checkout has `core.symlinks=true` and the tracked links restored without source changes.

## Next implementation step

Complete supported-model discovery, native recovery presentation and OS boundary verification, then validate a separately authorized live repository task with explicit subscription/overage settings. Implement the permitted Claude native adapter and bind Claude Skills activation to its native capabilities and session policy. The current desktop is a development build with one attached session; installers, signing, update channels and the full M1 acceptance flow remain open.
