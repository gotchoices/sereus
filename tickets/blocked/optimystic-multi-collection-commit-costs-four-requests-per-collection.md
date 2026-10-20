description: An Optimystic transaction that touches several collections (a table plus its index or UNIQUE trees, or several tables) runs one pend and one commit per collection against the other cohort member, about 4 requests per collection instead of 3 for the whole transaction, so Sereus's membership writes cost a dozen or more requests each; needs Optimystic to batch a transaction's collections per coordinator.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: ../optimystic/packages/db-core/src/transaction/coordinator.ts (`pendPhase` ~1615-1619, `commitPhase` ~1748-1752, `soleReservation` only for one collection ~1608, read only), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (one cluster transaction per pend ~2488-2495, read only), ../optimystic/packages/db-p2p/test/two-node-write-request-count.spec.ts (pins 3 and 8, read only), packages/cadre-core/src/strand-membership-writer.ts (the multi-collection membership transactions), schemas/strand.qsql
repro: static
----
# A transaction over several collections costs about 4 requests per collection

**Blocked on a dependency outside this repo.** Unblocks when Optimystic batches a multi-collection transaction's pends and commits per coordinator. Upstream issue: gotchoices/Optimystic#42 (per-index cost; our multi-table case added as a comment 2026-10-19), and #29 (write cost); upstream ticket `../optimystic/tickets/plan/a-commit-carries-its-collections-in-one-request-per-member` (filed 2026-10-19). Read at Optimystic 1.15.0 plus main (`f22a8cb7`).

## What happens (traced; upstream pins the numbers)

- **One collection.** A one-row insert into a table with no index costs 3 `/cluster` requests to the other member on a two-member cohort (pend promise, commit promise carrying the deferred pend decision, consensus delivery). Upstream's `two-node-write-request-count.spec.ts` pins 3.
- **Several collections.** Each index and each UNIQUE constraint is its own collection. A transaction over N collections runs N pends and N commits in parallel, each its own cluster transaction, and the pend-deferral that makes one collection cost 3 is off (`soleReservation` is set only for one collection). Upstream pins 8 for a table with one index; the general cost is about 4N requests, in about 4 round trips of latency regardless of N.

Sereus's membership tables carry UNIQUE stamp constraints, so `consumeInvite` (Member + ConsumedInvite and their unique trees), `registerMemberPeer`, and the founder's membership rows are each multi-collection transactions. The reconciler's NOTE measured the joiner's two seat transactions at 27 + 18 `/cluster` streams (2026-09-17, older stack).

## Proposed upstream change

Send a transaction's pends for all collections one coordinator covers as one cluster request, and the same for commits (`RepoMessage.operations` is already an array), and allow the two-member pend deferral when the whole transaction has one coordinator.

## Sereus's side meanwhile

`strand-founding-writes-batched` reduced the number of transactions; each remaining one still pays per collection. The joiner keeps its two seat commits (`joiner-seat-stays-two-commits`): merging them saves no requests until this lands, and would let a torn commit show a binding with no member. Do not drop UNIQUE constraints from the strand schema to save collections: they are the membership invariants.

## If nothing is done

Every membership change on a strand costs on the order of 12–20 relayed requests; app writes to tables with indexes pay 4 per index.
