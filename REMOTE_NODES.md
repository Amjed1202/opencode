# Remote nodes

Status: proposed design, 2026-09-06. Harness is a provisional codename. This stage defines remote-node contracts only; it starts no daemon, opens no port, and performs no pairing or SSH operation.

## Placement and authentication

`harness-node` will host control-plane services, native adapters, persistence, workspace tools, and credentials on the execution machine. The desktop accesses the same universal contracts through a remote transport adapter. Remote is placement and transport: Claude Code on Madar remains a Claude native runtime, not a generic remote model. Node IDs, application session IDs, and native session IDs remain distinct.

Prefer Tailscale connectivity plus application authentication and authorization. Network admission does not authorize repository reads, command execution, approvals, or artifact downloads. Tailscale documents separate network grants and application capabilities; the application interprets capability parameters. [Tailscale grants](https://tailscale.com/docs/reference/syntax/grants)

The proposed default is pinned node identity and mutually authenticated TLS inside the private network. Pair deliberately using a verified fingerprint and short-lived single-use bootstrap credential delivered through a trusted local/SSH channel. Store client credentials securely, scope grants by node/workspace/action, and support revocation and rotation. Mere tailnet membership or a machine label grants no access.

Bind to a private interface or loopback behind a configured authenticated proxy. Do not expose an unauthenticated public control port. If Tailscale Serve identity headers are adopted, accept them only through the trusted proxy path and prevent direct listener bypass. Tailscale can expose application capabilities through Serve, LocalAPI, or `tsnet`; choosing one remains implementation work. [Tailscale application capabilities](https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities)

Each node owns its native authentication. A user completes the official Claude/Codex login on that host where supported. The desktop receives sanitized authentication/billing evidence and freshness, never credentials. A remote subscription badge must satisfy the same evidence requirements as a local session. No unavailable subscription route becomes a paid API session silently.

## Negotiation and workspace ownership

Handshake checks protocol versions, node identity, server epoch, runtime inventory/version, OS/architecture, supported enforcement, artifact limits, and event retention. Unsupported mandatory features fail negotiation. Desktop policy and node policy intersect; the node remains the execution authority.

The node assigns opaque workspace IDs after validating allowed remote paths. Local paths are never interpreted as remote paths implicitly. One fenced control lease owns an active session/workspace writer; additional clients may observe. Independent writers require isolated workspaces. Restart invalidates stale ownership epochs. Revocation prevents new commands and follows an explicit policy for already running work.

## Commands, replay, and disconnects

Events have unique identity, node/session/stream epoch, monotonic stream sequence, occurrence/ingestion timestamps, and causal command/turn identifiers. There is no wall-clock-derived total order across nodes. Cursors are scoped to streams; expired history returns a gap plus an authenticated snapshot.

Replay is at-least-once with deduplicated projections. Replayed events never dispatch commands or approve tools. Commands have stable idempotency keys and body digests; the node journals admission/results and rejects conflicting reuse. Native resume, event replay, and rerunning a task are different operations.

Exactly-once shell/provider effects cannot be guaranteed across a crash between execution and result persistence. Represent `outcome-unknown`, reconcile native state where available, and obtain a deliberate retry decision for non-idempotent work. Do not recreate a native session merely because transport disconnected.

The node owns execution after submission. Disconnect is neither cancellation nor completion. A session's explicit policy may allow already approved bounded work to continue; new approvals, expired leases, and budget uncertainty pause it. Interrupt acknowledgement is separate from confirmed interruption. Forced process-tree termination follows policy and records possible incomplete cleanup.

Bound queues and apply backpressure. Large output becomes an authorized artifact with truncation metadata. Never silently discard approvals, terminal outcomes, or accounting reconciliation. SSH is bootstrap/recovery, not terminal scraping or the steady-state protocol.

## Implementation gates

After local native adapters work, verify Madar's actual OS/runtime/auth support, private binding, pairing/revocation, filesystem restrictions, billing evidence, duplicate commands, lost acknowledgements, crash recovery, cursor gaps, conflicting clients, and remote approval expiry. The initial types express these requirements; they do not prove them. See [SECURITY.md](SECURITY.md) and [PROTOCOL.md](PROTOCOL.md).
