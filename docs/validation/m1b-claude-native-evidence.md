# Claude native integration evidence

Checked **2026-09-07** against the official Anthropic pages linked below. This is documentation research, not a successful provider session or a billing verification. No credentials, native account files, login flow, or inference endpoint were accessed for this research.

## Integration and subscription route

Anthropic permits users to authenticate to an **unmodified Claude Code binary** with their own subscription, including a binary offered through another product under its stated conditions. Product operators must accept the applicable Commercial Terms, preserve every native authentication option, and avoid paying for, reselling, or intermediating end-user usage. Native sign-in must own credentials. The separate restrictions on application-owned Claude.ai OAuth flows still apply; this native-binary exception does not authorize importing tokens into an SDK or implementing our own subscription login. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

The support article dated June 16 retains a **June 15 pause notice**: Agent SDK, `claude -p`, and third-party app usage still draw from subscription usage limits. The proposed monthly-credit arrangement further down that page is historical and not taking effect. This billing statement does not independently authorize an application's authentication design. [Agent SDK plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

Subscription authentication does not prove that additional charges are impossible. Paid individual plans can enable separately billed usage credits, spending caps and automatic reload. The documented controls and usage display are in the provider's account UI. This research found no documented native status field proving those controls are disabled. Keep the extra-usage gate and subscription quota unknown. [Usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

## Authentication evidence and its limits

The authentication precedence includes cloud-provider flags, bearer tokens, API keys, `apiKeyHelper`, an explicit OAuth-token variable, Anthropic profiles and native subscription login. A signed-in Claude apps gateway overrides that list. Noninteractive `-p` uses an API key from the environment without the interactive confirmation. Console accounts can now authenticate through OAuth profiles, so “OAuth” or absence of an API key cannot establish subscription billing. A host environment allowlist alone also cannot establish the final provider route. [Authentication](https://code.claude.com/docs/en/authentication)

| Evidence                                 | What it can establish                                                  | What it cannot establish                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Native `--version`                       | Candidate binary version                                               | Binary integrity or execution compatibility                                                                             |
| Native `auth status`                     | JSON is documented; exit 0 means logged in and exit 1 means logged out | The reference does not publish the JSON field schema, subscription entitlement, effective provider or charge prevention |
| Pinned fixture observation of `loggedIn` | A bounded authentication indicator after schema validation             | Any subscription, model, quota or policy claim                                                                          |

The CLI documents those commands. The implemented `loggedIn` projection follows a pinned native observation, not an additional documented field contract. [CLI reference](https://code.claude.com/docs/en/cli-reference)

The SDK reference documents optional account fields `subscriptionType`, `tokenSource`, and `apiKeySource`. Its initialization message includes `apiKeySource`, `claude_code_version`, `cwd`, `model`, `permissionMode`, tool/MCP inventories, `skills`, and `plugins`. These are SDK contracts, not the `auth status` schema. They provide candidate correlation evidence only after native compatibility tests; none is a complete pre-dispatch billing or policy attestation. [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

## Headless stream and permission boundary

The native documented stream is newline-delimited JSON through `-p --output-format stream-json --verbose --include-partial-messages`. Text deltas occur inside `stream_event`; the final `result` carries response/session metadata. Subagent messages use `parent_tool_use_id`. Resume should bind an explicit session ID, never the most recent conversation. A normal `-p` startup loads project hooks and MCP without showing workspace trust or server approval dialogs. `--bare` avoids automatic discovery but does not use subscription OAuth/keychain login. It therefore cannot solve safe startup for the requested subscription route. [Programmatic execution](https://code.claude.com/docs/en/headless)

`--permission-prompt-tool` selects an MCP permission handler. Current docs describe waiting for its server connection and denying tools requiring human interaction even if that handler allows them. They do not provide a complete current MCP request/response schema. This research did not locate an authoritative native `control_request`/`control_response` protocol; examples in public issue comments are not a supported interface contract. `--permission-prompts none` requires 2.1.259, newer than the candidate 2.1.251. `--safe-mode` preserves authentication but still applies managed policy hooks; `--restricted` also retains managed settings. These flags alone do not certify a side-effect-free startup. [CLI reference](https://code.claude.com/docs/en/cli-reference)

Permission handling occurs after native hooks/rules and mode checks; autoapproved operations do not necessarily reach a host callback. An unresolved-prompt denial mode does not override an earlier hook approval. Plan mode and a callback therefore must not be advertised as universal read-only enforcement. Before execution, test the native permission bridge, denial precedence, expiry, disconnect, cancellation and descendants against the pinned binary. [SDK permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions)

## Effective settings and Skills authority

The native `/status` view names loaded settings sources, but does not identify the source of each effective key. Files, managed policy, environment, flags, trust filtering and updates can affect behavior. An empty session settings object does not erase omitted file values; list merging also matters. [Settings](https://code.claude.com/docs/en/settings)

Managed settings can come from server delivery, Windows registry policy, system files and host policy. They can update during a session, and a `policyHelper` can compute policy at startup. An inspection that checks only workspace files cannot establish the effective boundary. [Managed settings](https://code.claude.com/docs/en/managed-settings)

The SDK's alpha `resolveSettings()` returns `effective`, `provenance`, and `sources`, including MDM inputs. It does not execute `policyHelper` or reproduce the CLI's trust filter, and server-managed data is supplied as an input. It is not a native read-only RPC or a complete attestation of what a running binary will use. No such native attestation was located in this review. [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

Native skills may come from personal, project, managed, plugin, nested and synchronized sources; symlinked skill directories can load. A skill directory can also contain a plugin manifest introducing hooks, agents and MCP. A skill's `allowed-tools` grants last for the invoking turn and apply even in an untrusted `-p` project; this field is not merely descriptive. Skill content can invoke shell preprocessing, change model or fork a context. Native skill names alone cannot bind a selected catalog file/hash or prove authority over supporting resources. [Skills](https://code.claude.com/docs/en/skills)

## Admission decision for this increment

Implement **status only**: discover the explicitly selected binary, pin its version, validate bounded native authentication output and expose only the allowlisted login boolean. Even a logged-in result has unknown authentication mode and billing route. All execution, permissions, models, quota, resume and Skills activation capabilities remain unsupported.

Execution admission must wait for evidence tying one runtime/account/workspace to effective configuration, charge policy and a supported native permission interface before inference or startup extensions can run. A future Skills admission additionally needs exact loaded roots/content and native invocation restrictions, without substituting catalog discovery for activation authority. Missing evidence is an explicit blocked state, not permission to fall back to an API key, create a session or probe with a prompt.
