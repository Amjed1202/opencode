# Codex pre-write approval correction

The first authorized repository run on 2026-09-07 used Codex 0.153.4 with `on-request` and `workspaceWrite`. Its file tool wrote before any host permission request. This was a policy mapping error: the host's ability to approve a patch had become blanket native write authority. Native workspace-write thread creation also persisted project trust; the task's live validation record owns that observation and restoration evidence.

The adapter now requests `read-only` on thread creation/resume and `readOnly` on every turn, always with network disabled. Ask maps to `untrusted`; deny maps to `never`. An effective writable sandbox, extra sandbox fields, another reviewer or another approval mode blocks adoption. A host workspace-write policy remains necessary to accept an exact, observed patch. The adapter still rejects grant roots, command approvals, permission-profile expansion and session-scoped grants.

Native `features.shell_tool=false` is pinned per process and verified during every account/configuration observation. This matters because an existing native exec-policy allow rule can bypass the sandbox. Native shell reads and test commands are unavailable in this profile; a caller must supply selected file context and run validation separately. No execution rules, authentication files or global settings are read or edited by this correction.

The local stdio peer performs real writes to unique test-owned files. Unlike the old callback-only fixtures, it follows the native distinction between automatic writable-root patches and requests requiring approval. The new regression failed on the old adapter with changed bytes before review. With the correction it checks unchanged bytes while pending, unchanged bytes after denial, exact bytes after one accept, another request for the next patch and denial of a shell write. A separate deny-policy regression proves that a host workspace-write selection never becomes broad native write permission. Creation/resume parameter checks and ignored/changed shell-tool readback regressions cover the configuration path.

These are local protocol fixtures, not provider requests or proof of OS enforcement. Private extension internals are not attested. The adapter continues to reject `requireEnforcedBoundary`; installed-native acceptance is recorded separately, without claiming a local peer establishes live behavior.

After this correction, the full local Codex suite passed **299 tests, 987 assertions across 7 files**, with zero failures, and the adapters package typecheck passed. No installed-native process or provider prompt was invoked while implementing these changes.

Pinned OpenAI sources:

- [Patch safety](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/safety.rs): `UnlessTrusted` always asks; on-request can auto-approve writable targets, while never rejects a read-only patch.
- [Tool registration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/spec_plan.rs): `ShellTool` gates command and stdin registration; patch registration is independent.
- [Execution policy](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/exec_policy.rs): explicit allow rules can bypass the sandbox.
- [Approval cache](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/sandboxing.rs): only approval for the session is cached. The adapter emits plain one-time accept.
- [Generated pinned approval enum](./generated/0.153.4/v2/AskForApproval.ts) and [sandbox enum](./generated/0.153.4/v2/SandboxPolicy.ts) define the accepted wire settings.
