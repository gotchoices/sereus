---
description: Review the `--cluster-size <N>` CLI threading in `optimystic` `reference-peer` plus the web e2e fixture wiring it to `--cluster-size 3`. The fix-stage agent did the work end-to-end; the implement-stage agent re-validated (clean build + reference-peer test suite + help spot-check + bad-input rejection). All four checks green.
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/reference-peer/README.md, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/optimystic.ts
---

## What landed

### Optimystic — `reference-peer` CLI (uncommitted in `../optimystic`)

`../optimystic/packages/reference-peer/src/cli.ts`:

- New private `parseClusterSize(options)` helper on `PeerSession`
  (mirrors `parseStorageCapacity`). Uses `parseInt(..., 10)` and
  rejects anything that isn't a finite integer `> 0` with
  `Error('--cluster-size must be a positive integer')`. Returns
  `undefined` when the flag is absent so the existing
  `libp2p-node-base.ts` `?? 10` default keeps applying.
- `startNetwork()` accepts `clusterSize?: string`, parses it, logs
  `'👥 Cluster size override set to N'` (console) +
  `'cluster size override set'` (`logDebug`) when set, and forwards
  the parsed integer to `createLibp2pNode({ clusterSize, ... })`.
  Cluster size is also threaded into the existing
  `'starting libp2p node'` debug payload.
- `--cluster-size <number>` added to the `interactive`, `service`,
  and `run` commands with help text
  `'Desired cluster size per key (positive integer)'`.

`../optimystic/packages/reference-peer/README.md`:

- Adds `--cluster-size <number>` under "Interactive Mode" options,
  noting the default-10 fallback, that browser peers built with
  `clusterSize: 3` need service peers started with `--cluster-size 3`,
  and that all three subcommands accept it.

### Sereus — web e2e fixture + README (committed in `dc09583`)

`packages/reference-app-web/e2e/fixtures/reference-peer.ts`:

- Both the bootstrap (`interactive --offline`) and the two service
  peers (`service`) now pass `--cluster-size 3` alongside
  `--network sereus-web-reference`, matching the browser's
  `clusterSize: 3` in `packages/reference-app-web/src/lib/optimystic.ts`.

`packages/reference-app-web/README.md`:

- Local-bootstrap recipe, Tier 2 fixture description, and the
  "reproduce e2e locally" hint all now include `--cluster-size 3` so
  a human following the README sequence agrees with the browser too.

## Validation (implement-stage re-run)

All four TODO checks from the implement-stage ticket passed:

- **Clean build.** `rm -rf ../optimystic/packages/reference-peer/dist`
  then `yarn workspace @optimystic/reference-peer build` → exit 0,
  `dist/src/cli.js` regenerated.
- **Test suite.** `yarn workspace @optimystic/reference-peer test`
  → `4 passing (15s)`. The existing `test/distributed-diary.spec.ts`
  3-node mesh suite is unaffected because it doesn't pass
  `--cluster-size`, so the default-10 path is exercised exactly as
  before.
- **`--help` spot-check.** `node dist/src/cli.js {interactive,service,run} --help | grep cluster`
  each emits `--cluster-size <number>     Desired cluster size per key (positive integer)`.
- **Bad-input rejection.** Both `--cluster-size 0` and
  `--cluster-size abc` against
  `service --ws-port 19099 --no-tcp --offline` exit with
  `❌ Error: --cluster-size must be a positive integer` (also
  reflected in the stack trace from `parseClusterSize`).

## Acceptance check

The source-ticket acceptance bar was: "`reference-peer` started with
`--cluster-size 3` reports the same `clusterSize` as the browser,
visible via FRET / cluster panels on `#/diag` or via a `logDebug` line
at start-up". Satisfied by the
`'👥 Cluster size override set to N'` console line +
`'cluster size override set'` `logDebug` payload, plus the
`clusterSize` field newly added to the `'starting libp2p node'`
debug record.

## Known gaps / things for the reviewer to weigh

- **Web e2e Tier 2 suite was not run from this ticket.** The fixture
  change is mechanical (two `--cluster-size 3` pairs appended to
  string arrays) and the follow-up `web-e2e-tier2-cluster-supermajority`
  ticket is the one with the Playwright coverage that exercises the
  combined browser-↔-service-peer agreement. Tier 2 takes long enough
  + spawns enough processes that running it from an implement-stage
  agent isn't a routine check.
- **The optimystic working tree carries more than this ticket's
  changes.** `git diff ../optimystic` also includes the
  `--no-relay` / `effectiveRelay` / `🔁 Circuit-relay server: on/off`
  rework from the prior `web-e2e-tier2-data-convergence-relay` ticket
  (still uncommitted upstream because optimystic isn't on tess). That
  is **not** in scope for this ticket; the reviewer should ignore it
  when assessing this work but is welcome to note that it co-exists
  cleanly with the cluster-size threading (the test suite passes with
  both stacked).
- **Default value remains 10.** This ticket intentionally does not
  change the in-repo default in `libp2p-node-base.ts`; it only adds
  the opt-in override. If the reviewer thinks the browser's
  `clusterSize: 3` and the service default of `10` should be reconciled
  at the source instead of via a CLI flag, that's a separate design
  conversation and should be a new ticket, not an inline fix.

## Reviewer notes

- No follow-ups expected from this ticket; cluster-size threading is
  mechanical and `web-e2e-tier2-cluster-supermajority` already exists
  as the e2e-coverage follow-on (named in the original ticket as the
  downstream that needs this to land first).
- Suggested review flow: skim the `cli.ts` diff for the
  `parseClusterSize` shape vs. `parseStorageCapacity`, confirm the
  fixture's two-line additions match the browser's `clusterSize: 3`,
  and call it done. Minor findings (typos, wording) → inline; major
  findings (design pushback on flag vs. default change, missing
  validation, etc.) → new fix ticket per the workflow rules.
