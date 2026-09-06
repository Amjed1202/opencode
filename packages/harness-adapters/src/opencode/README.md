# OpenCode adapter — not implemented

Wrap the pinned native OpenCode server using the established legacy SDK surface initially. This is an independent runtime, including when OpenCode itself selects an Anthropic/OpenAI model. It is not native Claude Code or Codex. See [ADAPTERS.md](../../../../ADAPTERS.md) and [UPSTREAM_STRATEGY.md](../../../../UPSTREAM_STRATEGY.md).

TODO before adding `adapter.ts`:

1. Establish isolated XDG/test/config/state/cache/database roots before any native import/start.
2. Pin SDK/server versions and use one coherent session generation. Current `/api` session operations lack some legacy functionality; capability-probe rather than mix native sessions.
3. Map session/message/part deltas, tool lifecycle, SSE, permissions, resume, diffs and reported usage; retain protected native metadata and disclose unavailable replay.
4. Reuse native MCP/PTY/Git and permission implementations through the adapter or separately authorized workspace ports.
5. Test API/provider/auth selection explicitly, including upstream plugin configuration. Never present OpenCode's OAuth provider implementation as native Codex authentication.

The scaffold imports no upstream Core/SDK and executes no migration.
