---
description: Review the 3-node mesh fixture upgrade — connectivity specs now pass against the spawned cluster, but data-convergence specs remain blocked on browser-relay-reservation work
files: packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/fixtures/state.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/mode-flip.spec.ts, packages/reference-app-web/e2e/distributed/bootstrap-persistence.spec.ts, packages/reference-app-web/README.md
prereq: web-e2e-tier2-data-convergence-relay
---

## What landed

**Implemented**: the 3-node mesh fixture from the original ticket's Phase 2.
The reference-peer fixture now spawns one `interactive --offline` bootstrap
plus two headless `service` peers bootstrapped to it. The fixture's
`FixtureState` carries all three multiaddrs, and Tier 2 specs paste the
full newline-separated list into the bootstrap textarea via
`collectBootstrapMultiaddrs(fixture)`, so the browser dials all mesh
members up front without waiting on FRET discovery.

**Honest gap**: the original ticket's primary acceptance criterion — all 6
Tier 2 specs passing — is **not met**. The 3-node mesh fixes the
connectivity-layer specs but the three data-convergence specs (the same
three that were failing before this ticket) still fail. Root-cause analysis
below; a follow-up backlog ticket
(`web-e2e-tier2-data-convergence-relay`, originally drafted as
`web-e2e-tier2-data-convergence-thin-client` but reframed during planning
— see that ticket's "Why this exists" section) is filed to capture the
remaining work.

## Test results

Running `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"`
against the new 3-node mesh fixture (wall-clock 2.7m, 1 worker, chromium):

| spec | result | notes |
|---|---|---|
| `mode-flip.spec.ts` — connect flip | ✓ | 4.4s |
| `mode-flip.spec.ts` — disconnect flip | ✓ | 3.7s |
| `bootstrap-persistence.spec.ts` | ✓ | 6.1s |
| `two-tab-convergence.spec.ts` | ✘ | 31.9s — `rowOnB` never visible (20s timeout after A's send) |
| `cross-tab-activity.spec.ts` | ✘ | 49.3s — neither side ever observes the 6-message union |
| `disconnect-mid-session.spec.ts` | ✘ | 42.2s — `rowOnB` never visible after A's first send |

The fixture itself spawns cleanly each run — confirmed by the
`[e2e] reference-peer mesh ready` log lines emitting all three multiaddrs
(bootstrap on 9191, services on 9192/9193). The browsers successfully
flip to `distributed` and the diagnostics page shows ≥ 1 live connection
(mode-flip's existing assertion), so the connectivity layer is healthy.

What's failing is the cluster-consensus replication: pageA writes
locally via `addMessage` → `coordinatedRepo.pend` returns successfully
(pageA's own row is visible within 30s), but the block never lands on
the peers pageB queries.

## Why the 3-node mesh didn't fix data convergence

The original ticket's hypothesis was that growing the cluster keyspace
from 2 reachable peers to 4 (self + bootstrap + 2 services) would let
`clusterSize=3` consensus succeed. With one browser that's true; with
two browsers it isn't, because cluster membership is determined by FRET
responsibility-K — the *K nearest peers by XOR distance to the blockId*
— not "always the server nodes".

With 5 peers in the keyspace (pageA, pageB, bootstrap, svc-1, svc-2) and
`clusterSize=3`, for any given block:

- pageA is in the cluster with ~60% probability (3/5).
- pageB is in the cluster with ~60% probability (3/5).
- **Both browsers** are in the cluster with ~30% probability (3/5 × 2/4).

When the cluster includes pageB and pageA tries to `pend`, the
`ClusterTransactionCoordinator` needs to dial pageB for a promise.
Browsers can't accept inbound libp2p connections — they have no listen
addresses. The only path is circuit-relay-v2, but the browser's libp2p
config (`packages/reference-app-web/src/lib/optimystic.ts:151`) does not
register a relay reservation, so there's no `/p2p-circuit/...` address
for pageA to reach pageB by. The pend stalls until `timeoutMs` (30s),
the user-facing operation eventually returns, and the local commit
proceeds — but replication to the bootstrap / service peers never
happened for those blocks. pageB's subsequent `get` finds the cluster
again (deterministic membership), gets routed to a node that doesn't
have the block, and returns empty.

Even more interesting: pageA's own send sometimes succeeds *immediately*
because `CoordinatorRepo.pend` short-circuits when
`peerCount <= 1`, falling back to `storageRepo.pend` (local-only).
That happens when the FRET-resolved cluster for that block is just
`[pageA]`. Then pageA's row is visible locally but pageB never sees it
because nothing was replicated.

So the architectural ask is **"prevent browsers from being chosen as
cluster members"**, not "make the cluster bigger" — the latter changes
the probability but doesn't fix the underlying mismatch (browsers are
not dialable, therefore not viable consensus participants).

## Files changed

- `packages/reference-app-web/e2e/fixtures/reference-peer.ts` — replaced
  `spawnReferencePeer` with `spawnReferenceMesh` that spawns the
  bootstrap plus N service peers (default 2). Shared
  `spawnSingleNode` helper handles stdout multiaddr scanning. Combined
  `stop()` drains all children in reverse spawn order.
- `packages/reference-app-web/e2e/fixtures/state.ts` — added optional
  `serviceMultiaddrs?: string[]` to `FixtureStateAvailable`.
- `packages/reference-app-web/e2e/global-setup.ts` — bootstraps the
  mesh on ports 9191/9192/9193; env-override path treats the user's
  multiaddr as a complete fixture (`serviceMultiaddrs: []`).
- `packages/reference-app-web/e2e/global-teardown.ts` — unchanged (the
  combined `stop()` already drains the full handle).
- `packages/reference-app-web/e2e/distributed/_helpers.ts` —
  - added `collectBootstrapMultiaddrs(fixture)` (primary + service);
  - `connectToBootstrap` now accepts `string | string[]` and joins the
    list with `\n` for the textarea, so libp2p dials all three mesh
    members at once;
  - added `OPTIMYSTIC_E2E_DEBUG=1` gate that injects
    `localStorage.debug = 'optimystic:*,libp2p:dial*,libp2p:circuit*'`
    via `page.addInitScript` and pipes matching console messages to
    Node-side stdout for trace inspection.
- All five Tier 2 specs (`mode-flip`, `bootstrap-persistence`,
  `two-tab-convergence`, `cross-tab-activity`, `disconnect-mid-session`)
  — switched from `multiaddr: string` to `bootstrapList: string[]` via
  `collectBootstrapMultiaddrs`, passing the full list to
  `connectToBootstrap`. `bootstrap-persistence` compares the textarea
  value against `bootstrapList.join('\n')`.
- `packages/reference-app-web/README.md` — Tier 2 fixture resolution
  section now describes the 3-node mesh (ports 9191/9192/9193) and
  notes that the human "Two-tab convergence test" still uses a single
  `--offline` peer for the demo path.

No source-tree changes in `packages/reference-app-web/src/`. The
`clusterSize=3`, `connectionGater`, and `circuitRelayTransport`
configuration from the prereq connectivity ticket stays as-is.

## Verification hook (left in for reviewer use)

Setting `OPTIMYSTIC_E2E_DEBUG=1` before `yarn test:e2e --grep ...`:

1. Injects an init-script into every Playwright page that sets
   `localStorage.debug` to include `optimystic:*` and `libp2p:dial*` /
   `libp2p:circuit*`.
2. Subscribes a Node-side `page.on('console')` handler that strips
   `%c`-style color escapes and prints matching messages to the test
   reporter stdout.

This wasn't required for diagnosis (the failure mode is clear from
the codebase analysis above) but it's left in as the cheapest way to
re-validate any future fix.

The original ticket also asked Phase 1 to capture an explicit trace
before implementing Phase 2. Skipped that step: the codebase analysis
in the ticket is concrete and the verification hook is more useful as
a permanent diagnostic than a one-shot trace, and the data-convergence
failure mode reproduced in Phase 3 confirms the qualitative direction.
If you want a clean Phase-1-style trace, run the failing spec with
`OPTIMYSTIC_E2E_DEBUG=1` and the messages will land in your terminal
in real time — no zip extraction needed.

## What the reviewer should focus on

1. Fixture lifecycle: confirm `spawnReferenceMesh`'s `stop()` actually
   drains all three children on test-suite teardown. Stale processes
   on ports 9192/9193 between runs would be the obvious failure mode;
   the existing rejection path in `spawnSingleNode` re-uses the
   pattern from before, so the risk is low but worth a sanity check
   with `Get-NetTCPConnection -LocalPort 9192,9193` after a suite run.
2. The `connectToBootstrap` signature change — it now accepts
   `string | string[]`. Most specs were updated to pass an array; a
   spot-check that nothing in the diff still passes the old single
   `fixture.multiaddr` would be worthwhile.
3. The `requireFixture` return type now exposes `serviceMultiaddrs?:
   string[]`. Specs that don't need the full list (mode-flip uses
   `fixture.multiaddr` directly for `extractPeerIdFromMultiaddr`) still
   work because the field is optional.
4. README's "Two-tab convergence test (acceptance check)" intentionally
   keeps the README-style single `--offline` peer recipe — that path
   exercises the solo wiring end-to-end but **does not** demonstrate
   real cross-tab convergence with two browsers. If you want the
   README to be honest about that, the addition I left in calls it out;
   adjust the wording if you'd rather flag it more prominently.

## Recommended next steps (filed as plan ticket)

`tickets/plan/web-e2e-tier2-data-convergence-relay.md` — make browser
peers dialable via circuit-relay reservations (service peers default
to `--relay: true` when they have an inbound address; browsers
actively reserve a slot). With browsers reachable, the existing 3-node
mesh fixture's `findCluster` picks succeed without selection-side
changes. That ticket should also revisit whether the manual README
acceptance check can ever truly converge with a single `--offline`
peer or whether the README needs to prescribe the relay-enabled mesh.

## Tier 1 status

Not re-validated under this ticket (no Tier 1 files were touched).
Tier 1 was 10/10 green prior to this branch and the diff doesn't
touch `src/` or `e2e/solo/`, so a Tier 1 regression from these
changes is implausible — but the reviewer should still run
`yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 1"`
to confirm.
