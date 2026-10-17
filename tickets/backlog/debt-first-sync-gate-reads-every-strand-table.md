description: A machine joining a strand waits until it has read the strand's header and every app table before it may write, but not the membership tables it also writes to, so a join whose connection drops at the wrong moment could create a second, conflicting copy of one of those tables and lose its own membership rows.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-first-sync-gate.ts (`appTablesReadable`, `appTableNames`, the probe in the gate loop, the module comment's stated invariant), packages/cadre-core/src/strand-membership-reconciler.ts, docs/strands.md ("What the runtime does" bullets on the gate and on the founder's empty collections)
repro: static
severity: corruption
likelihood: unusual
tradeoffs: Each extra table read on a gated join can cost a relayed round trip on a slow link when backfill has not delivered that table yet, lengthening the time to writable that `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` is sized for, and the fork itself has not been observed and may already be prevented by Optimystic counting a remembered but disconnected peer in the cohort.
----
# The first-sync gate does not read the `Strand` tables a joiner writes

## The gap

The first-sync gate (`strand-first-sync-gate.ts`) holds a joining machine's database back until it holds `Strand.Header` and a read of every `App` table has settled. Its stated reason: a write to a table whose collection this machine has not fetched creates a new collection, and with no strand peer connected Optimystic's cohort is the machine alone, so that new collection is a second history beside the founder's; Optimystic keeps one and drops the other's rows.

The gate does not read the other `Strand` tables (`Member`, `Manager`, `MemberPeer`, `Invite`, `ConsumedInvite`, `CancelledInvite`, `Revocation`), yet the membership reconciler writes several of them on the joiner (`ConsumedInvite` and `Member` when it redeems its invitation, then `MemberPeer`) about a second after the database is published. Those collections reach the joiner by peer-join backfill, or by a read while the founder is reachable, separately from the Header and the `App` tables.

Since `strand-founder-commits-every-table-collection`, every one of those tables has a collection on the founder from founding on. Before it, `ConsumedInvite`, `CancelledInvite` and `Revocation` had none until first written, so the joiner's redemption created `ConsumedInvite` rather than possibly duplicating one. `Member`, `Manager`, `Invite` and `MemberPeer` were already written by the founder, so the gap is older than that change; the change widened it to the remaining tables.

## When it would bite (inferred, not observed)

A joiner becomes writable, then loses its connection to the founder before backfill has delivered, say, `Strand.ConsumedInvite`, and its reconciler redeems in that window. If Optimystic then sees a cohort of only this machine for that block and rules it absent, the insert creates a second `ConsumedInvite` collection. Whichever history Optimystic keeps, one side's rows are lost; losing the joiner's leaves a spent invitation unrecorded.

What would confirm or rule it out: whether a joiner that has heard from the founder and then lost the connection rules an unheld block absent (self-only cohort) or flags it `cohort-unreachable` (Optimystic's `CoordinatorRepo.absenceFlagFor` and the remembered-peer membership in `libp2p-key-network.ts` suggest the latter in some cases). A self-only cohort after becoming writable does occur: the fourth and fifth arms of `joiner-first-commit-over-slow-relay` make one on purpose (the founder hibernates its strand, and the joiner waits until its FRET ring no longer holds the founder live), and that commit names the founder as owed (`local`, 1 of 2, `unconfirmed [<founder strand peer>]`; `slow-link-restart-arms-lost-their-lone-commit`). That is a commit; whether a read of an unheld block in the same state rules it absent is still unchecked.

## What is wanted

The gate's invariant covers every table this machine may write: before the database is published, a read of each declared `Strand` table settles, as each `App` table's does now. Now that the founder commits every declared table's collection, a settled read of one of these tables means its collection was fetched (a table a later schema version adds stays the residual in docs/strands.md). The time this adds to a gated join on the relay scenarios should be measured and recorded against `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`.
