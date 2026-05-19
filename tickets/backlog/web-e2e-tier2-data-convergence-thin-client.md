---
description: Browser thin-client mode so browser peers aren't selected as cluster members; required to land the 3 data-convergence Tier 2 specs
files: packages/reference-app-web/src/lib/optimystic.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts
---

## Why this exists

The Tier 2 data-convergence specs in `@serfab/reference-app-web` —
`two-tab-convergence`, `cross-tab-activity`, and `disconnect-mid-session`
— need real cluster consensus to ferry blocks between two browser tabs
via the shared bootstrap / service peers. The companion ticket
`tickets/review/web-e2e-tier2-data-convergence` landed a 3-node mesh
fixture (one `--offline` bootstrap + two headless `service` peers) so
the cluster keyspace has enough server peers for a 3-peer quorum.

**That isn't enough.** With two browsers + three server peers and
`clusterSize=3`, FRET's responsibility-K selects the three nearest
peers by numeric distance to each blockId. Because peer IDs are uniform
random, browser peers end up in the cluster for many blocks (≈ 60%
each), and for ≈ 30% of blocks **both** browsers are in the cluster.

Browsers can't accept inbound libp2p connections (no listen addrs,
no circuit-relay reservation in the current config). So when pageA
tries to `pend` a block whose cluster includes pageB, the dial to
pageB hangs until the 30s NetworkTransactor timeout; the local commit
falls through to `storageRepo` (pageA's IndexedDB), pageA sees its own
row immediately, but the block was never replicated. pageB then asks
the same (deterministic) cluster for the block, hits the same
unreachable members, and reads empty.

## Required outcome

The three failing specs pass:

- `e2e/distributed/two-tab-convergence.spec.ts` — A sends → B sees,
  B edits → A sees, A deletes → B sees.
- `e2e/distributed/cross-tab-activity.spec.ts` — concurrent writes
  from A and B converge to the same set, both sides' activity is
  newest-first.
- `e2e/distributed/disconnect-mid-session.spec.ts` — A's first send
  reaches B, A disconnects → solo with local cache intact, B remains
  distributed and error-free.

## Design space (not yet committed)

A few shapes are plausible. The ticket promotor should weigh them
during the `plan/` stage:

### Option A — `joining`/`thin-client` distinction in db-p2p

Today `libp2p-node-base.ts` sets `networkMode: 'joining' | 'forming'`
based on whether bootstrap nodes are provided. Both modes still enroll
the peer as a cluster member. Add a third mode (or a flag) — say
`role: 'cluster-member' | 'thin-client'` — that:

- Marks the peer as ineligible in `Libp2pKeyPeerNetwork.findCluster`'s
  responsibility-K calculation (the peer is **not** included as a
  candidate cluster member, even though it's a fully participating
  libp2p peer).
- Skips `clusterMember(...)` wiring entirely on the local node — there's
  no need for the browser to run the cluster-member service, take
  promises, or serve `storageRepo` to remote callers.
- `CoordinatorRepo` continues to work on the browser as a client of
  the remote cluster: `findCluster` returns server peers only,
  `executeClusterTransaction` dials server peers, and the result is
  applied locally for read caching.

This is the architecturally honest option. It also implies the
browser's `NetworkTransactor.getRepo` should never route to "self" —
it always goes to a RepoClient against a server peer.

### Option B — peer-set filtering at the FRET layer

A narrower change: have FRET's responsibility-K respect a per-peer
"capabilities" tag (e.g. via libp2p peer record metadata) so peers
that advertise themselves as `dial-only` are skipped in cluster
selection. Less invasive than Option A but spread across both libp2p
and db-p2p, and the browser would still wear the cost of running the
cluster-member service for no purpose.

### Option C — accept the limitation, force `clusterSize: 1`

Documented in the parent ticket as not generally working: with
clusterSize=1, FRET picks **the** single nearest peer; if that's a
browser, the same hang re-emerges. Only viable if combined with one
of Options A/B's "exclude browsers from selection" mechanic — at
which point pick a real cluster size instead.

## Out of scope / explicit follow-ups

- Real-time push (gossip / sync subscription wiring) — the current
  cross-tab convergence is poll-based, and the 4s poll cycle still
  rules even after this lands.
- README's manual "Two-tab convergence test (acceptance check)" — once
  thin-client lands, the human-facing demo path with a single
  `--offline` peer truly **cannot** converge two browsers (because the
  cluster has no replicas). Either prescribe the 3-node mesh for the
  manual demo, or replace it with a single-browser scenario that
  exercises the same code paths against `pageA` + the bootstrap REPL.

## Acceptance criteria

- All 6 Tier 2 specs pass on a clean checkout (`yarn workspace
  @serfab/reference-app-web test:e2e --grep "Tier 2"` → 6 passed).
- Full sweep is 16/16 (`yarn workspace @serfab/reference-app-web
  test:e2e` → 16 passed, 10 Tier 1 + 6 Tier 2).
- No regression in `@optimystic/db-p2p`'s own test suite — thin-client
  mode is additive.
- README's Tier 2 fixture resolution section, if changed, accurately
  reflects whatever new manual-demo recipe lands.

## Risks

- The change reaches into `@optimystic/db-p2p` and likely touches its
  cluster-coordination spine. Coordinate with any in-flight db-p2p
  work; this is **not** a sereus-only ticket despite the user-facing
  surface being the web reference app.
- A cleaner alternative might exist on the libp2p side: registering
  the browser as a circuit-relay client with an active reservation
  would let the cluster dial it via relay. That doesn't change the
  fact that browsers are slow / unreliable as cluster members, but it
  would unblock the spec without touching db-p2p. Worth evaluating
  during planning.
