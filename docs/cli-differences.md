# CLI Differences

The source of truth for machine-readable CLI behavior is
`packages/core/src/index.ts`, exported as `agentCliManifests`.

This document explains why the manifest values differ.

## Login Semantics

### agy

`agy` does not expose a dedicated `login` subcommand. If its active credential
slot is populated, launching `agy` can reuse the current account instead of
opening a fresh Google OAuth flow.

`agyx login` therefore:

1. backs up the current active credential into the active saved profile,
2. clears only the active credential slot,
3. launches `agy` to trigger OAuth,
4. captures the newly created active credential,
5. restores the previous active credential if login fails.

Saved profile credentials are not deleted.

### codex

`codex login` is a real login command, but it can clear the active
`auth.json` immediately after it starts. If the user cancels or the browser
flow does not produce a valid credential, Codex can be left logged out.

`cdxx login` therefore:

1. backs up the current active `auth.json`,
2. runs `codex login`,
3. validates that a new active credential exists,
4. saves the new credential as a profile,
5. restores the previous active `auth.json` if login fails or produces no
   valid credential.

Saved profile credentials are not deleted.

## Contract Rule

Every adapter must declare:

- whether the target CLI clears active credentials at login start,
- whether the wrapper must clear the active slot before login,
- whether previous active credentials must be restored on failure,
- which active credential locations are authoritative.

Contract tests read `agentCliManifests` so these differences remain explicit.
