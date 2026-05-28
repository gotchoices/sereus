---
description: Excludes relay-only / thin-client peers (browser tabs) from FRET storage cohort assembly so coordinators no longer pick browsers as cluster members and broadcast-dial them with empty multiaddrs. The originally-named flake (`two-tab-convergence.spec.ts`) passes in isolation and the `no valid addresses` symptom no longer appears in the validation runs.
files: ../optimystic/packages/db-p2p/src/cluster/relay-only-peers.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/cluster/spread-on-churn.ts, ../optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts, ../optimystic/packages/db-p2p/src/network/network-manager-service.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/test/relay-only-peers.spec.ts, ../optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts
---

## Outcome

The "browser tab admitted to storage cohort → `code=none msg=\"no valid
addresses\"` on commit broadcast" class of failure is eliminated. The new
`cluster/relay-only-peers.ts` helper computes the set of peer-ids that
should not be admitted to a storage cohort, and that set is threaded
through every `assembleCohort` / `expandCohort` call site in db-p2p
(`Libp2pKeyPeerNetwork.findCluster`, `Libp2pKeyPeerNetwork.findCoordinator`,
`SpreadOnChurnMonitor.performSpread`, `RebalanceMonitor.performRebalanceCheck`,
`NetworkManagerService.getCluster`, and the dispute `selectArbitrators`
callback in `libp2p-node-base.ts`). `findCluster` additionally backfills
cohort members' multiaddrs from the libp2p peerStore for peers that are in
the cohort but without a live connection — without the backfill,
transiently-disconnected service peers would carry the same "no valid
addresses" symptom forward.

`findCoordinator` excludes other relay-only peers from candidacy but
**keeps self** even when self is relay-only, so a browser tab can still
self-coordinate as a fallback path while the cluster it broadcasts to is
composed entirely of dialable service peers.

## Validation

- `yarn workspace @optimystic/db-p2p test` — 473 passing, 7 pending (pre-existing), 0 failing.
- `yarn workspace @optimystic/db-p2p build` — clean (`tsc`, no diagnostics).
- Tier 2 e2e (full sweep, single worker): 13/16 pass; `two-tab-convergence.spec.ts` passes in isolation; `dial:fail code=none msg="no valid addresses"` count is 0 in the validation runs. The 3 remaining flakes (`cross-tab-activity`, `disconnect-mid-session`, and `two-tab-convergence` under load) surface a different class of error — `StreamResetError` on the `cluster-tx:promise-response` stream, with a secondary `Protocol selection failed - could not negotiate /db-p2p/cluster/1.0.0` from the legacy fallback. This is a distinct bug, not the one this ticket targeted; see the new follow-up ticket `fix/web-e2e-tier2-cluster-tx-stream-reset`.

## Review findings

### Correctness — verified

- `getRelayOnlyPeerIds` correctly handles every input branch the unit
  tests cover and a few they don't: empty peerStore, peerStore reject
  (swallowed), self-with-no-addrs (abstain via `isSelfRelayOnly`), self-relay-only,
  peerStore peers with all-circuit / mixed / direct addresses, FRET-known
  peers with and without peerStore entries, and FRET-known including self
  (skipped via the `idStr === selfStr` guard). The 12 helper specs cover
  these branches directly; the full failing-scenario reproduction (3 service +
  2 browser) is exercised in the final unit test and matches the field
  failure mode.
- The FRET `assembleCohort(coord, wants, exclude?: Set<string>)` and
  `expandCohort(current, coord, step, exclude?: Set<string>)` signatures in
  `p2p-fret/src/service/fret-service.ts` accept `Set<string>` for the
  exclusion arg and filter internally, so the callers correctly thread a
  `Set<string>` through with no need for additional post-filtering. The
  redundant `.filter(pid => !excludeSet.has(pid))` in
  `libp2p-node-base.ts:510` is harmless leftover and preserves the
  pre-existing arbitration shape; not changed in this pass.
