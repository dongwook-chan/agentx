# cdxx

`cdxx` is a Codex CLI companion for keeping the prompt experience moving after
quota exhaustion.

The goal is to remove the manual account-switching loop: when one Codex profile
runs out of quota, `cdxx` can activate another eligible saved profile and resume
the same Codex conversation, so development continues without logging out,
logging in, or rebuilding prompt context by hand.

It provides:

- local Codex auth profile save/use/next
- passive quota scanning from `$CODEX_HOME/sessions`
- shell integration so `codex` runs through the cdxx dispatcher
- a Rust native supervisor for wrapped Codex TUI processes, with a Node supervisor fallback
- live autoswitch and `codex resume <session_id>` failover when a profile reaches quota

## Install locally

```bash
npm install -g @dong-/cdxx
cdxx install
source ~/.zshrc
```

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
run through the Rust native supervisor for the current
host. If the matching native binary is not present, it falls back to the Node
supervisor with the same behavior. Set `CDXX_REQUIRE_NATIVE_SUPERVISOR=1` to
fail instead of falling back.

Native supervisor target status:

| host | Rust source/build support | shipped by this package |
| --- | --- | --- |
| `darwin/arm64` | yes | yes |
| `linux/arm64` | yes | yes |

The package install policy is `darwin/arm64` and `linux/arm64`. Other hosts can
run only from source with the Node supervisor fallback.

Native and Node supervisors are expected to agree on observable behavior:
non-interactive Codex commands are passed through directly, interactive TUI
sessions are monitored for quota events, and autoswitch resumes the same Codex
session with `codex resume <session_id>`.

The native supervisor intentionally does not decide account policy itself. When
it sees a quota event, it calls the JS policy helper (`cdxx
_supervisor-failover`) and receives an action JSON payload such as
`switch_and_resume` or `stop_retrying`. The helper owns profile selection,
autoswitch-off handling, no-selectable-profile handling, and user-facing
messages; the supervisor only prints the helper message and performs the
requested process action. This keeps native and Node supervisor behavior aligned.

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
codex x config autoswitch on
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
codex x next
```

`cdxx` stores profile credentials under `~/.config/cdxx/profiles/<name>/auth.json`
with owner-only permissions. The active Codex credential remains
`$CODEX_HOME/auth.json`, normally `~/.codex/auth.json`.

## Quota workflow

Codex records two quota windows in session JSONL as `primary` and `secondary`.
`cdxx` displays them as `5h` and `weekly`: `primary` is the 5-hour window
(`300` minutes), and `secondary` is the weekly window (`10080` minutes).

Scan local Codex session transcripts:

```bash
codex x scan
codex x scan --json
codex x scan --json --full
```

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

After a wrapped session exits, `cdxx` scans new or modified Codex transcripts
and records rate-limit status on the active profile. Enable live profile
failover:

```bash
codex x config autoswitch on
```

With autoswitch enabled, the Rust supervisor tails the matched Codex transcript
by byte offset. If Codex reports an exhausted rate limit, `cdxx` switches to the
next available saved profile and the supervisor starts
`codex resume <session_id>` from the same working directory.

The Node fallback follows the same pass-through and failover rules as the native
supervisor. Non-interactive commands such as `codex exec`, `codex review`,
`codex login`, and `codex doctor` are not supervised.

If every saved profile is disabled, exhausted, or otherwise not selectable,
`cdxx` prints a stop message and suppresses further failover attempts for that
quota event.

## Session matching

Codex does not expose an `agy --log-file` style TUI transcript path option.
`cdxx` matches the child session from Codex's real transcript files instead:

1. Snapshot `$CODEX_HOME/sessions/**/*.jsonl` immediately before launching Codex.
2. Poll new or modified JSONL files while Codex runs.
3. Read only the first `session_meta` record and match:
   `payload.cwd == process.cwd()`, `payload.originator == "codex-tui"`, and
   `payload.timestamp >= launchTime - 5s`.
4. Tail the matched JSONL file from the pre-launch file size, so runtime quota
   checks depend only on newly appended log bytes.

The matched `payload.session_id`/`payload.id` is suitable for `codex resume`.

## Notes

- `cdxx` reads Codex JSONL transcripts but does not print prompts or responses.
- A profile is treated as exhausted when Codex reports 5-hour
  `primary.used_percent >= 100`, weekly `secondary.used_percent >= 100`, or a
  non-null `rate_limit_reached_type`.
- Reset times are derived from the `resets_at` epoch fields stored by Codex.
