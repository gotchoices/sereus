----
description: A row written on one machine replicates to the others, but any lookup that goes through a secondary index on another machine never finds it — silently, forever. The bug is in the separate database-engine project, so it cannot be fixed here; until it is, invitation seat counts are wrong across machines.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/db-core/src/collection/collection.ts, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, schemas/control.qsql
difficulty: hard
repro: verified
----

> **Correction 2026-08-24 — the re-attribution suggested above is REFUTED. This ticket's own title
> was right all along.**
>
> The note added earlier today argued that each node holding only its own row is symmetric, that
> index blindness should not be symmetric, and that the fork tickets were therefore at least as good
> a fit. Upstream settled it against that reading, using **this repo's own control measurement**: on
> the same sibling, in the same window, a **primary-key descent converges** while the
> **secondary-index seek does not**, and a **full scan of the same table sees the row**. A forked or
> unrepaired data collection cannot produce that combination — it would fail the scan and the PK
> descent too. So this is *not* the same defect as `forked-control-collection-sync-livelocks` or
> `control-peer-row-refresh-invisible-to-third-node`, and the secondary-index attribution stands.
>
> Two more things ruled out by measurement rather than argument:
>
> - **The corroboration floor is not involved.** This repo declares `assumedClusterSize: 2` in both
>   its control and strand cluster policies, and has since 2026-08-02 — twenty days before the
>   failing measurement — so for a two-machine cohort the floor relaxes to one voter and repair is
>   possible. (This does **not** transfer to the three-node fork ticket, whose cohort has two other
>   peers and therefore a capacity of 2 regardless; that ticket's arithmetic is unchanged.)
> - **The guards from the two completed upstream tickets cannot fire here, and no change to them
>   would help.** They throw when the planner routes a seek into an index the table does not
>   maintain. Each machine *does* serve its own rows through that same seek, which proves it
>   maintains the index. The guard is correct; its condition is simply absent.
>
> **Still not reproducible upstream — now on real libp2p, not just the mock mesh.** A new
> two-real-node spec drives two Quereus databases over two `NetworkTransactor`s against an indexed
> table under *this repo's* cluster configuration (replication factor 16, `assumedClusterSize: 2`),
> sequential and concurrent. Both converge. So the trigger is not the mock transport, not write
> concurrency, not the cluster-size configuration, and not composite text primary keys.
>
> **What this repo has to do next.** Upstream is landing `1-name-the-collections-a-write-carries`:
> two log lines naming which collections a write actually staged and flushed. It fixes nothing by
> design — it makes the twelve-day-old claim ("the index collection is absent from the write
> transaction entirely") decidable from a log for the first time. Three investigations have now
> ended in source-reading because no log could answer it. **Once it lands, re-run
> `strand-formation-concurrent-redemption` here with that logging enabled and capture the output** —
> this is the only machine where the defect reproduces, so this repo is where the answer lives.
>
> The remaining differences between the passing upstream instrument and the failing run here are
> host wiring, not distributed-systems behaviour: the sibling opens its database by catalog
> **hydration** rather than a re-declared `create table`, it runs a write-through raw-storage cache,
> and the two machines hold different node roles.


> **Upstream re-filed 2026-08-24, and the previous attempt's conclusion matters more than this
> ticket knew.** The 2026-08-21 audit above asked someone with `../optimystic` open to check what
> that repo's 2026-08-13 fix stage concluded. Done — the run log survives and says:
>
> - It **corrected this ticket's log reading.** The 3-block pend is all *data*-collection blocks for
>   a first commit, and `NetworkTransactor.commit` legitimately splits the tail from the rest.
>   Nothing was being dropped. The sharper symptom is that the index collection is absent from the
>   write transaction entirely.
> - It **could not reproduce** — eight two-node shapes on that repo's mock mesh all converged.
>   "Trigger needs something the mock mesh lacks."
> - It filed two tickets, both since completed
>   (`1-index-maintenance-must-track-the-declared-index-set`,
>   `1.5-schema-catalog-index-list-is-lossy`), and said plainly that they do **not** verify this
>   symptom fixed — "what they guarantee is that the divergence becomes a named error instead of
>   empty rows."
>
> **That guarantee is not holding, which is the new information.** Measured 2026-08-22 against
> `v0.24.2` with both landed, the failure is still a 30 s timeout on empty rows with nothing raised.
> Re-filed as `../optimystic/tickets/fix/1-two-node-index-divergence-guard-never-fires.md`.
>
> **And the attribution may be wrong.** Each node holds exactly its *own* row and neither sees the
> other's — symmetric. Index blindness is not obviously symmetric: a node that never maintained an
> index should fail to find any row through it, including one it wrote itself. That reads at least
> as much like the collection views having forked, which is
> `control-peer-row-refresh-invisible-to-third-node` and `forked-control-collection-sync-livelocks`.
> The upstream ticket asks that question first rather than assuming this ticket's title.

> **Audit 2026-08-21 — still real, evidence refreshed.** The symptom reproduces:
> `strand-formation-concurrent-redemption` fails all 3 cases in both full-suite runs on 2026-08-20
> and 2026-08-21. Two corrections to the body below, neither changing the conclusion:
>
> - The measurement context is stale. It says the defect was measured against `../optimystic`'s
>   built `dist` at **0.22.0, clean at `6cc08ac`**. That checkout is now at **0.24.2** and the
>   failure is unchanged, so this is not a regression that a rebuild fixes.
> - The upstream ticket it names,
>   `../optimystic/tickets/fix/secondary-index-update-never-reaches-the-sibling.md`, is **no longer
>   on that repo's board**. Only a run log survives
>   (`../optimystic/tickets/.logs/secondary-index-update-never-reaches-the-sibling.fix.2026-08-13…log`),
>   which means it was picked up and processed on 2026-08-13 and has since aged out of `complete/`
>   — that repo prunes completed tickets after 30 days. Whether a fix landed cannot be told from
>   here; what *can* be told is that the symptom persists. Someone with `../optimystic` open should
>   check what that fix stage concluded before any more work is spent here.

# Blocked (b): a secondary-index seek on a sibling node never sees replicated rows

**Category (b) — dependency outside this repo.** The defect is in the distributed commit
path of the sibling checkout `../optimystic` (consumed from its built `dist`, 0.22.0,
clean at `6cc08ac` when measured): an insert into a table with a secondary index
replicates the data tree but never replicates (or re-derives) the index update, so the
sibling's index root stays at its schema-init empty state and every index descent there
honestly finds nothing. Nothing in this repository can make the failing scenario pass.

**Upstream ticket filed:** `../optimystic/tickets/fix/secondary-index-update-never-reaches-the-sibling.md`
(created by this pass; carries the pend/commit log evidence — the insert transaction pends
3 blocks including the new index leaf, commits only 2, and the index collection's HEADER
block is never in the transaction at all).

**Unblock condition:** an optimystic fix that makes a sibling's index-seek find a row once
the data tree has converged, landed and rebuilt (`cd ../optimystic && yarn build`). Then
re-run `strand-formation-concurrent-redemption.integration.ts` at least five times, and
remove this ticket's entries from `tickets/.pre-existing-known.md`.

## What was measured, 2026-08-12 (deterministic — 4 of 4 runs across two shapes)

Two-node party booted with connect-then-write ordering (`bootConnectedPair`: control
cohort of 2 confirmed on BOTH sides before the first control write), so none of this is
the old write-while-alone / one-member-cohort arm.

- **Sequential, single writer:** one `FormationUsage` insert via node A. The cluster
  commit is healthy — `cluster-member update-complete { promiseCount: 2, commitCount: 2 }`,
  both nodes' block storage commits the data blocks. B's **full scan**
  (`select PeerKey from CadreControl.FormationUsage`) sees the row within seconds. B's
  **index seek** (`… where Token = ?`) sees nothing, still nothing after 30 s of 250 ms
  polls. No error anywhere; B's read-repair no-ops; B reports
  `cluster-fetch:local-current { localRev: 1, clusterRev: 1 }` for the data collection.
- **Control — a PRIMARY-key descent on the same sibling converges fine.** In every run of
  the acceptance scenario, node B reads back A's `FormationInvite` row (`queryFormationInvite`,
  a lookup on the table's own primary key `Token`) inside the same 30 s window that the
  `FormationUsage` secondary-index seek never satisfies; the same holds for A's `Strand` and
  `ValidationKey` rows. So the blindness is specific to *secondary*-index sub-collections, not
  to indexed descent in general — a useful narrowing for whoever takes the upstream fix.
  (Re-confirmed in the review pass, 2026-08-12.)
- **Concurrent, two writers** (the acceptance scenario below): both joiners are approved,
  the approval hook is asked exactly twice, both rows commit — and each node's per-token
  view holds exactly its OWN row (distinct keys confirm attribution). A silent per-index
  split-brain with no merge and no error.

## Blast radius in this repo

- `packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts`
  — all three cases red on this (cases 1 and 2 directly; case 3 is skipped-by-dependency
  since it redeems the invite case 2 establishes). Listed in
  `tickets/.pre-existing-known.md` against this slug. The scenario is correct as written
  and is the re-measurement instrument for the unblock condition.
- **Production shape, not just tests:** every per-token `FormationUsage` read goes through
  the `FormationUsageByToken` secondary index (`schemas/control.qsql`), including
  `ControlDatabase.countFormationUsage` — which is the invitation seat cap
  (`enforceFormationUseCap`) and the outstanding-invite check
  (`hasOutstandingFormationInvite`). A node therefore counts only the redemptions it
  recorded itself: on a multi-machine party the use cap under-counts and **over-admits
  without bound** — well beyond the deliberate, bounded concurrent-race over-admission
  accepted by `formation-unique-token-redesign` — and a spent invite still reads as
  outstanding to the membership connection gate. The `NOTE:` at `countFormationUsage`
  points here.
- Any other cross-node read served by a secondary index has the same exposure; audit once
  the upstream fix lands rather than cataloguing speculatively here.

## Relation to neighbouring tickets

- `strand-unique-index-sync-stale-revision` (blocked) — writes to unique-index
  sub-collections exhausting sync retries (rev 2 / requested rev 1). Both defects are
  index sub-collections misbehaving across nodes and may share a root; fingerprints
  differ (that one throws on the writer, this one is silent on the reader), so they stay
  separate until the upstream fix shows whether one falls with the other.
- `control-peer-row-refresh-invisible-to-third-node` / `forked-control-collection-sync-livelocks`
  (blocked) — the DATA-tree fork family. Distinct: here the data tree converges fine and
  only the index view diverges; and the currency machinery optimystic shipped 2026-08-12
  (`coordinator-serves-stale-data-as-if-confirmed`) cannot flag it, because no peer ever
  holds a higher revision of the index collection to raise doubt against.

---

## Report back from `../optimystic`, 2026-08-24 — two attributions refuted, this one survives

The upstream fix ticket this file asked for
(`../optimystic/tickets/fix/1-two-node-index-divergence-guard-never-fires`) has been worked.
It could not reproduce the symptom and did not land a fix; what it *did* settle is worth
recording here, because two of the three competing explanations this ticket has been carrying
are now closed.

**1. The read-repair corroboration floor is NOT the cause — checked, not assumed.** The upstream
ticket arrived carrying a strong hypothesis from
`../optimystic/tickets/complete/1-repair-deadlock-is-never-named`: a two-machine cohort that
declares no cohort size can never repair a block, permanently and silently, because the
corroboration floor of two can never be met by a single peer. It asked this repo to grep its
startup logs for `cluster-policy` → `repair-fault-tolerance`. **No grep was needed.** This repo
declares `assumedClusterSize: 2` in both `CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY`
(`packages/quereus-plugin-sereus/src/cluster-size.ts`), and has since `42cd12c` on **2026-08-02**
— twenty days before the 2026-08-22 measurement. `corroboratorCapacity(1, 2) = 1`, so the floor
relaxes to one voter and a two-machine cohort repairs normally. Ruled out.

**2. The data-tree fork family is NOT the cause either, and this ticket's own evidence is what
rules it out.** The upstream ticket argued the symmetry (each node holding only its own row) reads
more like two forked collection views than like index blindness, and asked whether this ticket,
`forked-control-collection-sync-livelocks` and `control-peer-row-refresh-invisible-to-third-node`
are one defect. They are not. The controls recorded in this file settle it: on the same sibling,
in the same 30 s window, a **primary-key** descent (`queryFormationInvite`) converges, and B's
**full scan** of `FormationUsage` sees A's row while B's index seek does not. A forked or
unrepaired data collection cannot produce that. **The secondary-index attribution in this ticket's
title stands.**

**3. The guards from the two completed upstream tickets cannot fire on this path, and widening
them will not help.** That guard throws when the query planner routes a seek into an index the
table does not maintain. In the concurrent case each node serves *its own* row through that same
seek, which proves each node does maintain the index. The guard is correct; its precondition is
simply absent here. So "the divergence becomes a named error instead of empty rows" was never
going to hold for this shape — not because the guard regressed, but because it is looking for a
different failure.

**4. Still not reproducible upstream, and the search space is now much smaller.** A new
plugin-layer instrument landed there
(`packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts`):
two **real libp2p** nodes, each driving its own Quereus `Database` over its own
`NetworkTransactor`, against a table with a secondary index, under *this repo's* cluster
configuration (replication factor 16 with `assumedClusterSize: 2`), in both a
sequential-single-writer and a concurrent-both-writers shape. Both converge. Combined with the
existing mock-mesh coverage, the trigger is **not** the transport, **not** write concurrency,
**not** the cluster-size configuration, and **not** composite text primary keys.

What is left is host wiring, and it is all on this side of the boundary: the sibling opens its
control database through catalog **hydration** rather than a re-declared `create table`; it runs
the write-through raw-storage cache (`packages/quereus-plugin-sereus/src/cached-storage.ts`); the
two machines hold different roles (A owner/storage, B plain member/transaction); the index is
declared through the batch schema script (`index FormationUsageByToken on FormationUsage (Token)`)
rather than a standalone `create index`; and the schema carries many tables rather than one.

**What happens next, and what this ticket should do.** Upstream filed
`../optimystic/tickets/implement/1-name-the-collections-a-write-carries` — deliberately
observability only, no behavioural change. It adds two debug lines: one naming every collection id
a write transaction actually carries, and one naming the collection URI each maintained index
resolves to. Those exist specifically so **this** repo's next run of
`strand-formation-concurrent-redemption.integration.ts` can answer, from a log rather than by
reasoning, the two questions nobody has been able to close:

- was the index collection in the commit at all (this ticket's sharpest standing claim), and
- did the two machines commit to the **same** index collection id, or to two different ones?

Two machines resolving different index-tree ids would produce exactly the symmetric symptom
reported here while leaving the main table untouched, and nothing printed today can tell that
apart from "the index was never committed".

**This ticket's unblock condition is unchanged and it stays blocked** — the defect is still
upstream and still unfixed. But when the trace lands and `../optimystic` is rebuilt, re-running
the scenario with the new debug namespace enabled is a cheap, decisive step that does not need to
wait for a fix, and it is the fastest way to give the upstream ticket the one fact it lacks.