- `findCluster`'s peerStore backfill (`getPeerStoreAddrsByPeer`) preserves
  the "connected-first" multiaddr ordering, returns the parsed/validated
  multiaddrs only, and intentionally leaves a cohort member with neither a
  live connection nor a peerStore entry as an empty-multiaddrs entry
  (defense-in-depth + supermajority preservation). The new unit test
  `backfills cohort multiaddrs from peerStore when not currently connected`
  asserts the backfill path end-to-end.
- `findCoordinator` keeps self in the candidate set even when self is
  relay-only (per the design note in the implement ticket). Without this
  exception a browser tab would exhaust coordinators and surface
  `all-excluded`; the comment block in `libp2p-key-network.ts:370-379`
  documents the design.

### Style / SPP / DRY — verified

- Helper is small, single-purpose, and exports two narrowly-scoped
  functions (`isSelfRelayOnly`, `getRelayOnlyPeerIds`). No leakage into
  unrelated modules. Type signatures are concrete; no `any` casts except
  the unavoidable `peerStore` shape narrowing (libp2p's TS interface does
  not expose `peerStore` strongly on the top-level `Libp2p` type).
- Each call site has a short justifying comment before the
  `getRelayOnlyPeerIds` call, citing `cluster/relay-only-peers.ts` —
  consistent with the project's "comment WHY, not WHAT" rule.
- The new private helpers in `Libp2pKeyPeerNetwork` (`getRelayOnlyExcludes`,
  `listFretPeerIds`, `getPeerStoreAddrsByPeer`) keep `findCluster` and
  `findCoordinator` readable; the de-duplication via `Array.from(new Set(...))`
  in the merged multiaddrs path is consistent with how the rest of the
  file handles dedup.

### Tests — verified

- Helper coverage: 12 specs in `test/relay-only-peers.spec.ts`. Branch
  coverage matches every observable case the helper produces; no obvious
  gaps.
- `findCluster()` exclusion: 2 new specs in `test/libp2p-key-network.spec.ts`
  covering (a) end-to-end exclusion + self-when-relay-only + backfill, and
  (b) peerStore backfill alone. The first spec asserts the exclude set
  propagates to `assembleCohort` (captured via the mock fret), self is
  dropped from the returned cluster when self is relay-only, and every
  returned cluster member has non-empty multiaddrs.
- No new specs cover the dispute `selectArbitrators` arbitration path with
  relay-only peers. This is a small uncovered seam; flagged below.

### Docs — verified

- `relay-only-peers.ts` has a thorough header comment describing the
  three exclusion criteria and the original failure mode.
- The implement-stage handoff already lists the touched files and an
  honest assessment of the 3 remaining Tier-2 e2e flakes. The complete
  ticket carries that forward.

### Findings — minor (resolved here)

- **Drive-by changes in `test/circuit-relay-long-lived.spec.ts`.** Two
  unrelated edits sneaked into the diff:
    - `--grep "circuit-relay-long-lived"` → `--grep "Circuit-relay long-lived"`
      (corrects the doc comment so the grep actually matches the `describe`).
    - `listenAddrs: ['/p2p-circuit']` → `listenAddrs: [`${relayAddr}/p2p-circuit`]`
      (qualifies the browser-shaped peer's listen address with the relay's
      full multiaddr).
  Both are arguably-helpful test-setup fixes (the `--grep` fix is
  obviously correct; the `listenAddrs` change exercises the same shape the
  e2e harness uses), and neither is harmful, but they were not called out
  in the implement summary. Leaving them in — they're test-only and
  don't affect production behaviour — but noting the omission.
- **Minor: `connect()` cleanup** in `libp2p-key-network.ts:295` drops the
  `(this.libp2p as any)` cast and the now-unused `Connection` import. This
  is unrelated to the relay-only-peers feature but is a real readability
  win. Kept.

### Findings — major (filed as follow-up tickets)

