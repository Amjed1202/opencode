# Harness security architecture

Status: host admission, bound native interactions, encrypted review storage and a restricted Electron/Bun desktop are implemented, 2026-09-06. The desktop provisions review keys through OS secure storage. OS execution boundary attestation, remote transport and live provider acceptance remain open; see [desktop boundaries](DESKTOP.md) and [host scope](M1A_IMPLEMENTATION.md). Harness is a provisional codename. The original OpenCode policy is preserved after this section and applies to upstream OpenCode, not to new Harness security guarantees or reporting ownership.

## Boundaries and authority

Treat repository content, prompts, tool output, MCP servers, hooks, skills, local clients, and remote nodes as distinct trust boundaries. The renderer receives safe projections and submits typed intents through authenticated, validated IPC. It cannot execute commands, open arbitrary paths, read secrets, or call native transports directly. The control plane checks session ownership, target, workspace, and policy before dispatch; the execution node repeats authorization. Host administrator compromise is outside application-only isolation guarantees.

Advertised capabilities describe support, not authority. Record enforcement strength separately: OS isolation, native enforcement, adapter interception, advisory, or unavailable. Effective permission is the intersection of application policy, target restrictions, and native enforcement. Unsupported mandatory policies block admission. Observing a tool event after execution is not an approval mechanism; a user approval cannot widen an enforced workspace boundary.

Permission decisions bind to session, node identity, native request ID, immutable operation digest, policy revision, expiry, and allowed decision scope. Reject stale, conflicting, replayed, or changed requests. Pending requests remain denied/blocked on timeout or disconnection. Audit actor, decision, scope, and outcome.

The local Codex host limits grants to observed once-only workspace file changes. Commands, network and session/workspace expansions remain deny-only. Fixed-choice input uses the same full binding, claim-before-reply journal and final host authorization callback at the actual stdio write boundary. Only one to three blocking nonsecret questions with two to eight fixed options are supported; free-form, secret, nonblocking and malformed requests are cancelled. Native callback cleanup invalidates a pending request without a late reply. Nothing in answering a question widens the separate execution policy, and native extension isolation remains checked.

Resolve filesystem paths on the execution host, including symlinks, Windows reparse points, case rules, UNC paths, and race conditions. Cwd and path-prefix checks alone are insufficient isolation. Shell scripts, package managers, Git hooks, and MCP can mutate files or access networks even when edit tools are hidden. Read-only review requires the enforceable boundaries in [COLLABORATION.md](COLLABORATION.md). Claude SDK permission callbacks are not a universal intercept; the documented permission ordering must inform its adapter. [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

## Authentication, billing, and secrets

Subscription is the preferred intent; automatic paid API fallback defaults to disabled. Authentication evidence, effective provider configuration, billing route, and provider overage state are separate, timestamped facts. Recheck on account/configuration changes. Unknown billing cannot become “API billing: OFF.” Claude subscription usage credits can incur additional charges independently of our API fallback setting. [Claude usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

Compile provider-specific minimum launch environments. Do not inherit unrelated API keys, bearer tokens, endpoint overrides, cloud-provider flags, or profile/home overrides. Inspect supported effective configuration because helpers/settings can supersede environment choices; block conflicts without modifying user-global authentication. Do not use inference as a billing probe. Native login remains native-owned; no browser cookies, token copying, private endpoint reproduction, or application-owned subscription OAuth. Claude's unmodified-binary route and restricted SDK route remain distinct implementation gates. [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude legal conditions](https://code.claude.com/docs/en/legal-and-compliance)

The desktop provisions a random 32-byte review key with Electron safeStorage and persists only its OS-encrypted envelope. Missing secure storage, corrupt envelopes and known linked/replaced storage fail closed, without plaintext fallback. This Windows development slice uses DPAPI; Linux requires a recognized secure backend. Future API/node secrets need separate vault interfaces and opaque references. Native credentials remain with the runtime and execution host. An unavailable secure store does not justify plaintext fallback. Auth exchanges never enter ordinary events. Apply field redaction before persistence/export; raw native diagnostics require explicit retention policy and protected artifacts. Local audit provides traceability, not tamper-proof evidence against the host owner. Retention/deletion covers SQLite, artifacts, indexes, exports, and backups.

Implemented review storage encrypts patch and question display content with AES-256-GCM in a separate SQLite store, including content metadata. The host must supply a 32-byte key and an existing private directory outside registered workspaces. Path/file identity checks reject known links and replacements; they do not isolate storage from a hostile same-privilege process. Logical deletion is not secure erasure of backups or storage media. Ordinary journals retain scope paths, identifiers, hashes and restricted artifact references, not raw patches or question/option labels.

An allow/answer requires protected content delivery through the authenticated host actor's review path. Its in-memory review token binds actor, full request, operation hash and artifact hash for at most 60 seconds and never survives restart. The host then revalidates authority before native delivery. `interaction.reviewed` audits that content was made available, not that a person read or understood it. The desktop renders protected text inertly, holds the token in memory, and removes expired review content. Missing protected storage prevents grants/answers while denial/cancellation remains available. Duplicate or uncertain decisions are not replayed after recovery.

## Verified upstream integration hazards

The pinned source requires these safeguards before runtime integration:

- [Desktop sidecar environment](packages/desktop/src/main/server.ts): `createSidecarEnv` copies `process.env`; replace this behavior at the future adapter launch boundary.
- [Credential schema](packages/core/src/credential/sql.ts): credential values are JSON text in SQLite; this schema is not evidence of OS secure storage.
- [Core globals](packages/core/src/global.ts): the `opencode` data/config identity is hardcoded and directories are created during import. Provision separate Harness data/config/cache/state roots before loading native services; do not import Core into the renderer or universal protocol.
- [V2 reset migration](packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts): deletes session/event/workspace state. Never point exploratory migrations at the user's existing OpenCode database. Separate schema ownership, migration review, backups, and explicit import are required.

The desktop main validates exact webContents/main-frame identity and the fixed `harness://desktop/index.html` URL before and after asynchronous IPC. The sandboxed preload exposes only named operations; native pickers authorize paths. The Bun worker uses inherited private pipes and bounded frames, with no local listener. Main supplies the actor and key; the renderer cannot submit either. All application storage is reserved outside selected workspaces. Native adapters are privileged trusted code until separately isolated. Local HTTP, if introduced, needs per-launch authentication, origin checks and authenticated WebSocket upgrades; loopback alone is insufficient. Remote authentication and command recovery are specified in [REMOTE_NODES.md](REMOTE_NODES.md). These are future acceptance gates, not changes made to upstream behavior now.

---

## Preserved upstream security policy

The following text is retained unchanged from the pinned OpenCode release. Its upstream reporting contacts are not a Harness support service. Harness needs its own disclosure process before distribution.

# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

OpenCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

OpenCode does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run OpenCode inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/anomalyco/opencode/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, you may send an email to security@anoma.ly
