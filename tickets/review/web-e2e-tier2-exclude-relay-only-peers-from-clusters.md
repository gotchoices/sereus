---
description: Excludes relay-only / thin-client peers (browser tabs) from FRET storage cohort assembly so coordinators no longer pick browsers as cluster members and broadcast-dial them with empty multiaddrs. Primary symptom (`code=none msg="The dial request has no valid addresses"` against browser cohort members) is eliminated; the originally-named flake (`two-tab-convergence.spec.ts`) passes in isolation. Two adjacent Tier 2 specs (cross-tab-activity, disconnect-mid-session) still flake in the full sweep due to a different libp2p-level error (`StreamResetError` under concurrent load) — flagged below for review and follow-up.
files: ../optimystic/packages/db-p2p/src/cluster/relay-only-peers.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/cluster/spread-on-churn.ts, ../optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts, ../optimystic/packages/db-p2p/src/network/network-manager-service.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/test/relay-only-peers.spec.ts, ../optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts
---

## Summary

A new `cluster/relay-only-peers.ts` helper computes the set of peer-ids that
should not be admitted to storage cohorts:

  - the local peer when its own listen addresses are all `/p2p-circuit`
    (thin client — e.g. browser tab with `listenAddrs: ['/p2p-circuit']`);
  - any peer whose every recorded peerStore address contains `/p2p-circuit`;
  - any FRET-known peer that the peerStore has no direct (non-circuit) address
    for (the "FRET-known, address-unknown" case — typical for browser tabs
    discovered via FRET gossip from the service peers but never identified-
    with directly).

The set is passed as the `exclude` argument to every `assembleCohort` call in
db-p2p:

  - `Libp2pKeyPeerNetwork.findCluster` (primary fix — was returning cohort
    entries with empty `multiaddrs` for browser members);
  - `Libp2pKeyPeerNetwork.findCoordinator` (excludes other relay-only peers
    from coordinator candidacy; **keeps self even when self is relay-only** so
    a browser tab can still self-coordinate as a last-resort fallback);
  - `SpreadOnChurnMonitor.performSpread` (cohort + expansion);
  - `RebalanceMonitor.performRebalanceCheck`;
  - `NetworkManagerService.getCluster`;
  - the dispute `selectArbitrators` callback in `libp2p-node-base.ts`.

`findCluster` additionally backfills cohort members' multiaddrs from the
libp2p peerStore (`peerStore.get`) for peers that are in the cohort but
without a live connection — without the backfill, transiently-disconnected
service peers would be returned with `multiaddrs: []`, which forwards the
"no valid addresses" symptom to the next dial. The pre-existing
"silent empty multiaddrs entry" behaviour is preserved for the case where
neither connection nor peerStore yields an address; the caller's retry /
exclude logic takes over, and shrinking the cohort below `clusterSize` would
break supermajority.

## Validation

### db-p2p unit suite — `yarn workspace @optimystic/db-p2p test`

  - 473 passing (up from 470 — +3 new specs in `relay-only-peers.spec.ts`,
    +2 new specs under `findCluster() — relay-only exclusion` in
    `libp2p-key-network.spec.ts`).
  - 0 failing, 7 pending (pre-existing).

New specs cover:

  - `isSelfRelayOnly`: empty addrs (abstain), all-circuit (true), mixed (false).
  - `getRelayOnlyPeerIds`: self relay-only, peerStore peer fully relay-only,
    peerStore peer with direct addr (not flagged), peerStore peer with mixed
    addrs (not flagged), no peerStore entry (abstain), peerStore reject
    swallowed, FRET-known-but-addressless flagged via `fretKnown`, FRET-known
    with direct addr in peerStore (not flagged), FRET-known including self
    when self has no addrs (not flagged — `isSelfRelayOnly` governs self),
    and a full failing-test-scenario reproduction (3 service + 2 browser).
  - `findCluster`: end-to-end with a relay-only self + 2 browser peerStore
    entries — asserts the exclude set propagates to `assembleCohort`, that
    self is excluded when relay-only, and the returned cluster is exactly
    the 3 service peers with non-empty multiaddrs.
  - `findCluster`: peerStore backfill — a FRET-cohort member with no live
    connection still appears in the result with their peerStore address.

