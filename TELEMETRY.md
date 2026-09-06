# Telemetry and usage

Status: proposed design, 2026-09-06. Harness is a provisional codename. This stage defines measurement contracts only; it collects no runtime usage and implements no dashboard, storage, pricing service, or budget enforcement.

## Meaning and presentation

Store telemetry locally. Keep four categories distinct:

1. Activity observed inside Harness: turns, commands, durations, tool calls, and file changes.
2. Native/provider-reported usage and limits, preserving their actual account/session/window scope.
3. Estimated monetary cost for explicitly selected API execution, with pricing source/version and currency.
4. Subscription quota/allowance only where exposed; otherwise unavailable.

Subscription sessions primarily show runtime/billing evidence, model, tokens/context where known, durations, tools, and exposed limits. Optional API-equivalent value is hypothetical, never an invoice, saving, remaining quota, or actual charge. Subscription authentication does not establish that provider-side overage is disabled. Claude usage credits may produce extra charges independently of our fallback policy. [Claude usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

Authentication/billing badges use independent safe evidence, with source and freshness. Unknown plan/billing/usage remains unknown; unavailable metrics are not zero. No reliable machine-readable Claude remaining-subscription endpoint was established in this reconnaissance. Do not scrape browser state or infer account allowance from locally observed tokens.

Codex App Server exposes account rate-limit observations; preserve account/window and multi-bucket scope rather than attributing all consumption to this application. Reading usage must not consume reset credits, buy credits, trigger upgrades, or mutate accounts. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## Measurement and aggregation

An observation identifies metric/unit, provider/model/runtime, execution target, session/turn/request/attempt, parent/role where known, source event, measurement scope, delta versus cumulative basis, reset epoch/window, timestamps, freshness, completeness, and observed/provider-reported/estimated/unknown provenance.

Deduplicate before aggregation. Delta measurements add once per identity. Cumulative snapshots replace earlier values or contribute a validated difference within the same scope/reset epoch; never add every snapshot. Missing native IDs require a documented identity strategy and uncertainty, not text hashing that collapses legitimate identical events. Corrections, resets, and model/context changes must be represented explicitly.

Inclusive parent totals and subagent totals cannot both be summed. Attribute each underlying request once, and expose partial role attribution where necessary. Claude SDK result `usage` excludes subagents while `modelUsage` includes them; streaming-input totals can be cumulative. Its cost field is an estimate, not proof of a charge. [Claude SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

Preserve provider-specific token semantics. Cache reads/writes and reasoning may be subsets or differently priced categories; do not add them blindly to input/output totals. Native Codex `total` and `last` usage require distinct mapping. Failed/retried/cancelled requests can still incur usage; request-attempt identity separates logical turns from accounting. Late final measurements reconcile prior estimates.

Context is a runtime-scoped gauge with declared capacity semantics, not cumulative tokens divided by an assumed model window. Compaction changes context state without erasing consumed tokens. Account quota is not additive across sessions, nodes, roles, or applications.

Preserve original currencies; conversion needs an explicit rate source/date. Subscription fees are user/provider facts, not inferred marginal session costs. Aggregate by session, project, provider, model, day/week/month, and collaboration role only where attribution exists. Store UTC plus the reporting time zone; use monotonic clocks for local durations. Cross-host wall clocks do not establish execution duration.

Define TTFT as submission to first visible assistant text at the control plane, with queue/native/transport timing separate when exposed. Count tool executions rather than output events. Define file-change counts by path and reporting scope, accounting for renames/reverts.

## Persistence, privacy, and limits

Own Harness observations and projections separately from upstream session tables; native session IDs are references. Reuse storage/migration patterns through an interface without importing Core into protocol/UI or dual-writing universal sessions into native schemas.

Separate numeric telemetry, user content, and sensitive native diagnostics. Redact before persistence/export. Retain optional raw payloads only under explicit policy, using protected filesystem artifacts for large data; authentication exchanges never enter ordinary logs. Retention/deletion covers artifacts and derived indexes too. Product analytics export would require a separate opt-in minimized schema.

Hard budgets require usable measurements and enforcement. Unknown-budget policy defaults to pause; explicit advisory mode cannot claim a hard cap. Future validation covers replay/reordering, cumulative resets, child-inclusive totals, cache overlap, missing metrics, retries, late corrections, stale quota, secret redaction, and time-zone/currency aggregation.
