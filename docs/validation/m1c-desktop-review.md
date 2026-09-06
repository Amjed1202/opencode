# Desktop and Claude Skills review

Reviewed 2026-09-06. Independent agents reviewed the main/preload/worker boundary, renderer, skill catalog and backend, with fixture regressions for concrete findings. Root reviewed the integrated code and validation outputs.

## Findings addressed

- Strict request decoding now bounds UTF-8 bytes, rejects accessors without evaluating them, and requires nonempty distinct question selections for answers.
- Host transport validates response shape before retiring its pending promise, rejects ambiguous result/error frames and malformed UTF-8, handles pipe errors and ignores late output after stopping. Failures reject pending operations and publish a disconnected/uncertain state without replay.
- The worker preserves its fatal UTF-8 decoder across input chunks and rejects truncated/oversized/malformed frames and invalid initialization. No renderer route can initialize the worker or provide its key/environment.
- Native pickers cannot race and overwrite each other's configuration. Exact sender/main-frame/URL checks run before privileged work and after asynchronous results; fixed IPC operations expose no arbitrary paths or native methods.
- Recovery uses canonical path-derived workspace identities, with Windows case normalization. Unsettled commands and uncertain sessions block fresh work; uncertain native creates without saved session identity conservatively block all workspaces in the application journal across restarts.
- Journal startup checks existing database and SQLite sidecars for observed links/hardlinks. Recovery failure closes the newly opened journal. Manager cleanup failure still reaches adapter disposal, preserving uncertainty rather than skipping shutdown.
- Serialized preview budgets cover both user and assistant messages, skill metadata and pending decisions. Display truncation is explicit and does not mutate native authority. Concurrent snapshot reads preserve newly streamed text and monotonically increasing published revisions. Authoritative completed responses replace partial text and appear when no deltas were received.
- Protected patch/question display treats content as text. Review expiry removes content and disables approval; opaque option IDs and host-bound review tokens stay separate from native labels. Native grants/answers still require the existing final write-time authorization checks.

## Evidence and limits

Full package tests, four typechecks, build, source-format/lint checks and real Electron startup are recorded in [results](m1c-desktop-results.json). Browser fixtures cover explicit admission controls, inert patch text, choice replies, expiry, stale state and responsive keyboard navigation. Electron verifies the actual custom origin, sandbox, absence of Node globals, fixed frozen bridge, CSP/asset restrictions, empty backend and OS-wrapped review-key reuse across restart.

No live provider thread, turn, login or account probe was used in this continuation. Native behavior tests use local protocol peers. The desktop is one-session development software: full history/recovery presentation, signed packaging, actual OS execution boundary attestation, cross-process fencing and provider billing acceptance remain open. Claude Skills discovery neither executes skills nor proves native activation compatibility. Same-OS-account compromise is outside these application-only protections.
