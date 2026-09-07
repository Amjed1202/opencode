# Codex native model catalog evidence

Reviewed on 2026-09-07 for Codex CLI **0.153.4**. This review used the previously generated local protocol and the official source at `rust-v0.153.4`. It did not launch a native provider process, read user credentials, log in, or send an inference request.

## Supported surface

OpenAI documents `model/list` for populating model selectors. It supports pagination and returns picker-visible entries by default; `includeHidden: false` states that choice explicitly. The current documentation illustrates supported reasoning efforts, input modalities and defaults, but this implementation uses the installed version's generated contract. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server#list-models-modellist)

The local `codex app-server generate-ts` output confirms these pinned fields:

| Type                | Relevant contract                                                                            | SHA-256 of local generated source                                  |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ModelListParams`   | Optional nullable `cursor`, `limit`, `includeHidden`                                         | `9749040f93232fee23f044d307fd69eb08fea77eb6c56b1d04593d7533dd7bf4` |
| `ModelListResponse` | `data: Model[]`, required nullable `nextCursor`                                              | `5969afbe718e9a6270fe1e4f58315d7dbffe2e2275973b9c93e5abb2e8daa675` |
| `Model`             | Distinct `id` and `model`; `displayName`, `hidden`, reasoning, modality and default metadata | `ff56f09e9b9f301f1c6ecc565e2bcf6355c6ea66880f3ac963b7754e74cbe0a3` |

The native projection preserves `preset.id` and `preset.model` as separate fields. Harness must send the returned `model` value as the dispatch identifier, without replacing it with the catalog row ID, display name, or a hard-coded model. The requested model is still checked against the effective native thread response by the existing adapter. [Pinned model projection, lines 27–70](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/models.rs#L27)

## Pagination and freshness limits

The pinned request processor rebuilds the model list on each request, defaults hidden inclusion to false, clamps page size to at least one, and slices it by an integer offset represented as a string cursor. A null next cursor ends pagination. There is no catalog revision or stable snapshot token across pages. Harness treats the cursor as opaque and rejects cycles, duplicate identifiers, malformed pages and limit exhaustion. These checks cannot detect every native catalog change between pages. [Pinned catalog processor, lines 243–293](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/catalog_processor.rs#L243)

Native listing uses `OnlineIfUncached`: Codex may serve its cache or retrieve catalog metadata over its own network connection. A successful retrieval can update `models_cache.json`; failures can leave an existing or bundled catalog in use. A fresh Harness request therefore means a new observation of the native catalog, not guaranteed fresh remote availability. [Pinned list implementation, lines 13–24](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/models.rs#L13), [pinned model manager, lines 338–435](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/src/manager.rs#L338)

The pinned manager filters presets by native authentication mode, but its cache loader explicitly leaves provider identity out of cache eligibility. Catalog entries must not establish provider identity, account membership, subscription entitlement, remaining quota, billing route, or disabled overage. Those require their own evidence. [Pinned auth filtering, lines 126–138](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/src/manager.rs#L126), [pinned cache eligibility, lines 478–514](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/src/manager.rs#L478)

App Server also starts a native background model refresh worker during construction; it requests an online refresh initially and then every four minutes and thirty seconds. Model listing is not an offline or side-effect-free filesystem operation. This is native catalog maintenance, separate from thread creation and inference. [Pinned worker construction, lines 368–370](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/message_processor.rs#L368), [pinned refresh worker](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/models_refresh_worker.rs)

## Integration requirements

- Check the exact pinned runtime binding and native subscription/configuration evidence before and after bounded pagination. A native account or configuration event invalidates an in-flight result.
- Publish only bounded dispatch IDs and display names, plus the explicitly supported universal descriptor fields. Do not expose native descriptions, URLs, cursor values, account data, or provider errors through the picker.
- Clear catalog state when runtime, executable, account home, or workspace changes. A failed refresh must not retain a previously ready catalog.
- Before creating a thread, observe the catalog again and require the requested dispatch ID to remain listed. Do not silently replace a removed model. Continue to apply existing admission and effective thread model/provider checks.
- Label the result as models reported by the native runtime. Catalog membership does not guarantee a future request succeeds or is included in a subscription. Native account/configuration checks remain observations, not an atomic lock against another client changing state.
- Claude remains status-only. This Codex catalog does not enable Claude execution or native Skills activation.

## Pinned source identity

The official GitHub connector returned these blob SHAs at `rust-v0.153.4`:

| Source                                                   | Git blob SHA                               |
| -------------------------------------------------------- | ------------------------------------------ |
| `app-server/src/models.rs`                               | `1063e64c339ab97d9717e5923a2c209e4899e038` |
| `app-server/src/request_processors/catalog_processor.rs` | `0b2178ea9280858e047a47d25db52a04424fde8b` |
| `models-manager/src/manager.rs`                          | `45835c37cd41d28c3a6c038a3e77a1369621562a` |
| `app-server/src/models_refresh_worker.rs`                | `e57abcc938fb78e173e839b626f2ff3a255d89f4` |
| `app-server/src/message_processor.rs`                    | `8e78c929e14b65fa7189d8597ed7a077c805003e` |

The older `codex_message_processor.rs` and `core/src/models_manager/manager.rs` paths returned 404. The evidence above uses the verified module locations instead. Source-level findings are not a live-account compatibility test.
