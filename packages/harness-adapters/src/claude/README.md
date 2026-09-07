# Claude native adapter

`@harness/adapters/claude` exports the pinned Claude Code 2.1.251 / official Agent SDK 0.3.251 adapter. It uses an explicitly selected unmodified Windows binary and its existing native personal Pro/Max login. Presence of managed policy, unsupported billing/auth observations or missing SDK controls blocks execution. Native credential files are never read by Harness.

The execution path supports chat, streamed text, bounded repository text reads, protected Edit/Write review, standalone explicitly selected native Skills, per-turn token observations, and clean exact native resume. Provider overage remains unknown and requires explicit acknowledgment; API fallback is disabled. Shell, network tools, MCP, subagents, attachments, quota, cost estimates, OS sandbox attestation and uncertain native history inspection are unsupported.

The official SDK owns its protocol. Harness owns the selected process, no-prompt admission, host-bound Skill staging, exact input acknowledgment, the final permission write guard, and confirmed direct-process cleanup. Diagnostic-only construction without a workspace retains the historical version/login-status behavior and cannot execute.

See [V1 contract](../../../../V1_CLAUDE.md) and [official/local evidence](../../../../docs/validation/v1-claude-native-evidence.md). Native initialization and staged Skill discovery passed without sending a prompt; real task/permission/Skill/resume validation remains pending explicit provider-overage acknowledgment.
