---
description: Add a `--cluster-size <N>` flag to optimystic `reference-peer`'s `interactive`, `service`, and `run` commands so the e2e fixture and the browser agree on a configurable cluster size end-to-end. Today the browser builds with `clusterSize: 3` while service peers default to `clusterSize: 10` (`libp2p-node-base.ts`), and there is no CLI knob to align them.
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## Problem

Browser `optimystic.ts` hardcodes `clusterSize: 3` for distributed
mode (`packages/reference-app-web/src/lib/optimystic.ts:136`).
Service peers spawned by the e2e fixture take the
`libp2p-node-base.js` default of `clusterSize: 10`. There is no
`reference-peer` CLI flag to override this — the option must be
passed programmatically.

The mismatch shows up as cluster-coordinator asymmetry in the e2e
data-convergence specs, and pre-empts cleanly testing the
supermajority-merge bug separately (see
`web-e2e-tier2-cluster-supermajority`).

## What to add

1. `--cluster-size <N>` option on each of `interactive`, `service`,
   and `run` in `../optimystic/packages/reference-peer/src/cli.ts`,
   wired through to the existing `createLibp2pNode({ clusterSize, ... })`
   path. Default behaviour (no flag) stays whatever
   `libp2p-node-base.ts` uses today; this is purely an opt-in.
2. Pass `--cluster-size 3` from the e2e fixture
   (`packages/reference-app-web/e2e/fixtures/reference-peer.ts`)
   alongside the existing `--network sereus-web-reference`.
3. Update the README cluster-recipe blocks in both repos
   (`../optimystic/packages/reference-peer/README.md` and
   `packages/reference-app-web/README.md`) to document the flag.

## Acceptance

- `yarn workspace @optimystic/reference-peer build`, then
  `node dist/src/cli.js service --help` lists `--cluster-size <N>`.
- `reference-peer` started with `--cluster-size 3` reports the same
  `clusterSize` as the browser (visible in the browser's
  `#/diag` page via FRET / cluster panels, or via a `logDebug` line
  on the peer at start-up).
- e2e fixture passes the flag and the supermajority follow-up has a
  clean baseline (no cluster-size discrepancy in the trace).
- `yarn workspace @optimystic/reference-peer test` still passes.

## Notes

- The flag value should be parsed via `parseInt(..., 10)` with a
  positive-integer guard mirroring the existing `--ws-port` validation
  (`cli.ts:316-319`).
- This ticket is a prereq of `web-e2e-tier2-cluster-supermajority` so
  the cluster-size asymmetry can be excluded before chasing the
  merge-counting bug.
