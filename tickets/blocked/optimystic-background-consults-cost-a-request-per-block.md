description: Optimystic checks a held block with the other cohort members on the first read after a 10 s window, with one request per block that carries the whole block back, and does not count a commit or push this node received as a check, so every block the other member writes and every poller slower than 10 s costs a full-block request per block; needs per-peer batching, a revision-only check and freshness from received commits.
architecture: docs/cadre-consistency.md#deadlines-below-cadre
files: ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (`shouldReadRepair` ~1300-1313, `startHeldBlockConsult` ~1459-1486, freshness stamps ~1380/~1418 and the comment ~924-926, `readRepairWindowMs` default ~737, read only), ../optimystic/packages/db-p2p/src/sync/protocol.ts (single `blockId` request ~10-38, read only), ../optimystic/packages/db-p2p/src/storage/block-archive.ts (block serialized twice ~49-50, read only), ../optimystic/tickets/backlog/feat-a-cohort-consult-batches-blocks-per-peer.md (read only)
repro: verified
----
# Optimystic's background consults cost one full-block request per block

**Blocked on a dependency outside this repo.** Unblocks when Optimystic ships any of items 1–3 below in a version Sereus can adopt. Not yet reported upstream as one issue; Optimystic's own backlog has item 1 (`feat-a-cohort-consult-batches-blocks-per-peer`). Read at Optimystic 1.15.0 plus main (`f22a8cb7`).

## What happens

In lazy read-repair mode (the default; Sereus sets nothing), a read of a held block whose freshness stamp is older than `readRepairWindowMs` (10 s) is served locally and starts a background consult: one `sync` request per other cohort member, per block. Three properties make this the bulk of a strand's and a multi-machine cadre's idle traffic:

- **Per block, not per peer.** `SyncRequest` takes one `blockId`. Each scan reads at least a header and a log tail, so a two-table read is four requests.
- **Whole block, twice.** The answer is the full archive, and the block is serialized twice in it (`block-archive.ts` ~49-50), even when the answer is "you are current" and only (revision, action id, proof) is used.
- **Received commits do not count.** Only this node's own coordinated commits set the stamp (`coordinator-repo.ts` ~1380/~1418; comment ~924-926). A commit this node voted on as a cohort member, or a block pushed to it, leaves the block stale, so the next read of every block the other member wrote is a consult.

## Measured

- GitHub sereus#50 comment: ~33 relayed `sync` requests per strand per two minutes from one 30 s poller, 83–98% within 2 s of its refresh; ~8 inbound requests a minute per strand on a Galaxy S7.
- `message-cost-accounting` baseline (2026-10-19): a two-machine cadre's idle minute 103–134 `sync` streams from 133–148 control reads.

## Proposed upstream change

1. Batch a peer's due consults into one request (Optimystic's existing backlog item).
2. A revision-only consult: ask for (revision, action id, proof), fetch bytes only when the peer is ahead.
3. Stamp freshness when a block arrives by a commit this node took part in, or by a certified push.

## Sereus's side meanwhile

The pollers stop reading on a timer (`strand-watcher-woken-by-control-changes`, `control-reconcile-woken-by-changes-reads-once`, `pending-join-runner-woken-by-changes`, `strand-revocation-enforcer-woken-by-membership-changes`), and repeated reads go to an in-memory view (`control-membership-rows-cached-until-changed`). That removes most idle consults without this. What remains is the app's own reads: every read of a table the other member wrote recently costs a full-block request per block.

**Rejected alternative:** widen `readRepairWindowMs` in Sereus's cluster policies. It cuts the requests but lengthens how long a reader can miss a commit, for every read on the strand.

## If nothing is done

App-driven reads on two-party strands keep paying one full-block round trip per block per 10 s; idle cost is fixed by the Sereus tickets above.
