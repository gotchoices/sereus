----
description: When a third machine joins a group, one of the machines already there can end up with its own private, permanently out-of-date copy of the shared member directory — so it never learns how to reach the newcomer. It keeps writing to its private copy successfully, and nothing anywhere reports a problem. The code that would notice and merge the two copies lives in a separate repository, so it cannot be fixed here.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts, ../optimystic/packages/db-core/src/transactor/transactor-source.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/cadre-core/src/cadre-node.ts
difficulty: hard
repro: verified
----

> **Correction 2026-08-24 — one of the two arms this repo has been reporting was already fixed
> upstream, and had been since 2026-08-12.**
>
> The upstream ticket filed tonight led with the claim that `CoordinatorRepo.get` acts on an
> `inconclusive` outcome only when the block is **missing**, so a present-but-stale block is
> returned to the caller as authoritative. That is quoted from this ticket's own 2026-08-12
> analysis, and it is **no longer true** — `../optimystic`'s `coordinator-serves-stale-data-as-if-confirmed`
> fixed it and was reviewed 2026-08-12; the fix stage re-verified that tonight. The claim was
> carried forward here for twelve days without being re-read against the code it describes.
>
> **The other arm is real, and is now measured rather than argued.** The repair genuinely cannot
> converge in this shape, and the arithmetic that decides it was swept directly
> (`resolveClusterPolicy` / `corroboratorCapacity` / `quorumSize`):
>
> | nodes | peers who answered | capacity | corroborators needed | converges? |
> | --- | --- | --- | --- | --- |
> | 2 | 1 | 1 | 1 | yes |
> | **3** | **1** | **2** | **2** | **NO** |
> | 3 | 2 | 2 | 2 | yes |
> | **4** | **1** | **3** | **2** | **NO** |
> | 4 | 2 | 3 | 2 | yes |
>
> Row 2 is exactly this ticket: three nodes, B can reach only A, so one peer answers, two
> corroborators are required, and no amount of retrying changes that. It is arithmetic, not a race.
>
> **And nothing says so.** 1821 `cluster-fetch:no-quorum` and 954 `read-repair-triggered` in one
> boot, 2 repairs applied, no error raised — a fact the node knew at the moment of every single
> decline, which then cost twelve days to re-derive from logs. Now
> `../optimystic/tickets/implement/1-repair-deadlock-is-never-named.md`, which also reports that the
> cohort-size advice printed at startup is wrong about how many machines are needed.
>
> Note what this does **not** claim: naming the deadlock does not make this scenario converge. It
> converts a silent permanent stall into a loud one. The convergence question stays open on the
> parent fix ticket.


> **Upstream owner filed 2026-08-24 — and the one this ticket named never existed.**
> The body says an upstream ticket
> `../optimystic/tickets/fix/collection-view-forks-silently-when-repair-cannot-reach-quorum.md`
> was "created by this pass". **It is not in that repository** — not on the board, not in
> `complete/`, and no run log, which that repo writes for every ticket it processes. It was never
> created, or was removed without one. So the analysis below sat unowned for twelve days while
> three integration suites failed on it.
>
> Now filed, carrying the measured record verbatim:
> `../optimystic/tickets/fix/1-stale-read-returned-as-authoritative-when-repair-cannot-converge.md`.
> It leads with the half of this that is self-contained and fixable on its own — `CoordinatorRepo.get`
> acts on an `inconclusive` outcome only when the block is **missing**, so a present-but-stale block
> is returned to the caller as authoritative with nothing raised — ahead of the harder convergence
> question.
>
> Two sibling tickets were filed there at the same time and may be the same defect:
> `1-two-node-index-divergence-guard-never-fires` (the shape behind
> `secondary-index-seek-blind-to-sibling-rows`) and, less likely,
> `1-inbound-relayed-connection-addr-is-never-published`. Each cross-references the others.

