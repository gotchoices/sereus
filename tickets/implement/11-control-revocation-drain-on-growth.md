----
description: A revocation made while a machine was offline still has to actually reach the other machines once it reconnects. Wire the re-sendable revocation record into the existing catch-up pass that runs when a node rejoins, including after a restart.
prereq: control-revocation-reissuable-tombstone
files: packages/cadre-core/src/cadre-node.ts (noteControlWrite, noteGuardedDelete, drainPendingRevocations, runDrainControlReplication, pendingRevocations), packages/cadre-core/src/seed-bootstrap.ts (reissueRevocations wrapper), packages/cadre-core/src/control-database.ts (GuardedDeleteListener seam — DONE, committed), packages/cadre-core/test/cadre-node-control-replication.spec.ts (DONE, green), packages/cadre-core/test/control-database-offline-peers.spec.ts (~314-316, MUST update), packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts (scratch experiment to REPLACE), packages/integration-tests/src/harness/node-fixtures.ts, docs/architecture.md (~line 198-204), tickets/.pre-existing-known.md, tickets/blocked/forked-control-collection-sync-livelocks.md
difficulty: hard
----

<!-- resume-note -->
## Resume note (2026-08-01 run 4, ended on BUDGET_WARNING)

### Run 4 progress (in working tree, uncommitted — do not redo)

- `packages/cadre-core/test/control-database-offline-peers.spec.ts` — DONE, GREEN.
  Rewritten to the new contract: `pendingPeerWrites` helper narrowed to
  `Map<string, 'authorize'>`; new `pendingRevocations(node)` peek helper;
  `runRemoveWrite` captures `queryCadrePeerStampId(doomedPeerId)` BEFORE the
  remove, then asserts the `pendingPeerWrites` entry is ABSENT and
  `pendingRevocations.get(stampId)` equals `{tableName:'CadrePeer', rowKey:
  doomedPeerId, stampId}`; the second (no-op) remove asserts queue size
  unchanged. Verified: `npx vitest run test/control-database-offline-peers.spec.ts
  test/cadre-node-control-replication.spec.ts` in `packages/cadre-core` →
  **2 files, 33/33 passed** (112 s). `yarn build` in cadre-core clean.
- `packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts`
  — WRITTEN (both tests per the original Tests section, all run-1 recipe
  corrections applied: stamp captured before remove, seed bootstrap re-wired
  before any sibling connect after each A restart, no OwnerKey re-insert, vouch
  before connect; shared `removeWhileAlone()` phases 1–3 + shared
  `expectRemovalConverges()` phase 4). **Both tests FAIL on the predicted
  pre-existing fingerprint**, NOT on this ticket's code:
  `SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10
  retries: stale revision: block … at rev 3 (resp. 4), requested rev 1` — the
  exact headline signature of `tickets/blocked/control-db-cross-node-convergence-halted`.
  Both die symmetrically at ~15 s, i.e. inside shared Phase 1 (the
  `authorizePeer(X)`/converge machinery, same as the already-listed
  `control-write-while-alone-convergence` "both tests" entry) — **before the
  delete or any drain code runs**. A drain-thrown error could not surface this
  way (drain catches and logs). Classification per this ticket's own rules:
  belongs under `control-db-cross-node-convergence-halted` in
  `.pre-existing-known.md`. Do not skip/loosen/delete the scenario. Log:
  scratchpad `delete-alone-run1.log` (gone next session — fingerprint quoted
  above is the substance).

### Remaining work (in order) — board/docs reconcile only, no product code left

- `tickets/.pre-existing-known.md`: add
  `control-delete-while-alone-convergence.integration.ts (both tests) → control-db-cross-node-convergence-halted | blocked | 2026-08-01`
  (note: fails in Phase 1 setup, before the delete-drain path is reached, so the
  scenario currently proves nothing about this feature either way); REMOVE the
  `zz-scratch-delete-alone` line (~27) and its explanatory paragraph
  ("The third (`zz-scratch-delete-alone`)…", ~88–95) once the scratch file is
  deleted.
