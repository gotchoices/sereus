----
description: When two machines change the same membership record at the same moment, which happens routinely while a cadre starts up, one change is refused and is never tried again. A machine's own address record or an owner's re-broadcast of a member is then lost until a later pass happens to redo it. A degraded-cohort test fails on this on most boots.
prereq:
files: packages/cadre-core/src/control-write-retry.ts (RETRIABLE_CONTROL_WRITE_MATCHERS, matchesRetriableFailure, SCHEMA_INIT_RETRY_POLICY as the precedent for a per-call-site policy), packages/cadre-core/src/control-database.ts (lockedWithRetry ~4002, execWrite ~4031, updateSelfPeerRecord ~2320, reauthorizeCadrePeer ~3316, deleteCadrePeer ~3365, removeMachine ~2603), packages/cadre-core/src/cadre-node.ts (publishSelfRecord ~3383, signSelfRecord ~3605, reissuePendingPeerWrites ~5120, reissuePeerAuthorize ~5146, revouchDependents ~9540, scheduleSelfRegistration ~3311), packages/cadre-core/src/seed-bootstrap.ts (reauthorizePeer ~732), packages/cadre-core/src/control-write-retry.spec.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (afterEach abandoned-write check ~1060), packages/integration-tests/src/scenarios/machine-removal.integration.ts (~119), docs/architecture.md (#control-write-retry, "What is never retried, and why")
difficulty: hard
architecture: docs/testing.md
----

# A `CadrePeer` row's two writers refuse each other, and the loser is never re-run

Supersedes `tickets/backlog/bug-owner-write-racing-a-machines-own-publish-fails` (same defect, seen there on `removeMachine`). Delete that backlog ticket when this lands.

## Failing test

`packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts` > "commits with a healthy three-member cohort (authorize AND remove)", failing in the file's `afterEach` abandoned-write check (~line 1060):

```
AssertionError: a control write was abandoned while the cohort was healthy — it is lost, and nothing else in this file would have failed: expected [ …(2) ] to deeply equal []
```

The losses happen during `beforeAll`'s trio boot; the first case's `afterEach` is the first check that sees them. The case's own writes commit.

Reproduce (about 23 s per run; the race happens at boot, so the first case alone is enough):

```
yarn workspace @serfab/integration-tests exec vitest run control-write-degraded-cohort-member -t "commits with a healthy three-member cohort"
```

Measured 2026-10-21 at `597c2833`, stale-build guard green: the implement pass of `degraded-cohort-covers-a-member-silent-after-the-pend` saw it in 1 boot of 4 (whole-file runs); this triage's four runs of the first case alone failed **4 of 4**: twice B and C `[self-record-update]`, once B and C again, once A `[peer-reauthorize]` plus C `[self-record-update]`. Fingerprints seen (each line is `[abandoned-write <node>] [<label>] declined after 1/3 attempt(s) …`):

```
A [peer-reauthorize]   concurrent modification: another writer changed or removed the row in CadrePeer at primary key ("<B>") | Tree collection default/cadrecontrol/CadrePeer: the entry at key … was changed by another writer since this change read it
B [self-record-update] concurrent modification: … CadrePeer at primary key ("<B>") | …
C [self-record-update] concurrent modification: … CadrePeer at primary key ("<C>") | …
```

## What happens

A machine's `CadrePeer` row has two writers:

- the owner (A): the write-while-alone drain (`CadreNode.reissuePendingPeerWrites` → `reissuePeerAuthorize` → `SeedBootstrapService.reauthorizePeer` → `ControlDatabase.reauthorizeCadrePeer`) re-touches rows A authorized while it had no control connection. It fires when A first gets a reachable sibling, which is the moment B and C connect.
- the machine itself (B, C): `scheduleSelfRegistration` publishes its signed address record about a second after start, and the first-growth publish fires when it first gets a reachable sibling, again the moment the trio connects.

Both writes read the row, then commit. Whichever commits second finds the row changed. Optimystic's conflict replay refuses it (`TreeEntryChangedError`), and the Quereus bridge raises `ConcurrentModificationError` (`StatusCode.BUSY`). `ControlDatabase.lockedWithRetry` does not re-run it, because `isRetriableControlWriteFailure` claims only a cohort that did not answer. The write is reported abandoned (`control:write-abandoned`) and dropped:

- A's lost re-touch is benign in effect: the drain keeps the entry queued, and the next drain sees `record.sig` set and drops it. It is still reported as an abandoned write.
- A machine's lost self-publish leaves its row without its address record until `publishFirstSelfRecord` on a later reconcile pass, or the 7.5-minute heartbeat.
- An owner's `removeMachine` lost to the machine's publish fails to the user (the backlog ticket's evidence; `machine-removal.integration.ts` now waits for `registerSelf` to avoid it).

## Is re-running a lost update safe?

Yes, by upstream's contract, when no partial commit is in the chain:

- `TreeEntryChangedError` is thrown inside the action's atomic handler, so none of that action's entries land (`db-core/src/collections/tree/struct.ts`, doc on `TreeGuardRefusedError`). It is not a `StaleFailure`, so Optimystic never absorbs it itself.
- In a multi-collection commit, the refusal escapes `TransactionCoordinator.commitAttempts` through `refreshBetweenAttempts` and leaves `commit()` through `reportSaved`. That rethrows it as `CoordinatorPartialCommitError` whenever any participant was saved (`db-core/src/transaction/coordinator.ts` ~389, ~595). A bare refusal therefore means nothing was saved. `reportsPossiblyStoredWrite` already vetoes the partial-commit types by `instanceof`, before any matcher runs.
- The bridge's doc on `ConcurrentModificationError` (`quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` ~251): "retrying the statement sequentially re-reads the row and decides again."
- `ConcurrentModificationError` is exported from both the plugin's root and `/plugin` entries in the linked 1.17.0 build.

## Why widening the classifier alone is wrong

The funnel re-runs only the locked body. For both writers involved here, the read, the decision and the signature happen outside that body, so a bare re-run is either refused again or does damage:

1. **Self-publish (`updateSelfPeerRecord`).** `publishSelfRecord` reads the row, then `signSelfRecord` signs `UpdatedAt = max(now, current.updatedAt + 1)`, then `execWrite` runs. A re-run presents the same signed record. If the rival was the owner's drain re-touch, it bumped `UpdatedAt` to `max(now@A, old + 1)`, which can exceed the signed value. The self branch of `CadrePeer.AuthorizedUpdate` then fails `new.UpdatedAt > old.UpdatedAt`, a CHECK failure that is still not retried. The record must be re-read and re-signed inside the retried body.
2. **Drain re-touch (`reauthorizeCadrePeer` from `reissuePendingPeerWrites`).** The drain reads `record.sig` outside the lock, and skips the row when the machine has self-published. A bare re-run after losing to that self-publish would commit the owner branch over the self-signed row. It would rewrite `UpdatedAt`, leave `Sig` signed over the old `UpdatedAt`, and make the machine's address record unverifiable to resolvers until its next heartbeat (the `NOTE:` on `AuthorizedUpdate` in `control-schema.ts`). The re-run must see the self-publish and do nothing: carry the "only while unsigned" decision into the locked body (for example `and Sig is null` on the drain's update, which the other caller, `revouchDependents` in `removeOwner`, must not get).
3. **Removal (`deleteCadrePeer` / `removeMachine`).** The `'remove'` signature binds `(PeerId, StampId)`, and a self-publish never changes `StampId`, so re-running the body is valid as is. Confirm the body re-reads whatever else it decides on.

## Root-cause fix (proposed)

- Add a lost-update policy beside `SCHEMA_INIT_RETRY_POLICY` in `control-write-retry.ts`. It is the default classifier plus `ConcurrentModificationError` claimed by type, after both vetoes. Opt in only the `CadrePeer` writers whose locked bodies have been made to re-read and decide (items 1 to 3 above). Do not widen the default list: the module's own rule is that anything there "must be safe for all ~19 callers", and several other bodies sign over rows read outside the lock.
- Restructure the self-publish so the read of the current row and `signSelfRecord` run inside the retried body. `lastSignedSelfRecord` / `noteSelfPeerWritten` must record the record actually written, not the first one signed.
- Move the drain's "machine has self-published, nothing to re-touch" decision into the locked body.
- Update `docs/architecture.md` → "Control-write retry" ("What is retried" and "What is never retried, and why") to name the lost-update class and the per-call-site opt-in. Update the comments that describe the current gap: `cadre-node.ts` `scheduleSelfRegistration` (~3326) and `machine-removal.integration.ts` (~119).

## Design constraints

- Never re-run a lost update for a body whose decision or signature was made outside the lock (item 2 shows the harm). The opt-in has to be per call site and justified at the call site, as `SCHEMA_INIT_RETRY_POLICY`'s NOTE requires.
- Match by type, not text. Import `ConcurrentModificationError` from the same entry as `PartialCommitError`; the NOTE on `reportsPossiblyStoredWrite` about the two plugin entries sharing one chunk applies to it too.
- The vetoes still run first. A `ConcurrentModificationError` whose chain carries `CoordinatorPartialCommitError` / `PartialCommitError` / `SyncRetryExhaustedError` / a non-final `TornActionError` must stay declined. Add spec cases in `control-write-retry.spec.ts` for both the bare and the vetoed shape.
- The 10 s retry budget still applies. A self-publish that lost after 7.5 s (seen) gets at most one retry; that is acceptable.
- Do not loosen the degraded-cohort `afterEach` check. It is correct: these writes are lost.
- No determinism edition, byte-format vector, golden fixture or migration is involved. The control schema does not change, unless the chosen drain condition needs a schema change rather than a `where` clause; then the control-schema release and migration rules apply (`control-store-migrates-on-start`).

## Confirm

Run the reproduce command above about ten times: zero `concurrent modification` abandonments. Then run the whole file once in isolation, and `machine-removal.integration.ts` with its `registerSelf` wait removed at least three times.
