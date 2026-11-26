description: A machine that keeps a full copy of every strand its party runs could be left one version behind a change it did not help approve, for as long as it stayed connected. The machine that writes a change now offers it again to the copies that were already connected, so they no longer stay behind.
architecture: docs/cadre/control-replication.md#catching-up-a-new-machine
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, docs/cadre/control-replication.md, tickets/.pre-existing-known.md
----

## What landed

`PeerJoinBackfill` had one trigger: a connection. A peer marked caught up and still connected got nothing more, so a revision that advanced after that mark was never re-offered — an always-on storage replica that did not sign a commit stayed a revision behind it for the life of the connection. The per-block skip rules were already correct for this case; only the scheduling was missing.

The module now has a second trigger: a commit this node made. On one, it unions the commit's block ids into a per-peer `owed` set and schedules. A scheduled run's *kind* is decided when the timer fires, not when it is scheduled, so both triggers share one scheduling entry point and one copy of the in-flight, re-arm and backoff bookkeeping: `whole` (the peer is not caught up — enumerate the store, as before), `delta` (caught up and owes blocks — offer exactly those ids), `none` (caught up and owes nothing — dropped at schedule time, where the drop used to be on `done` alone).

The rule that prevents double-pushing: a node re-offers only what it committed. The store's change feed fires for every block that lands, a commit or a push, so the module ignores every event whose `tailId` is absent. Without it, a whole-store catch-up of N blocks into a peer would make that peer offer all N straight back.

Everything else is reused unchanged — the per-peer memo, the proof-signature skip, the chunk budgets, the dial and response deadlines, the backoff, and the control network's `authorizePeer` gate. No new timing constant: the coalesce window is the existing `debounceMs`. Wiring is one new optional dep, `subscribeStorageChanges`, subscribed in `start()` and released in `stop()`; absent (a node without a `storageRepo`, a test double), the catch-up is connection-triggered only, exactly as before. No persisted format, signed payload, schema or config field changed.

See `ticket(implement): always-on-replica-can-stay-a-revision-behind-a-commit-it-missed` for the implementation and `docs/cadre/control-replication.md` → "Catching up a new machine" for the mechanism.

## Review findings

### Fixed in this pass

**A pending delta delivery could be postponed indefinitely by identify churn** — the one real defect found, with a reproduction. `schedulePeer` cleared and re-set an armed timer for every schedule except the commit trigger's. That is the right settle behaviour for connection churn, which is a burst that should collapse to one run at its end, but `peer:identify` also fires on every identify-push from an already-connected peer (an address or protocol change), and after this change a caught-up peer with owed blocks *is* scheduled by such an event where it used to be dropped. So identify churn arriving faster than the settle window kept re-setting the delta run's timer and the owed blocks were never delivered — the same starvation the implementer's `keepPendingTimer` was added to prevent on the write-stream side, reached by the other door. Fixed by also leaving an armed timer alone whenever the pending run would be a `delta` (its owed set only grows, so there is nothing to collapse); `keepPendingTimer` still earns its place, because the commit trigger must not postpone a pending *whole* run either. One clause in `schedulePeer`, plus the reproduction in `peer-join-backfill.spec.ts` ("delivers a commit to a caught-up peer whose identify keeps re-firing") — confirmed to fail with the clause removed and pass with it.

**Two header-comment claims the change made false.** The module comment still said `peer:identify` churn for a connected, caught-up peer "is dropped before any work" and "dropped outright for caught-up peers". Both are now conditional on nothing being owed to that peer; corrected, with a pointer to the no-re-set rule above.

**A stale line in the architecture doc.** `control-replication.md` still said the node "pushes each block once per peer". It is each block *revision* once per peer now — the module comment was updated to say so and the doc was not. Corrected in place.

**DRY: `owedFor` duplicated `memoFor`.** Two identical lazy-map-init helpers in one class; both now go through one `getOrCreate` helper.

