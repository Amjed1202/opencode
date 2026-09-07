# Runtime adapters

Codex App Server is pinned to **0.153.4**. Claude uses official Agent SDK **0.3.251** with the unmodified selected Claude Code **2.1.251** executable. Both adapters support conditional native subscription execution; account/policy admission remains separate from declared route support. OpenCode and other runtime adapters remain unimplemented. Local and no-prompt native evidence do not replace live acceptance. [V1 scope](V1_STATUS.md), [Claude scope](V1_CLAUDE.md). OpenCode baseline: `v1.18.29`, commit `16747470f976aca3d362ad730bcd3fe82ecc2c9a`.

## Package boundary

Three additive runtime-library packages preserve upstream layout; the separate `@harness/desktop` package consumes their host operations:

- `@harness/protocol` in `packages/harness-protocol`: runtime, capability, session, event, permission, usage, collaboration and node types.
- `@harness/adapters` in `packages/harness-adapters`: exported contracts in `src/index.ts`, implemented Codex and Claude adapters, and provider folders describing their remaining gates.
- `@harness/control-plane` in `packages/harness-control-plane`: admission, lifecycle and application-service interfaces.

Adapters depend on the protocol; the control plane selects adapters. Renderer code talks to control-plane application operations. Provider-specific settings remain namespaced extensions, never renderer-owned subprocess or provider orchestration.

## Contract

