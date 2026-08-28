# cdxx

`cdxx` is a Codex CLI companion for keeping the prompt experience moving after
quota exhaustion.

The goal is to remove the manual account-switching loop: when one Codex profile
runs out of quota, `cdxx` can activate another eligible saved profile and resume
the same Codex conversation, so development continues without logging out,
logging in, or rebuilding prompt context by hand.

It provides:

- local Codex auth profile save/use/next
- quota refresh from Codex `/status`, with app-server events as the live trigger
- shell integration so `codex` runs through the cdxx dispatcher
- a Rust native supervisor for wrapped Codex TUI processes
- live autoswitch and `codex resume <session_id>` failover when a profile reaches quota

## Install locally

```bash
npm install -g @dong-/cdxx
cdxx install
source ~/.zshrc
```

Installation capability-detects the installed Codex CLI. When `--remote` and a
listen-capable `codex app-server` are available, `cdxx` uses a persistent local
app-server and a thin per-session proxy. If that transport is unavailable,
installation asks before adding lifecycle hooks to `~/.codex/hooks.json`. If
hook installation is declined, only the agentx Codex integration is disabled;
the regular Codex CLI remains usable.

For the current terminal only:

```bash
eval "$(cdxx shell-init)"
```

Build the native supervisor locally:

```bash
npm run build:native
```

## Native supervisor support

`codex` first enters the cdxx dispatcher. Normal interactive Codex sessions then
run through the Rust native supervisor for the current host. If the matching
native binary is not present, `cdxx session` fails and reports the missing
binary.

Native supervisor target status:

| host | Rust source/build support | shipped by this package |
| --- | --- | --- |
| `darwin/arm64` | yes | yes |
| `linux/arm64` | yes | yes |

The package install policy is `darwin/arm64` and `linux/arm64`. Other hosts can
run only from source after adding a native supervisor target.

The native supervisor intentionally does not decide account policy itself. When
it sees a quota event, it calls the JS policy helper (`cdxx
_supervisor-failover`) and receives an action JSON payload such as
`switch_and_resume` or `stop_retrying`. The helper owns profile selection,
autoswitch-off handling, no-selectable-profile handling, and user-facing
messages; the supervisor only prints the helper message and performs the
requested process action.

## Command model

After `cdxx install`, use the normal Codex command. Wrapper commands live under
the `x` namespace, except `codex login`, which is intentionally protected
because plain Codex can clear active auth before login succeeds.

```bash
codex                      # supervised Codex TUI
codex "inspect this repo"  # supervised prompt
codex login                # protected login, auto-save, activate
codex x list
codex x use
codex x use personal
codex x next
codex x status
codex x config
codex x config autoswitch scope-first
codex x config yolo off
codex x remove personal
codex --native --help      # bypass cdxx and run real Codex
```

`cdxx` remains installed as the backend command for setup, shell integration,
and compatibility. Existing `cdxx login`, `cdxx use`, and `cdxx list` commands
still work, but the intended daily interface is `codex`.

## Profile workflow

Add another profile:

```bash
codex login
```

Codex has an annoying edge case: starting `codex login` can immediately clear
or invalidate the current active login before the browser flow succeeds. If you
cancel at that point, plain Codex can be left logged out.

The cdxx dispatcher avoids that by running Codex login in an isolated temporary
`CODEX_HOME`. The real active Codex home is not touched while login is in
progress. Only after the temporary login produces a valid Codex `auth.json` does
`cdxx` copy that credential into the real active slot and save it as a profile.
If login is cancelled or fails, the previous active profile stays active.

Import an already-active Codex login only for recovery or migration:

```bash
codex x import-current
codex x import-current personal
```

Switch profiles:

```bash
codex x list
codex x use
codex x use personal
codex x use personal --force
codex x next
```

Unavailable profiles remain selectable for an explicit `use`; cdxx asks for
confirmation before switching. Use `--force` for the same override in a
non-interactive shell. `next` and automatic quota failover still skip them.

`cdxx` stores profile credentials under `~/.config/cdxx/profiles/<name>/auth.json`
with owner-only permissions. The active Codex credential remains
`$CODEX_HOME/auth.json`, normally `~/.codex/auth.json`.