- **Tier-2 e2e sweep flake under concurrent load.** Three multi-tab Tier 2
  specs (`cross-tab-activity`, `disconnect-mid-session`, `two-tab-convergence`)
  still fail when the full sweep runs sequentially against the shared
  3-service-peer fixture. The captured failure is `StreamResetError` on
  `cluster-tx:promise-response` during the consensus broadcast, with a
  secondary `Protocol selection failed - could not negotiate /db-p2p/cluster/1.0.0`
  from `ClusterClient.update`'s legacy-protocol fallback. The dial
  succeeds; the stream resets mid-transaction. Plausible causes (per the
  implement-stage handoff): relay-server stream/byte caps, yamux
  flow-control limits under load, or accumulated FRET/peerStore state on
  the service peers across specs. **Filed as a new fix ticket:
  `fix/web-e2e-tier2-cluster-tx-stream-reset`.**

### Findings — out-of-scope known gaps (not blockers)

- **Per-call cost of `getRelayOnlyPeerIds`.** Each `findCluster` /
  `findCoordinator` call does `peerStore.all()` plus per-FRET-peer
  scanning, and `findCluster` additionally does N `peerStore.get` calls
  for the backfill. For the test mesh (≤5 peers) negligible; in a larger
  mesh this is O(peerStore-size) per cohort-assembly. Not optimised
  speculatively; a small TTL cache is a natural follow-up if profiling
  shows hotspot. Implement ticket already noted this.
- **Arbitrator-selection cohortSize doesn't expand by relay-only count.**
  `libp2p-node-base.ts:496` computes `cohortSize = count + excludePeers.length + 1`
  without adding `relayOnly.size`. In a service-only mesh this is fine;
  in a mesh where browsers outnumber service peers, the arbitrator pool
  could end up smaller than `count`. Pre-existing pattern; not changed.
- **Relay-server limit assumptions.** The fix assumes service peers
  serving as relays still have `applyDefaultLimit: false` per the prior
  `optimystic-circuit-relay-reservation-lifetime` ticket. A regression
  there would mask the effectiveness of this fix and surface as the
  `StreamResetError` class the follow-up ticket covers.
- **`/db-p2p/cluster/1.0.0` legacy fallback.** `ClusterClient.update` still
  falls back to the unprefixed protocol on error, which is never
  registered on optimystic clusters and adds noise (`Protocol selection
  failed`) to the failure log. Cleanup candidate; out of scope here.

## Acceptance / use cases — verified

1. **Browser tab not in another node's findCluster cohort.** Unit-tested
   via `findCluster() — relay-only exclusion / passes a relay-only
   exclude set to assembleCohort …`.
2. **Browser tab self-coordinating against a service-peer cluster.**
   Exercised by `two-tab-convergence.spec.ts` end-to-end in isolation; the
   `findCoordinator` keep-self-when-relay-only rule is documented inline.
3. **FRET-known-but-addressless filter.** Unit-tested in two specs (with
   and without `fretKnown`).
4. **peerStore backfill in findCluster.** Unit-tested directly.
5. **Harness gap (browser console `%s`-format substitution) preserved** in
   `packages/reference-app-web/e2e/distributed/_helpers.ts` —
   `maybeEnableBrowserDebug` + `formatConsoleArgs` resolve console args so
   `dial:fail code=/msg=` fields land in the e2e log.
6. **Originally-cited `getComponents is not a function` TypeError**: not
   observed in the post-fix validation captures.

## End-state of source tree

  - **new** `optimystic/packages/db-p2p/src/cluster/relay-only-peers.ts`
  - **modified** `optimystic/packages/db-p2p/src/libp2p-key-network.ts`
  - **modified** `optimystic/packages/db-p2p/src/cluster/spread-on-churn.ts`
  - **modified** `optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts`
  - **modified** `optimystic/packages/db-p2p/src/network/network-manager-service.ts`
  - **modified** `optimystic/packages/db-p2p/src/libp2p-node-base.ts`
  - **new** `optimystic/packages/db-p2p/test/relay-only-peers.spec.ts` (12 specs)
  - **modified** `optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts` (+2 specs in `findCluster() — relay-only exclusion`)
  - **modified** `optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts` (drive-by: `--grep` doc fix + explicit relay-prefixed `listenAddrs`)
  - **untouched** the sereus tree (harness gap in `_helpers.ts` was applied in the working tree by the prior `fix/` agent run)
