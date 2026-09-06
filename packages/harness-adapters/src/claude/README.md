# Claude native adapter — not implemented

Preferred candidate: the user's unmodified Claude Code binary with its native subscription login, subject to the current official conditions in [ADAPTERS.md](../../../../ADAPTERS.md). Native sign-in choices must remain intact. Direct Agent SDK subscription login is a distinct approval-sensitive integration; API mode is explicit.

TODO before adding `adapter.ts`:

1. Select/pin a supported installed binary; record native `auth status` JSON and stream-json schemas without collecting credentials. Claude was not on PATH during reconnaissance.
2. Implement discovery/preflight, config/environment conflict detection and billing evidence. Subscription login does not establish disabled provider extra usage.
3. Implement documented programmatic text/tool/result streams and native session IDs, plus the documented permission-host interface. Do not assume private control messages or scrape terminal screens.
4. Verify deny/expiry, cancellation/process-tree cleanup, resume, partial/final deduplication and subagent-inclusive usage accounting on Windows.
5. Advertise only verified capabilities; leave subscription quota unknown until an official usable interface exists.

No fake responses, default API key, native token import or SDK dependency belongs in this folder at this stage.