**A non-null assertion where the file already had the idiom to avoid it.** The strand wiring site wrote `node.storageRepo && ((listener) => node.storageRepo!.onAnyCollectionChange(listener))`; the same file hoists the field to a local const for the identical expression about 110 lines below (the first-sync gate's subscription). Follows that now, and the `!` is gone.

### Recorded as a tripwire, not a ticket

**A capped run drops owed ids it never reached.** A run that hits `maxBlocks` is still "clean", so `clearOwed` removes the whole worked snapshot including the ids past the ceiling — those revisions then wait for the peer's next reconnect rather than getting a delta run of their own. Conditional on a single run exceeding 10,000 blocks, which is also the condition the pre-existing `done`-on-a-capped-run tradeoff is already parked against. Added to that existing `NOTE:` in `settleRun` rather than filed, since the two conditions and the two fixes are the same one.

### Verified, no finding

**The `tailId` discriminator is sound in both directions**, read at the source in `../optimystic` rather than taken from the handoff. `StorageRepo.commit` stamps `request.tailId` onto its emitted event; `saveReplicatedBlock` and the read-driven promotion path emit tail-less events, so no replica landing is ever mistaken for a commit (the direction the no-echo rule needs). The converse hole is empty too: the only *commit* that carries no tail is the bare per-block repo operation, used by churn replication — a replica landing, which is precisely what must not be re-offered. Collection writes always carry one, since the transactor threads the committing collection's tail through every per-block commit.

**The deviation the implement ticket asked a reviewer to weigh is the right call.** The ticket's literal rule was to clear a peer's `owed` entirely on a clean *whole* run; what landed uses the snapshot rule for both kinds. Endorsed as landed: a whole run's enumeration is an async walk, so a commit landing after the walk passed a block's id was offered at the older revision, and clearing wholesale would discard the one record that the newer revision is still unsent — putting the peer back to waiting for a disconnect, the exact bug this ticket fixes. It also collapses two cases into one code path. The cost is at most one extra cheap delta run per commit that lands during a whole run. Not pinned by a test: it is clean-run bookkeeping rather than a named piece of the specification, and pinning it would need a storage seam that stalls mid-enumeration; the two commit-trigger tests exercise the `owed` bookkeeping end to end.

**The implementer's two tests both pay for themselves and were kept as written** — one is the reproduction of the reported defect, the other pins the no-echo rule through the commit's own run rather than a sleep, so a regression cannot pass on timing slack. None were cut. Nothing was added for the dep wiring at the two construction sites, for `RunKind`, or for `owed` in isolation: the type enforces the first and the behaviour tests cover the rest.

**Checked and found correct:** the memo's revision skip across the new path (`memoSettled` does not skip a block memoized at rev 4 once the local tip is rev 5); `clearOwed` on the non-clean outcomes (a denied run, an inert store and a failed push all retain `owed`, so nothing is lost to a retry); the snapshot's isolation from concurrent mutation (a `delta` run iterates its own copy, so a commit landing mid-run cannot disturb the walk); the control gate on a delta run (unchanged, still fails closed, and a denied peer is not `done` so it answers `whole`); the inert-store bail moving into `blockIdsFor`'s whole branch (a delta run names its own ids and is correctly no longer refused by a store that cannot enumerate); subscription lifecycle (`start`/`stop` symmetric, `noteCommitted` guards on `stopped`, and the handler does only map work and timer arming inside Optimystic's synchronous dispatch); two co-signers of one commit (skipped by the retained proof, and bounded to one refused push per revision where no proof was retained — pre-existing and already documented); and `owed`'s growth bound, which is the same one `PeerMemo` and `contacted` already carry and is documented at the field.

**The one loose end the handoff flagged is not a correctness concern and needed no work.** On the T strand of one uncontended debug run a behind-by-one gap closed in 254 ms with no delta-run line logged for that peer in the window. The likeliest reading stands — the whole-store push logged 150 ms earlier already carried the revision — and `debug` writes to stderr while the scenario logs to stdout, so their interleaving through one pipe is not evidence of ordering either way. The gap closed, and the contended series is 15 for 15.

**No tickets filed.** Nothing found clears the filing bar: the one real defect was minor and local enough to fix in this pass with its reproduction, the capped-run concern is conditional and belongs at its site, and no finding named a class-level invariant that a type, a general test or a boundary assertion would retire.

### Left alone deliberately

`tickets/backlog/debt-late-join-catch-up-seam-is-never-forced.md` describes a window this change narrows rather than closes, and the snapshot rule above is what preserves that narrowing. Untouched, as the handoff asked.

The `NOTE:` the implementer parked in `noteCommitted` — a connected peer that is not caught up is scheduled from the commit handler too and fires a *whole* run, costing one `authorizePeer` check per commit burst for a peer the gate keeps denying — is a deliberate, cheap tradeoff with a stated revisit condition. Left as recorded.

## Validation

- `yarn lint` (ESLint + `check:docs`, 67 Markdown files OK) — clean.
- `yarn workspace @serfab/cadre-core typecheck` and `yarn workspace @serfab/integration-tests typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — 199 files, 2716 passed, 1 skipped (one more test than the implement run: the reproduction added above). The backfill spec alone: 40 passed.
- The physical reproduction after the scheduling fix: `strand-moves-between-cadres.integration.ts` green in 25.2 s, block coverage closing in 268 ms — inside the 253–528 ms range the implement run measured, against the 60 s freeze the bug produced. `@serfab/cadre-core` was rebuilt first, since these tests run compiled output; no sibling repository was built or touched.
- The implement run's evidence was spot-checked rather than taken on trust: `tickets/.logs/always-on-replica.contended.log` holds 15 green runs of the scenario under concurrent load, and `always-on-replica.debug.log` holds 17 `kind=delta` catch-up lines.
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written. `tickets/.pre-existing-known.md` needed no further change: the implement run already moved this scenario's entry from **Open** to **Resolved in place**, keeping the two standing rules for any recurrence (do not raise a wait, do not weaken the block-coverage assertion).
