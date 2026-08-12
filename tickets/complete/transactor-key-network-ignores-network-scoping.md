----
description: The database layer used to build its own second copy of the peer-discovery component, so writes forgot which network they were on and how many machines to copy to. Fixed upstream and now consumed here; this repo's documentation, test harness and failure ledger were brought in line, and a three-machine test that was blamed on the same bug turned out to be failing for a different, still-unsolved reason.
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/control-cohort.ts, docs/architecture.md, tickets/.pre-existing-known.md
----

# Complete: transactor and node share one key network

## What the fix is

A **key network** answers two questions for a given piece of data: *which peers should hold it*
(`findCluster`) and *which peer coordinates this write* (`findCoordinator`). `createLibp2pNode`
builds exactly one per node — with that node's configured cluster size, network mode, persistence,
reputation and the protocol prefix that scopes discovery to peers serving this network — and
attaches it as `node.keyNetwork`.

The Quereus collection factory used to ignore that and construct a **second** one from Optimystic's
defaults. Every database write therefore ran against a 16-wide cohort with network scoping off — a
different peer set and a different coordinator than the same node's own consensus path derived for
the same key. `resolveKeyNetwork` now prefers the attached instance; the no-attached-key-network
fallback (a node injected by a host that did not build it through `createLibp2pNode`) still
constructs one, but states `DEFAULT_CLUSTER_SIZE` and passes the protocol prefix through so
discovery stays scoped.

**Both halves are upstream in `../optimystic`** (`b55bda5` implement, `02d5a00` review). Sereus
consumes them; nothing here implements the fix. What this repo carries is consumption, validation,
documentation, permanent debug instrumentation, and the successor tickets below.

The strongest guard is not a test: `Libp2pKeyPeerNetwork`'s constructor now takes `clusterSize` as a
**required** argument, so a caller that silently defaults the cohort width is a compile error.

## Changes in this repo

- `packages/cadre-core/src/cadre-node.ts` — permanent, debug-gated instrumentation, kept
  deliberately: the `resolvePeerAddrs` signature-verification failure log carries the row's
  `updatedAt`, `addrs` and a signature prefix, and both `registerSelf` success logs carry a
  signature prefix. This is what makes the stale-read failure below diagnosable at all.
- `packages/integration-tests/src/harness/forced-cluster.ts` — header rewritten. It documented at
  length that every node has TWO key networks and that only a prototype patch covers both; that is
  no longer true. The prototype patch stays, and the header now states the real reason (see review
  findings).
- `packages/integration-tests/src/harness/control-cohort.ts` — the same stale two-key-networks claim
  in `observeControlCohorts`'s header, missed by the implement pass, corrected in review.
- `docs/architecture.md` → "Replication cluster size" — new bullet, "One key network per node, so
  one cluster size and one network scope", plus a tripwire note on the shared coordinator cache.
- `tickets/.pre-existing-known.md` — three boot-gate entries re-attributed away from this ticket,
  and one entry re-attributed off a closed owner in review.
- New: `tickets/fix/control-peer-row-refresh-invisible-to-third-node.md`,
  `tickets/backlog/debt-strand-write-breadth-observed-end-to-end.md`,
  `tickets/backlog/bug-strand-join-dies-on-missing-block.md` (review).
- `tickets/implement/control-write-retry-scenario-coverage.md` — arm appended for a second, distinct
  failure in a scenario that ticket already owns.

## The headline finding: the regression this ticket was blocked on is NOT fixed

This ticket had sat in `blocked/` waiting on an Optimystic defect — a node that picked itself as
coordinator before its first dial completed cached that pick for 30 minutes and then served its own
stale replica.

**It landed, it is live, and the failure it was supposed to explain is unchanged.** In a captured
failing run `coordinator-cache:self-write-ignored` fires **3771** times, so no node ever caches
itself as a coordinator, and `control-cohort-three-node-isolation` still fails 2 of 3 plain runs
with the byte-identical fingerprint. The cache was not the cause.

What the failure actually looks like: node C successfully publishes its signed address record (the
harness step that waits for that **passes**), and node B then reads the *previous* revision of C's
row — the address-less owner-vouch one — for the full 45 s, with no error raised anywhere. Ruled out
by measurement: the coordinator cache, network scoping (cohorts measured at 1/2/3 wide with the
membership filter dropping foreign peers, not 16), and every known failure fingerprint. The leading
hypothesis — B answers its own read from a replica that missed the write — is recorded explicitly as
**not proven**, with the two experiments that would settle it, in
`tickets/fix/control-peer-row-refresh-invisible-to-third-node.md`.

## Validation (review pass, both sibling repos clean, whole workspace rebuilt)

`../optimystic` clean at `f02be8e`; declared floor `^0.22.0` (released 2026-08-08) contains the fix,
so the published dependency and the linked working copy agree.

| check | result |
| --- | --- |
| `yarn build` (root) | pass |
| `yarn lint` | exit 0 |
| `integration-tests` `typecheck` | exit 0 |
| `cadre-core` unit suite | 92 files, 1506 passed, 1 skipped |
| `quereus-plugin-sereus` suite | 76 passed, **1 failed**, 1 todo |
| `control-cohort-harness-helpers` | 18 passed |
| `happy-path` + `control-db-two-node-convergence` | 3 passed |

The one plugin failure is `test/e2e/networked.e2e.spec.ts` dying with `Missing block` — pre-existing
and ledgered, now re-owned (see findings).

Implement-pass results carried forward: `control-cohort-auto-convergence`,
`control-cohort-cold-start-retry`, `control-write-while-alone-convergence` all pass;
`control-cohort-three-node-isolation` ×3 → 1 pass / 2 boot-gate fails;
`control-write-degraded-cohort-member` ×3 → 1 pass / 1 boot-gate fail / 1 super-majority fail.

