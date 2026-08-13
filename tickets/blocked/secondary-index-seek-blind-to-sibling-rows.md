----
description: A row written on one machine replicates to the others, but any lookup that goes through a secondary index on another machine never finds it — silently, forever. The bug is in the separate database-engine project, so it cannot be fixed here; until it is, invitation seat counts are wrong across machines.
prereq:
files: ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, ../optimystic/packages/db-core/src/collection/collection.ts, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts, schemas/control.qsql
difficulty: hard
repro: verified
----

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