- Delete `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`.
- `tickets/blocked/control-db-cross-node-convergence-halted.md`: add the new
  scenario to `files:` and to "The failing tests" table (symptom: both tests,
  `SyncRetryExhaustedError default/CadrePeer at rev 3/4, requested rev 1`,
  measured 2026-08-01 solo run, quereus v4.6.0 `f620aade`).
- `tickets/blocked/forked-control-collection-sync-livelocks.md`: (a) `files:` —
  replace the deleted scratch path with the new scenario path, and fix the stale
  `tickets/plan/10-control-delete-while-alone-tombstone.md` reference (that plan
  ticket became the shipped `control-revocation-reissuable-tombstone` +
  `control-revocation-drain-on-growth` implement work); (b) rewrite the
  "Alternative unblock" paragraph — WRONG as written: the shipped work converges
  the *Revocation tombstone*, it does NOT stop `removePeer` committing a
  local-only `CadrePeer` delete while alone, so the fork it describes is still
  constructed and the livelock is NOT unblocked from this repo; (c) "The failing
  test" / "What the scenario builds" / "Do not" sections reference the scratch
  file — point them at the new scenario, noting it currently dies EARLIER (in
  Phase 1, the halted class) and so does not currently reach the fork the ticket
  is about.
- `docs/architecture.md` ~198–204 rewrite (see "Docs" below + kept run-1 notes:
  intro line ~198 AND the bullet; honest residuals — row not physically deleted
  on holders, clear-on-exec ≠ broadcast →
  `tickets/backlog/control-rereplication-broadcast-confirmation` (exists,
  verified); fix stale `tickets/backlog/control-delete-while-alone-tombstone.md`
  path reference).
- `yarn lint` (root). Then move this ticket to review/ with an honest handoff:
  unit layer fully green (33/33 across the two specs); integration proof of the
  end-to-end path BLOCKED on `control-db-cross-node-convergence-halted`
  (upstream optimystic) — and the re-issue DB layer additionally depends on the
  quereus-v4.6.0 UNIQUE-collision triage
  (`10-revocation-reissue-same-pk-update-unique-collision`, blocked;
  `10-control-revocation-reissue-test-fixes` in implement), so the whole feature
  path is unproven end-to-end until both clear. Also carry the run-1 note:
  confirm/state in the handoff whether anything clears a `DeviceToken` without
  an owner signature (not yet checked in any run).

## Resume note (2026-08-01 run 3)

Runs 2+3 together have landed **all of Phase 1 and Phase 2, plus the primary unit
spec**. Run 2's `ControlDatabase` seam is already COMMITTED (20cf4f8). Run 3's edits
are COMMITTED (1902c65), build-clean, and its rewritten
spec passes in the whole-suite run. Do not redo any of this:

- `src/cadre-node.ts`: `pendingPeerWrites` narrowed to `Map<string, 'authorize'>`;
  `pendingRevocations` + `reissuedHeldRevocations` fields added; `noteControlWrite`
  rewritten (remove arm only clears a queued authorize + logs when alone);
  `noteGuardedDelete` added; `drainPendingRevocations` added (merged sweep+in-session
  drain per run-1 refinements 2–6: success-gated sweep flag, per-stamp clear, NOTE: on
  sweep sizing, broadcast-confirmation caveat in its doc); drain step 2 inserted into
  `runDrainControlReplication` (before `reconstructAuthoredMembership`, steps
  renumbered, no gate-refresh wrapper — rationale in the step comment); dead `remove`
  branch deleted from `reissuePendingPeerWrites`; doc comments updated on the field,
  `drainPendingPeerWrites`, `reconstructAuthoredMembership`; listener wired in
  `start()` beside the membership listener and cleared in teardown beside it.
- `src/seed-bootstrap.ts`: `reissueRevocations(rows, reissuedAt)` wrapper after
  `reauthorizePeer` (requireOwnerPublicKey → controlDatabase guard → delegate);
  `RevocationRow` added to the `./types.js` import block.
