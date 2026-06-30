# agentx

Monorepo for shared agent CLI wrapper infrastructure.

The goal is to remove the developer tax of switching accounts after quota
exhaustion. `agyx` and `cdxx` keep multiple authenticated profiles ready, detect
quota exhaustion, and move the active prompt session to an eligible profile so
development can continue without manually logging out, logging in, copying
context, or restarting the conversation.

Published CLI packages:

- `agyx`
- `@dong-/cdxx`

`agentx`, the future umbrella router across multiple agent CLIs, is intentionally
not implemented yet. This repository first centralizes shared policy and
contract tests so existing CLIs cannot drift.

Product-specific README files live with each published package:

- `packages/cli/agyx/README.md`
- `packages/cli/cdxx/README.md`

Cross-CLI behavior differences that must stay explicit are documented in
`docs/cli-differences.md` and recorded as machine-readable contracts in
`packages/core/src/index.ts`.

## Workspaces

```text
packages/
  core/
  contracts/
  cli/
    agyx/
    cdxx/
```

## Checks

```bash
npm install
npm run build
npm run check
npm test
npm run check:native-package
```
