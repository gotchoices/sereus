----
description: A revocation made while a machine was offline still has to actually reach the other machines once it reconnects. Wire the re-sendable revocation record into the existing catch-up pass that runs when a node rejoins, including after a restart.
prereq: control-revocation-reissuable-tombstone
files: packages/cadre-core/src/cadre-node.ts (noteControlWrite ~2027, runDrainControlReplication ~2067, reconstructAuthoredMembership ~2142, drainPendingPeerWrites ~2210, reissuePendingPeerWrites ~2230, committedAlone ~2011, pendingPeerWrites ~371), packages/cadre-core/src/control-database.ts (deleteGuardedRow — add the committed-delete listener next to membershipListener ~398/1352), packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts (scratch experiment to REPLACE), packages/integration-tests/src/harness/node-fixtures.ts, docs/architecture.md (~line 199, the "Delete-while-alone durability (open)" bullet), tickets/.pre-existing-known.md, tickets/blocked/forked-control-collection-sync-livelocks.md
difficulty: hard
----

## Why

`control-revocation-reissuable-tombstone` makes a `CadreControl.Revocation` row
re-writable (owner-signed monotonic `ReissuedAt` bump) and makes every membership read
treat a retired stamp as absent. Nothing yet *calls* the re-issue, so a revocation that
committed while the node was alone still never reaches the cohort.

`CadreNode` already has the machinery for exactly this: a write-while-alone queue
(`pendingPeerWrites`), a 0→≥1 control-connection growth edge
(`handleControlConnectionChange`), a single-flight drain
(`drainPendingControlReplication`), and a one-shot first-growth reconstruction sweep for
writes made before this process started (`reconstructAuthoredMembership`). This ticket
adds the delete arm to all of it.

Today's `reissuePendingPeerWrites` handles a queued `remove` by calling
`seedBootstrapService.removePeer(peerId)` again. That is a no-op — the row is already
gone, `deleteGuardedRow` returns `false` without issuing any statement. Replace it.

## Design

**A committed-delete seam on `ControlDatabase`.** Mirror the existing single
`membershipListener`: one optional listener invoked after every guarded delete commits,
with `{ tableName, rowKey, stampId }`. `CadreNode` wires it in `start()` and clears it on
teardown. This is what makes the delete arm cover all four guarded tables
(`CadrePeer`, `DeviceToken`, `Strand`, `ValidationKey`) through one seam, instead of
threading a return value out of four unrelated call paths.

**In-session queue.** `CadreNode` keeps `pendingRevocations: Map<string, {tableName,
rowKey, stampId}>` keyed on `stampId`. The listener adds an entry when
`committedAlone()`, and deletes any entry for that stamp otherwise — same shape as
`noteControlWrite`. Keep `noteControlWrite`'s loud `remove` log line but rewrite its text:
the re-issue is no longer best-effort-and-probably-useless.

**Drain step.** Add a step to `runDrainControlReplication`, after the self rows and
before/alongside `drainPendingPeerWrites`: gate on
`seedBootstrapService.canAuthorize()` (a node with no owner key cannot sign a re-issue —
drop stray entries, as `drainPendingPeerWrites` already does), then call
`controlDatabase.reissueRevocations(...)` for the queued rows. Clear entries only on
success; a failure leaves them queued for the next growth edge.

**First-growth sweep (restart durability).** On the first growth
(`firstGrowth`/`reconstructedLocalOnlyWrites`, next to
`reconstructAuthoredMembership`), an owner-capable node re-issues **every** locally-held
tombstone from `queryRevocations()` — one batched transaction. This is the only thing
that covers a removal made before this process started, since the in-memory queue does
not survive a restart. Skip stamps already in the in-session queue so they are not
bumped twice.

Sizing: this is O(all tombstones ever) row-updates in one transaction, once per process.
`Revocation` is append-only and the schema already declares unbounded growth acceptable
for a cadre-sized party. Leave a `NOTE:` at the sweep — *if the tombstone table ever gets
large, bound the sweep (e.g. persist a node-local high-water mark of what has been
re-issued while connected) instead of re-touching everything.*

**Keep the existing `remove` entry in `pendingPeerWrites`?** No. Delete the `remove`
branch from `reissuePendingPeerWrites` and the `'remove'` arm of that map's value type;
removals are now entirely the `pendingRevocations` path. `noteControlWrite`'s `remove`
call site stays only if it still has a log line worth keeping — do not leave two queues
tracking the same event.

## Edge cases & interactions

- **"0 connections" is not the same as "alone".** Measured during the plan pass: with
  the sibling still in Optimystic's FRET table for the block, a write made with zero
  libp2p connections **fails** with `Failed to get super-majority` rather than committing
  local-only. So a re-issue can throw for reasons that are not bugs. Every re-issue call
  must be caught and logged, never thrown into the drain (matching the existing
  best-effort drain contract), and a throw must leave the entry queued.
- **Clear-on-exec is not proof of broadcast.** A successful `exec` does not mean the row
  replicated — the connection that fired the growth edge may not be in the affected
  block's cluster. This is the known gap tracked by
  `tickets/backlog/control-rereplication-broadcast-confirmation`; the revocation drain
  inherits it. Do **not** re-file it — reference it in a comment at the clear site.
- **Re-issue that itself commits alone.** Follows from the above: the entry is cleared
  while still unreplicated. The first-growth sweep re-covers it on the next process
  start; within a process, a full disconnect→reconnect re-arms the edge.
