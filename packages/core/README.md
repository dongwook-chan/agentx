# @dong-/agentx-core

Shared policy code for `agyx` and `@dong-/cdxx`.

This package owns behavior that must not diverge between wrapper products.

Shared policy is defined here before product adapters implement it. In
particular, live quota exhaustion switches immediately, and usage/status
refreshes marked background-only must stay off the failover foreground path.
Autoswitch modes, eligibility capability, candidate filtering and ordering,
quota expiry, and action results are also core contracts; adapters only map
product events, scopes, credentials, and supported capabilities onto them.
Profile table/picker presentation and the post-pause quota-switch notice
sequence are shared core contracts as well. The manual-use contract keeps an
unavailable profile selectable behind a negative-default confirmation while
automatic selection still excludes it. Session ownership also follows rollout
parent lineage so adapter observers never attribute an unowned quota record to
the currently active profile.
Unmanaged transcript observation treats filesystem change notifications as
latency hints, never as the correctness boundary. Adapters must periodically
reconcile recently active file sizes and recent session directories within the
core delay bound. They must also emit bounded heartbeats and classify recovered
notification, directory-watch, or dirty-drain gap using the core diagnosis
registry.
Credential lifecycle is also shared: active credentials are mutable, are saved
before replacement and after refresh-capable operations, temporary probe
mutations merge back, and refresh-capable work is serialized against live CLI
sessions.
Live exhaustion without a CLI-specific scope is retained as exhausted in the
shared `unknown` scope until a background refresh supplies authoritative scope
and reset metadata.
The private contracts package enforces these architecture boundaries during
development and CI.
