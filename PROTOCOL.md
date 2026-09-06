# Universal agent protocol

Status: protocol `0.3` contracts with native stdio decoding, local command/event/permission/input journals, protected review and host admission. A public renderer/node wire decoder is still pending. Authoritative contracts: `packages/harness-protocol/src`; they have no runtime dependency on OpenCode, Electron, a vendor SDK or Node. See [implemented scope](M1A_IMPLEMENTATION.md).

## Domain and versioning

Compatibility note for 0.3: human-input requests/responses now use the complete `PermissionBinding`, fixed-choice metadata and explicit answer/cancel outcomes. Permission and input requests may reference a protected review artifact; resolutions record its digest, and `interaction.reviewed` audits authorized content delivery. Responses may carry a short-lived host review token, which is never persisted. Existing 0.2 and older event journals require an explicit migration or a separate new database; no automatic conversion or deletion is performed. The full runtime/native/policy binding introduced in 0.2 remains required, including string-versus-number native request identity. Workspace package versions remain development package versions and are distinct from this wire version.

Use separate application `sessionId`, native session/turn IDs, command ID, workspace ID, target ID, runtime ID, adapter ID and provider/model IDs. A runtime can offer models from several providers. Remote is an execution target/transport; an API runtime can itself run on a remote node. Human account labels are optional, sanitized and not credential identifiers.

The pre-1.0 protocol may change incompatibly only with a minor-version change and an explicit migration/compatibility note. Later 1.x majors govern incompatible wire changes. Handshake must agree protocol version, runtime/adapter versions, event support, resource bounds and authenticated peer identity before commands. Unknown extension events are retained as `native.event`, never interpreted as executable instructions. Unknown mandatory commands fail with `unsupported`; optional fields are additive. Types alone cannot validate network input: implement bounded runtime schemas before IPC or remote exposure.

Capabilities are a map of known feature names to supported/unsupported/unknown observations with limitations and evidence. Features include coding, terminal, permissions, resume, context, quota, hooks, MCP and subagents. Model capabilities and effective session policy can narrow runtime support. Missing means unknown, not supported. Supported optional operations must also have implementations; contract tests will enforce this relationship. Advertisements control UI visibility, not authority.

## Authentication and admission

`RuntimeAuthState` carries requested-independent observed authentication, account/plan when exposed, source and observation time. `BillingEvidence` separately describes subscription/API/local/provider-specific/unknown route and provider overage state. A subscription account is neither an API credential nor proof that extra usage is disabled.

`SessionIntent` contains the selected runtime, model, execution target, workspace, auth mode, billing intent and required policy. `PreflightResult` is either blocked with reasons or ready with an expiring opaque admission reference and effective evidence. An internal `AdmittedSessionRequest` is produced only after control-plane validation. Its TypeScript shape is not a security token: the host must validate the stored admission binding, expiry, policy version and current account/configuration at execution time. No credentials occur in renderer-visible DTOs.

`PreflightRequest` identifies create, resume or turn admission. For resume/turn, the host resolves the stored session and supplies it in `AdapterPreflightRequest`, so current account/cwd configuration is checked against the host-stored binding before admission. Native thread settings are validated during open/resume; each turn repeats explicit sandbox and approval settings. The operation is part of the admission binding; a create admission cannot authorize a resume or turn.

`send` acknowledges admission with a command receipt; `events` is a separate continuous asynchronous stream. This supports idle account updates, tool/permission events, more than one turn and reconnects. It avoids tying a session's lifetime to a single HTTP response. One writer per session executes admitted input serially. The DTO reserves queue/when-idle delivery, but this implementation accepts only when-idle and rejects queue; steering can be added as a verified native extension without pretending all runtimes support it.

## Event envelope

Every persisted event has protocol version, globally unique ID, stream ID, monotonically increasing sequence, observation time, correlation scope and a discriminated `type`/`data` pair. The host assigns ordering on durable append; adapters emit unsequenced normalized event drafts. An event may include native occurrence time/IDs and `NativeEventReference`: sanitized inline JSON or a protected artifact reference with provider/native event name and redaction metadata. Large content uses artifacts. Credentials and auth exchanges are never raw-log preservation candidates.

Scope includes target and runtime, with session/turn/command/task/collaboration/parent identifiers where meaningful. Account quota is account scoped rather than assigned fictitiously to a session. Aggregate streams retain the source stream and sequence; there is no implied global order between independent nodes. Event IDs deduplicate replay, while native IDs correlate updates; neither a timestamp nor text content is a deduplication key.

Before assigning host IDs, deduplicate drafts by `EventOrigin` `(streamId, epoch, eventId)`. Adapters preserve native identity where available; otherwise they must assign and durably retain ingestion identity before offering replay. If native history cannot supply stable identity or missing output, report `stream.gap` rather than promise lossless resume. Role assignment, workflow step and attempt IDs enable collaboration attribution without parsing opaque accounting keys.

