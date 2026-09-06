# Remote transport adapter — not implemented

Remote is an execution target, not a model or billing mode. The future proxy forwards the universal protocol to an authenticated `harness-node`; the node runs the native adapter with its local authentication. See [REMOTE_NODES.md](../../../../REMOTE_NODES.md).

TODO: implement pairing and pinned identity, mTLS/private-network transport, workspace grants, version/resource negotiation, replay cursors/gaps, fenced writer leases and uncertain-command reconciliation. Keep provider credentials on the execution machine. Reject stale approvals and never replay a coding command merely because an acknowledgement was lost.

No listener, daemon, SSH command or connection is implemented.
