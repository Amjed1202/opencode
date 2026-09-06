# Claude native connection checks

Harness now has a native Claude Code adapter for **installation and sign-in checks only**, pinned to **2.1.251**. Select Claude Code in the desktop, choose its executable and the native account home containing `.claude`, then check the connection. This uses the unmodified binary and existing native sign-in; Harness does not offer a login/token-import flow or read credential files directly.

Claude conversations, model discovery, tools, approvals, resume and native Skills activation remain unavailable. A signed-in result is displayed separately from billing. It cannot make the Start button available or issue a native prompt. The existing Codex path remains the only conversation executor.

## Implemented boundary

`@harness/adapters/claude` exports `ClaudeAdapter`. Discovery checks only `--version` on the exact host-selected executable. `status` verifies the runtime/target/path/version binding, repeats the version check and runs `auth status`. The native diagnostic uses fixed argument arrays, closed stdin, no shell, a hidden child window, a deliberate environment and the host's private working directory. It has bounded output and timeouts. All ordinary status/errors omit raw stdout, stderr, account labels, provider profile fields, token-like fields and native paths.

The pinned signed-out observation contains a boolean `loggedIn`; the inspector requires that field and its matching exit status (0 signed in, 1 signed out). It exposes only that boolean. Unknown fields cannot establish a plan, provider route or subscription claim. Authentication mode, billing and provider overage remain unknown, and all execution capabilities are explicitly unsupported. Preflight and direct execution methods reject without launching a diagnostic or provider operation. Disposal invalidates observations still in flight. Cleanup closes owned output streams, attempts direct-child termination and waits at most 250 ms for close; an unconfirmed shutdown disables further inspection. This does not attest descendant termination.

The desktop adds one validated `selectRuntime` operation with only `codex` and `claude` choices. Switching clears the executable, account-home selection, prior connection evidence and local admission acknowledgments. The selected repository and metadata-only Skills catalog can remain. Runtime changes are rejected while a session is attached or a native picker is open. Native paths still come solely from main-process pickers. Claude status runs outside the repository to avoid using its working directory as a diagnostic context.

## Why execution is blocked

The current documented controls do not provide all the evidence this host needs before dispatch. Normal headless startup can load hooks, MCP and Skills without the interactive trust dialog. `--bare` bypasses native subscription OAuth. The authentication-preserving `--safe-mode` and `--restricted` options retain managed policy, while effective provider routing can involve profiles, gateways, managed settings and dynamic policy. A boolean sign-in indicator is insufficient to verify that complete state.

The native permission prompt tool covers unresolved prompts; it is not proof that every operation reaches the host before execution. The newer `--permission-prompts none` flag is outside the pinned 2.1.251 interface. The adapter therefore has no print/stream invocation, private control-protocol implementation, API fallback or permission-bypass switch. [Checked primary-source evidence](docs/validation/m1b-claude-native-evidence.md).

Future execution work needs a verified native route for effective authentication/provider configuration, managed policy and startup extensions before side effects, then pinned permission ordering, cancellation, native session identity and recovery tests. Skill activation additionally needs exact loaded source/content hashes and resource/permission boundaries; catalog discovery does not grant tool access. See [Claude Skills](CLAUDE_SKILLS.md).

## Verification scope

The real installed binary was exercised only with `--version` and `auth status` in a fresh, signed-out temporary profile. That check says nothing about the user's existing account, subscription entitlement or billing. No real Claude prompt, login or provider task was sent. [Native smoke](docs/validation/m1b-claude-native-smoke.json).

Local process fixtures cover framing, output limits, malformed status, version drift, timeouts and disposal. Adapter tests cover identity binding, unsupported operations and suppression of late observations. Desktop fixtures and browser tests cover switching, clearing stale Codex readiness, sign-in/billing separation and blocked execution. The real Electron smoke exercises the new preload operation while preserving sandbox/storage checks. [Validation](VALIDATION.md).
