# CLI Differences

The source of truth for machine-readable CLI behavior is
`packages/core/src/index.ts`, exported as `agentCliManifests`.

This document explains why the manifest values differ.

## Login Semantics

### agy

`agy` does not expose a dedicated login command with the same semantics as
`codex login`. If its active credential slot is populated, launching `agy` can
reuse the current account instead of opening a fresh Google OAuth flow.

After shell integration, `agy login` is owned by the wrapper and runs `agyx
login`. It therefore:

1. backs up the current active credential into the active saved profile,
2. clears only the active credential slot,
3. launches `agy` to trigger OAuth,
4. captures the newly created active credential,
5. restores the previous active credential if login fails.

Saved profile credentials are not deleted.

### codex

`codex login` is a real login command, but plain Codex can clear the active
`auth.json` immediately after it starts. If the user cancels or the browser
flow does not produce a valid credential, Codex can be left logged out.

After shell integration, `codex login` is owned by the wrapper and runs the cdxx
protected login transaction. It therefore:

1. backs up the current active `auth.json`,
2. runs `codex login` in an isolated temporary `CODEX_HOME`,
3. validates that the temporary home produced a new credential,
4. copies the validated credential into the real active `auth.json`,
5. saves the new credential as a profile,
6. restores the previous active state if login fails or produces no
   valid credential.

Saved profile credentials are not deleted.

## Contract Rule

Every adapter must declare:

- whether the target CLI clears active credentials at login start,
- whether the wrapper must clear the active slot before login,
- whether login must run in an isolated temporary environment,
- whether previous active credentials must be restored on failure,
- which active credential locations are authoritative.

Contract tests read `agentCliManifests` so these differences remain explicit.

## Credential Refresh Lifecycle

There is no product policy difference here. Both adapters follow the core
`credentialLifecyclePolicy`: the active credential is mutable, is persisted to
its saved profile before replacement, and is persisted again after any
refresh-capable operation. An isolated probe must merge its credential changes
back before deleting its temporary home. Refresh-capable probes do not run
concurrently with live CLI sessions.

Google currently keeps the Agy refresh token stable while replacing its access
token. Codex can rotate the refresh token itself. Those are transport details;
the shared stricter lifecycle handles both without adapter policy branches.

## Quota Failover Semantics

The generic core policy uses the richer agyx behavior as its vocabulary:

- `off`: never switch automatically.
- `scope-first`: switch when the quota scope that triggered the event is
  exhausted.
- `all-scopes`: wait until every independently usable quota scope on the active
  profile is exhausted.
- `allow` / `block`: permit or reject profiles carrying an explicit
  `ineligible` state.

Core owns mode normalization targets, candidate filtering and ordering,
resetless quota expiry, usage-check reasons, and autoswitch action results.
Adapters own event parsing, product scope aliases, credential I/O, and the
mapping of product capabilities into `agentCliManifests`.

### agy

agy supports all three autoswitch modes and both eligibility modes. Its default
is `all-scopes` with eligibility `allow`. Candidates are rejected only when the
triggering quota scope blocks them; in `all-scopes` mode, immediately usable
profiles are preferred, followed by partially exhausted profiles ordered by
the earliest reset. The legacy names `all-providers` and `provider-first` are
accepted as aliases for `all-scopes` and `scope-first`.

agy quota observation remains launcher-scoped because its runtime writes a
supervisor-owned log per managed session. There is no shared global transcript
tree that can safely identify unmanaged agy quota events.

### codex

Codex supports `off` and `scope-first`; `on` remains an alias for
`scope-first`. Its 5-hour, weekly, and monthly windows are cumulative blockers,
not independently usable scopes. Consequently `all-scopes` cannot be
implemented safely: waiting for every window would leave a session stalled as
soon as any one window blocks requests. A candidate is therefore rejected when
any active Codex window is exhausted.

Codex auth and status data also provide no eligibility state separate from
credential validity. cdxx cannot offer `ineligible allow|block`; it continues
to reject invalid credentials through the shared candidate contract.

Codex additionally observes appended records under `$CODEX_HOME/sessions` so
SDK and other non-interactive clients that bypass the wrapper can still trigger
auth failover. Existing files are indexed at EOF, managed session identities
are excluded, and only appended bytes are parsed. Each turn records the active
profile at `task_started`; the auth-switch lock rechecks that observed profile
against the current profile before switching, suppressing stale concurrent
failures after another turn has already switched accounts.

The Codex global observer uses filesystem notifications only to reduce latency.
It reconciles recently active JSONL sizes plus the current and previous UTC
session date directories within the core delay bound, then reads only bytes after each
file's offset. A missing file notification, a missing directory watcher, and a
received notification that never reached the drain queue are recovered and
logged as distinct diagnoses. Start/stop records and periodic heartbeats expose
the supervisor PID, resolved sessions root, watcher/file counts, latest watch and scan activity,
reconciliation count, and recovery totals. `agentx-supervisor watcher-status`
returns the same live snapshot.

Both adapters enter usage probing through core `runUsageCheck`. The probes
remain product-specific transport: agyx drives `/usage`, while cdxx drives
`/status` and uses app-server or hook events for the live exhaustion trigger.
When the live trigger has no scope metadata, both adapters use the core
`unknown` exhausted scope immediately. A product background probe may later
replace it with authoritative scope and reset metadata.

## Profile Presentation

Core owns the base profile columns, width/alignment calculation, static table,
and interactive `list`/`use` picker. Both CLIs therefore render the same active
row, muted/blocked row, navigation, rename, delete, and help format. An adapter
may add product-specific columns by declaring them through the core column
model, but it must not implement a separate table or picker renderer.

Manual `use` is an explicit override in both products. Unavailable profiles
remain selectable in the shared picker and require the same negative-default
`Switch anyway?` confirmation before activation. Non-interactive callers use
`--force`. Automatic `next` and quota failover continue to exclude unavailable
profiles.

## Quota Switch Terminal Sequence

The shared auth-switch transaction pauses every managed session first. It then
sends each paused terminal exactly three CRLF pairs followed by
`Quota detected; switching profiles...`, performs the credential switch, and
finally resumes the sessions. CLI adapters implement only the terminal notice
transport for their native or JS supervisor.
