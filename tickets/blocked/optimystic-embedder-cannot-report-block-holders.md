description: When a machine joins, Sereus's join catch-up copies it every existing block, and seconds later Optimystic copies the same blocks again, one request per block, because Optimystic has no way to be told that the joiner already holds them. Needs Optimystic to accept a "this peer holds this block" report from the application.
architecture: docs/architecture.md#replication-cluster-size
files: packages/cadre-core/src/peer-join-backfill.ts (`recordReply`, where the report would be made), packages/integration-tests/src/scenarios/message-cost-accounting.integration.ts (baseline comment holds the counts), ../optimystic/packages/db-p2p/src/repo/under-replication-drain.ts (read only), ../optimystic/packages/db-p2p/src/repo/i-under-replication-ledger.ts (`satisfy`, read only), ../optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordBlockHolders`, read only), ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`underReplicationLedger` attached untyped ~1778, rebalance wiring ~1882, read only), ../optimystic/packages/db-p2p/src/optimystic-node.ts (`OptimysticNodeAttachments`, read only)
----
# Upstream: an embedder cannot tell Optimystic that a peer already holds a block

**Blocked on a dependency outside this repo.** Unblocks when Optimystic releases a typed way for an embedder to report that a peer holds a block at a revision (proposal below), and Sereus adopts that release. Upstream ticket: `../optimystic/tickets/plan/an-embedder-reports-a-block-a-peer-already-holds` (filed 2026-10-20); no GitHub issue yet.

## What happens

Sereus's peer-join catch-up (`peer-join-backfill.ts`) pushes each newly connected peer every block it does not already hold, in chunks of up to 64 blocks per request. Optimystic tracks who holds what in two places, and neither hears of those pushes:

- **The under-replication drain.** A block committed while its writer had no connected cohort is recorded in the under-replication ledger as owed to the members that missed it. When such a member connects, the drain pushes each owed block to it, one request per block. It clears an entry only when its own push succeeds.
- **The rebalance monitor** (storage-profile nodes only). Its growth arm pushes a joiner every block whose cohort the joiner entered, one request per block, unless the monitor already counts the joiner as holding it. The monitor learns holders only from this node's own commits and pushes and from pushes it receives (`RebalanceMonitor.recordBlockHolders`, fed by `BlockTransferService`'s sender reports).

Optimystic attaches the ledger to the node as an untyped property (`(node as any).underReplicationLedger`, which has `satisfy(blockId, peerIds, heldRev)`), and the rebalance monitor is not attached at all. `OptimysticNodeAttachments` carries neither.

## Measured

`message-cost-accounting` (`MESSAGE_COST_MEASURE=1`), 2026-10-20, sereus `b1d85c22` with `join-backfill-pushes-once-and-is-waited-for`, `@optimystic/*` 1.16.0 linked at `72ac338c`, in-memory storage, loopback, one run each, attributed with `DEBUG=optimystic:db-p2p:*,sereus:cadre:peer-join-backfill`:

- **Strand case** (two single-machine parties, transaction profile, so no rebalance): the founder's backfill delivers its 42 blocks to the joiner in one request (`accepted=42`). About 7 s later the founder's drain pushes the same 42 blocks again, one request each (`under-replication-drain pass:done trigger=identify entries=42 ... pushed=42`). That is 42 of the 44 founder-to-joiner `block-transfer` streams in the join window.
- **Invite case** (storage-profile owner, a second machine redeeming a cadre invitation): the owner's backfill delivers 99 control blocks (64 + 35 per request). Afterwards the drain pushes 91 of them one at a time (64 in one pass, 27 at the 30 s recheck), and the rebalance growth arm pushes 90, one at a time (`reason=rebalance`). `cohort-join-catch-up-runs-once-per-node` removes the growth arm's share where the backfill runs; the drain's share remains.

Each duplicate is a separate stream carrying a full block; over a public relay each costs a relayed request (GitHub gotchoices/Optimystic#39 shows one such frame taking 8 s).

## Proposal (recommended default)

An Optimystic node attachment, typed in `OptimysticNodeAttachments`:

```ts
/**
 * Record that `peerId` holds `blockId` at revision `rev` or later, as learned by the embedder (an
 * application-level push it made and the peer accepted). Satisfies the under-replication ledger's
 * entry for that peer when `rev` covers it, and records the peer as a holder in the rebalance monitor.
 */
reportBlockHeld(blockId: BlockId, rev: number, peerId: string): Promise<void>;
```

Sereus would call it from `PeerJoinBackfill`'s reply handling for each block the receiver accepted (the same place that fills the per-peer memo). The ledger's existing `satisfy(blockId, peerIds, heldRev)` already has the semantics needed; the attachment only needs to reach it and the rebalance monitor's `recordBlockHolders`.

## Alternatives rejected

- **Call `(node as any).underReplicationLedger.satisfy` from Sereus today.** Reaches an untyped internal property that Optimystic may rename or restructure without notice, and still leaves the rebalance monitor uninformed.
- **Turn the under-replication drain off where the backfill runs** (as `cohort-join-catch-up-runs-once-per-node` does for the rebalance reaction). The drain also delivers a write that missed a member which was connected at the time, on its 30 s recheck; the backfill runs only when a peer connects and does not run again for a caught-up peer, so it would lose that delivery.
- **Push from Sereus only after the drain has run.** The drain's timing (5 s debounce, 15 s minimum interval) is Optimystic's, and waiting would delay the joiner's first sync, which now waits for the backfill's push.

## If nothing is done

Each join costs one extra full-block request per block its peer wrote alone before the join (42 and 91 in the runs above), starting about 7 s after the catch-up finished. Correctness is unaffected; the cost is traffic and, over a relay, time on a shared connection. Reversible: the proposal adds an API and one call site.