> **Audit 2026-08-21 — still real, but narrower than the body claims.** Measured across the
> full-suite runs of 2026-08-20 and 2026-08-21, of the four scenarios this ticket names:
>
> | scenario | status |
> | --- | --- |
> | `control-cohort-edge-carries-data` | still fails, both runs |
> | `control-cohort-three-node-isolation` | intermittent — failed one run, passed the other |
> | `control-write-degraded-cohort-member` | **7/7 passing, both runs** |
> | `control-write-while-alone-convergence` | **2/2 passing, both runs** |
>
> The last two no longer demonstrate anything. That does not clear the ticket — the fork it
> describes is still visible through `control-cohort-edge-carries-data` — but anyone re-measuring
> should not expect those two to reproduce it, and the blast radius stated in the body is wider
> than what is currently observable.

# Blocked (b): node B's control collection silently forks and never merges back

**Category (b) — dependency outside this repo.** Everything that must change is in the
sibling checkout `../optimystic` (`@optimystic/db-core` and `@optimystic/db-p2p`), which
Sereus consumes from its built `dist`. Nothing in this repository can make the failing
scenarios pass.

**Upstream ticket filed:** `../optimystic/tickets/fix/collection-view-forks-silently-when-repair-cannot-reach-quorum.md`
(created by this pass, carrying the full measured record and the reproducer recipe).

**Unblock condition:** an optimystic fix that makes a node whose collection view has
diverged either (a) detect the divergence and merge, or (b) refuse to answer reads from
the diverged view, landed and rebuilt
(`cd ../optimystic && yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-p2p build`).
Then re-run the scenarios below at least five times each and remove this ticket's entries
from `tickets/.pre-existing-known.md`.

This is very probably the **same upstream defect** as
`tickets/blocked/forked-control-collection-sync-livelocks.md` — same collection, same file
(`db-core/src/collection/collection.ts`) — seen from its silent side. That ticket's fork
announces itself as `SyncRetryExhaustedError`; this one never raises anything at all. Both
tickets should clear on one upstream fix; keep them separate only until that fix lands,
because their fingerprints and their failing suites are different.

## What a user sees

Three machines, A (the owner) plus B and C. C joins last. C publishes its network address
into the shared `CadrePeer` directory. A sees it. C sees it. **B never does** — not in the
45 s the test waits, and not afterwards. B cannot dial C, so the two never connect. No
exception is thrown, nothing is logged as an error, and B keeps serving reads and
committing writes to the directory perfectly happily. It is simply reading a different
history of the same table from everyone else.

## Blast radius

Three integration suites fail their boot gate on this (all already listed in
`tickets/.pre-existing-known.md` against this slug):

- `control-cohort-three-node-isolation.integration.ts`
- `control-write-degraded-cohort-member.integration.ts` (boot gate)
- `control-cohort-edge-carries-data.integration.ts` (boot gate)

Measured hit rate this pass: **5 failures in 66 consecutive boots** of `bootControlTrio`
(runs of 10, 25, 25, 25, 25, 25 attempts, aborting each run at the first failure — so
failures landed at attempt 3, 3, 5, 10 and 2 of their respective runs). It is a boot race;
a single green run proves nothing.

In production the same shape is a member that can never dial a newly joined machine, with
no error to act on and no self-healing path.

## What was measured, 2026-08-12

Six runs of a throwaway probe scenario (since deleted) that boots `bootControlTrio` in a
loop until step 6 fails, then interrogates the trio. It patched
`Libp2pKeyPeerNetwork.prototype.findCoordinator` / `findCluster` through the existing
`packages/integration-tests/src/harness/key-network-patch.ts` so every routing decision
could be attributed to the node that made it — the peer-id attribution the predecessor
ticket asked for. Sibling repos clean and freshly built; `DEBUG='optimystic:db-p2p:coordinator-repo'`.

**1. B's view is stuck, permanently, and A's and C's are not.** Sampled every 2 s after the
failure, byte-identical in all five failing runs:

```
A[updatedAt=1786519567099 addrs=1 sig=piX_ESleUqHy]
B[updatedAt=1786519566062 addrs=0 sig=(empty)]     ← the owner-vouch revision
C[updatedAt=1786519567099 addrs=1 sig=piX_ESleUqHy]
```

