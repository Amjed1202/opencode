# Native model catalog independent review

Date: 2026-09-07. Reviewed against base `c4e146e` in `outputs/harness`.

## Scope

- `packages/harness-adapters/src/codex/adapter.ts` and new `models.ts`: runtime binding, native account/configuration observations, bounded parsing, safe projection, disposal and failure behavior.
- Desktop backend, main-process failure projection, shared state, renderer selection and related model tests: configuration invalidation, native catalog membership before creation, no automatic selection or fallback, and preservation of Claude status-only behavior.
- Official pinned `rust-v0.153.4` model implementation and local generated schema, documented in `docs/validation/m1c-models-native-evidence.md`.

## Findings

No production defect found in the completed scope. The corrected adapter tests independently pass; there is no outstanding review finding.

The model list is display metadata. It does not add model capabilities, billing or entitlement authority. Native `model` is retained as the dispatch string; hidden entries are omitted; malformed, duplicate or excessive results invalidate the entire observation. The adapter checks runtime identity before native reads and brackets pagination with fresh account/configuration observations, including native account/config event epochs. Disposed results cannot become usable.

Desktop configuration and runtime changes clear the catalog. The backend rejects arbitrary IDs before another catalog call, observes the catalog again before admission, and blocks creation if the selected model disappears or listing fails. The existing admission plus native thread model/provider verification remains in effect. Main-process worker failure also clears the catalog. Renderer selection requires an explicit listed choice and resets for lost entries or changed workspace, executable, account home or runtime; busy state disables starting during refresh. Claude execution remains independently blocked.

The parser bounds pagination to eight pages and 256 received entries, each page to its requested limit, cursor size to 4096 bytes, and public model projection to 128 KiB. Existing native transport bounds individual messages and per-request time. Existing desktop host timeout can terminate a prolonged operation without replay. These bounds do not claim an atomic native catalog snapshot; native cache/network behavior is separately documented.

## Independent checks

- Desktop backend suite: **25 passed, 0 failed, 135 assertions**, using spawned local fixture processes. No installed native provider runtime or user account was used.
- Final adapter model suite: **36 passed, 0 failed, 209 assertions**, independently rerun after the test matcher correction; 2.65 seconds. Cases include malformed/oversized entries, cursor cycles, duplicate dispatch IDs, total/page/byte limits, hidden/empty catalogs, changing account/configuration observations and events, runtime identity mismatches, disposal and timeout.
- The first adapter model suite run had **9 passed, 27 failed**. All failing cases passed an unresolved native-process promise directly into Bun 1.3.14's `.rejects.toThrow` matcher, then encountered the native request timeout. The adapter owner independently reproduced successful fast rejection and a subsequent `fixture/state` response outside the matcher. Replacing only the assertions with explicitly awaited promise rejection results resolved the failures; production code did not change for this fix.
- Read the renderer browser tests and Electron smoke changes. The root reports **12 browser tests passed** and has recorded a passing final built Electron validation; those counts were not independently rerun here.

## Limits

No real-account catalog request, native thread creation, login or inference was performed by this review. Native catalogs may come from bundled data or cache, may trigger native network/cache maintenance, and have no stable pagination snapshot. Membership remains advisory availability data; account, provider, policy and billing admission remain separate observations. Native account/configuration transitions between independent observations cannot be atomically locked by this implementation.
