----
description: The seat cap on an invitation counted redemptions through a secondary index, and across machines that index returns only the rows the reading machine wrote — so the cap counted only local redemptions and admitted members the invitation never paid for. The index was a pure optimization added three weeks ago; removing it puts the count back on the table scan it used to use, which does converge across machines.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, docs/architecture.md
difficulty: medium
----

# The `FormationUsageByToken` tripwire fired — the seat cap is back on a table scan

`formation-unique-token-redesign` (complete, 2026-08-04) took `Token` out of `FormationUsage`'s
primary key and declared `index FormationUsageByToken on FormationUsage (Token)` **purely to spare
a table scan**. Its review recorded a tripwire, verbatim:

> **The seat count is now an index seek, where it used to be a scan.** … That count *is* the seat
> cap, so an under-reporting descent would admit a seat the invitation did not pay for — a failure
> mode a scan could not produce. … **no miss has been observed on this index**, and the full package
> suite exercises the seek.

A miss has now been observed, and measured. **The tripwire fired; this ticket is it going off.**

## The measurement

Ran `strand-formation-concurrent-redemption` with the engine's own read-side trace
(`DEBUG='optimystic:quereus-plugin:module,optimystic:quereus-plugin:txn-bridge'`). Both machines
resolve the same index collection id. At the failing read:

| | case 1 | case 2 |
| --- | --- | --- |
| node A, index `rev=` | 3 | 4 |
| node B, index `rev=` | 2 | 3 |
| node A / node B, `main_rev=` | 2 / 2 | 4 / 4 |
| `matched=`, both nodes | 1 | 1 |

**The two machines' copies of the table agree; their copies of the index sub-collection differ by
exactly one revision**, and `arm=live` means the engine refreshed both trees immediately before
descending. Each machine's index tree holds exactly the entry that machine wrote, so each counts
only its own redemptions. On a multi-machine party the cap therefore under-reports **without
bound** — not by the number of concurrent redeemers, which is the bounded over-admission the
redesign deliberately accepted, but by every redemption recorded on another machine, forever. A
spent invite also keeps reading as outstanding to the membership connection gate
(`hasOutstandingFormationInvite`).

Full detail, and the correction of three claims this repo carried since 2026-08-12, is in
`tickets/blocked/secondary-index-seek-blind-to-sibling-rows.md`. The engine defect is upstream and
unfixed; filed there as
`../optimystic/tickets/backlog/bug-index-subcollection-sits-one-revision-behind-on-the-sibling.md`.

## What changed here

The index declaration was removed from both copies of the control schema (`schemas/control.qsql`
and the embedded `packages/cadre-core/src/control-schema.ts`, which
`control-schema-drift.spec.ts` holds identical), replaced by a block comment carrying the
measurement and a do-not-re-add note. `countFormationUsage`'s `NOTE:` and the formation section of
`docs/architecture.md` were rewritten to match.

Nothing else moved. The redesign's actual design decision — no per-token sequence number, bounded
over-admission accepted in exchange for never silently losing a consented join — is untouched;
only its optimization is. `where Token = ?` on a non-key column with no index is a shape the
optimystic vtab declines to claim, so the engine serves it by scanning and filtering, which is what
this read did before 2026-08-04 and what the ticket's own remedy line anticipated: *"suspect this
seek first and drop the index to fall back to the scan."*

## The cost, stated plainly

**This removes the only reliable reproducer of the upstream defect.** Re-adding the one index line
restores it — that is recorded at the schema site, in `docs/architecture.md`, and on the upstream
ticket, because this repo is the only place the defect has ever reproduced.

**It fixes one read path, not the defect.** Every `unique` constraint in the control schema is
still enforced through a secondary index (`_uniq_1`, `_uniq_5`, `_uniq_6` on `OwnerKey`,
`CadrePeer`, `FormationInvite`, `Strand`, `ValidationKey`, `DeviceToken`), so cross-machine
uniqueness is exposed to exactly the same staleness. That arm is `strand-unique-index-sync-stale-revision`
(blocked) and is not addressed here. Do not read a green suite as the engine defect having cleared.

**It costs a full table scan per per-token read.** `FormationUsage` is append-only and grows with
redemptions, so this is a real cost that grows; it is the cost the read had before the index and it
buys cross-machine correctness of the seat cap.
