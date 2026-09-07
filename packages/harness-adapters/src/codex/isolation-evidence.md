# Codex startup isolation validation

Observed on 2026-09-07 with the installed, unmodified Codex 0.153.4 and the production `CodexAdapter`. The diagnostic used the selected local repository, an explicit OS environment, and the existing native home. Native authentication remained inside Codex.

## Installed-native observations

- `shell_environment_policy.set={}` did not clear configured values because native table overrides deep-merge. Per-key empty-string arguments cleared both observed entries.
- Quoted root TOML table overrides preserved the observed MCP/plugin names and explicitly disabled all entries: 1 MCP server and 33 plugins. No configured command or source value was copied into an argument.
- `notify=[]` was reflected as an empty array.
- The observed ChatGPT endpoint exactly matched the public official endpoint. The adapter now pins that endpoint per process and rejects any differing effective readback.
- Production status reported `authenticated`, authentication mode `subscription`, and billing route `subscription`. Provider overage remained `unknown`.
- Production model discovery returned `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.

The diagnostic sent initialize, account/configuration reads and model listing only. It created no native session, submitted no prompt, requested no native configuration write and performed no login, token extraction, purchase or credential-store migration. Model listing may update native caches. Catalog membership does not establish entitlement, model execution, tool behavior, billing charges or OS sandbox enforcement.

## Regression coverage

Tests exercise actual spawned local stdio fixtures and the production parsing/verification helpers. Coverage includes concurrent initial observations; exactly one replacement; ignored overrides; unknown, invalid and excessive mappings; bounded argument encoding and TOML key round-trips; failure of replacement version verification; disposal during observation; early external-auth and command callbacks receiving only denial; and environment, plugin, MCP or notification changes blocking an established session without restarting or dispatching. Custom, suffix-confusable and path-changed ChatGPT endpoints fail effective readback checks.

The final full Codex suite passed **292 tests, 951 assertions across 7 files**, with zero failures. The adapters package typecheck passed. Generated protocol validation confirmed 84 current types, all 81 previous hashes unchanged, and no file/hash mismatches. These fixtures never invoke installed Codex or perform inference.

## Sources

The locally retained config schema for Codex 0.153.4 defines `RawMcpServerConfig.enabled`, `PluginConfig.enabled`, `notify` and `chatgpt_base_url`; the installed native readback verifies the overrides accepted by this exact binary. The public [OpenAI Codex source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs) specifies `https://chatgpt.com/backend-api/` as the ChatGPT backend fallback. That public URL is pinned exactly; no arbitrary configured endpoint is accepted as a default.