**2. B routes that block to itself; A and C route it elsewhere.** Over one failing boot,
B called `findCoordinator` 2548 times and picked itself 1657 times; for the `CadrePeer`
data block specifically it picked itself **930 of 930 times**, while A picked B and C
picked A for the same block.

**3. Routing is NOT the cause.** Forcing every coordinator to A (`pinCoordinator([A])`,
confirmed live: 16 pinned `findCoordinator` calls served during the probe) and re-reading
on B still returns **0 addresses**. B asks A, and A answers — with the old revision,
honestly, because the read is context-pinned: `TransactorSource.tryGet` passes
`context: this.actionContext` on every read, so a collection sitting at an old revision
asks every peer for that old revision's view and gets it.

**4. B is not merely behind — it has FORKED.** After the failure, `B.registerSelf()` returns
`refreshed`, i.e. B successfully commits a brand-new revision to that very same
`CadrePeer` table — and B's read of C's row is *still* the pre-refresh revision.
`B.reconcileControlCohort()` afterwards changes nothing either. B is committing on a
lineage that does not contain C's refresh, and the commit is accepted. (Control writes run
with cohort downsizing allowed, so a node can commit alone; see
`packages/quereus-plugin-sereus/src/cluster-size.ts`.)

**5. The safety net that should catch this is measurably dead.** B's lazy read-repair fires
constantly on `default/CadrePeer` and on the collection's data block, and **every single
pass fails the same way**:

```
cluster-fetch:no-quorum { blockId: 'default/CadrePeer', responders: 1, required: 2 }
```

1821 `cluster-fetch:no-quorum`, 954 `cluster-tx:read-repair-triggered`, 952
`cluster-tx:read-repair-noop`, 2 `read-repair-applied` in one run. The cohort B sees for
that block is all three peers `[A, B, C]`, so `corroboratorCapacity` is 2 and the
corroboration floor stays at 2 (`db-p2p/src/cluster/quorum-restore.ts`). B can reach only
A. **The second corroborator B needs is C — and C is unreachable precisely because the
record being repaired is C's address.** The dependency is circular, so the repair can never
converge, and `CoordinatorRepo.get` discards the inconclusive outcome for a
present-but-stale block (it acts on `inconclusive` only under `if (isMissing && ...)`), so
the stale revision is returned to the caller as an authoritative answer with no flag.

## What this rules out

The predecessor ticket's leading hypothesis — "B answers its own read from its own replica"
— is **half right and not the root cause**: B does self-coordinate the block (finding 2),
but finding 3 shows that taking that away fixes nothing. The coordinator cache
(`coordinator-cache-poisoned-by-boot-time-self-selection`, fixed upstream), network
scoping, and the 16-wide cohort were already ruled out by that ticket and were not
revisited.

## Reproduce

From `packages/integration-tests`, at least five times — it is a boot race:

```
npx vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

For diagnosis:

```
DEBUG='optimystic:db-p2p:coordinator-repo,sereus:cadre:node' \
  npx vitest run src/scenarios/control-cohort-three-node-isolation.integration.ts
```

Permanent instrumentation already in place and worth keeping:
`packages/cadre-core/src/cadre-node.ts` logs `updatedAt`, `addrs` and a signature prefix on
the `resolvePeerAddrs` verification failure, and a signature prefix on both `registerSelf`
success paths. The per-node routing attribution used above is not permanent — it was a
throwaway scenario built on `harness/key-network-patch.ts`; the recipe is in the upstream
ticket.

## Note on scope

There is a Sereus-side lever here — control writes are allowed to commit on a downsized
(possibly one-member) cohort, which is what lets B's branch exist at all. It is deliberate
and load-bearing: a one-node party must be able to write, and
`control-write-while-alone-convergence.integration.ts` exists to hold that behaviour. Taking
it away is a product decision, not a bug fix, and it would not repair a fork that has
already happened. Left alone here on purpose.
