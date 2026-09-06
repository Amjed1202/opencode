# Local host and Codex implementation

The host libraries from migration tasks 4–5 now include protected patch and choice-question review, durable permission/input decisions, and bounded native history inspection. M1a acceptance remains incomplete. A subsequent [development desktop](DESKTOP.md) now presents these APIs and provisions review keys through OS secure storage. OpenCode's functional source remains unchanged.

## Implemented behavior

| Component                     | What it does                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@harness/control-plane/host` | Privileged Bun entry point, separate from the type-only client/service contracts.                                                                                                                                                                                                                                                                 |
| Admission                     | Checks the selected runtime, target, provider, native authentication method, billing evidence, policy, capabilities and optional capacity observation. Issues expiring tokens bound to the workspace, session, operation and command digest. Rechecks evidence, runtime identity, consent and lease validity before dispatch.                     |
| Environment                   | Builds an OS allowlist from explicit host inputs. Native home and executable search path are deliberate selections. Credentials, provider/profile overrides, proxies, shell controls and runtime injection variables are not inherited.                                                                                                           |
| Workspace registry            | Canonical authorized directories, overlapping-root rejection, process-local read/write leases and generation checks. Expiration blocks further use without transferring a possibly running writer's ownership.                                                                                                                                    |
| SQLite journal                | Durable session revisions, exact-command idempotency, event origin deduplication, host sequence numbers, atomic event/receipt writes, permission/input claims and audit outcomes, snapshot gaps and explicit uncertain recovery.                                                                                                                  |
| Protected artifacts           | AES-256-GCM encrypted SQLite records in an explicitly supplied private directory outside registered workspaces. The host supplies a 32-byte key; the new desktop provisions it through Electron safeStorage, while library callers still supply their own key.                                                                                    |
| Runtime manager               | Create, send, interrupt, close, native-ID resume, protected interaction review, permission/input decisions and read-only inspection. Exact known terminal turns can reconcile detached uncertain sessions. Durable claims precede native replies; ambiguous outcomes cannot automatically replay.                                                 |
| `@harness/adapters/codex`     | Explicit local executable, private stdio JSON-RPC, pinned `0.153.4` handshake, managed account/config reads, native lifecycle/text mapping, bounded history, optional once-only file approvals and blocking fixed-choice questions. Commands and permission-scope expansions remain deny-only. Unknown events retain sanitized identity metadata. |
| Diagnostic command            | Reads native compatibility and subscription-route evidence; creates no admission token, thread, turn or login.                                                                                                                                                                                                                                    |

Wire protocol 0.3 adds complete permission-equivalent input bindings, protected review references and review audit events. Existing 0.2 event journals, invalid JSON and missing/incompatible protocol versions require an explicit migration or a separate new database; opening them does not rewrite or delete the original. The protocol package remains independent of Bun, Node, Electron and vendor runtimes. Official generated native types stay private to the Codex adapter; their provenance, hashes and third-party license notices are retained.

## Subscription and policy behavior

The concrete Codex adapter offers only managed ChatGPT subscription mode. It exposes no API-key or token-import route. Automatic API fallback is unsupported and rejected, including when a caller supplies a consent identifier. The general admission library validates explicit API/provider-specific consent through a trusted host store, but no API executor or consent UI ships here.

Authentication evidence does not prove that extra provider charges are disabled. Codex currently reports provider overage as **unknown**. `require-disabled` therefore blocks; execution through this initial adapter requires an explicit `acknowledge-provider-settings` intent. The diagnostic uses that value only to observe the route and never authorizes execution.

Native sandbox settings are requested and checked, but OS enforcement is not attested. The adapter accepts only an explicit `requireEnforcedBoundary: false` policy with native sandboxing, denied network and no approved MCP servers. Approval policy may deny everything or ask for a bounded once-only file decision. Enforced reviewers remain blocked. This is an experimental integration condition, not evidence that arbitrary tools are safely isolated.

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

For grants or answers, open `EncryptedArtifactStore` with an existing private `rootPath` outside every registered workspace and an explicitly supplied 32-byte `key`, then pass it as the manager's `artifacts` option. The workspace registry rejects overlap with existing workspaces and reserves that private root for its lifetime against later registrations. Restart setup must reserve it before accepting workspaces. Protect the directory and key through host provisioning; the library does not provision an OS vault. The desktop supplies an OS-wrapped key, which does not guarantee isolation from a hostile process with the same privileges. Missing protected storage disables grants and answers. Denial and cancellation remain available.

Artifact size is capped at 1 MiB, with at most 1,024 ephemeral artifact grants and 1,024 review proofs; aggregate database retention is not bounded by those limits. Resolved encrypted artifacts remain until explicitly deleted. Deletion is logical and does not securely erase backups or storage media.

These are privileged in-process APIs. There is no renderer IPC decoder, account authorization layer or network listener yet. A caller cannot safely expose these constructors directly to a renderer or remote client.

## Protected review, decisions and recovery

Configure `LocalRuntimeManager` with a trusted `actorId` to resolve decisions. The future authenticated transport must supply that identity from host context; a renderer's actor/timestamp fields have no authority. `permission.requested` is committed with its ledger record before delivery. `resolvePermission(decision)` claims the exact offered once choice, recording actor and time, then calls the native adapter. `permission.resolved` means the reply was flushed or an autonomous denial/expiry was recorded; it does not prove a file operation executed. A lost reply leaves a separate uncertain claim and is never sent again.

The host validates and encrypts a pending patch or question's display content before attaching a restricted `reviewArtifact` reference to its metadata event. `reviewPermission(requestId)` or `reviewInput(requestId)` returns the bound content and an in-memory `reviewToken`, limited to the request expiry and at most 60 seconds. The token binds the authenticated actor, request, operation digest and artifact digest, and is required for an allow/answer. `interaction.reviewed` records content delivery through this authorized path; it does not prove that a human read or understood it. Tokens never enter the journal and do not survive restart. Ordinary events contain metadata, scope paths and hashes; raw patches and question/option labels stay in protected storage.

Every decision binds the runtime, target, workspace, session, native thread/turn/request, policy ID/version, lease generation and operation hash. A grant requires current account/configuration/billing/policy evidence and the original live workspace lease. The original command token may expire while a tool waits; revocation still blocks the grant. After asynchronous native checks, a host-only callback rechecks authority synchronously at the stdio write boundary. The callback is never serialized to Codex.

Only a complete, observed pending file-change item can offer **allow once**, under a workspace-write policy. File paths and rename destinations must remain inside the canonical workspace; linked paths, existing hard links, protected `.git`/`.codex`/`.agents` paths and session-wide write roots are rejected. The protected patch review preserves the exact pending diff and operation digest. Arbitrary commands, network grants, policy amendments and session/workspace grants cannot be accepted in this slice. Path checks do not attest OS enforcement or eliminate filesystem races with another process.

Codex human input supports one to three blocking questions, each with two to eight fixed options. Native secret, free-form, nonblocking, unknown or malformed requests are cancelled without retaining question content. `input.requested` carries generated question/option IDs under `harness.choice-input.v1`; `resolveInput` accepts exactly one offered option per question, or cancellation with no selections. Answers map to the original native labels only in adapter memory. Each input has the same full binding and final host authorization guard as a permission grant. Expiry, interruption, account/config changes, close, terminal events and native callback cleanup invalidate it. Duplicate answers and recovery never replay a native reply.

`initialize.capabilities.experimentalApi` remains **false**. Although the pinned question types say EXPERIMENTAL, official `rust-v0.153.4` source forwards this request without that capability. No broad experimental opt-in or new native extension permission was introduced. See [the pinned source findings and local test evidence](docs/validation/m1a-review-input-native-source.md).

`inspectSession(sessionId)` reads metadata and paginated turn summaries through official App Server methods, with account/config checks before and after. Defaults are four pages, 200 turns and 1 MiB of responses; incomplete or changing history cannot establish idle; observed active work remains running, and malformed responses produce unknown state. No message bodies, preview content or native error bodies are returned.

`reconcileSession(sessionId)` requires a detached, uncertain session and exclusive ownership of its native processes. It settles only saved command records whose exact native turn IDs appear as terminal in complete, idle history. Missing turn acknowledgements, partial pages or running/unknown evidence remain uncertain. It does not infer identity from user text/message IDs, replay a command or attach a stream. Resume remains a separate fresh admission. Restart recovery expires pending native reply handles and marks previously claimed decisions uncertain; it never reconstructs permission to grant.

## Remaining acceptance work

- A separately authorized live repository task, including supported-model discovery and actual host sandbox verification. No live subscription inference was performed in this continuation.
- Complete desktop recovery and broader accessibility/platform acceptance beyond the new patch/question UI and OS-protected key provisioning. See [desktop scope](DESKTOP.md).
- Rich tool/file/diff/subagent mappings, broader raw-artifact retention, token/context/quota telemetry and accounting. Protected artifacts currently cover bounded interaction review. Unknown native bodies are deliberately omitted, not archived in full.
- Full native transcript hydration and recovery of lost acknowledgements without a known native turn ID. Bounded inspection and exact-turn reconciliation do not establish that ambiguous work is safe to repeat.
- A cross-process host ownership service and OS process-tree supervision. Lease state is process-local. Recovery requires exclusive ownership of the journal and its native processes; two independent hosts must not operate the same workspace. SQLite atomicity alone does not provide that ownership.
- An uncertain detach or ambiguous create retains its workspace lease. The host must stop the native adapter/process and reconcile its work before releasing that ownership; a generic close acknowledgement is not proof of provider-side termination.
- Secret-vault support for future API/node credentials, Claude/OpenCode adapters and native Claude Skills activation, collaboration and remote nodes.

`skipLibCheck` applies only to the two Bun host packages because the existing catalog's Bun declaration files conflict with the pinned compiler. All Harness source, tests, generated protocol types and browser-safe protocol contracts are still typechecked. Dependency versions are unchanged.