- **The `CadrePeer` collection stays forked.** This ticket converges the *tombstone*, not
  the delete: a sibling that held the removed row keeps holding it physically (inert —
  every read path filters it as of the prereq ticket). That fork is what
  `tickets/blocked/forked-control-collection-sync-livelocks` is about, and it is **not**
  closed by this work. Correct that ticket's "Alternative unblock, entirely in this repo"
  paragraph, which currently claims plan ticket 10 removes the fork.
- **Non-owner node.** Cannot sign a re-issue. Its `pendingRevocations` entries are
  dropped, not retried forever.
- **Teardown mid-sweep.** Same `_running`/`controlNode`/`controlDatabase` guards the
  existing sweeps use.
- **Concurrent drains.** The single-flight guard covers the new step; two growth signals
  must not double-issue (a double bump is harmless but wasteful, and the second commit
  loses its monotonic CHECK).
- **`DeviceToken` clear on a member's own device.** Goes through the same seam, so it is
  covered without extra wiring. Confirm nothing clears a `DeviceToken` without an owner
  signature; if something does, that path's tombstone cannot be re-issued and needs a
  line in the handoff.
- **Membership gate refresh.** The re-issue writes are `Revocation` writes, not
  `CadrePeer` writes, so they do not fire `membershipListener` — but the *effect* on
  `listAuthorizedMembers` is real on the receiving node. Check whether the drain needs a
  gate refresh after the revocation step, the way `deferMembershipGateRefresh` wraps the
  other sweeps.

## Tests

**Unit** (`packages/cadre-core/test/cadre-node-control-replication.spec.ts`, which
already covers the insert/update drain):

- a guarded delete committed with zero connections lands in `pendingRevocations`; one
  committed with connections present does not;
- a drain with an owner key calls `reissueRevocations` with exactly the queued rows and
  clears them on success; a throwing `reissueRevocations` leaves them queued;
- a drain on a node with no owner key clears the queue without calling the database;
- first growth re-issues every row from `queryRevocations()`, minus in-session
  duplicates; second growth does not.

**Integration** — replace the scratch file with a real regression scenario,
`packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts`,
keeping the scratch file's phase structure (it is the only recipe known to produce a
genuinely local-only commit):

1. A + B up, X authorized, X converged on B (`waitForCadrePeerConverged`).
2. B stopped; A restarted on the same `MemoryRawStorage` — A now has zero connections
   *and* an empty FRET view of B.
3. `A.removePeer(X)` — commits local-only.
4. B restarts and reconnects. Assert **B reports `isMember(X) === false`** within the
   convergence timeout (with the prereq ticket's read-path change, `isMember` now
   reflects the tombstone), and that `B.getControlDatabase().queryRevokedStamps('CadrePeer')`
   contains X's stamp.

Second test, restart durability: same through step 3, then restart A **again** before any
connection, and only then bring B back — the first-growth sweep must carry the tombstone
with nothing in memory.

Then **delete `zz-scratch-delete-alone.integration.ts`** (its own header says to, once
the experiment settles — it has) and remove its line from `tickets/.pre-existing-known.md`.
If the new scenario fails only under whole-suite contention with the
`SyncRetryExhaustedError … at rev N, requested rev N` signature, that is the tracked
upstream livelock: add the new path to `.pre-existing-known.md` under
`forked-control-collection-sync-livelocks`, update that ticket's `files:` and failing-test
name, and say so plainly in the review handoff. Do not skip, loosen, or delete the test to
get a green run.

Run: `cd packages/integration-tests && npx vitest run src/scenarios/control-delete-while-alone-convergence.integration.ts` — a package-relative forward-slash path filter works on Windows and costs ~40 s; `-t "<name>"` still imports every scenario file and costs ~2 min. The suite has a stale-build guard: `../quereus` and `../optimystic` may each need `yarn build` first.

## Docs

`docs/architecture.md` ~line 199: the bullet **"Delete-while-alone durability (open,
security-relevant)"** becomes a ✅ bullet describing the shipped mechanism (re-issuable
`Revocation` tombstone, drained on the growth edge, swept on first growth after start),
and must state the residual honestly: the removed row itself is not deleted on nodes that
already held it, only rendered inert by the tombstone. Fix the stale
`tickets/backlog/control-delete-while-alone-tombstone.md` path reference while you are
there.

## TODO

Phase 1 — seam + queue
- Add the committed-delete listener to `ControlDatabase` next to `membershipListener`;
  fire it from `deleteGuardedRow` after commit.
- Add `pendingRevocations` to `CadreNode`; wire the listener in `start()`, clear on
  teardown; rewrite `noteControlWrite`'s `remove` log text.

Phase 2 — drain
- Add the revocation step to `runDrainControlReplication` (owner-gated, best-effort,
  clear-on-success) and the first-growth full sweep with its `NOTE:`.
- Remove the dead `remove` branch from `reissuePendingPeerWrites` and narrow the
  `pendingPeerWrites` value type.

Phase 3 — tests + docs
- Unit specs above; `cd packages/cadre-core && yarn test 2>&1 | tee /tmp/cadre-core.log`.
- New integration scenario; delete the scratch file; reconcile
  `tickets/.pre-existing-known.md` and `tickets/blocked/forked-control-collection-sync-livelocks.md`.
- `docs/architecture.md` bullet rewrite; `yarn lint`.
