# Native Codex model selection

Historical model-picker increment. The later [V1 desktop](V1_STATUS.md) also adds Claude execution, Skills, history/recovery, files, usage and Windows packaging. Native catalog limitations below remain applicable.

The desktop now loads a bounded model catalog from the selected Codex **0.153.4** runtime. After **Check connection**, choose a model from the **Codex model** list, review the existing billing and execution acknowledgments, then start the conversation. There is no automatic selection, hardcoded fallback or free-text model route in the desktop.

The list represents what native Codex reports. It does not prove subscription entitlement, remote availability, disabled overage or additional tool capabilities. Native Codex may return cached data, fetch catalog metadata over the network and maintain its own cache. The application does not call an inference API to discover models. [Pinned native evidence](docs/validation/m1c-models-native-evidence.md).

## Adapter and host behavior

The adapter implements the existing optional `AgentAdapter.models` method with native `model/list`, `includeHidden: false`, explicit page size and opaque cursors. Requests are bounded to eight pages, 256 native records and 128 KiB of projected metadata. Each request uses the existing private transport timeout. Looping cursors, duplicate dispatch IDs, invalid names/IDs, excessive pages/records and malformed responses invalidate the observation. Hidden entries are omitted. Only the native dispatch string (`model`), display name, fixed provider ID and empty capability map are returned; descriptions, upgrade instructions, URLs and all other native fields stay private.

Native `id` and `model` are distinct fields. The desktop sends the validated `model` string; it does not substitute a catalog ID, display name or advertised upgrade. Native account/configuration observations bracket the catalog read. Runtime binding, account changes, configuration changes and disposal invalidate pending observations. Pagination is not an atomic server snapshot and the native cache is not an account-bound entitlement record.

The host publishes only bounded `{id, name}` entries and an observation timestamp. Changing repository, executable, account home or runtime clears prior catalog evidence. Failed/empty catalog reads disable selection. Claude's model catalog remains unsupported. A disconnected private host clears the displayed catalog and execution state.

Start checks membership in the displayed catalog, requests a new native catalog, publishes the resulting list and rejects if the selected model is missing or the observation fails. Only then does the existing admission flow perform its separate account, subscription-route and policy checks. Native thread creation must echo the selected provider/model and required execution settings. There is no automatic retry or replacement model. A new catalog read may still reflect native cache; it is not a remote availability guarantee.

The renderer requires an explicit offered choice, supports keyboard selection, shows loading/unavailable states, and clears selection after configuration changes or removal from the next catalog. A returned list never starts a session or sends a prompt. Protocol 0.3 and the narrow desktop request API remain unchanged; only the private state projection gains catalog metadata. No dependencies or credentials were added.

## Verification and remaining work

Local spawned native-protocol peers exercise pagination, filtering, schema/size limits, account/configuration drift, disposal, catalog failure and disappearing selections. Desktop backend tests prove that rejected or stale IDs do not produce `thread/start`; browser tests exercise selection, loading and invalidation. The real built Electron smoke checks the empty catalog, disabled selector, runtime switching and existing sandbox/storage boundaries. [Recorded checks](VALIDATION.md).

No real user account, model-list request or provider task was used to validate this increment. Generated model contracts were copied byte-for-byte from the previously generated pinned CLI protocol, with hashes and OpenAI license attribution retained. All 72 existing generated file hashes remain unchanged; nine additional model contracts bring the recorded set to 81.

Claude execution and native Skills activation remain blocked pending effective billing and managed-policy verification. Native history/recovery presentation, usage/context displays, OS execution boundary attestation, a separately authorized live Codex repository task and signed distribution remain further milestones. This increment does not complete M1 acceptance.
