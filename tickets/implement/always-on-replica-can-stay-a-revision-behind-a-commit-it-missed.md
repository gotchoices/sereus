description: One machine in a party keeps a full copy of every strand the party runs, but that copy can be left one version behind for good. Make the machine that writes a change offer it again to the copies that were already connected, so they never stay behind.
architecture: docs/cadre/control-replication.md#catching-up-a-new-machine
files: packages/cadre-core/src/peer-join-backfill.ts (the whole change), packages/cadre-core/src/strand-instance-manager.ts (~1289-1304, the strand construction site — `node.storageRepo` is in scope at line 1053's `const node`), packages/cadre-core/src/cadre-node.ts (~2379-2420, the control construction site), packages/cadre-core/test/peer-join-backfill.spec.ts (the reproduction; `makeStorage`/`makeLibp2p`/`makePushClient`/`makeBackfill` already exist), docs/cadre/control-replication.md (~line 114-126, "Catching up a new machine"), packages/integration-tests/src/scenarios/strand-moves-between-cadres.integration.ts (the failing scenario — validation only, do not change it), tickets/.pre-existing-known.md (clear the in-flight entry)
difficulty: hard
repro: verified
----

## What is wrong

`PeerJoinBackfill` (`packages/cadre-core/src/peer-join-backfill.ts`) is the only thing that delivers a block to a peer which was not in the cluster the writer resolved. Its trigger set is keyed on the **connection**: `peer:identify`, `scheduleConnectedPeers()`, and `forceCatchUpPeer`. Once a run finishes cleanly the peer is marked `done`, and `schedulePeer` then drops identify churn for a connected, caught-up peer before any work. Nothing re-offers a block whose local revision advances **while the peer stays connected and is already `done`**.

The per-block skip rule is already correct for this case — `memoSettled` does not skip a block memoized at rev 4 once the local `latest.rev` is 5 — so the existing push would carry the missing revision. Only the scheduling is missing.

Consequence, measured: an always-on storage replica sits two blocks behind by one revision for as long as the connection lasts. No other path covers it. Optimystic's rebalance reaction is deliberately off wherever this module is armed (`strand-instance-manager.ts` ~1131, `cadre-node.ts` ~2737); the under-replication drain holds no entry, because `resolveOwedPeers` records a shortfall only against the commit's own resolved cluster view; and read repair is a read-side path, which a replica running no app never takes.

The diagnosis, the DEBUG evidence and the measurement that rules out raising any wait are recorded in this slug's entry in `tickets/.pre-existing-known.md`. Do not re-derive them, and in particular do not raise the wait: the coverage step closes on its **first** poll when it closes at all (3 ms and 2 ms with the file alone), so the 60 s gate is four orders of magnitude clear of what the step costs and is a hang detector doing its job (`docs/contributing/testing.md` → "A per-step deadline is a hang detector, not a budget"). Do not weaken the assertion either: block coverage is physical-store evidence on purpose (`block-store-probe.ts` header, "WHY THIS EXISTS").

Sibling repositories are read-only (`tickets/rules/sibling-repos.md`). If the fix turns out to belong in Optimystic — a cohort-join catch-up of its own, or recording a shortfall for a connected same-network peer outside the resolved cluster — the outcome is a `report-*` ticket in `tickets/blocked/` naming it, not an edit under `../optimystic`.

## The change: a commit-driven re-offer

Give the module a second trigger — **this node committed a revision** — and a targeted offer path for exactly the blocks that commit touched. Everything else (the per-peer memo, the chunk budgets, the dial and response deadlines, the backoff, the control network's `authorizePeer` gate at push time) is reused unchanged.

### The signal, and the filter that prevents double-pushing

`CadreNodeConfig.storageRepo.onAnyCollectionChange` (`packages/cadre-core/src/types.ts` ~line 63) already carries what is needed: `CollectionChangeEvent` has `collectionId`, `blockIds`, `actionId`, `rev` and `tailId` (Optimystic's `db-core/src/transactor/change-notifier.ts`). It is already consumed by the first-sync gate (`strand-instance-manager.ts:1414`).

The feed fires for every block that lands in the node's store, **a commit or a push**. Subscribing to all of it would echo: a whole-store catch-up push of 44 blocks into M makes M's store fire 44 events, and M would offer all 44 straight back to N. That is the double-pushing the fix ticket's design constraints forbid.

`tailId` is the discriminator, verified by reading Optimystic's `db-p2p/src/storage/storage-repo.ts`: `commit()` (line ~1585) emits with `request.tailId` set; `saveReplicatedBlock` (line ~1998) and the read-driven promotion path `emitPromotions` (line ~1229) both emit with no `tailId`, and the field's own doc says so. **Subscribe to the feed and ignore every event whose `tailId` is `undefined`.** The rule that follows is clean and is the one to write down: a node re-offers what **it** committed; a block that arrived by push belongs to its pusher to propagate.

Confirm this holds on the path that matters before trusting it — see "Settle the assertion's source" below.

### Shape inside the module

Decide the run's kind at **fire** time, not at schedule time, so one scheduling entry point still serves both triggers and the existing in-flight, re-arm and backoff bookkeeping needs no second copy.

- A per-peer `owed: Map<string, Set<BlockId>>` — block ids this node committed since that peer's last clean run.
- A `runFor(key)` decision: `'whole'` when the peer is not `done`; `'delta'` when it is `done` and its `owed` set is non-empty; `'none'` otherwise.
- `schedulePeer` drops on `runFor(key) === 'none'` in place of today's `done.has(key)`. Every other guard it holds stays exactly as it is — the in-flight deferral into `rearmAfterFlight`, and the `retryAfter` drop that keeps identify churn inside a backoff wait free.
- `runCatchUp` takes the id source: `storage.listBlockIds()` for a whole run, the `owed` snapshot for a delta run. Move the `listBlockIds` inert bail into the whole-store branch — a delta run does not enumerate and must not be refused by a store that cannot.
- On a **clean** delta run, remove from `owed` the ids of the snapshot the run worked from (not ids added during it). On a clean whole run, clear the peer's `owed` entirely: the whole store was just offered at its current revisions.
- `done` is never touched. A delta run runs past it the way `forceCatchUpPeer` does, and a clean one leaves it set. `forgetCaughtUp` keeps sole ownership of `done` and the `inFlight` bookkeeping that goes with it.

### Who is offered to, and when

On a commit-driven event, for each peer key already in `contacted`, union `event.blockIds` into its `owed` and schedule. `contacted` is the right set and keeps the handler synchronous: every peer in it was scheduled through the `speaksBlockTransfer` filter, so no non-speaker is ever dialed, and a peer not yet contacted has a whole-store run coming that will carry the new revision anyway.

**No new timing constant.** Reuse `debounceMs` (1000 ms on a strand, 250 ms on the control network) as the coalesce window — which is what satisfies the fix ticket's constraint that any new scheduling constant be derived from the declared link round trip: there is no new constant. Measured convergence for a behind-by-one replica that is delivered is 529 ms, against a 60 s gate, so a sub-second settle is ample.

One distinction from the identify path: **delta scheduling must leave an existing pending timer alone** rather than clearing and re-setting it. `schedulePeer` re-sets the timer today, which is correct settle behaviour for connection churn but would postpone delivery indefinitely under a steady write stream. The `owed` set grows while the already-armed timer runs down, and the run that fires carries everything in it.

The handler runs inside Optimystic's synchronous dispatch (`fireChangeListeners`), so it must do no async work and must not throw.

### Wiring

Add to `PeerJoinBackfillDeps`:

```ts
/**
 * Subscribe `listener` to every commit landing in this network's store and return the
 * unsubscribe — the second trigger, alongside `peer:identify`: a revision that advances while a
 * peer stays connected and caught up is re-offered to it. Both construction sites pass the
 * node's `storageRepo.onAnyCollectionChange`. Absent (a node without one, a test double), the
 * catch-up is connection-triggered only.
 */
subscribeStorageChanges?: (listener: CollectionChangeListener) => () => void;
```

`start()` subscribes (after its `enabled` / `stopped` guard, beside the two `addEventListener` calls); `stop()` unsubscribes. `CollectionChangeListener` imports from `@optimystic/db-core`, which the module already imports types from.

Both construction sites pass it from the node they already hold:

- `strand-instance-manager.ts` ~1289: `node.storageRepo` is in scope (`const node` at line 1053).
- `cadre-node.ts` ~2379: `(this.controlNode as Libp2pNodeWithRepo).storageRepo`, the same cast the site already makes for `keyNetwork` and `reportBlockHeld`.

The control network's gate is unaffected in design but is now consulted on each delta run too — that is already push-time, already fails closed, and a denied peer is not `done`, so `runFor` returns `'whole'` for it and the existing denial handling stands.

## Settle the assertion's source

The scenario compares N's raw store against M's. N can hold the missing revision because it signed the commit, or because its own read pulled it in through `CoordinatorRepo.restoreCorroborated` — the confound `packages/integration-tests/src/harness/block-store-probe.ts` warns every caller about. It decides whether the commit-driven filter fires on N at all: a read-driven promotion carries no `tailId`, so if N held rev 5 only that way, N would never re-offer it and this fix would not deliver.

Reading the scenario, N should be a signer: step 5 waits for `strandConnectedTo(P, S, nSPeerId)` before `writeRow(pSDb, 's-p-a')`, and P's commit needs a super-majority of a cohort that is N and P (plus M's replica if it is up), so N must approve. Confirm it rather than assume it: run the scenario with `DEBUG=sereus:cadre:peer-join-backfill` and check that the delta trigger fires on N naming the two app-collection blocks (`default/app/Data` and its content block) within the debounce of P's write. If it does not, the filter is too narrow for this case and the fallback is to drop the `tailId` filter and rely on the existing proof and memo rules to bound the echo to one extra round per revision per peer pair — weigh that against the double-pushing constraint and say in the handoff which way it went and why.

While the reproduction is in front of you, also record (in the handoff, not in the doc) whether M is in S's cohort before the final write. If it is not, the scenario is asserting over a replica that was never a commit target, which is the case this module exists for and is worth stating plainly in the review handoff.

## Docs

One home per fact. Update both, and do not retell the diagnosis in either (`AGENTS.md` → Docs):

- `docs/cadre/control-replication.md` → "Catching up a new machine", the paragraph at ~line 118 that names identify as the trigger. It gains the second trigger and the rule that a node re-offers only what it committed.
- The module header's trigger and "WHAT IS PUSHED" paragraphs.

## Validation

- `yarn workspace @serfab/cadre-core test` and `yarn lint`, plus the type check.
- The reproduction series. A single green run proves nothing here: the failure was 2 of 6 **contended** attempts, and the file alone and a full `--shard=4/6` were green throughout. Run the scenario in a loop while a second shard of the same suite runs concurrently, and require roughly fifteen contended runs with no failure:

```
# terminal 1, the load
yarn workspace @serfab/integration-tests run test --shard=5/6
# terminal 2, in a loop
yarn workspace @serfab/integration-tests run test src/scenarios/strand-moves-between-cadres.integration.ts
```

  Under tess that is two foreground invocations and cannot be driven from one agent turn, so chain them in a single shell pipeline or state honestly in the handoff how many contended runs were actually taken.
- The hole is in a trigger set that serves the **control** network as well as strands (`cadre-node.ts` arms the same module), so the control scenarios have to stay green: `control-delete-while-alone-convergence`, `control-write-degraded-cohort-member`, and the strand join scenarios `strand-late-cadre-join` and `strand-membership-closed-strand-e2e`.

Note for the review stage, not work for this ticket: the commit-driven trigger also narrows the window `tickets/backlog/debt-late-join-catch-up-seam-is-never-forced.md` describes — a block committed after the enumeration passed its id now has its own event to carry it. Say so in the handoff; leave that ticket alone.

## Cross-cutting obligations

None triggered. No persisted format, signed payload or schema changes; a new optional dep and no new config field.

## TODO

- Add `subscribeStorageChanges` to `PeerJoinBackfillDeps`; subscribe in `start()`, unsubscribe in `stop()`; ignore any event with no `tailId`.
- Add the per-peer `owed` map, the `runFor` decision, and the `'none'` drop in `schedulePeer` in place of the `done` check.
- Parameterize `runCatchUp`'s id source; move the `listBlockIds` inert bail into the whole-store branch.
- Clear `owed` correctly: the worked snapshot on a clean delta run, the whole set on a clean whole run, nothing on a non-clean run.
- Make delta scheduling leave an already-pending timer alone.
- Pass `storageRepo.onAnyCollectionChange` from both construction sites.
- Reproduction test in `packages/cadre-core/test/peer-join-backfill.spec.ts`: a caught-up, still-connected peer is re-offered a block whose local revision advanced, and only that block.
- Second test, for the rule that prevents double-pushing: an event with no `tailId` (a push landing in the store) offers nothing.
- Update the module header and `docs/cadre/control-replication.md` → "Catching up a new machine".
- Confirm with `DEBUG=sereus:cadre:peer-join-backfill` that the trigger fires on N for the two app-collection blocks, and record what the run showed about M's cohort membership before the final write.
- Run the contended series and report the count honestly.
- Remove the `in-flight` entry for this slug from `tickets/.pre-existing-known.md`.
