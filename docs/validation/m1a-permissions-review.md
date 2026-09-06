# Permission and history continuation review

Four independent review findings were reproduced and fixed before delivery:

| Finding | Final behavior | Verification |
| --- | --- | --- |
| Host revocation or lease release could race asynchronous native approval checks. | A private synchronous host guard checks revocation, runtime identity, current lease, evidence/consent freshness and expiry immediately before the stdio write. The native adapter also checks its own account/operation epochs. Callback fields never enter the JSON-RPC response. | Host regressions, an independent delayed-grant probe and actual stdio microtask-revocation tests. |
| Rewriting a duplicate denial timestamp conflicted with event deduplication. | Repeated terminal negative outcomes validate their full binding and preserve the first durable host audit; identical request replays validate request and command identity. | Host replay regression plus an independent probe advancing the clock by 1 ms. |
| A file notification without its official turn ID could seed or cancel approval evidence. | File evidence changes require the explicit native turnId field to match the active owned turn. Nested turn objects and malformed/missing IDs cannot substitute. | Spawned-peer cases for omitted, null, array and numeric IDs, including cancellation attempts. |
| Coercing a file operation tag to a string admitted malformed arrays. | File operation tags and terminal turn status require exact strings from the supported native enum. | Decoder and spawned-peer regressions. |

The independent host reviewer reran two separate probes: **2 pass, 0 fail**, with zero native grant writes after revocation and no detachment on identical denial replay. The independent native reviewer rechecked the corrected cache guard, enum decoder and wire callback. No remaining actionable findings were reported in those reviewed paths.

The permission journal was separately tested with killed SQLite writers at pending, claimed and resolved windows, and competing child processes. An original claim retains host actor/time and intent; a flushed reply or autonomous terminal denial is recorded separately. Exact retries never send again. Native denials/expiry override a grant intent without erasing it.

Review does not establish OS isolation, eliminate cross-process filesystem races, certify provider billing, or prove a file edit completed after its approval response was flushed. Live provider tasks, protected patch presentation, full transcript hydration and cross-process ownership remain acceptance work. All subprocess validation here used local Bun protocol peers, not installed Codex or real accounts.

Final root review also found that restart expiry updated the permission ledger without adding a replay event. Recovery now appends the expired resolution and updates its ledger in the same SQLite transaction, retaining the original request stream and command scope. Claimed outcomes remain uncertain without a fabricated resolution. Regression coverage verifies restart replay, repeated recovery, crash durability and rollback if event append fails.

A final documentation review aligned the milestone next steps, partial-history running state, exact journal version gate, unsupported queue delivery and preflight/thread-validation distinctions with the implementation.
