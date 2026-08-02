description: A shared workspace whose start failed used to be permanently un-startable for the life of the app; now a failed start leaves no trace and is automatically retried with a growing delay. Review the change.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/strand-watcher.spec.ts, packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, docs/architecture.md
difficulty: medium

# What was wrong

One transient strand-launch failure permanently disabled that strand id for the life of the
process. Three independent latches, all now released.

# What changed

## Latch 1 — `strand-instance-manager.ts` / `startStrand`

The `catch` now sets `status`/`error` on the local `instance` object (so `log` still reports
the failure sensibly) and then **deletes the strand from both `instances` and `launchConfigs`**
before rethrowing. A failed launch leaves nothing tracked, matching the pre-registration
failure path (rejected schema signature) that already left nothing tracked. The
`launchConfigs` has an entry iff `instances` does invariant is preserved.

`resumeStrand`'s catch is deliberately unchanged — that path operates on an
already-tracked, retained instance and is itself retryable.

## Latch 2 — `strand-watcher.ts` / `poll`

`knownStrands.set` still happens **before** the `await` (it is the in-flight guard that stops
the 5 s interval timer from starting a second concurrent launch). The `catch` now deletes the
id from `knownStrands` and `provisional` so a later poll retries. The removed-strands loop is
unaffected: a failed strand is no longer in `knownStrands`, so `onStrandRemoved` correctly
never fires for something that never started.

## Latch 3 — `cadre-node.ts` / `handleStrandAdded`

Now rethrows after emitting `strand:error`. The only caller is the watcher's `onStrandAdded`
callback, which catches and logs — so nothing escapes as an unhandled rejection, but the
watcher can now tell a failed add from a successful one.

## Backoff — `strand-watcher.ts`

Per-strand `failureStates: Map<string, {failures, nextAttemptAt}>`. Next attempt allowed no
earlier than `pollInterval * 2^(failures-1)`, capped at `MAX_RETRY_BACKOFF_MS` (5 min).
Attempts are never abandoned. Cleared on a successful add, pruned when the strand's row
disappears from the control DB, cleared in `stop()`.

Clock is injectable: `private poll(now: number = Date.now())`, `forcePoll(now?: number)`
passes through. No fake timers anywhere.

## Docs

`docs/architecture.md` "Cadre Node" item 3 now states the drop-on-failure contract
(`getStrand(id)` after a failed launch returns `undefined`, not an error record), the two
surviving failure channels, and the retry/backoff cadence. `docs/strands.md` needed no change
— it covers negotiation, not lifecycle mechanics, and never claimed an inspectable error
instance.

# Use cases to validate

- **Transient launch failure, explicit path.** `addStrand` rejects; `getStrand(id)` is
  `undefined`; a second `addStrand` with the same id builds a real runtime and reaches
  `active`. `sAppConfigs` is deliberately NOT dropped (the retry and the watcher's automatic
  relaunch both need the config still registered — `detachStrand` remains what clears it).
- **Transient launch failure, discovery path.** Control-network row discovered, launch throws
  → `strand:error` emitted AND the promise rejects → watcher forgets the strand → a later poll
  retries it.
- **Permanently-unlaunchable strand.** Retries continue forever but back off 1x, 2x, 4x, …
  poll intervals up to 5 minutes, so a host app subscribed to `strand:error` gets a trickle,
  not a storm.
- **Strand row deleted while backing off.** Backoff entry is pruned; if the row reappears it
  gets a fresh first attempt with no wait.
- **Watcher restart.** `stop()` clears failure state, so a restarted watcher attempts
  immediately.

# Tests added

`packages/cadre-core/test/strand-instance-manager.spec.ts` (3 new, in `startStrand`):
- runtime-build failure leaves nothing tracked (`getInstance` undefined, `getInstances().size` 0)
- retry after a failed launch reaches `active` with real `libp2pNode` + `database` handles
- retained launch config is dropped too (`resumeStrand` then rejects with `not tracked`)

Driver: `BAD_SCHEMA = 'create table (id text primary key);'` with `requireSignedSchemas: false`
and `mode: 'bootstrap'` — `StrandDatabase.initialize()` throws
`Expected table name in declaration`. Runs in ~30 ms, no network.

`packages/cadre-core/test/strand-watcher.spec.ts` (8 new, `failed launch retry` describe):
retry after a throwing `onStrandAdded`; backoff defers until due (exact boundaries at
`INTERVAL-1` / `INTERVAL` / `INTERVAL*2` / `INTERVAL*3`); a successful add is not re-called;
backoff resets after success; failure state cleared when the row disappears;
`onStrandRemoved` never fires for a never-launched strand; state cleared on `stop()`; the
5-minute cap (uses a 60 s interval and 12 polls 5 min apart — fails without the cap).

`packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts` (new file, 2 tests):
`handleStrandAdded` both emits `strand:error` and rejects when `startStrand` throws; and the
unconfigured-strand path still resolves with only `strand:discovered`. Uses a fake strand
manager — no real node boots.

`packages/cadre-core/test/strand-founder-bootstrap.spec.ts` (1 assertion changed): the
"founding a closed strand with no MemberPrivateKey" test asserted `instance?.status === 'error'`
on the leftover record. That record is the bug this ticket removes, so it now asserts
`getInstance(...)` is `undefined` and `getInstances().size` is 0. **This is the one behavioral
assertion this change intentionally inverts — worth a close look.**

# Validation performed — and the gap

- `yarn typecheck` (packages/cadre-core): clean.
- `yarn lint` (repo root): clean.
- Full `yarn vitest run` in `packages/cadre-core`: **1382 passed, 6 failed, 1 skipped.** Five of
  the six are the known revocation failures already listed in `tickets/.pre-existing-known.md`
  (`control-revocation-reissue.spec.ts` x4, `control-revocation-replay.spec.ts` x1 → blocked
  ticket `10-revocation-reissue-same-pk-update-unique-collision`). No
  `.pre-existing-error.md` filed — already tracked. The sixth was
  `strand-founder-bootstrap.spec.ts`, caused by this change, and was fixed as described above.

**Gap the reviewer must close:** the founder-bootstrap fix was made *after* that full-suite run
and could NOT be re-verified. Every subsequent vitest invocation died in `global-setup.ts`'s
stale-build guard: `@quereus/quereus: dist is stale`. The `../quereus` workspace is being edited
live right now (12 modified files, mtimes advancing mid-session, an in-progress materialized-views
feature) and `yarn workspace @quereus/quereus build` fails there with
`src/core/database.ts(1911,71): error TS2554: Expected 1-2 arguments, but got 3` — an external,
uncommitted, in-flight edit, nothing to do with this repo. So:

- `strand-founder-bootstrap.spec.ts` — **unverified since the edit.** Re-run it first.
- `strand-instance-manager.spec.ts` (21 tests) — verified green *before* the founder-bootstrap
  edit, which does not touch it.
- `strand-watcher.spec.ts` + `cadre-node-strand-added-failure.spec.ts` (19 tests) — verified
  green in isolation.

Re-run once `../quereus` builds again:
`cd packages/cadre-core && yarn vitest run 2>&1 | tee /tmp/cadre-core-tests.log`

# Known gaps / things to probe

- **Concurrent-launch guard in `CadreNode.launchStrand` is untouched.** Its already-tracked
  check runs before an await-heavy `resolveCohortSeed`, so two concurrent launches for the same
  strand can both pass it; they converge harmlessly (the second reaches `startStrand`, sees the
  instance tracked, returns it). Pre-existing and explicitly out of scope per the ticket. Now
  that `startStrand` drops the record on failure, a *failed* concurrent pair both reject — which
  is the correct outcome, but nobody has exercised that interleaving.
- **No test drives the watcher's real 5 s interval timer**, so the "pre-set `knownStrands`
  blocks a second concurrent launch" property is preserved by construction and by code comment,
  not by an assertion. Asserting it needs overlapping async polls.
- **`'this is not sql'` as an sApp schema starts a strand successfully** (reaches `active`) —
  found while picking a schema that would actually fail. Only genuinely malformed DDL
  (`create table (` with no name) throws. Not investigated; unclear whether Quereus tolerates
  it or the apply path silently skips it. Not this ticket's subject and no ticket filed — but if
  a reviewer thinks a garbage sApp schema should be rejected at bring-up, that is a real,
  separate question worth filing.
- **No integration-level coverage.** Everything here is unit-level against
  `StrandInstanceManager` / `StrandWatcher` / a faked strand manager. The end-to-end shape (real
  control DB row → watcher → failed launch → retry succeeds) is not exercised anywhere.
- **`resumeStrand`'s error record still latches.** A quiesced strand whose resume fails keeps
  `status: 'error'` with its instance and config retained. That is intended (resume is retryable
  on the retained record), but it means the two paths now behave differently — confirm that reads
  correctly to a fresh reader of `strand-instance-manager.ts`.