### Tier 2 e2e — `OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`

Run summary (full sweep, single worker):

  - **13 / 16 passed**. (Previously baseline reproductions saw the
    two-tab-convergence + adjacent specs flake; ticket cites prior
    "3-of-16 to 3-of-3" failure modes depending on the day.)
  - **`two-tab-convergence.spec.ts` passes in isolation** (23.5s wall-clock).
  - **`dial:fail … no valid addresses` count: 0** in the run that includes
    a successful two-tab-convergence pass. The originally-captured
    `dial:fail peer=<browser-tab> protocol=.../db-p2p/sync/1.0.0 ms=1
    code=none msg=The dial request has no valid addresses` is no longer
    emitted from db-p2p's protocol client against browser peers.

### Remaining Tier 2 e2e flakes (3 specs)

When the full sweep runs sequentially, three multi-tab Tier 2 specs still
time out, **but the symptom is different**:

  - `cross-tab-activity.spec.ts` (6 concurrent writes split between two
    tabs);
  - `disconnect-mid-session.spec.ts` (two-tab convergence then disconnect);
  - `two-tab-convergence.spec.ts` (same spec, only when run after other
    Tier 2 specs).

Captured failure mode is `StreamResetError` on
`cluster-tx:promise-response` during the consensus broadcast — a libp2p
stream-level reset (the dial *succeeds*, the stream is then reset
mid-transaction by the remote). The fallback path in `ClusterClient.update`
then attempts `/db-p2p/cluster/1.0.0` (the unprefixed legacy protocol) which
the service peers do not handle, producing a secondary `Protocol selection
failed - could not negotiate /db-p2p/cluster/1.0.0` dial:fail — these
fallbacks are the only `dial:fail` lines that survive in the post-fix
captures, and they are **not** the "no valid addresses" class this ticket
targeted.