## Quota workflow

Codex records two quota windows in session JSONL as `primary` and `secondary`.
`cdxx` displays them as `5h` and `weekly`: `primary` is the 5-hour window
(`300` minutes), and `secondary` is the weekly window (`10080` minutes).

Manual scan uses Codex's interactive `/status` view:

```bash
codex x scan
codex x scan --json
codex x scan --all
codex x scan --no-record
codex x scan --json --full
```

By default, `scan` records the active profile's 5-hour and weekly quota windows
and reset times from the current `/status` result. Use `--no-record` only when
you want a dry run. Use `--all` to run isolated `/status` probes for every saved
profile and record their reset windows without replacing the active auth file.
Scans pause live sessions and merge any rotated `auth.json` from the isolated
probe back into that profile before removing its temporary home.
`--jsonl` remains available as an explicit diagnostic command for local
transcript scanning. Codex `/status` can briefly lag right after a fresh TUI
starts or a quota event, so remote sessions use app-server rate-limit and turn
failure notifications as the live trigger; `/status` remains the preferred
refresh source for current windows and `resetAt` when it is available.

`cdxx` defaults to yolo mode for supervised Codex sessions. It injects Codex's
own dangerous flag, `--dangerously-bypass-approvals-and-sandbox`, unless you
already passed it yourself. Configure it with:

```bash
codex x config
codex x config yolo on
codex x config yolo off
```

The `agy` flag `--dangerously-skip-permissions` is rejected when passed through
`cdxx`; it is not a Codex option.

Enable live profile failover:

```bash
codex x config autoswitch scope-first
```

`on` remains accepted as a compatibility alias for `scope-first`. Codex quota
windows are cumulative blockers, so `all-scopes` is intentionally unsupported:
waiting for every window would stall after the first exhausted window. Codex
also exposes no eligibility state separate from credential validity, so the
agyx `ineligible allow|block` option is not available in cdxx.

With autoswitch enabled, the supervisor observes app-server events (or the
approved hook transcript in compatibility mode). If Codex reports an exhausted
rate limit, `cdxx` switches to the next available saved profile and starts
`codex resume <session_id>` from the same working directory.

A definitive live quota event starts failover immediately. If the event does
not include reset metadata, `cdxx` refreshes that exhausted profile with
`/status` in a detached background process; the probe never blocks profile
selection, credential replacement, or session restart.

Non-interactive commands such as `codex exec` and SDK-launched turns are not
process-supervised or automatically restarted. The singleton supervisor does,
however, observe appended quota records across `$CODEX_HOME/sessions`, so an
unmanaged turn can still trigger auth failover for later turns. Existing JSONL
content is never replayed at startup.
Subagent rollouts inherit their parent rollout's profile ownership. A quota
record whose owner cannot be established is left unattributed instead of being
charged to whichever profile is currently active.

If every saved profile is disabled, exhausted, or otherwise not selectable,
`cdxx` prints a stop message and suppresses further failover attempts for that
quota event.

## Session identity

For supported Codex versions, the TUI connects through a Unix-socket proxy to a
persistent Codex app-server. The proxy forwards traffic unchanged and records
`result.thread.sessionId` from the TUI's own `thread/start`, `thread/resume`, or
`thread/fork` response. It does not create an extra thread, issue an extra
resume, or scan `$CODEX_HOME/sessions`.

The shared agentx launcher only exposes an optional transport-adapter lifecycle.
The Codex JSON-RPC adapter owns the proxy behavior, while `agyx` keeps its
existing single-log-path adapter and conversation-ID parser.

## Notes

- Remote-mode session identity and control do not depend on Codex JSONL.
  Separately, the singleton global quota observer tails only appended JSONL
  bytes and excludes transcripts already owned by a managed session.
- A profile is treated as exhausted when Codex reports 5-hour
  `primary.used_percent >= 100`, weekly `secondary.used_percent >= 100`, or a
  non-null `rate_limit_reached_type`.
- Reset times are derived from the `resets_at` epoch fields stored by Codex.