- `test/cadre-node-control-replication.spec.ts`: fully rewritten — fake control DB
  gained `queryRevocations`, fake seed gained recording/throwing `reissueRevocations`;
  old `'remove'`-queue tests replaced; new describes "queueing (noteGuardedDelete via
  the committed-delete seam)" and "revocation drain (drainPendingRevocations)"
  (sweep-covers-all-exactly-once, no-re-sweep, queued-row-only second drain,
  throw-leaves-queued + sweep-retry, non-owner drop). All green.

### Whole-suite run result (cadre-core, `yarn test`): 15 failed / 1357 passed

Two distinct classes — do NOT conflate:

1. **Ours to fix (next run, first thing)**:
   `test/control-database-offline-peers.spec.ts` — 8 failures, all through
   `runRemoveWrite` (~line 314–316): `expect(pendingPeerWrites(node).get(doomedPeerId)).toBe('remove')`
   asserts the OLD contract. Rewrite to the new one: after a remove-while-alone the
   `pendingPeerWrites` entry is absent, and the tombstone is queued in
   `pendingRevocations` keyed by the removed row's StampId — but FIRST check how that
   spec boots its node: the guarded-delete listener is wired in `start()`; if the
   harness starts the real node the queue assertion works directly, if it injects like
   the replication spec it must drive/assert differently. There is also 1 unhandled
   rejection in that file (`queryPeerRecord` on a closed DB from the reconcile loop) —
   pre-existing teardown noise, do not chase, but confirm it predates the spec edit.
2. **Not ours — already filed in `tickets/.pre-existing-error.md` (this run). Do not
   re-report; check `.pre-existing-known.md` for the slug triage assigns before
   touching them**: `control-revocation-reissue.spec.ts` (4),
   `control-revocation-replay.spec.ts` (1) — `UNIQUE constraint failed:
   Revocation.TableName, Revocation.StampId` thrown from `../quereus` (now at
   freshly-released v4.6.0 `f620aade`) `dml-executor.ts processUpdateRow` on the
   PK-preserving `set ReissuedAt` UPDATE; plus `membership-connection-gater.spec.ts` /
   `control-stream-authorization.spec.ts` (1 each, retired stamp still admitted —
   plausibly same root). These specs import nothing this ticket edits; drift from the
   quereus release since the prereq ticket ran them green. **Consequence: the re-issue
   drain's DB layer may be broken under quereus v4.6.0 until that triage lands — the
   integration scenario below may fail on THIS fingerprint too (a
   `ConstraintError: UNIQUE constraint failed: Revocation…` inside the drain log);
   classify such a failure against the triage ticket, not the two livelock slugs.**

### Remaining work — SUPERSEDED by the run-4 list above (first two items DONE in run 4)

### Kept from run 1 (still needed; the seams/design sections are dropped — implemented, the code is the reference)

**Test-plan corrections:**
- Integration risk ledger: the insert/update analog
  `control-write-while-alone-convergence.integration.ts` is ALREADY a known failure
  ("both tests") under `control-db-cross-node-convergence-halted` (see
  `.pre-existing-known.md` ~17–37). The new delete scenario may fail even SOLO with
  that class's fingerprint (`SyncRetryExhaustedError … requested rev 1` variants or a
  converged-wait timeout), not only the whole-suite livelock signature
  (`rev N, requested rev N`). If it fails with either fingerprint, list it in
  `.pre-existing-known.md` under the matching slug, update that ticket's
  `files:`/failing-test references, and say so plainly — do not skip/loosen. (And see
  the new quereus-v4.6.0 fingerprint above — three possible classifications now.)
- Scenario recipe: `B.isMember(x)` works with an EMPTY trusted-owner anchor (scratch
  precedent — `isMember` is the addressable surface, not `listAuthorizedMembers`);
  capture `xStamp` via `A.getControlDatabase()!.queryCadrePeerStampId(xPeerId)` BEFORE
  `removePeer`; after each A restart `initializeSeedBootstrap(privateKeyB64)` must run
  BEFORE the sibling connects (the growth-edge drain needs `canAuthorize()`); OwnerKey
  row survives restart on the same `MemoryRawStorage` (no re-insert). Keep scratch's
  phase order: A vouches B before `connectControlNodes(B, A)`.
