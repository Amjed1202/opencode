# Protected review and input boundary review

Reviewed the continuation from `f3308fb365718274e7535c21b309854ace9cf0a2` with independent agents covering the host/journal, encrypted storage/workspace boundary, and native adapter/transport. Tests use local fixtures, not provider inference.

## Findings corrected

1. **Private storage could overlap an unrelated workspace.** Checking only the active session's workspace left artifacts exposed to deletion or corruption from another registered workspace. The manager now reserves the canonical private root through the workspace registry. Reservations reject all current overlaps and future equal/parent/child registrations, including registration already awaiting filesystem checks. The reservation lasts for the registry's lifetime; startup must reserve storage before admitting workspaces.
2. **Review expiry was checked only before claiming a response.** A longer-lived generic request could reach the native write after its shorter review token expired. Separate permission and input regressions failed before the fix. Both final synchronous reply callbacks now check the captured review expiry as well as request expiry and current admission authority. A delayed reply becomes uncertain and cannot be replayed.
3. **Evicted SQLite statements could retain database handles.** The pinned Bun 1.3.14 reproduction closed 20 cached queries but failed strict close with 21 or more. SQLite can defer closure while statements remain unfinalized. The journal now owns a cache of its static prepared SQL statements and explicitly finalizes every statement before strict close, including incompatible-journal rejection. The previously recurring interaction-expiry cleanup case then passed five consecutive runs; no retry limit or cleanup-error suppression was added. [SQLite connection lifetime](https://www.sqlite.org/c3ref/close.html).

## Evidence and limits

- Encrypted storage checks cover wrong keys, modified ciphertext, metadata/session mismatches, bounded actor grants, database/sidecar links, restart invalidation of grants, and durable encrypted commits after a killed writer. A Windows-incompatible open-directory rename test is explicitly skipped; other replacement and link checks run.
- Protected-content validation rejects unknown fields, getters, serialization hooks, sparse arrays, mismatched operation or request IDs, changed patch resource sets, and question/option identity or order changes. Returned content is detached from stored authority.
- Host regressions cover missing/cross-interaction/expired review tokens, account revocation during content read and audit append, forged native host-authority events, cancellation, original audit preservation, and exact retry without native resend.
- Native review adds seven adversarial cases for numeric versus string callback IDs, wrong-thread cleanup, retirement after the adapter removes its handle, and account/configuration/terminal/expiry changes before transport write. The final transport callback executes immediately before serialization/write. Delivery means a reply was flushed, not that a file operation or provider turn completed.

Final suite counts, lint diagnostics and command logs are in [VALIDATION.md](../../VALIDATION.md). Review does not establish OS sandbox enforcement, resistance to a hostile same-privilege process, physical secure erasure, OS vault provisioning, cross-process host ownership, aggregate artifact retention limits, authenticated renderer transport or live subscription billing behavior.
