----
description: When a third machine joins a group, one of the machines already there can keep seeing that newcomer's old, address-less directory entry for a full 45 seconds after the newcomer has published its real address — so it never learns how to reach it. No error is raised anywhere; the read just quietly returns the older version.
prereq:
files: packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/cadre-node.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts
difficulty: hard
repro: verified
----

# A silent stale read: node B never sees node C's signed address refresh

## What happens

`bootControlTrio` (`packages/integration-tests/src/harness/control-trio.ts`) brings up three
control nodes: **A** (owner + storage), **B**, and **C** (vouched by A). Its last step waits for
B to resolve C's signed `CadrePeer` address record.

Step 5 — C self-publishes — **succeeds**: `C.registerSelf()` returns `refreshed` and logs a row
with one address and a real signature. Step 6 then fails: for the full 45 s, every
`B.resolvePeerAddrs(cPeerId)` returns the *earlier* revision of the same row — the one A wrote
when it vouched C, which by design carries no address and no signature:

```
resolvePeerAddrs: signature verification failed for 12D3KooWBFzx… (updatedAt=1786510940273, addrs=[], sig=(empty))
```

`sig=(empty)` is not a bad signature; it is the owner-vouch revision. B is reading a stale
version of a row that has already been committed at a newer version elsewhere, and **nothing
anywhere reports an error** — no exception, no absence, no retry exhaustion.

## Blast radius

Two integration suites fail their shared `beforeAll` gate on this:

- `control-cohort-three-node-isolation.integration.ts` — 2 of 3 plain runs, 1 of 3 runs with
  debug namespaces enabled (extra logging widens the boot window; the failure is a race).
- `control-write-degraded-cohort-member.integration.ts` — 1 of 3 runs, reported as all 6 tests
  skipped.

In production the same shape means a member that cannot dial a newly joined machine until
something else refreshes its view.

## What has been ruled out (measured 2026-08-11, both sibling repos clean and rebuilt)

Diagnosed against `../optimystic` at `f02be8e` with `DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node'`,
one captured failing run:

- **Not the coordinator cache.** This was the prior explanation and it is now fixed upstream
  (`../optimystic/tickets/complete/coordinator-cache-poisoned-by-boot-time-self-selection.md`).
  The fix is live and firing: `coordinator-cache:self-write-ignored` appears **3771** times in the
  failing run, so no node ever caches itself as a key's coordinator. The failure survives it
  unchanged, with the identical `sig=(empty)` fingerprint.
- **Not network scoping, and not the 16-wide cohort this ticket's predecessor fixed.** Cohort
  widths in the failing run are 1, 2 and 3 (842 / 738 / 440 calls), and the membership filter is
  active (`foreignDropped=1` on 42 calls). The transactor and the node share one correctly
  configured key network.
- **Not any known failure class.** The failing run contains zero occurrences of
  `header block read as absent`, `peers-unreachable`, `SyncRetryExhausted`, `no-quorum`,
  `Missing block`, `Cannot add to non-existent chain`, or `grace-period-not-elapsed`.

## The leading hypothesis, and what would confirm it

B answers its own read from its own replica, and its replica missed C's refresh.

Supporting evidence from the same run: `shouldAllowSelfCoordination` returned
`self-coord-allowed: extended-isolation` **2176** times, and `findCoordinator` resolved
`source=fret` 3724 times against `source=cache` 855. The FRET tier keeps SELF as a candidate
regardless of whether it is connected (`isSelfAdmissible()` in
`../optimystic/packages/db-p2p/src/libp2p-key-network.ts`), so a node that is key-proximate for the
`CadrePeer` collection tree can coordinate its own read. C's refresh commits on whatever cohort
exists at that instant, which need not include B — leaving B authoritative for a key whose newest
revision it does not hold, with no path that makes it ask.

**Not proven**, and this is the first thing the next agent should nail down: the optimystic
key-network debug lines carry no peer id, and all three nodes share one vitest process, so no
captured line attributes a coordinator decision to B specifically. Two ways to close it:

- add a peer-id prefix to the key-network log lines (sibling-repo edit), or
- probe B's and A's raw block stores at the moment of the stale read
  (`packages/integration-tests/src/harness/block-store-probe.ts` exists for exactly this) and show
  that A holds the newer revision while B answers from its own older one.

If confirmed, the root cause is upstream in `libp2p-key-network.ts` / the coordinator repo's read
path, not in this repository, and this ticket should be re-filed as a `blocked/` dependency plus an
upstream ticket in `../optimystic/tickets/fix/` — the same route
`control-coordinator-answers-absent-without-asking-cohort` took. That closed ticket is the closest
relative: it fixed the case where a coordinator answers a remote read as an authoritative
**absence** without consulting its cohort. This is the sibling case — an authoritative **stale
present revision** — and the fix that landed for the first (dropping `skipClusterFetch` on the repo
protocol in `db-p2p/src/repo/service.ts`) does not cover a read that never leaves the node.

## Reproduce

From `packages/integration-tests`:

```
npx vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

Run it at least three times — it is a boot race, so a single green run proves nothing. For
diagnosis:

```
DEBUG='optimystic:db-p2p:libp2p-key-network,sereus:cadre:node' \
  npx vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

The instrumentation that makes this visible is permanent and already in place:
`packages/cadre-core/src/cadre-node.ts` logs `updatedAt`, `addrs` and a signature prefix on the
`resolvePeerAddrs` verification failure, and a signature prefix on both `registerSelf` success
paths. Keep it.
