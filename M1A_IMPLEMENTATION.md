# Initial local host and Codex implementation

This continuation implements the first runnable host libraries from migration tasks 4–5. It does not complete M1a or create a desktop application. OpenCode's functional source remains unchanged.

## Implemented behavior

| Component | What it does |
| --- | --- |
| `@harness/control-plane/host` | Privileged Bun entry point, separate from the type-only client/service contracts. |
| Admission | Checks the selected runtime, target, provider, native authentication method, billing evidence, policy, capabilities and optional capacity observation. Issues expiring tokens bound to the workspace, session, operation and command digest. Rechecks evidence, runtime identity, consent and lease validity before dispatch. |
| Environment | Builds an OS allowlist from explicit host inputs. Native home and executable search path are deliberate selections. Credentials, provider/profile overrides, proxies, shell controls and runtime injection variables are not inherited. |
| Workspace registry | Canonical authorized directories, overlapping-root rejection, process-local read/write leases and generation checks. Expiration blocks further use without transferring a possibly running writer's ownership. |
| SQLite journal | Durable session revisions, exact-command idempotency, event origin deduplication, host sequence numbers, atomic event/receipt writes, bounded-history snapshot gaps and explicit uncertain recovery. |
| Runtime manager | Create, send, interrupt, close and native-ID resume; a durable dispatch marker precedes the native call. It consumes native events into the journal and serves replay plus live events. Ambiguous calls and disconnected execution cannot automatically replay. |
| `@harness/adapters/codex` | Explicit local executable, private stdio JSON-RPC, pinned `0.153.4` handshake, managed account/config reads, native thread/turn lifecycle and text/completion mapping. Native approval requests are denied. Unknown events retain sanitized identity metadata. |
| Diagnostic command | Reads native compatibility and subscription-route evidence; creates no admission token, thread, turn or login. |

The protocol package remains independent of Bun, Node, Electron and vendor runtimes. Official generated native types stay private to the Codex adapter; their provenance, hashes and third-party license notices are retained.

## Subscription and policy behavior

The concrete Codex adapter offers only managed ChatGPT subscription mode. It exposes no API-key or token-import route. Automatic API fallback is unsupported and rejected, including when a caller supplies a consent identifier. The general admission library validates explicit API/provider-specific consent through a trusted host store, but no API executor or consent UI ships here.

Authentication evidence does not prove that extra provider charges are disabled. Codex currently reports provider overage as **unknown**. `require-disabled` therefore blocks; execution through this initial adapter requires an explicit `acknowledge-provider-settings` intent. The diagnostic uses that value only to observe the route and never authorizes execution.

Native sandbox settings are requested and checked, but OS enforcement is not attested. The adapter accepts only an explicit `requireEnforcedBoundary: false` policy with native sandboxing, denied network, denied approvals and no approved MCP servers. Enforced reviewers remain blocked. This is an experimental integration condition, not evidence that arbitrary tools are safely isolated.

Native account/configuration observations are checked repeatedly but cannot atomically lock the provider's billing decision. The pinned account response identifies email and plan, not a stable organization/workspace identity; the stored digest is an observation fingerprint. A different organization with identical reported fields cannot be distinguished by this interface. No zero-cost guarantee or native quota value is invented.

## Run checks

Use the repository's pinned Bun **1.3.14**. Install workspace dependencies with:

```powershell
bun install --frozen-lockfile --ignore-scripts --filter '@harness/*'
```

Run each command from the indicated package directory, never root `bun test`:

```powershell
# packages/harness-protocol
bun typecheck

# packages/harness-adapters
bun typecheck
bun run test

# packages/harness-control-plane
bun typecheck
bun run test
```

The tests spawn local protocol peers and abruptly terminated SQLite writers. They do not use the installed provider runtime, real accounts or model inference. A sandbox that forbids child processes must permit these fixture processes for the integration checks to execute. [Validation](VALIDATION.md) distinguishes test results from the native smoke check.

## Read native status

From `packages/harness-control-plane`:

```powershell
bun run probe --help
bun run probe --executable 'C:\path\to\codex.exe' --home 'C:\Users\you' --workspace 'C:\path\to\repository' --path 'C:\Windows\System32;C:\path\to\approved-tools' --model 'your-native-model-id'
```

Supply an existing native home where the user manages Codex login themselves. The command uses official account/config reads and never opens auth files directly. Output excludes account identifiers, account labels, environment values, native configuration bodies and credentials. Exit `0` means the diagnostic route checks passed, `2` means unavailable/blocked, and `1` means arguments or diagnostic setup failed. None means a model task has run or that billing is free.

## Host integration

The host registers an authorized directory in `LocalWorkspaceRegistry`, constructs one `SQLiteJournal` with an explicit application-owned path, and selects a `CodexAdapter` with a compiled environment. `AdmissionController` receives the host runtime resolver and `session: id => journal.get(id)`. `LocalRuntimeManager` receives those same instances. Preflight each create/resume/turn, then pass its opaque admission ID and a unique command ID to the manager. Retry only the exact same request when looking up an existing receipt.

These are privileged in-process APIs. There is no renderer IPC decoder, account authorization layer or network listener yet. A caller cannot safely expose these constructors directly to a renderer or remote client.

## Remaining acceptance work

- A separately authorized live repository task, including supported-model discovery and actual host sandbox verification. No live subscription inference was performed in this continuation.
- Interactive permission grants, expiry and human-input handling. This release denies approval requests instead of presenting them.
- Rich tool/file/diff/subagent mappings, protected raw-artifact retention, token/context/quota telemetry and accounting. Unknown native bodies are deliberately omitted, not archived in full.
- Native history hydration and reconciliation of uncertain turns after restart. Native-ID resume is implemented; it does not establish that an ambiguous previous turn is safe to repeat.
- A cross-process host ownership service and OS process-tree supervision. Lease state is process-local. Recovery requires exclusive ownership of the journal and its native processes; two independent hosts must not operate the same workspace. SQLite atomicity alone does not provide that ownership.
- An uncertain detach or ambiguous create retains its workspace lease. The host must stop the native adapter/process and reconcile its work before releasing that ownership; a generic close acknowledgement is not proof of provider-side termination.
- Secret-vault implementation for future API/node credentials, desktop IPC/UI, Claude/OpenCode adapters, collaboration and remote nodes.

`skipLibCheck` applies only to the two Bun host packages because the existing catalog's Bun declaration files conflict with the pinned compiler. All Harness source, tests, generated protocol types and browser-safe protocol contracts are still typechecked. Dependency versions are unchanged.
