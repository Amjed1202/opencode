# Claude native execution in V1

Harness uses the official `@anthropic-ai/claude-agent-sdk` **0.3.251** with the user-selected, unmodified **Claude Code 2.1.251** Windows executable. The optional SDK platform binary may be installed as a development dependency, but is never selected or packaged by Harness; the explicit external executable is required. Authentication remains in Claude Code; Harness never reads credential files, imports OAuth tokens, creates API keys, or switches providers.

The supported path is an existing native **personal Pro or Max** login on an **unmanaged Windows machine**. A no-prompt SDK handshake must confirm the same native account, first-party provider, personal plan, applied SDK permission hooks, and fast mode off. Only opaque account hashes leave the inspector. Generic signed-in status alone remains diagnostic-only. Team, Enterprise, API/Console, cloud-provider, managed-policy and unrecognized observations fail closed.

Subscription evidence does not establish whether provider extra usage is disabled. `providerOverage` remains `unknown`; execution requires the explicit `acknowledge-provider-settings` intent and forbids automatic API fallback. Harness does not claim to prevent provider charges. Native aliases are listed from initialization, with `default` omitted; the chosen alias is passed explicitly and observed response model identities are checked.

## Execution and permissions

The SDK owns protocol encoding. Each session uses an explicit workspace, fixed environment, empty settings sources and MCP configuration, restricted mode, disabled user/plugin hooks and dynamic Skill shell execution, disabled auto memory/connectors, and only `Read`, `Edit`, `Write`, plus `Skill` when model invocation was selected. Without selected plugins, safe mode is also enabled. The host rejects native shell input and unadmitted direct slash commands.

The PreToolUse SDK hook forces a permission callback. Reads are limited to ordinary UTF-8 text files inside the selected repository. Writes require a protected full patch review, a still-current workspace lease, matching native request/turn/session/policy bindings, and an unchanged preimage. The host authorization callback runs synchronously at the actual SDK-generated allow-reply write; a revoked or unbound allowance closes the process. Denial, interrupt, expiry, account change, and stale content cannot become a new approval. No session or workspace-wide permission grants are emitted.

V1 has no Claude shell, Git, web, MCP, subagent, attachment, human-input or OS sandbox capability. File helpers reject links, hardlinks, metadata directories, Windows alternate streams and ambiguous names; files are limited to 256 KiB and review diffs to 512 KiB. Existing parent directories are required for new files. These checks and native restricted mode are tool mediation, not proof against another local process racing filesystem operations. Policies requiring an enforced OS boundary are rejected.

## Native Skills

Selections come from the host's authorized catalog sources and bind catalog ID, SHA-256, workspace, runtime, target, policy/version and invocation actor. V1 admits a standalone `SKILL.md` with plain frontmatter only; support files, hook/model/fork/tool declarations, dynamic shell substitutions, and external file references are unsupported. Native name changes during plugin staging are rejected.

The exact selected bytes are copied into a private explicitly loaded local plugin. Manifest, directory contents and Skill hashes are checked again before dispatch. The SDK's `skills` allowlist controls model invocation; it does not restrict direct user commands. Harness therefore validates direct `/name` input separately and rewrites only an admitted user Skill to its native plugin-qualified name. A user may select the same Skill once for each actor mode. Selection is per conversation and persists through exact resume.

## Streams, usage and resume

Input dispatch requires the native replay acknowledgment for its exact user UUID. Unacknowledged input becomes uncertain and is never resent automatically. Streamed text and completed SDK block frames retain all text under the provider response ID. Native session IDs, explicit model identity, and available input UUID correlations are checked. Account/status payloads, raw SDK errors and unrecognized output are not journaled.

Interrupt control acknowledgment alone never settles a turn. Only a terminal result with native `aborted_streaming` or `aborted_tools` reason is projected as interrupted; a racing natural completion retains its native outcome. If the native receipt says the admitted input survived in the queue, the selected process is closed and the command remains uncertain instead of being replayed.

Token telemetry uses native per-turn main-loop usage with cache counts reported separately. Cumulative SDK costs are omitted: they have a different accounting scope, and no charge or cost estimate is displayed. Quota and context telemetry remain unsupported.

Clean host-journal sessions in `idle` or `closed` state can resume through the documented `resume: <exact-native-UUID>` option. Account, workspace, native version, model selection, policy and selected Skills are revalidated. The adapter never selects the latest conversation, forks, truncates, or replays an uncertain command. Uncertain-state native completeness inspection is unsupported; uncertain conversations remain blocked.

Closing waits for the selected native process to exit, then performs a bounded post-kill confirmation if necessary. An unconfirmed stop rejects cleanup and does not establish a host stop proof. This is direct native process termination, not an OS process-tree isolation claim.

## Validation status

Capability `verified` means the pinned adapter/control support demonstrated by native initialization and local official-SDK fixtures. It is independent of account/billing admission and does not mean a live provider task has passed. The real DesktopBackend plus actual ClaudeAdapter integration fixture covers admission, protected approval/denial, Skills, text/tokens/files, saved history and exact resume.

Provider-free fixtures cover the inspector, execution admission, protected permissions, stale epochs and files, input identity, model identity, multi-block text, clean exact resume, Skills, and actual official SDK framing with a compiled local peer. The installed binary passed no-prompt subscription/control initialization and explicit staged Skill discovery. These observations do **not** substitute for the still-pending real task, live permission and resume validation. No Claude provider prompt has been sent by this implementation work.

See [primary-source and local evidence](docs/validation/v1-claude-native-evidence.md). [M1B_CLAUDE.md](M1B_CLAUDE.md) records the historical diagnostic-only stage.
