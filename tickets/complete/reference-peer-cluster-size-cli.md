---
description: Thread `--cluster-size <N>` through the `optimystic` `reference-peer` CLI (interactive/service/run) and wire the web e2e fixture + README to `--cluster-size 3` so service peers agree with the browser's `clusterSize: 3`. Landed end-to-end. Review tightened `parseClusterSize` to also reject non-integer numeric input.
files: ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/reference-peer/README.md, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/optimystic.ts
---

## Outcome

- `reference-peer` CLI gains a `--cluster-size <number>` flag on
  `interactive`, `service`, and `run`. Absent → existing
  `libp2p-node-base` default of 10 still applies; present → forwarded
  through `createLibp2pNode({ clusterSize, ... })` and logged via
  `'👥 Cluster size override set to N'` + `logDebug('cluster size override set', { clusterSize })`.
  `clusterSize` is also surfaced inside the existing
  `'starting libp2p node'` debug payload.
- `parseClusterSize` private helper sits next to `parseStorageCapacity`
  on `PeerSession`, mirroring its shape.
- Sereus web e2e fixture spawns its bootstrap + two service peers with
  `--cluster-size 3` so the spawned mesh matches the browser's
  distributed-mode `clusterSize: 3` (in `src/lib/optimystic.ts`).
  README's local-bootstrap recipe and Tier 2 fixture description were
  updated in step.
- Acceptance signal — `--cluster-size 3` produces the
  `'👥 Cluster size override set to 3'` console line plus the
  `'cluster size override set'` `logDebug` payload, visible at peer
  start-up. `clusterSize: 3` also appears in the `'starting libp2p node'`
  debug record.

## Review findings

### Code quality — `parseClusterSize` strictness (minor, fixed inline)

The implement-stage parser used `parseInt(options.clusterSize, 10)`,
which silently truncates `'3.5'` → `3` and `'3abc'` → `3` while the
sibling `parseStorageCapacity` uses `Number()` (strict). The error
message reads `--cluster-size must be a positive integer`, but the
parser wasn't actually enforcing integer-ness — only finiteness and
positivity. Tightened to:

```ts
const parsed = Number(options.clusterSize);
if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--cluster-size must be a positive integer');
}
```

This now rejects `'3.5'` and `'3abc'` in addition to `'0'`, `'-3'`,
and `'abc'`. Behaviour on valid integer input (`'3'`, `'10'`) is
unchanged. Edit lives in the same uncommitted optimystic working tree
as the rest of the optimystic-side changes for this ticket.

### Threading end-to-end (clean)

- All three subcommands (`interactive`, `service`, `run`) delegate
  `options` straight to `PeerSession.startNetwork(options)` via simple
  `.action(async (options) => { await session.startNetwork(options); })`
  wrappers, so the new `clusterSize?: string` field on `startNetwork`'s
  options type propagates without per-command plumbing.
- `clusterSize` lands on `createLibp2pNode(...)`. Confirmed
  `libp2p-node-base.ts` consumes it across `Libp2pKeyPeerNetwork`,
  `clusterPolicy.configuredClusterSize`, and the cluster module
  configuration — same code paths the in-repo distributed-diary test
  has been exercising under the default of 10.

### Fixture / browser agreement (clean)

`packages/reference-app-web/e2e/fixtures/reference-peer.ts` appends
`'--cluster-size', '3'` to both the bootstrap (`interactive --offline`)
and each service peer's argv. Matches
`packages/reference-app-web/src/lib/optimystic.ts:136`
(`opts.clusterSize ?? (isDistributed ? 3 : 1)`).

### Docs (clean)

- `packages/reference-app-web/README.md`: local-bootstrap recipe, Tier
  2 fixture description, and "reproduce e2e locally" snippet all
  consistently include `--cluster-size 3` with rationale (browser
  defaults to 3, peer defaults to 10, mismatch breaks cluster-coordinator
  membership).
- `../optimystic/packages/reference-peer/README.md`: `--cluster-size`
  documented under "Interactive Mode" options with default-10 fallback
  note and the cross-mention that browser peers built with
  `clusterSize: 3` need service peers started with `--cluster-size 3`.
  Accepted by all three subcommands.

### Validation re-run (post-fix)

- **Clean build.** `rm -rf ../optimystic/packages/reference-peer/dist`
  then `yarn workspace @optimystic/reference-peer build` → 0; compiled
  output reflects the `Number(...) / Number.isInteger(...)` change.
- **Test suite.** `yarn workspace @optimystic/reference-peer test`
  → `4 passing (15s)`. The 3-node mesh suite does not pass
  `--cluster-size`, so it exercises the default-10 path unchanged.
- **`--help` spot-check.** `interactive`, `service`, and `run` all
  emit `--cluster-size <number>     Desired cluster size per key (positive integer)`.
- **Bad-input rejection.** `--cluster-size {0, abc, -3, 3.5, 3abc}`
  against `service --ws-port 19099 --no-tcp --offline` each exit with
  `❌ Error: --cluster-size must be a positive integer` — the last two
  are the newly-strict cases that previously silent-truncated.
- **Happy path.** `--cluster-size 3` on the same command emits
  `👥 Cluster size override set to 3` before listen-address output,
  confirming the parser → console → `createLibp2pNode` wiring.

### Out-of-scope, not reviewed

Per the implement-stage handoff: the uncommitted optimystic working
tree also carries `--no-relay` / `effectiveRelay` / `🔁 Circuit-relay server: on/off`
rework that belongs to the prior `web-e2e-tier2-data-convergence-relay`
ticket. Untouched in this review; coexists cleanly with the cluster-size
threading (the reference-peer test suite passes with both stacked).
Default cluster size of 10 in `libp2p-node-base.ts` was left as-is —
the source ticket scoped this to an opt-in CLI override; harmonizing
the source defaults is a separate design conversation if the user
wants to pursue it.

### Not run from this stage

- Web e2e Tier 2 suite (`web-e2e-tier2-cluster-supermajority`) is the
  downstream coverage that exercises browser-↔-service-peer cluster
  agreement under the new fixture. Its run is owned by that downstream
  ticket; it spawns enough processes and runs long enough that doing
  it from this review stage isn't a routine check. The fixture-side
  edits in this ticket are mechanical (two `--cluster-size 3` pairs
  appended to argv arrays) and structurally identical to existing
  `--network sereus-web-reference` threading, so the risk of regression
  beyond what the downstream e2e will already catch is low.

## Follow-ups

None. Cluster-size threading is mechanical and the downstream
`web-e2e-tier2-cluster-supermajority` ticket is the e2e-coverage
follow-on that was already named as the dependent in the source ticket.
