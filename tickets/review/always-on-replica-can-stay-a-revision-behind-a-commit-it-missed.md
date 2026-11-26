description: A machine that keeps a full copy of every strand its party runs could be left one version behind a change it did not help approve, for as long as it stayed connected. The machine that writes a change now offers it again to the copies that were already connected, so they no longer stay behind.
architecture: docs/cadre/control-replication.md#catching-up-a-new-machine
files: packages/cadre-core/src/peer-join-backfill.ts (the change), packages/cadre-core/src/strand-instance-manager.ts (~1289-1304, strand wiring), packages/cadre-core/src/cadre-node.ts (~2371-2401, control wiring), packages/cadre-core/test/peer-join-backfill.spec.ts (two new cases + a change-feed fake), docs/cadre/control-replication.md ("Catching up a new machine"), tickets/.pre-existing-known.md (entry moved from Open to Resolved in place)
difficulty: hard
----

## What landed

`PeerJoinBackfill` had one trigger: a connection. A peer marked caught up and still connected got nothing more, so a revision that advanced after that mark was never re-offered — an always-on storage replica that did not sign a commit stayed a revision behind it for the life of the connection. The per-block skip rules were already correct for this case (`memoSettled` does not skip a block memoized at rev 4 once the local tip is rev 5); only the scheduling was missing.

The module now has a second trigger: **a commit this node made**. On one, it unions the commit's block ids into a per-peer `owed` set and schedules. A scheduled run's *kind* is decided when the timer fires, not when it is scheduled, so both triggers share one scheduling entry point and one copy of the in-flight, re-arm and backoff bookkeeping:

- `whole` — the peer is not `done`. Enumerates the local store, as before.
- `delta` — the peer is `done` and owes blocks. Offers exactly those ids; no enumeration.
- `none` — the peer is `done` and owes nothing. `schedulePeer` drops, where it used to drop on `done.has(key)`.

Everything else is reused unchanged: the per-peer memo, the proof-signature skip, the chunk budgets, the dial and response deadlines, the backoff, and the control network's `authorizePeer` gate (still consulted at push time, now on each delta run too — a denied peer is not `done`, so `runFor` answers `whole` for it and the existing denial handling stands).

**The rule that prevents double-pushing**: a node re-offers only what it committed. The store's change feed fires for every block that lands, a commit or a push, so the module ignores every event whose `tailId` is `undefined`. `tailId` is stamped by Optimystic's `StorageRepo.commit` from the `CommitRequest`, and by neither `saveReplicatedBlock` nor the read-driven promotion path. Without this, a whole-store catch-up of 44 blocks into a peer would make that peer offer all 44 straight back.

**No new timing constant.** The coalesce window is the existing `debounceMs` (1000 ms on a strand, 250 ms on the control network). One difference from the identify path: delta scheduling passes `keepPendingTimer` and leaves an already-armed timer alone rather than clearing and re-setting it, because re-setting under a steady write stream would postpone delivery indefinitely. The owed set grows while the armed timer runs down and the run that fires carries everything in it.

**Wiring**: a new optional dep `subscribeStorageChanges`, subscribed in `start()` and released in `stop()`. The strand site passes `node.storageRepo`; the control site passes `(this.controlNode as Libp2pNodeWithRepo).storageRepo`. Absent (a node without one, a test double), the catch-up is connection-triggered only, exactly as before.

## One deviation from the implement ticket — please weigh it

The ticket said: on a clean *delta* run remove the worked snapshot, and on a clean *whole* run clear the peer's `owed` entirely, "the whole store was just offered at its current revisions".

What landed uses the **snapshot rule for both kinds**: `settleRun` snapshots `owed` before its first await and a clean run of either kind removes exactly that snapshot. The reason is that a whole run's enumeration is an async walk over the store, so a commit landing after the walk passed a block's id was offered at the older revision; clearing `owed` wholesale would discard the one record that the newer revision is still unsent, and the peer would go back to waiting for a disconnect. With the snapshot rule, such a block stays owed and a delta run follows. The cost is at most one extra, cheap delta run per commit that lands during a whole run. It also collapses the two cases into one code path.

If a reviewer prefers the ticket's literal rule, the change is one line in `settleRun`, but the race above comes back.

## Use cases to test, and what each should show

**The case the fix exists for.** Two machines on one strand, one of them a replica that runs no app and never disconnects. A third machine writes a row; the replica is not in the commit's cohort. The replica must reach the writer's revision for every block within a sub-second settle, not on its next reconnect. `strand-moves-between-cadres` is the physical reproduction: its block-coverage gate in `expectReplicaOnM` used to freeze at "two blocks one revision behind, 42 others current" for the whole 60 s.

**The echo that must not happen.** Two machines each holding blocks the other lacks, connecting for the first time. Each runs one whole-store push; neither re-offers the blocks it just received. Watch for a push count that grows per block per reconnect rather than staying at one round each — `DEBUG=sereus:cadre:peer-join-backfill` prints `kind=` per run, so a `delta` run with a large `offered=` right after a `whole` run that `accepted=` the same count is the fingerprint of a broken filter.

**A peer that goes away.** A commit must not start a dial to a contacted peer that has disconnected. The handler checks `isConnected` (or an in-flight run) before scheduling, so a long-gone peer accumulates `owed` entries but is never dialed; its reconnect runs the whole store and clears the snapshot.

**The control network's gate.** A connected non-member must still receive nothing on a commit-driven run. The gate is unchanged and fails closed; a denied run is not `done`, so it stays a `whole` run.

**A store that cannot enumerate.** `listBlockIds` absent is still the inert verdict for a whole run, but a delta run names its own ids and must not be refused by it — the bail moved into `blockIdsFor`'s whole branch for exactly that reason.

## Tests added