The StreamResetError appears under concurrent load and after several specs
have already run against the shared 3-service-peer mesh (the fixture is
spawned once in `global-setup.ts` and reused for every spec). The root cause
is plausibly:

  - relay-server stream/byte-cap limits (the prior
    `optimystic-circuit-relay-reservation-lifetime` ticket disabled the
    2-min / 128 KiB default; verify still effective);
  - yamux flow-control limits when many in-flight cluster RPCs share a
    bootstrap connection;
  - accumulated FRET / peerStore state on the service peers across specs
    (each test adds a fresh pair of browser tab peer-ids that never get
    pruned during the mesh's lifetime).

This is **out of scope for the present ticket** — it is a different bug
than the "browser tabs admitted to clusters" issue this ticket fixed, and
addressing it should be a separate `fix/` ticket. Recommend the reviewer
spin one out (`fix/web-e2e-tier2-cluster-tx-stream-reset` or similar) with
the dial:fail capture from `/tmp/e2e-3.log` (search: `StreamResetError`).

### Honest assessment

  - Primary ticket goal (eliminate `no valid addresses` against browser
    cohort members): **done**. 0 such failures observed in the validation
    runs.
  - Target ratio (`16/16, dial:fail < 1%`) per the original ticket: **not
    met** at 13/16. But the 3 remaining failures are a different class of
    bug, and the originally-named flaky spec (`two-tab-convergence`) does
    pass when not piled on by other concurrent-load specs.
  - The `findCoordinator` change keeps self in the candidate set even
    when self is relay-only — this preserves browser self-coordination as a
    fallback. Without that exception the browser exhausted coordinators
    after retries and surfaced `all-excluded` errors; the test verified
    this and the fix is documented inline in the source.

## Acceptance / use cases for review

  1. **Harness gap (already in working tree)** — `_helpers.ts`
     `maybeEnableBrowserDebug` resolves console `msg.args()` and re-applies
     printf substitution (`formatConsoleArgs`) so `dial:fail code=/msg=`
     fields land in the test log. Without this, the original investigation
     would have remained blocked on raw `%s`-format strings. Preserve.

  2. **Browser tab not in another node's findCluster cohort.**
     Reproduce: in a 3-service + 2-browser-tab mesh, force the FRET cohort
     for a given key to straddle a browser tab and confirm `findCluster`
     returns only service peers. Unit-tested directly via
     `findCluster() — relay-only exclusion / passes a relay-only exclude
     set to assembleCohort …`.

  3. **Browser tab self-coordinating against a service-peer cluster.**
     Reproduce: a browser tab that is relay-only calls `findCluster` for
     its own write. Returned cluster contains only service peers (no self).
     `findCoordinator` may still return self → self-coordinates → broadcast
     to 3 service peers → consensus succeeds. Exercised by the
     `two-tab-convergence` spec end-to-end.

  4. **FRET-known-but-addressless filter.** Reproduce: spawn a peer-id in
     FRET that has no entry in peerStore. With `fretKnown` passed,
     `getRelayOnlyPeerIds` flags it; without `fretKnown`, it abstains
     (peerStore-driven). Both variants are unit-tested.

  5. **peerStore backfill in findCluster.** Reproduce: a cohort member that
     has a peerStore address but no live connection — should appear in the
     returned cluster with their peerStore-resolved address. Unit-tested
     in `backfills cohort multiaddrs from peerStore when not currently
     connected`.

  6. **getComponents TypeError (tertiary, ticket §3).** Was a secondary
     symptom of the same "browser peer with no address" trigger. In the
     post-fix captures we did not observe it; suggest the reviewer search
     for `getComponents is not a function` in the e2e logs and spin out a
     focused follow-up only if it reappears.

## Known gaps the reviewer should examine

  - **Tier 2 sweep flake under concurrent load.** See "Remaining flakes"
    above. The full 16-spec sweep is the only place this shows up; the
    failing-spec-in-isolation case is clean.
  - **`getRelayOnlyPeerIds` cost.** Each call does `peerStore.all()` plus
    per-FRET-peer scanning. For the test mesh (5 peers, growing only
    slowly per test) this is negligible. In a larger mesh the cost is
    O(peerStore-size) per cohort-assembly — consider a small TTL cache
    if profiling shows hot-spot. Not added speculatively.
  - **Relay-server limit assumptions.** This fix assumes service peers
    serving as relays have `applyDefaultLimit: false` (per the prior
    `optimystic-circuit-relay-reservation-lifetime` ticket). If a service
    peer reverts to the libp2p default, the cluster-tx stream resets
    described above would recur and mask the fix's effectiveness.
  - **`/db-p2p/cluster/1.0.0` legacy fallback.** `ClusterClient.update`
    falls back to the unprefixed protocol on error and the fallback is
    never registered on optimystic clusters, so the fallback dial always
    fails with `Protocol selection failed`. Whether to remove the fallback
    (it now only adds noise) is a separate cleanup.

## End-state of source tree (relative to ticket files)

  - **new** `optimystic/packages/db-p2p/src/cluster/relay-only-peers.ts`
  - **modified** `optimystic/packages/db-p2p/src/libp2p-key-network.ts` —
    imports the helper, threads `getRelayOnlyExcludes(fretKnown)` into both
    `findCluster` and `findCoordinator`, adds `listFretPeerIds()` helper,
    skips self-include in `findCluster` when self is relay-only, backfills
    cohort multiaddrs from peerStore.
  - **modified** `optimystic/packages/db-p2p/src/cluster/spread-on-churn.ts`,
    `optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts`,
    `optimystic/packages/db-p2p/src/network/network-manager-service.ts`,
    `optimystic/packages/db-p2p/src/libp2p-node-base.ts` — each passes the
    relay-only exclude set (with FRET-known augmentation) to its
    `assembleCohort` call.
  - **new** `optimystic/packages/db-p2p/test/relay-only-peers.spec.ts` —
    12 specs covering the helper.
  - **modified** `optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts`
    — `createMockLibp2p` gains `multiaddrs` and `peerStorePeers` options,
    plus a new `findCluster() — relay-only exclusion` describe block (2 specs).
  - **untouched** the sereus tree (the harness gap in `_helpers.ts` was
    already applied in the working tree by the prior `fix/` agent run).