| Operation                                   | Meaning                                                                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover(context)`                         | Find runtime metadata on the selected target without inference or credential extraction.                                                                                                                              |
| `status(runtime)`                           | Optional bounded native account/config observation before choosing a model or starting a session. Codex uses existing official account/config reads with token refresh disabled; no login, thread or turn is created. |
| `preflight(request)`                        | Compare create/resume/turn intent with native evidence; resume/turn include the host-resolved existing session so persisted native configuration is checked.                                                          |
| `createSession(admission)`                  | Accept validated control-plane admission and associate application/native session IDs.                                                                                                                                |
| `send(session, input)`                      | Admit a command and return a receipt; receipt does not mean execution completed.                                                                                                                                      |
| `events(session)`                           | Continuous asynchronous event stream covering execution, approvals and lifecycle beyond individual sends.                                                                                                             |
| `interrupt(session)`                        | Request cancellation; terminal state arrives through events.                                                                                                                                                          |
| `resume(...)`                               | Optional, advertised only after native resume behavior is verified.                                                                                                                                                   |
| `resolvePermission(...)`                    | Resolve the correlated native request using its supported decisions and scopes.                                                                                                                                       |
| `reviewPermission(...)`, `reviewInput(...)` | Host-only access to a cloned pending patch or question display, bound to the current session and operation. The host protects it before presentation.                                                                 |
| `resolveInput(...)`                         | Resolve a bound native question using offered option IDs or cancellation. Answer delivery requires the final host authorization callback.                                                                             |
| `inspect(session)`                          | Optional bounded read-only history evidence; does not resume or replay native work.                                                                                                                                   |
| `models(...)`, `usage(...)`                 | Optional native discovery/observations; unavailable is distinct from empty or zero.                                                                                                                                   |
| `close(session)`                            | Release the attachment and owned resources without deleting native history.                                                                                                                                           |

Discovery records executable, runtime/adapter versions, protocol variant, target and support evidence. Capabilities distinguish requested, declared and verified support, with limitations. Unsupported operations fail explicitly. Cross-runtime builder/reviewer workflows belong to our collaboration engine.

## Claude

The native account remains in the unmodified installed CLI; Harness neither imports credentials nor creates an application-owned subscription login. The official SDK launches that selected executable with isolated settings and a restricted tool set. Native version, personal Pro/Max account/provider evidence, unmanaged-policy checks, applied permission hooks and initialization must pass before execution. Provider overage remains unknown and automatic API fallback is disabled. [Native source and observed evidence](docs/validation/v1-claude-native-evidence.md).

The implemented subset covers text streaming, ordinary workspace Read/Edit/Write, protected once-only write review, per-turn token telemetry, explicit standalone native Skills and clean exact-UUID resume. Shell, network tools, MCP, subagents, arbitrary hooks, context/cost/quota telemetry and uncertain native inspection remain unsupported. Source hashes, selected Skill invocation modes, native model identity, session/input IDs and current host approval authority are rechecked at their boundaries. The SDK owns protocol encoding and Claude owns the agent loop.

Route support is declared by discovery. Supported capabilities become verified only after the pinned native controls are observed; this describes the fixture-validated adapter contract and does not certify successful live inference. Current host admission remains mandatory. Historical status-only research is preserved in [M1B_CLAUDE.md](M1B_CLAUDE.md); the complete execution contract is [V1_CLAUDE.md](V1_CLAUDE.md).

## Codex

Prefer Codex App Server, intended for custom clients requiring authentication, history, approvals and streaming. Use existing managed ChatGPT authentication or native `account/login/start` with `chatgpt`/`chatgptDeviceCode`; Codex owns tokens and refresh. Read `account/read` and account notifications. Externally supplied token modes are unnecessary here. API-key login is an explicit separate selection. [App Server](https://learn.chatgpt.com/docs/app-server), [authentication](https://learn.chatgpt.com/docs/auth)

Start with private stdio transport. Preserve thread/turn/item IDs and version-generated native schemas inside the adapter. Local research found Codex `0.153.4`; schema inspection is not execution certification. The SDK remains useful for automation, but the interactive desktop needs the richer App Server boundary. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

The implemented `models(...)` port uses pinned native `model/list` with bounded pagination and hidden entries excluded. It projects only validated dispatch IDs, display names and the OpenAI provider identity, without inferred capabilities, entitlement or billing. Native account/configuration observations bracket the listing, and changed evidence rejects the result. The desktop requires an explicit picker choice, makes another list request before independent session admission, and blocks when the selected model disappears or the catalog is unavailable. There is no default selection, manual-ID entry or fallback.

Native listing can fetch metadata and update Codex's own cache; a repeated request can return cached results. Neither listing nor the surrounding observations atomically locks model availability or native account/configuration through dispatch. Model membership does not replace current subscription, provider-overage or permission-policy admission. Native model discovery, desktop history/recovery, files and native token/context-capacity presentation are implemented. Launch-only isolation is verified against the installed CLI without editing global configuration. OS boundary attestation and a separately authorized live repository task remain open.

The implemented adapter defers bounded native file approvals and blocking fixed-choice input while continuing to drain stdio. Both use exact native request/session/turn identity, operation hashes, expiry and an asynchronous flush acknowledgement. File grants remain limited to observed once-only workspace changes; command execution and broader permission expansions remain deny-only. Questions require one to three nonsecret blocking items with two to eight fixed options; free-form, secret, nonblocking and unknown shapes are cancelled. Public input events carry generated IDs, while exact labels remain private pending data for protected review and the original response.

The host encrypts patch/question review artifacts and requires an actor-bound review token before granting or answering. After fresh native account/config checks, a synchronous host callback runs immediately before reply bytes are written. Native `serverRequest/resolved` retires the exact callback without sending a late response; interruption, terminal state, expiry, account/config changes and close also invalidate pending interactions. Replies never replay after a host restart.

The handshake keeps `experimentalApi: false`. In the pinned official source, `ToolRequestUserInput` has experimental prose but no experimental gate, and the transport forwards it independently of that capability. This does not promise compatibility with another release or enable unrelated experimental APIs. [Pinned request declaration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/protocol/common.rs#L1702), [pinned transport](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/transport.rs#L180), [implementation evidence](docs/validation/m1a-review-input-native-source.md).

## OpenCode, generic and remote

Initially wrap the established `@opencode-ai/sdk/v2` compatibility surface and isolate its session, event, permission and PTY calls. That SDK version label does not mean the newer Core `SessionV2` is interchangeable. At the pinned release, Core `shell`, `skill`, `compact` and `wait` return `OperationUnavailableError`. Move to the newer `/api` client only after parity tests establish required behavior. Keep each operation on a coherent backend; do not secretly combine sessions from two implementations. Evidence: [pinned Core session implementation](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/session.ts), [legacy SDK](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/sdk/js/src/v2/gen/sdk.gen.ts).

A generic HTTP/model adapter advertises inference capabilities only. Function-call output is a request, not executed shell/filesystem access. Tool execution requires a separately admitted executor and permission boundary. Local/self-hosted inference has its own authentication and cost semantics.

Remote is an orthogonal execution target: `harness-node` hosts the same native adapters. A remote proxy transports the universal protocol and sanitized runtime status; native credentials remain on the node. It does not become a new model/provider identity.

## Native event mapping

The table describes the target cross-runtime mapping. Codex has an implemented event stream; Claude and OpenCode event production remain future work. Claude status checks do not create native sessions or model events.

| Native source                                                                    | Normalized meaning                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Claude text deltas; Codex `item/agentMessage/delta`; OpenCode text-part deltas   | `assistant.text.delta`                                                                         |
| Claude tool-use/result; Codex tool item lifecycle; OpenCode tool parts           | Tool requested/started/output/completed, according to actual lifecycle evidence                |
| Claude permission host; Codex server approval request; OpenCode permission event | `permission.requested` with native correlation and scope                                       |
| Codex `item/tool/requestUserInput`                                               | `input.requested` with bound choice IDs and protected display; unsupported forms are cancelled |
| Claude result/model usage; Codex thread token snapshots; OpenCode message usage  | `usage.updated`, retaining source and cumulative/delta semantics                               |
| Native session status, compaction and subagent events                            | Corresponding lifecycle/context events; unknown variants retained                              |

Retain supported sensitive display payloads through protected artifact references; the current implementation covers bounded patches and fixed-choice questions. Unknown native bodies remain omitted. Never persist authentication exchanges, tokens or complete process environments. Deduplicate partial/final messages and cumulative usage; missing fields stay unknown.

## Admission and implementation gates

The execution environment must deliberately select credential sources, provider endpoints, profiles and settings. Claude API keys take precedence in print mode; Console OAuth can also mean API billing. Therefore “OAuth detected” cannot prove subscription billing. Block mismatched effective configuration without changing user-global credentials. [Claude authentication precedence](https://code.claude.com/docs/en/authentication)

Automatic API fallback defaults **off**. Subscription login also does not prove provider usage credits/overage are disabled; show that state separately and never claim zero extra charges without evidence. [Claude usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

Before enabling execution, verify native authentication and approval schemas, effective billing/managed configuration before startup side effects, disconnect/interruption behavior, resume, event replay/deduplication, usage scope and reviewer filesystem isolation. The real Claude 2.1.251 smoke used only version/status commands in a fresh signed-out profile; it establishes no fact about the user's subscription or a provider task. Unsupported quota or billing observations remain unavailable; neither fake sessions nor schemas satisfy the subscription-backed Milestone 1 demonstration.
