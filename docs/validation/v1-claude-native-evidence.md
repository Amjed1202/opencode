# Claude V1 native evidence

Observed 2026-09-07. Native executable 2.1.251, official TypeScript Agent SDK 0.3.251. Findings are scoped to this pin and the narrow personal unmanaged Windows contract; they are not a general managed-policy or billing attestation.

## Official support and interfaces

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): the unmodified Claude Code binary may be incorporated into a product under the stated conditions, preserving native authentication and the user's own credentials and billing. This is the relevant native-binary route; it does not authorize token extraction or an independent subscription API route.
- [Headless operation](https://code.claude.com/docs/en/headless) and [CLI reference](https://code.claude.com/docs/en/cli-reference): documented headless structured input/output, restricted mode, safe mode, explicit tools/settings sources and native CLI selection. Bare mode does not preserve the required native subscription authentication, so it is not used.
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript): public `query`, `initializationResult`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`, `canUseTool`, hooks and session options. The installed `sdk.d.ts` is the exact versioned contract; SDK-generated permission replies are inspected at the custom native pipe boundary, not synthesized by Harness.
- [Official SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md): version parity and the earlier managed-disableAllHooks fix preserving host SDK callbacks. The selected initialization actually returns `hooks_applied: true`; absence is rejected.
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions): PreToolUse checks and native deny/ask rules are ordered before the callback. Harness forces ask for the exact supported tools and never supplies persistent native permission updates.
- [Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features): empty settings sources suppress user/project/local customizations, while managed configuration and native global authentication still require separate treatment. Strict empty MCP configuration suppresses connector discovery.

## Narrow unmanaged personal route

- [Managed settings](https://code.claude.com/docs/en/managed-settings): Windows managed files and registry policy sources; policy values are not needed to reject their presence.
- [Server-managed settings](https://code.claude.com/docs/en/server-managed-settings): documented eligible organization authentication differs from personal Pro/Max. The local remote-settings cache is still checked and rejected if present.
- [Authentication](https://code.claude.com/docs/en/authentication): native account, provider and auth-route labels must be distinguished from API/cloud configuration.

Local absence checks covered `C:\Program Files\ClaudeCode\managed-settings.json`, `managed-settings.d`, `managed-mcp.json`, native `remote-settings.json`, and the ClaudeCode policy key under HKLM/HKCU in both registry views. Checks inspect presence only and fail on unknown errors; they do not inspect policy values or credential files. The fixed environment excludes provider keys, OAuth token overrides, config-directory overrides, proxies and runtime injection variables.

The fixed native `auth status` projection required logged-in `claude.ai`, `firstParty`, personal `pro`/`max`, no API-key source, and bounded account identifiers. Only SHA-256 account/email bindings are returned. The SDK initialization must match the first-party personal account/email hash, have no API-key source, have hooks applied and fast mode off. A second native observation/policy check guards against drift during initialization.

This establishes the selected native subscription route for admission. It does not establish provider overage status, which remains unknown and requires explicit acknowledgment before execution. No settings are changed to disable or enable provider extra usage.

## Native Skills and resume

- [SDK Skills](https://code.claude.com/docs/en/agent-sdk/skills) and [native Skills](https://code.claude.com/docs/en/skills): the SDK allowlist constrains model Skill invocation; direct user slash commands require separate host admission. Explicit local plugins preserve native loading while allowing bounded private staging.
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions): exact `resume` uses a known conversation ID. Harness reapplies all controls and revalidates saved identity; it does not use `continue`, latest-session selection, forks or uncertain replay.

The pinned SDK `TerminalReason` union and official TypeScript reference expose `aborted_streaming` and `aborted_tools` on a terminal result. These are the adapter's interruption evidence. A control acknowledgment or host cancellation request alone cannot override a natural completion. The SDK also exposes interrupt receipts with surviving queued UUIDs; if the admitted input survives, Harness closes the selected process and preserves uncertainty because this pinned public Query API has no queue-cancellation method.

The actual installed native binary initialized with one private staged plugin containing only a harmless standalone Skill. Sanitized result:

```json
{
  "nativeVersion": "2.1.251",
  "sdkVersion": "0.3.251",
  "initialized": true,
  "personalSubscription": true,
  "hooksApplied": true,
  "fastModeOff": true,
  "skillLoaded": true,
  "unexpectedPlugins": false,
  "providerTaskStarted": false,
  "promptSent": false,
  "rawStatusRetained": false
}
```

The initialized model inventory exposed named `sonnet` and `haiku` alongside `default`; Harness omits `default`. This is initialization evidence, not an inference or live Skill invocation test.

## Verification and outstanding live evidence

The test suite exercises malformed/changed authentication status; strict account/provider/plan admission; managed-policy rejection; explicit models and overage acknowledgment; exact user UUID acknowledgment and no replay; changed patch preimages; lease/epoch/host authorization; blocked shell/network/unselected Skills; full text projection; per-turn token accounting without cumulative costs; clean exact resume; and standalone Skill hash/manifest validation.

Independent tests use a compiled local peer with the actual pinned official SDK to verify allow-response framing, late authorization revocation, rejection of unbound allowance, and confirmed selected-child shutdown. These fixtures never use native credentials or contact a provider.

The real native no-prompt route and staged Skill discovery passed. Real provider execution, live protected write approval, direct/model Skill invocation and clean live resume remain pending the user's explicit acknowledgment of unknown provider extra usage. No completion claim for those live scenarios is made here.

The production DesktopBackend was also run in diagnostic mode against both installed selected native runtimes, each in a new marked fixture. Claude reported ready, subscription authentication/billing, unknown overage and the named `sonnet`/`haiku` model catalog; its generated standalone Skill appeared in the authorized workspace catalog. No session or provider prompt was created. The old shared fixture was left unchanged.

## Packaging

The SDK's native binary resolver is skipped when `pathToClaudeCodeExecutable` is supplied, as it always is here. The SDK module has Node builtin imports and no required sibling `cli.js` or WASM reference on this path. The bundle retains required SDK/peer notices; Anthropic SDK usage terms are preserved rather than relabeled as MIT. User-installed Claude remains external and pinned.
