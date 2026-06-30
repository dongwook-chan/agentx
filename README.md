# agentx

Monorepo for shared agent CLI wrapper infrastructure.

Published CLI packages:

- `agyx`
- `@dong-/cdxx`

`agentx`, the future umbrella router across multiple agent CLIs, is intentionally
not implemented yet. This repository first centralizes shared policy and
contract tests so existing CLIs cannot drift.

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
