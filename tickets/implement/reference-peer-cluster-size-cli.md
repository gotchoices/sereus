---
description: Wire a `--cluster-size <N>` flag through `optimystic` `reference-peer`'s `interactive`, `service`, and `run` commands and have the web e2e fixture pass `--cluster-size 3` so the browser (`clusterSize: 3` in `optimystic.ts`) and the spawned service peers (default `clusterSize: 10` in `libp2p-node-base.ts`) agree end-to-end.
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/reference-peer/README.md, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/optimystic.ts
---

## Status

Implementation is already in the committed work for this stage —
the fix-stage agent landed the full change end-to-end and validated it.
See **Validation** below for what was run and the observed outputs;
the implement stage's job is to re-validate (clean build + repeat the
reference-peer suite) and hand off to review.

## What landed

### `cli.ts`
- New private `parseClusterSize(options)` helper on `PeerSession`,
  modelled on `parseStorageCapacity` and using `parseInt(..., 10)` with
  a `> 0` finite-integer guard. Throws
  `--cluster-size must be a positive integer` on bad input.
- `startNetwork` accepts an optional `clusterSize?: string` and forwards
  the parsed integer to `createLibp2pNode({ clusterSize, ... })`. When
  omitted, the value is `undefined` and `libp2p-node-base.ts` keeps
  using its existing `?? 10` default — purely opt-in.
- `console.log` + `logDebug` emit a "👥 Cluster size override set to N"
  line at start-up when the flag is supplied (matches the
  storage-capacity pattern).
- `--cluster-size <number>` added to `interactive`, `service`, and
  `run` commands with the help text
  `'Desired cluster size per key (positive integer)'`.

### `reference-peer.ts` fixture (web e2e)
- Both the bootstrap (`interactive --offline`) and the two service
  peers spawned via `service` now pass `--cluster-size 3` alongside
  `--network sereus-web-reference`, matching the browser's
  `clusterSize: 3` in `packages/reference-app-web/src/lib/optimystic.ts`.

### READMEs
- `../optimystic/packages/reference-peer/README.md`: option list under
  "Interactive Mode" now documents `--cluster-size <number>`, noting
  the default-10 fallback and that the flag is accepted by all three
  subcommands.
- `packages/reference-app-web/README.md`: the local-bootstrap recipe,
  the Tier 2 fixture description, and the "reproduce e2e locally"
  hint all now include `--cluster-size 3` so a human running the
  README sequence agrees with the browser too.

## Validation

Run from the fix-stage agent (re-run these as the implement-stage check):

- `yarn --cwd ../optimystic workspace @optimystic/reference-peer build` — succeeds.
- `node ../optimystic/packages/reference-peer/dist/src/cli.js service --help`
  — lists `--cluster-size <number>` under Options. Same for `interactive`
  and `run`.
- `node ../optimystic/packages/reference-peer/dist/src/cli.js service
  --ws-port 19099 --no-tcp --offline --cluster-size 0` — exits with
  `❌ Error: --cluster-size must be a positive integer`. Same for a
  non-numeric value (`--cluster-size abc`).
- `yarn --cwd ../optimystic workspace @optimystic/reference-peer test`
  — 4 passing (the existing `test/distributed-diary.spec.ts` 3-node
  mesh suite is unaffected because it doesn't pass `--cluster-size`).

## Notes for review

- This ticket is a prereq of
  `web-e2e-tier2-cluster-supermajority`; once it lands, that follow-up
  starts from a clean baseline where browser and service peers agree on
  `clusterSize` and any cluster-coordinator asymmetry visible in a trace
  is genuinely the supermajority-merge bug rather than a CLI default
  mismatch.
- Acceptance check from the source ticket ("`reference-peer` started
  with `--cluster-size 3` reports the same `clusterSize` as the
  browser, visible via FRET / cluster panels on `#/diag` or via a
  `logDebug` line at start-up") is satisfied by the new
  "👥 Cluster size override set to N" console line + the
  `'cluster size override set'` `logDebug` payload.
- The fix-stage agent did not run the web e2e Tier 2 suite — running
  Playwright + spawning the mesh from inside this agent is too long
  for a routine fix turn. The fixture change is mechanical (two
  string-array append pairs) and a follow-up Tier 2 ticket will exercise
  it end-to-end.

## TODO (implement stage)

- Re-run `yarn --cwd ../optimystic workspace @optimystic/reference-peer build`
  to confirm the in-tree CLI source still builds clean.
- Re-run `yarn --cwd ../optimystic workspace @optimystic/reference-peer test`
  to confirm the existing 3-node mesh suite still passes.
- Spot-check the three `--help` outputs all show `--cluster-size <number>`.
- Move to `review/` with a handoff noting "no follow-ups expected;
  cluster-size threading is mechanical and the supermajority follow-up
  has the e2e coverage."
