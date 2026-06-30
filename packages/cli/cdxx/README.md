# cdxx

`cdxx` is a small Codex CLI companion inspired by `agyx`.

It provides:

- local Codex auth profile save/use/next
- passive quota scanning from `$CODEX_HOME/sessions`
- optional shell integration so `codex` runs through `cdxx session`
- a Rust native supervisor for wrapped Codex TUI processes, with a Node supervisor fallback
- live autoswitch and `codex resume <session_id>` failover when a profile reaches quota

## Install locally

```bash
cd ~/codexx
npm link
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

`cdxx session` first tries to run the Rust native supervisor for the current
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

## Profile workflow

Save the currently active Codex login:

```bash
cdxx save
```

When the name is omitted, `cdxx` derives one from the active Codex account email
or account id. You can still provide an explicit name:

```bash
cdxx save personal
```

Add another profile:

```bash
cdxx login
```

Switch profiles:

```bash
cdxx list
cdxx use
cdxx use personal
cdxx next
cdxx current
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
cdxx scan
cdxx scan --json
cdxx scan --json --full
```

`cdxx` defaults to yolo mode for supervised Codex sessions. It injects Codex's
own dangerous flag, `--dangerously-bypass-approvals-and-sandbox`, unless you
already passed it yourself. Configure it with:

```bash
cdxx yolo
cdxx yolo on
cdxx yolo off
```

The `agy` flag `--dangerously-skip-permissions` is rejected when passed through
`cdxx`; it is not a Codex option.

Run Codex through the wrapper:

```bash
cdxx session -- "inspect this repo"
```

After a wrapped session exits, `cdxx` scans new or modified Codex transcripts
and records rate-limit status on the active profile. Enable live profile
failover:

```bash
cdxx autoswitch on
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
