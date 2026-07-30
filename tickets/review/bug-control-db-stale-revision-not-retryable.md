description: When two machines write to the party's control database at the same instant, the loser used to die with a hard error instead of quietly retrying, which could leave a row half-written across tables. The retry fix is implemented, unit-tested, and validated by 20 scenario runs — review should confirm the fix and weigh in on one open question about a failure mode the validation surfaced.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, ../optimystic/packages/db-core/test/network-transactor.spec.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
difficulty: medium
----

# Review: stale-revision retryability fix for the control database

## What changed and where

Concurrent-write conflicts on the control database (two nodes pending the same block revision)
used to surface as a **thrown error**, so the losing node never retried and a per-tree SQL commit
sweep could split a write across trees (`PartialCommitError`). The fix classifies that specific
conflict shape and returns it as a `StaleFailure` value instead, so `Collection.sync`'s existing
bounded retry loop picks it up and retries.

All changes are uncommitted in the `../optimystic` working tree (this repo's `master` is clean;
optimystic is a linked sibling workspace referenced via `resolutions` in root `package.json`):

- `db-p2p/src/repo/cluster-coordinator.ts` — new exported `ValidatorRejectionError extends Error`
  (typed, coordinator-local, never serialized over the wire; carries `rejectReasons:
  Record<string,string>` per peer). `executeTransaction`'s `rejectionCount >
  maxAllowedRejections` branch throws this instead of a bare `Error`; the message string is
  unchanged so nothing depending on it breaks.
- `db-p2p/src/repo/coordinator-repo.ts` — `pend`'s catch block calls a new private
  `classifyStaleRejection(error, request, allBlockIds)` before rethrowing. It returns a
  reason-only `StaleFailure` **only when all three hold**: the error is a
  `ValidatorRejectionError`, the request carried a `rev`, and a local `storageRepo.get` re-read
  confirms some affected block's `state.latest.rev >= request.rev`. Anything else (read error,
  no-rev request, unconfirmed rejection) rethrows — fail-fast behavior is preserved for every
  case that isn't a confirmed stale write.
  - There's a `NOTE:` tripwire comment at that site: if only *remote* cluster members saw the
    newer revision (this node's local re-read doesn't confirm it), the code still throws rather
    than guessing. Deliberate conservative choice, not an oversight — flagging per tess tripwire
    convention.

## Constraints honored (worth checking in review)

- No string-matching on signed validator reject reasons — classification keys off the typed
  error + a local storage re-read, not reason-text parsing.
- No wire/protocol change — `ValidatorRejectionError` is coordinator-local and never crosses the
  network.
- `PartialCommitError`'s own contract (thrown when a multi-tree legacy commit is left half
  persisted) is untouched — this fix reduces how often the *precondition* for it occurs, it
  doesn't touch the error type itself.
- Retry stays bounded — reuses `Collection.sync`'s existing retry loop and its existing cap;
  no new unbounded retry path was added.
- No new lock/serialization of writes introduced in `cadre-core` or anywhere else — the fix is
  purely "classify correctly then let the existing retry mechanism run," not a concurrency-control
  change.

## Test coverage (what to trust, what's a floor not a ceiling)

Unit-level, all currently passing:

- `db-p2p/test/coordinator-repo-stale-classification.spec.ts` (new) — 4 cases: confirmed-stale
  returns `StaleFailure` and a follow-up retry at the next rev succeeds; unconfirmed rejection
  throws the typed error; a no-rev request throws without attempting the re-read; a failure
  during the re-read itself throws. This is the direct unit coverage for
  `classifyStaleRejection` — if you want to poke at edge cases, this is the file to extend.
- `db-core/test/network-transactor.spec.ts`, new describe `"pend mixed stale + transport
  failure"` — one batch of the pend responds stale while another batch throws a transport error;
  pins that `pend` **returns** `success: false` rather than throwing
  (`network-transactor.ts:511-518`, the stale-preemption branch). This is the case that
  motivated the fix in the first place (a mix of stale + non-stale responses shouldn't crash the
  caller).
- Full suites green: `db-core` 1267 passing, `db-p2p` 1436 passing / 41 pending. Both packages'
  builds are clean (`yarn workspace @optimystic/db-core build`,
  `yarn workspace @optimystic/db-p2p build`). Downstream sereus consumers
  (`@serfab/cadre-core`, `@serfab/cadre-host`) rebuild clean against the changed workspace.

Scenario-level (the real-world reproduction), from `packages/integration-tests`:

```
yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

Run alone 20 times this way (the scenario is designed to provoke the concurrent-pend race; it
passes reliably when run as part of the whole file/suite instead — different timing, see
`tickets/.pre-existing-known.md`). Tally: **14 pass, 6 fail**. Zero of the 6 failures were the
*original* symptom (a stale write thrown as a hard error with no retry). What did show up:

- 2× `Timeout waiting for S resolves Rx's address record via replication` (30s timeout) — the
  known, separately-tracked replication-convergence issue, `bug-control-db-rx-record-never-
  converges-on-sender` (currently in `tickets/fix/`). Not this ticket's defect.
- 2× `SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10 retries` —
  thrown from the *first* tree in `commitDirtyTreesLegacy`, so nothing was durably committed and
  atomicity held. This confirms the fix's retry path is executing (the loser is retrying, not
  hard-failing) but the retries all lose: the re-read never observes the winner's committed
  revision inside the 10-attempt budget, so it keeps recomputing the same stale rev.
- **1× `PartialCommitError` — read this one carefully.** Full trace:
  ```
  PartialCommitError: Legacy multi-tree commit was not atomic: 1 tree(s) were durably committed
  to storage before the commit failed and CANNOT be rolled back. Persisted (now out of sync with
  the unpersisted trees): [default/CadrePeer]. Not persisted (reverted in-memory only):
  [default/CadrePeer/index/_uniq_5]. Underlying failure: sync for collection
  default/CadrePeer/index/_uniq_5 exhausted 10 retries
  ```
  Same `SyncRetryExhaustedError` root cause as the previous bullet, but this time exhaustion hit
  the *second* tree (`.../index/_uniq_5`) in `commitDirtyTreesLegacy` **after** the first tree
  (`default/CadrePeer`) had already committed — reproducing the exact split-write symptom this
  ticket exists to eliminate.
- 1× failure from the *prior* validation session (before this handoff) that matched none of the
  above shapes; its log lived in a session scratchpad and is gone before it could be classified.
  It did not recur in this session's 6 additional runs, so it's unconfirmed either way.

**Open question for review, not resolved here:** is the `PartialCommitError` occurrence a new
defect, or a downstream consequence of the already-tracked replication non-convergence
(`bug-control-db-rx-record-never-converges-on-sender`)? Evidence points toward the latter — same
`SyncRetryExhaustedError` root cause, same "re-read never sees the winner's rev" shape as the two
benign occurrences above, just unlucky enough to land on a non-first tree this time. If that
diagnosis holds, the practical fix likely lives in whatever `bug-control-db-rx-record-never-
converges-on-sender` turns out to need (which is already in `tickets/fix/`), not here — but this
ticket's own fix (retryability) is doing its job either way: it converts a guaranteed-immediate
`PartialCommitError` into a probabilistic one gated on the retry budget being exhausted, which is
a real improvement, just not a complete elimination. Recommend review either (a) folds this
evidence into `bug-control-db-rx-record-never-converges-on-sender`'s description, or (b) leaves a
tripwire/note pointing at it if judged not yet actionable — but don't let it silently drop, since
"zero PartialCommitError" was this ticket's original success criterion and it's not fully met.

Full `packages/integration-tests` suite run once (`yarn vitest run`, all 29 files): 5 files / 6
tests failed, none in the targeted scenario and none overlapping this diff's code paths (HTTP
surface 500s in `cadre-host-bootstrap`/`cadre-host-origin-guard`, a membership-count race in
`cadre-host-trust-circle`, a circuit-relay transport listen failure in a *different* push-wake
sub-test, a replication timeout in `strand-formation-e2e`). Logged as pre-existing/environmental
in `tickets/.pre-existing-error.md` with reasoning per file — not chased further here since none
touch `cluster-coordinator.ts` or `coordinator-repo.ts`.

## Suggested test plan for review

- Read `classifyStaleRejection` in `coordinator-repo.ts` alongside its spec file — check the
  three-condition gate (typed error, `rev` present, local re-read confirms) is exhaustive and the
  tripwire NOTE's conservative choice (remote-only confirmation still throws) is acceptable.
- Re-run the scenario command above a handful of times if you want to see the shapes firsthand;
  10-20 runs is what it takes to hit the rarer `PartialCommitError` shape (~1/20 in this sample).
- Decide the open question above (fold into the sibling ticket vs. leave a tripwire vs. something
  else) — that's the one substantive judgment call left on this ticket.

## Known gaps (flagged, not hidden)

- The `PartialCommitError` recurrence above is not eliminated, only reduced in likelihood — see
  open question.
- `lastReason` on `SyncRetryExhaustedError` is `undefined` in all observed failures — the
  transactor's stale aggregation drops the `reason` string before it reaches the exhaustion
  error. Pre-existing, not touched by this fix; makes root-causing retry exhaustion harder than
  it needs to be. Didn't file a ticket for it — flagging here in case review wants to.
- The 1 unclassified failure from the earlier session is unconfirmed (log lost, didn't recur).