Two, both in `packages/cadre-core/test/peer-join-backfill.spec.ts`, plus a `makeChangeFeed()` fake beside the existing libp2p one (its two emitters differ only in `tailId`, which is the one field the module discriminates on):

- *"re-offers a block whose local revision advanced to a caught-up peer that never disconnected, and only that block"* — the reproduction. A peer is caught up over a 3-block store, stays connected, then one block's local revision advances and a commit event fires. Pins that a second push happens at all, that it carries only the advanced block, and that its `blockMeta` names the new revision. Also pins that `stop()` releases the subscription.
- *"acts on a commit but not on a block that merely landed from a push"* — the rule that prevents double-pushing. A tail-less event (a pushed replica) and a commit event are fired back to back; the delta run that follows carries only the committed block. Asserted through the commit's own run rather than a sleep, so there is no timing slack: were the tail-less event acted on, its block would ride along in the same run.

No test was added for the dep wiring at the two construction sites (glue, and the type enforces the shape), for `RunKind` itself, or for the `owed` bookkeeping in isolation — the two cases above exercise it end to end.

## Validation actually run

- `yarn workspace @serfab/cadre-core test` — 199 files, 2715 passed, 1 skipped. The backfill spec alone afterwards: 39 passed.
- `yarn lint` (ESLint + `check:docs`) and `yarn workspace @serfab/cadre-core typecheck`, plus `yarn workspace @serfab/integration-tests typecheck` — all clean.
- **The contended series: 15 runs, 15 green.** Run as four batches; in each, `yarn workspace @serfab/integration-tests run test --shard=5/6` ran concurrently as load (verified from its own log that it was executing scenarios throughout) while `strand-moves-between-cadres.integration.ts` ran in a loop in the foreground. Per-run wall clock 15.5–27.7 s. The behind-by-one gap shape still appears — `behind: [… (source rev 4 > target rev 3), …]` in runs 1, 3 and 4 — and now closes on the next 250 ms poll (253–528 ms observed) instead of freezing for 60 s. Logs: `tickets/.logs/always-on-replica.contended.log`.
- The named control and strand-join scenarios: `control-delete-while-alone-convergence`, `strand-late-cadre-join`, `strand-membership-closed-strand-e2e` (14 tests, green) and `control-write-degraded-cohort-member` (8 tests, green — including the three long degraded cases, which the 2026-10-14 delta in `.pre-existing-known.md` flags as historically flaky).
- `tickets/.pre-existing-known.md`: the `in-flight` entry for this slug is gone from **Open**; a short **Resolved in place** entry replaces it, keeping the two standing rules for any recurrence on this scenario (do not raise a wait, do not weaken the coverage assertion) and the one-off record for its other historic wait, `rowArrives`.

### The DEBUG confirmation the implement ticket asked for

`DEBUG=sereus:cadre:peer-join-backfill` on one uncontended run (`tickets/.logs/always-on-replica.debug.log`). The delta trigger does fire on N and does deliver:

```
[strand-move-s-…] catch-up peer=12D3KooWAbD6…GNSu kind=delta offered=6 alreadyHeld=0 accepted=6 …
[strand-move-s-…] catch-up peer=12D3KooWAbD6…GNSu kind=delta offered=2 alreadyHeld=0 accepted=2 …
```

`12D3KooWAbD6…GNSu` is M's replica peer for S — it is one of the two peers P binds to N's member key, and it is not N's own strand peer. So the `tailId` filter is **not** too narrow for this case and the fallback (dropping the filter) was not needed. N signs the commits P drives, which is what makes its `StorageRepo.commit` emit a tail-bearing event.

**M's cohort membership before the final write, as asked:** M is not a commit target. Its first whole run for S reported `offered=42 alreadyHeld=0` — it held nothing and had signed no proof among those 42 blocks — and the later delta runs offered it 6 and then 2 blocks, which `signedBy` would have skipped had M approved those commit rounds. So the scenario is asserting over a replica that was never in the cohort, which is exactly the case this module exists for.

**One loose end in that run, worth a reviewer's eye.** On the *T* strand of that same uncontended run the gap `source rev 4 > target rev 3` closed in 254 ms with **no** delta-run line logged for M's T peer in that window. The likeliest reading is that the whole-store push logged 150 ms earlier (`offered=42 accepted=42`) already carried rev 4 and M's store had not surfaced it by the probe's first poll; `debug` writes to stderr and the scenario's `console.log` to stdout, so their interleaving through one pipe is not reliable evidence of ordering either. It is not a correctness concern — the gap closed, and the contended series is 15 for 15 — but nobody has proved which path delivered those two blocks.

## Notes for the reviewer, not work for this ticket

- The commit-driven trigger narrows the window `tickets/backlog/debt-late-join-catch-up-seam-is-never-forced.md` describes: a block committed after the enumeration passed its id now has its own event to carry it. The snapshot-clearing deviation above is what preserves that. Leave that ticket alone.
- One tripwire was parked as a `NOTE:` in `noteCommitted` (`peer-join-backfill.ts`): a connected peer that is not caught up is scheduled from the commit handler too and fires a *whole* run, which on the control network means one `authorizePeer` check per commit burst for a connected peer the gate keeps denying. Deliberate — it picks an authorization up sooner than the next identify would — and cheap, since that gate is an in-memory set lookup and the run ends at the denial without dialing. The note says to restrict the handler to `runFor(key) === 'delta'` if a node ever holds many denied-but-connected peers under a steady write stream.
- `owed` is bounded the way `PeerMemo` already is: at most one entry per distinct block id in the store, per peer ever contacted. It is not dropped for a peer that never returns, which is consistent with `contacted` and `memos`.
- No persisted format, signed payload or schema changed; a new optional dep and no new config field.