## Review findings

**Checked:** the upstream diff both halves of the fix live in; every Sereus site that could
construct or consume a key network (`grep` for `Libp2pKeyPeerNetwork`, `keyNetwork`,
`DEFAULT_CLUSTER_SIZE`, `registerLibp2pNode` across the repo, excluding tickets); the declared
dependency floor against the release that carries the fix; every doc that mentions the key network,
the collection factory or the transactor (`docs/architecture.md`, `docs/STATUS.md`,
`docs/cadre-consistency.md`, `docs/strands.md`, `docs/releasing.md`); the test edit swept into the
implement commit; the two new tickets and the ledger edits; lint, build, typecheck and the suites
above.

**Fixed in this pass (minor):**

- `packages/integration-tests/src/harness/control-cohort.ts` — `observeControlCohorts`'s header still
  asserted "each node has two `Libp2pKeyPeerNetwork` instances … an instance patch would miss the
  transactor's". Same false claim the implement pass corrected in `forced-cluster.ts`, in the sibling
  file on the same seam. Rewritten to match reality.
- `packages/integration-tests/src/harness/forced-cluster.ts` — the rewritten header justified keeping
  the prototype patch on *simplicity* ("only some node shapes expose the key network"), which is the
  weaker half of the truth and is undercut by `control-cohort.ts` already resolving an attached key
  network off a `Libp2p` in one line, with a test for the missing case. The hard reason was missing:
  `observeControlCohorts` takes **no** node list — it records cohorts from nodes it was never handed
  — so an instance patch is not available to it at all, and the three helpers must patch the same
  seam the same way to compose under the documented restore ordering. Header now leads with that.
- `tickets/.pre-existing-known.md` — the `networked.e2e.spec.ts` entry pointed at
  `control-coordinator-answers-absent-without-asking-cohort | blocked`, with a "do not re-triage"
  directive. That ticket is in `complete/`; its closing measurement lists what its fix cleared and
  this suite is not on the list. The entry was sending readers to a nonexistent file for a live
  failure. Re-pointed, with the contradiction stated.

**Filed (major):**

- `tickets/backlog/bug-strand-join-dies-on-missing-block.md` — the failure behind that dangling
  ledger entry, re-measured still-red in this pass (1 of 78). Two successive attributions for it
  have now proved wrong, so the ticket deliberately asserts no diagnosis; it names what a diagnosis
  pass has to establish and which of the two repositories each answer would implicate. Filed to
  `backlog/` rather than `fix/` because it is an intermittent ~1-in-9 draw with no current
  hypothesis, and the site-claim grep found no open ticket touching that file.

**Recorded as a tripwire, not a ticket:**

- Consolidating onto one key network also consolidates its per-key coordinator cache, so a wrong
  cache entry now misroutes both the consensus path and the transactor rather than one of them.
  Fine by design — the two *should* agree on a key's coordinator, which is the point of the
  consolidation — so it is parked as a `NOTE:` on the new `docs/architecture.md` bullet with its
  revisit condition, not queued as work. Parked in the doc rather than at a code site because the
  code site is upstream.

**Considered and not filed:**

- The test edit swept into the implement commit
  (`packages/cadre-core/test/control-revocation-replay.spec.ts`) swaps an `AuthorizedReissue` probe
  from a forged-signature envelope to a null-context one, which reads as a weakened assertion. It is
  not: the wrong-digest and non-owner shapes are covered by
  `control-revocation-reissue.spec.ts:232`, and the replay spec's probe only needs a shape that
  reaches the named constraint. No coverage lost.
- The declared floor `@optimystic/db-p2p ^0.22.0` was checked precisely because the fix lives
  upstream and this repo consumes it through a `link:` resolution — a consumer installing from the
  registry could otherwise get the buggy behaviour. v0.22.0 was cut three days after the fix landed,
  so the floor is correct and no ticket is owed.
- `docs/STATUS.md`'s dated narrative entries about cross-network coordinator selection assert that
  the protocol prefix is "threaded by `createLibp2pNode`, so all sereus nodes get it". That was
  false when written (the transactor's second instance missed it) and is true now, so it was left
  alone rather than annotated.

**Empty categories, with reasons:**

- *No correctness defect found in the change itself.* The Sereus-side diff is documentation, a
  harness header, ledger bookkeeping and new tickets — there is no behavioural code in it to be
  wrong. The behaviour lives upstream and is covered by that repo's spec, including its
  foreign-node fallback branch.
- *No source-hygiene findings.* Nothing here added or grew a source file; the two edits shrank
  inaccurate comment blocks rather than adding to them.
- *No new test gaps filed.* The one real gap — nothing in this repository counts how many machines
  physically hold a block after a strand write — was already weighed and filed by the implement pass
  as `backlog/debt-strand-write-breadth-observed-end-to-end`, with its two confounds and an honest
  tradeoffs line. Re-reviewed and left as filed; if defence-in-depth here is worth the flakiness
  budget, that is the ticket to promote.

## Known gaps, stated plainly

- The three-node boot gate fails 2 of 3 runs and neither pass fixed it. Owned by
  `fix/control-peer-row-refresh-invisible-to-third-node`, whose hypothesis rests on aggregate log
  counts from a single captured failing run — the optimystic debug lines carry no peer id and all
  three nodes share one vitest process, so nothing attributes a coordinator decision to node B
  specifically. Everything downstream of that is inference, and it says so.
- The degraded-cohort `0/3 approvals, 0 rejections` failure has no cause at all, only a recorded
  fingerprint, tracked as an arm on `implement/control-write-retry-scenario-coverage`.
- No test in this repository observes the cohort width a strand write actually used.
