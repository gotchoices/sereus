description: When a strand member reads a block it does not hold (every block, for a joiner attaching), Optimystic asks the other member for it twice in a row and opens collections one sequential read at a time, so attaching a two-table strand costs about 25 relayed sync requests in series; needs Optimystic to reuse the first answer and fetch concurrently.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback` ~1519-1570, `fetchArchiveFromPeer` ~1377-1396, the upstream comment admitting the double fetch ~1370-1376, read only), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (`queryClusterForLatest` ~1999-2009, `restoreCorroborated` ~1808/~1879-1917, read only), ../optimystic/packages/db-p2p/src/cluster/reconcile-block.ts (~349-351, read only), ../optimystic/packages/db-core/src/collection/collection.ts (open sequence ~403/~436/~438, read only), ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts (index trees opened one at a time ~238-243/~263-273, read only)
repro: verified
----
# Optimystic fetches each missing block twice, one block at a time

**Blocked on a dependency outside this repo.** Unblocks when Optimystic ships items 1–2 below in a version Sereus can adopt. Upstream issue: gotchoices/Optimystic#39 (open); upstream ticket `../optimystic/tickets/plan/a-cold-read-fetches-each-block-once` (filed 2026-10-19). Read at Optimystic 1.15.0 plus main (`f22a8cb7`).

## What happens

On a two-member strand, a member reading a block it does not hold:

1. **Consult.** `queryClusterForLatest` sends `requestBlock({ blockId })` to the other member, which answers with the full archive (block, action, proof). The asker keeps only (revision, action id, proof) and discards the bytes.
2. **Acquire.** `restoreCorroborated` → `reconcileBlock` → `fetchArchiveFromPeer` sends the identical request again and saves the answer.

Upstream's own comment at `libp2p-node-base.ts` ~1370-1376 says a read that goes on to repair "pays two identical round trips per peer rather than one". On top of that, opening a collection is a strict chain of awaits (header probe, log tail, chain open re-reading the header, tail, then `update()`), and index and unique-enforcement trees are opened one after another.

## Measured

- gotchoices/Optimystic#39: 16 sequential `sync` requests for a two-table strand's attach, 8 distinct blocks each fetched exactly twice; ~1.6 s of a ~2.4 s `addStrand` on relay.sereus.org.
- `message-cost-accounting` baseline (sereus, 2026-10-19, loopback): `addStrand` 25 `sync` B→A; the joiner's first insert 20 more.
- Phones: a two-table join 7–12 s on a Galaxy S21, 18–25 s on a Galaxy S7 (#39).

## Proposed upstream change (for the issue, if not already there)

1. Carry the consult's archive into the acquisition when it already holds the selected revision's block and action, instead of fetching again. Halves the round trips for every cold read.
2. Open a collection's blocks and its index trees concurrently where the reads are independent (header and tail together; index trees with `Promise.all`), so a cold attach costs about one round trip per tree level rather than per block.

## Sereus's side meanwhile

`first-sync-gate-probes-cheaply` and `join-backfill-pushes-once-and-is-waited-for` reduce how many cold reads a joiner makes at all; they do not depend on this.

## If nothing is done

Every cold read on every strand pays double, sequentially. It is the main cost of joining on a phone.
