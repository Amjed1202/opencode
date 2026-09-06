# Codex protected review and choice-input evidence

Date: 2026-09-06. Continuation base: `f3308fb`. Native wire version: **0.153.4**. This slice is implemented and verified with local spawned protocol peers. No native provider task, login, auth-file read, configuration mutation or model inference was performed for this continuation. Earlier native diagnostic smoke evidence remains historical and does not validate this new behavior against a live model.

## Experimental negotiation

The adapter keeps `initialize.capabilities.experimentalApi: false`.

The generated `ToolRequestUserInput*` types describe the payload as experimental, but `ServerRequest.ts` already includes `item/tool/requestUserInput` in the pinned stable schema output. Official source at `rust-v0.153.4` shows that receiving this method does not require enabling the broader experimental capability:

| Pinned official source | Evidence | Git blob SHA |
| --- | --- | --- |
| [protocol/common.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/protocol/common.rs#L1702) | `ToolRequestUserInput` has experimental documentation but no experimental gating attribute; nearby `CurrentTimeRead` does have one. | `6c00f889f55cdf0be495a39c8693610af9a40010` |
| [app-server/transport.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/transport.rs#L101) | The capability filter applies to experimental notifications. The request filter at lines 180–197 strips experimental command-approval fields and passes other server requests through. | `62b3da44cd80f6efcdb9f6a674b8b0a648cc8d0d` |
| [bespoke_event_handling.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/bespoke_event_handling.rs#L824) | Native `RequestUserInput` unconditionally emits the server request. The handler at lines 1731–1809 supplies an empty answer map after ordinary client errors/disconnection; turn-transition cancellation returns without submitting an answer. | `91cda28b0a09a066b03501afde15eb4fb8d3c359` |
| [protocol/request_user_input.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/request_user_input.rs) | Question/answer structures carry secret and free-form flags. `autoResolutionMs` is deprecated in favor of `isBlocking`. | `379d9ba1c111245df945d54aa92d7010a196693e` |

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput) describes one to three questions, optional free-form input, and `serverRequest/resolved` notifications after answer or cleanup. Its experimental wording is broader than the pinned method's actual gate. The adapter uses the pinned source finding; this is not a compatibility claim for another release. The local peer rejects initialization that enables experimental APIs.

## Implemented native contract

- `decodeHumanInput` validates exact known fields and scalar types before retaining a private clone. Requests require an active matching native thread/turn/item, one to three distinct questions, `isBlocking: true`, `isSecret: false`, `isOther: false`, and two to eight distinct option labels per question.
- Bounds are 128 characters for headers, 4,096 for questions, 256 for option labels and 1,024 for descriptions, with a 64 KiB native request bound. Empty descriptions are allowed. Control characters and bidirectional formatting controls are rejected. Unsupported, malformed, secret, free-form and nonblocking requests receive an empty answer map without producing an input event containing their display text.
- `input.requested` carries only the fixed schema/prompt, generated IDs such as `q1` and `o1`, full request binding, operation digest and expiry. Native question IDs and option labels remain in pending adapter memory. `reviewInput` returns a detached clone for the host's protected artifact path.
- Answers select exactly one offered option for every question. The adapter maps those IDs back to exact native question IDs and original option labels; response order does not change the mapping. Arbitrary answer text and additional selection fields are rejected.
- Each response binds request/session/runtime/target/workspace IDs, native thread/turn/request IDs, policy ID/version, lease generation and operation SHA-256. Native numeric and string RPC IDs remain distinct. The digest includes native content, configuration fingerprint, policy, workspace and lifecycle epochs.
- The deadline is the earliest adapter timeout, acquired lease expiry and valid supplied native timeout. The adapter timeout is at most 60 seconds; the stdio transport separately limits callbacks to 32 concurrent requests and 4,096 seen IDs per process.
- Answers require fresh account/configuration observations and the host's synchronous authorization callback immediately before writing native bytes. Explicit response success means the reply flushed; it does not prove native tool execution or turn completion. Automatic cancellation/expiry emits only a bound metadata outcome. Cancellation closes the question callback, not necessarily the entire native turn.
- Interrupt, terminal state, account/config changes, close/dispose and expiry invalidate pending callbacks. A matching native `serverRequest/resolved` retires the transport callback without a late response. Duplicate native IDs terminate the transport, including IDs already answered. Duplicate or invalid concurrent answers consume the pending request without answering.

The separate native filesystem/network/shell policy remains unchanged. Only observed bounded workspace file changes can be approved once. Commands and broader permission expansions remain deny-only. MCP/apps/extensions remain disabled by the checked isolated configuration; supporting questions does not enable them or broaden execution authority.

## Protected review boundary

`reviewPermission` returns the retained path/change-kind/diff/optional move destination for a still-pending allow-capable file request. It validates the current session and operation and returns a clone. `reviewInput` returns only the validated fixed-choice display. These host-only methods do not place display content into ordinary events.

The host validates content against the bound metadata request, encrypts it using AES-256-GCM in a separate SQLite store, and supplies a restricted artifact reference. Storage requires an existing private root outside all registered workspaces and an explicitly supplied 32-byte key. The manager reserves that root for the registry's lifetime, preventing existing or later workspace overlap; restart setup must reserve it before admitting workspaces. Key provisioning and OS vault integration remain absent.

Grants and answers require a current protected review token bound to actor, request, operation and artifact digest. Tokens and read grants live only in memory, last at most 60 seconds and do not survive restart. `interaction.reviewed` records authorized content delivery, not human comprehension. There is no desktop review UI yet. Denial and cancellation do not require reading protected content.

Storage is capped per artifact (1 MiB) and bounds ephemeral grants/reviews (1,024 each); this is not an aggregate database retention policy. Resolved encrypted artifacts remain until an explicit delete operation. Deletion is logical and does not securely erase media or backups. Host-protected directories are required because application checks cannot defend against a hostile same-privilege filesystem race.

## Local validation

From `packages/harness-adapters`, using pinned Bun 1.3.14:

```text
bun typecheck
bun run test
```

Result at native handoff: **207 tests passed, 515 assertions, five test files; typecheck passed**. Tests use spawned local peers, never the installed provider runtime. New coverage includes strict request decoding, metadata-only input events, protected patch/question clones, exact original label replies, reordered multiple questions, all binding fields, malformed selections, missing/revoked host guards, simultaneous answers, native ID replay, native callback cleanup, expiry, interrupt/close/dispose, account/config changes and terminal completion. Existing file-policy, stdio and bounded history regressions remain green.

The decoder's first test run failed because its implementation did not exist; the protected patch integration failed because the adapter review method did not exist. The implementation then passed the focused cases and complete package suite. Host artifact/journal/manager integration has separate checks recorded in [VALIDATION.md](../../VALIDATION.md); this document does not imply a live subscription task, attested OS sandbox, complete M1a or a working desktop application.

Generated additions are copied unmodified from the pinned local protocol output: `RequestId.ts`, `ServerRequestResolvedNotification.ts`, and `ToolRequestUserInput{Params,Question,Option,Response,Answer}.ts`. Their provenance and SHA-256 records remain in the adapter's private generated directory, with the existing license notices and line-ending policy preserved.
