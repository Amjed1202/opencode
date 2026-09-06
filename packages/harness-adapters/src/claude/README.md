# Claude native adapter — connection checks only

`@harness/adapters/claude` exports `ClaudeAdapter`, pinned to the unmodified **Claude Code 2.1.251** binary. Discovery runs `--version`; status verifies the selected runtime/target/path/version binding, repeats the version check and runs `auth status`. The inspector validates bounded output and exposes only the native `loggedIn` boolean. Sign-in occurs separately through Claude Code. Harness neither imports credentials nor reads native account files directly.

Authentication mode, billing, provider overage, models and quota remain unknown. Execution, streaming, sessions, permissions, resume and native Skills activation are unsupported. Preflight and direct execution methods fail without starting a provider operation. Diagnostics use fixed arguments, closed stdin, bounded output/timeouts and a host-owned working directory outside the repository. Disposal invalidates late observations. See [implemented scope](../../../../M1B_CLAUDE.md) and [primary-source evidence](../../../../docs/validation/m1b-claude-native-evidence.md).

Before enabling execution:

1. Establish a supported native interface for effective authentication/provider routing, managed policy and startup extensions before they can cause side effects. A sign-in boolean or environment allowlist is insufficient.
2. Verify charge policy separately from subscription authentication. Unknown billing or required policy evidence blocks admission; it never enables API fallback.
3. Pin and test documented text/tool/result streams, session identities and permission ordering. Do not assume private control messages or scrape terminal screens.
4. Verify denial/expiry, cancellation and descendant cleanup, resume, partial/final deduplication and subagent-inclusive usage accounting.
5. Bind native Skills activation to exact loaded roots/content hashes, invocation rules and host policy. Catalog metadata never grants execution.

The real native smoke ran only version/status diagnostics in an isolated signed-out profile. It did not inspect the user's account or send a Claude task. Current integration conditions are recorded in [ADAPTERS.md](../../../../ADAPTERS.md); the direct Agent SDK subscription route remains distinct. No fake responses, default API key, native token import or SDK dependency belongs in this adapter.