- Run: `cd packages/integration-tests && npx vitest run src/scenarios/control-delete-while-alone-convergence.integration.ts`
  (package-relative forward-slash path filter, ~40 s; `-t` imports everything, ~2 min).
  Stale-build guard: `../quereus` and `../optimystic` may each need `yarn build` first.

**Docs / board:**
- `docs/architecture.md`: besides the ~204 bullet rewrite, the INTRO line at ~198
  ("only the **delete-while-alone** path remains an open durability gap") must change
  too. The clear-on-exec residual references
  `tickets/backlog/control-rereplication-broadcast-confirmation.md` (exists, verified).

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
adds the delete arm to all of it. (Design detail now lives in the implemented code —
see `files:` — and the run-3 note above.)

## Edge cases & interactions (original — still governs review)

- **"0 connections" is not the same as "alone".** A write made with zero libp2p
  connections can still **fail** with `Failed to get super-majority` rather than commit
  local-only (sibling still in Optimystic's FRET table). Every re-issue call is caught
  and logged, never thrown into the drain; a throw leaves the entry queued.
- **Clear-on-exec is not proof of broadcast.** Tracked by
  `tickets/backlog/control-rereplication-broadcast-confirmation`; the revocation drain
  inherits it (referenced in a comment, not re-filed).
- **Re-issue that itself commits alone.** Entry cleared while still unreplicated; the
  first-growth sweep re-covers on next process start; within a process a full
  disconnect→reconnect re-arms the edge.
- **The `CadrePeer` collection stays forked.** This ticket converges the *tombstone*,
  not the delete — `tickets/blocked/forked-control-collection-sync-livelocks` is NOT
  closed by this work (and its "Alternative unblock" paragraph must be corrected).
- **Non-owner node**: queued entries dropped, not retried forever.
- **`DeviceToken` clear on a member's own device** goes through the same seam. Confirm
  nothing clears a `DeviceToken` without an owner signature; if something does, that
  path's tombstone cannot be re-issued — needs a line in the handoff.

## Tests (original spec for the remaining integration work)

**Integration** — replace the scratch file with
`packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts`,
keeping the scratch file's phase structure:

1. A + B up, X authorized, X converged on B (`waitForCadrePeerConverged`).
2. B stopped; A restarted on the same `MemoryRawStorage` — A now has zero connections
   *and* an empty FRET view of B.
3. `A.removePeer(X)` — commits local-only.
4. B restarts and reconnects. Assert **B reports `isMember(X) === false`** within the
   convergence timeout, and that `B.getControlDatabase().queryRevokedStamps('CadrePeer')`
   contains X's stamp.

Second test, restart durability: same through step 3, then restart A **again** before
any connection, and only then bring B back — the first-growth sweep must carry the
tombstone with nothing in memory.

Then **delete `zz-scratch-delete-alone.integration.ts`** and remove its line from
`tickets/.pre-existing-known.md`. Failure classification: see run-3 note (three
possible fingerprints now). Do not skip, loosen, or delete the test to get a green run.

## Docs

`docs/architecture.md` ~line 199: the bullet **"Delete-while-alone durability (open,
security-relevant)"** becomes a ✅ bullet describing the shipped mechanism (re-issuable
`Revocation` tombstone, drained on the growth edge, swept on first growth after start),
stating the residual honestly: the removed row itself is not deleted on nodes that
already held it, only rendered inert by the tombstone. Fix the stale
`tickets/backlog/control-delete-while-alone-tombstone.md` path reference while there.

## TODO

Phase 3 — remaining
- Fix `control-database-offline-peers.spec.ts` remove-write assertions (new contract).
- New integration scenario; delete the scratch file; reconcile
  `tickets/.pre-existing-known.md` and `tickets/blocked/forked-control-collection-sync-livelocks.md`.
- `docs/architecture.md` rewrite; `yarn lint`; move to review/ with honest handoff.
