# Codex App Server adapter — not implemented

Use official App Server with private stdio and Codex-managed ChatGPT authentication. API-key mode requires an explicit different selection. See [ADAPTERS.md](../../../../ADAPTERS.md).

TODO before adding `adapter.ts`:

1. Select a supported executable/version and generate its official wire types privately inside this adapter. Research inspected Codex 0.153.4; that is not a compatibility certification.
2. Implement initialize/account reads and native browser/device login without reading/copying auth files or taking externally supplied subscription tokens.
3. Verify effective account/provider/configuration before each admission; test API environment/profile conflicts without mutating global login.
4. Map thread/turn/item events, native approval request IDs, human-input requests, interrupts and resume into the common interface.
5. Test uncertain dispatch, stream replay, last-versus-total usage and account-scoped rate-limit buckets. Quota reads must never spend reset credits.

No App Server is started by this package.