| Event family | Payload semantics |
| --- | --- |
| `assistant.text.delta`, `.completed`, `assistant.thinking` | Stable message/part IDs; delta appends, completion replaces/reconciles authoritative content; thinking is exposed native content only |
| `agent.started`, `.completed`, `.error` | Native turn lifecycle; completion includes succeeded/failed/interrupted, independent of command acknowledgement |
| `tool.started`, `.output`, `.completed` | Call ID, sanitized name/arguments, artifact/text output and result status; argument generation is not execution |
| `terminal.started`, `.output`, `.completed` | Actual terminal/process identity only; ordinary shell tool output need not be a PTY |
| `file.read`, `.changed`, `.created`, `.deleted`, `diff.created`, `git.changed` | Workspace-relative resources, change source and artifact/snapshot identity; a proposed patch is distinct from an applied change |
| `permission.requested`, `.resolved`, `input.requested`, `.resolved` | Security approvals are distinct from questions or MCP elicitation |
| `interaction.reviewed` | Host-assigned actor/time and artifact digest establish authorized content delivery, not human comprehension |
| `task.started`, `.updated`, `.completed`, `session.updated` | State projections and native bindings; changes carry explicit versions |
| `usage.updated`, `context.updated`, `context.compacted` | Provenanced observations with cumulative/delta scope and epoch; unknown counts stay unknown |
| `subagent.started`, `.completed`, `collaboration.review.created` | Native child relationships versus application collaboration roles remain distinct |
| `runtime.updated`, `native.event` | Sanitized runtime/auth changes and unsupported native extensions |

## Delivery, failures and replay

Host storage uses uniqueness on `(streamId, sequence)` and event ID. Publish after append; readers reconnect with a cursor and receive at-least-once events. A reducer persists the last cursor atomically with its projection. Keep text backpressure separate from durable control events: the UI may coalesce display updates, but journal order is preserved. Bound frame sizes, queues and artifact storage; signal an explicit gap when native output cannot be recovered. Never invent missing events.

Client/store streams return `EventDelivery`: a durable event frame or a retention-gap recovery frame carrying an authorized snapshot and replacement cursor. Recovery frames never execute tools. This host-retention recovery differs from an adapter-reported native `stream.gap`, where a recoverable snapshot may not exist.

Persist a command ledger with caller request ID, canonical request hash, admission binding and receipt. Reusing an ID with different content fails. A crash between native dispatch and receipt produces `uncertain`, not an automatic retry. Reconcile native turn/session state or ask the user before another coding command. Event replay **never executes** tools or re-sends prompts. There is no exactly-once execution promise across processes.

Standard errors distinguish unsupported, invalid input, auth required, auth/billing conflict, capacity limited, permission denied, workspace conflict, unavailable, incompatible protocol and unknown native failure. Include retryability and sanitized native code; never allow an error handler to choose paid API mode. Interrupt is acknowledged separately from observed process/turn termination. Closing an attachment unsubscribes/releases resources; deleting history is a separate future command.

## Permissions and extension points

A request binds request ID, native correlation, session, target, workspace, tool/action, policy version, lease generation, offered choices and expiry. The host owns the native reply handle; the renderer sees safe details and submits a choice ID. Validate current state and exact choice; stale, cross-session, duplicate or expired replies fail closed. Native session-wide approval is only available if the host policy permits its precise scope. Unknown decisions are not approvals.

The binding includes the immutable operation SHA-256 digest. Resolution events record authenticated actor and decision time assigned by the host, including policy/timeout decisions; renderer input cannot choose the audit actor.

`HumanInputRequest` carries the fixed prompt `Choose one option for each question.`, schema `harness.choice-input.v1`, generated question/option IDs and expiry. A response supplies one offered option per question or cancels with no selections. Question headers, prose and option labels are excluded from ordinary events. The Codex implementation permits only one to three blocking nonsecret questions with two to eight fixed options each; other forms are cancelled. Native labels remain private to the adapter's pending callback and protected review artifact.

Privileged `reviewPermission`/`reviewInput` returns validated display content, its restricted artifact reference and an in-memory review token. Grants and answers require that token bound to the actor, full request, operation and artifact digest, plus a fresh admission/lease check at the actual native reply write boundary. Review expiry is capped at 60 seconds and request expiry. A token is not a replacement for session authority, is not an event payload, and cannot authorize replay after restart. Denial/cancellation does not require protected content access. Pending and claimed interaction recovery follows the command ledger's fail-closed, no-replay semantics.

Extensions use an adapter namespace, version and JSON-schema identifier. Native model effort, review modes, hooks or structured output may appear in a generic extension control surface after explicit support negotiation. Raw native data is an observability channel, never a bypass for arbitrary provider commands.

## Required future protocol checks

Public IPC/node frame decoding, cross-node replay rejection, interrupted/error usage and cumulative usage reset remain future checks. Local native framing, durable command/interaction claims, expiry, binding mismatches, review capabilities, account/config invalidation and exact-turn reconciliation have behavioral fixture coverage; see [validation](VALIDATION.md) for the precise evidence. Compile-time shape checks do not establish live provider execution or OS isolation.
