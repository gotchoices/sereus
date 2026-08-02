description: A shared workspace whose start failed used to be permanently un-startable for the life of the app; now a failed start leaves no trace and is automatically retried with a growing delay. Reviewed and completed.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/README.md, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/strand-watcher.spec.ts, packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, docs/architecture.md

# What shipped

A strand launch that throws now leaves no residue and is automatically re-attempted,
where before one transient failure disabled that strand id for the life of the process.
Three latches were released, and a retry backoff was added.

## Drop-on-failure — `StrandInstanceManager.startStrand`

The `catch` sets `status`/`error` on the local `instance` (so `log` still reports the
failure sensibly), then deletes the strand from both `instances` and `launchConfigs`
before rethrowing. This matches the pre-registration failure path (a rejected schema
signature) that already left nothing tracked, and preserves the `launchConfigs` has an
entry iff `instances` does invariant. `buildStrandRuntime`'s own `catch` already ran
`releaseRuntime`, so no libp2p node or database handle leaks behind the dropped record.

`resumeStrand`'s catch is deliberately unchanged: it operates on an already-tracked,
retained instance that is itself retryable on that record.

## Forget-and-retry — `StrandWatcher.poll`

`knownStrands.set` still happens before the `await` (it is the in-flight guard against a
second concurrent launch). The `catch` deletes the id from `knownStrands` and
`provisional` so a later poll retries. A failed strand is no longer in `knownStrands`, so
`onStrandRemoved` correctly never fires for something that never started.

## Rethrow — `CadreNode.handleStrandAdded`

Rethrows after emitting `strand:error`, so the watcher can tell a failed add from a
successful one. Its only caller (the watcher's `onStrandAdded`) catches and logs, so
nothing escapes as an unhandled rejection.

## Backoff — `StrandWatcher`

Per-strand `failureStates: Map<string, {failures, nextAttemptAt}>`. Next attempt allowed
no earlier than `pollInterval * 2^(failures-1)`, capped at `MAX_RETRY_BACKOFF_MS` (5 min).
Attempts are never abandoned. Cleared on a successful add, pruned when the strand's row
disappears from the control DB, cleared in `stop()`.

The wall clock is a constructor-injected `now: () => number` (6th param, defaults to
`Date.now`), read fresh at each use rather than snapshotted per poll — see finding 1.

# Review findings

## Checked and clean

- **Resource cleanup on the dropped record.** The worry was that deleting the instance
  makes a half-built runtime unreachable (no `getInstance`, so no `stopStrand`).
  `buildStrandRuntime`'s catch already calls `releaseRuntime` (closes the database, stops
  the libp2p node) before rethrowing, so the record is genuinely dead when dropped. No leak.
- **External consumers of the latched error record.** Grepped `packages/*/src` for
  `status === 'error'` on strand instances and for `startStrand(` / `getKnownStrands`
  callers. The only writers of `status = 'error'` are inside `strand-instance-manager.ts`
  itself; nothing outside cadre-core reads a strand instance's error status. Removing the
  record breaks no consumer.
- **`2 ** (failures - 1)` overflow.** `failures` grows without bound (a strand failing at
  the 5-minute cap accumulates ~105k failures/year). At `failures ≈ 1030` the exponent
  yields `Infinity`; `Math.min(Infinity, MAX_RETRY_BACKOFF_MS)` still returns the cap, so
  the delay stays correct. No guard needed.
- **`provisional` / deferred-filter interaction.** A `defer`-admitted strand whose launch
  throws is removed from both `knownStrands` and `provisional`, so the provisional
  re-evaluation loop cannot act on a strand that never started. Correct.
- **Removed-strand loop and the `failureStates` prune.** The prune runs after the removed
  loop over a snapshot of the keys and only drops ids absent from `currentMap`; a strand
  that just failed is still in `currentMap`, so its fresh backoff survives the same poll.
- **The one intentionally-inverted assertion.** `strand-founder-bootstrap.spec.ts`'s
  closed-strand-without-MemberPrivateKey test now asserts `getInstance(...)` is `undefined`
  and `getInstances().size` is 0 instead of `status === 'error'`. That inversion is exactly
  the contract this ticket establishes, and the test passes — it was the implementer's
  stated unverified gap, now closed (see Validation).

## Fixed in this pass

1. **The backoff was measured from the start of the poll, not from the failure** —
   `strand-watcher.ts`. `poll(now = Date.now())` snapshotted the clock, then awaited
   `queryStrands()` and `onStrandAdded`. A launch that fails slowly — a libp2p dial
   timeout, i.e. the exact fault this backoff exists for — recorded
   `nextAttemptAt = pollStart + pollInterval`, a time already in the past. Worked example
   with the 5 s default and a 30 s dial timeout: failure 1 schedules T+5000 but real time
   is T+30000, so the next tick retries immediately; the same holds for failures 2 and 3;
   the backoff only engages from failure 4 (5000 × 2³ = 40 s > 30 s). Self-correcting, but
   the first several attempts got no backoff at all.
   **Fix:** the clock is now a constructor-injected `now: () => number` (default
   `Date.now`), read fresh in `recordFailure` and per-candidate at the gate. `poll()` and
   `forcePoll()` lost their `now` parameter, which also removes a test-only argument from
   a public method. New test pins it: `should schedule the backoff from the failure, not
   from the start of the poll` (advances the clock inside `onStrandAdded` before throwing).

2. **New retry tests were exposed to the watcher's real timers** —
   `strand-watcher.spec.ts`. Every pre-existing test in this file uses `pollInterval:
   60000` specifically so the interval timer stays quiet; the new `failed launch retry`
   block used `1000` and drove time through a `forcePoll(now)` argument. A real timer
   firing mid-test — the 100 ms initial poll, or the 1 s interval — called `poll()` with
   real `Date.now()` (~1.7e12), which passes any `nextAttemptAt` in the 0–3000 range, so a
   stray poll would launch an extra attempt and inflate `addCount`. Low probability (the
   bodies run in well under 100 ms) but a real nondeterminism, and one the pre-existing
   tests had deliberately avoided.
   **Fix:** folded into the same change — the tests now inject a mutable clock object, so
   a stray timer poll reads the same clock as the deliberate ones and is a no-op while the
   strand is backing off. Rewritten with `createWatcher` / `pollAt` helpers so each time
   advance stays a one-liner.

3. **Undocumented public contract: a rejected `addStrand` keeps retrying** —
   `cadre-node.ts`. The implement ticket names it deliberate ("`sAppConfigs` is
   deliberately NOT dropped") but nothing in the code said so. Because the config survives,
   once the strand's row is visible on the control network the watcher relaunches in the
   background forever, re-emitting `strand:error` each time — a host app that caught the
   `addStrand` rejection and moved on would be surprised. Added to `addStrand`'s doc
   comment, naming `detachStrand` as what actually abandons a strand.

4. **`strand:error` documented as a one-shot** — `packages/cadre-core/README.md` events
   table. It now repeats on every retry; the table row says so.

## Filed as tickets

None. Finding 1 was the only defect found, and it was small and local enough to fix in
place rather than hand off.

## Tripwires recorded

- **No test drives the watcher's real interval timer.** The "pre-set `knownStrands` blocks
  a second concurrent launch" property is held by construction and by the comment at
  `strand-watcher.ts:174-175`, not by an assertion — proving it needs overlapping async
  polls. Left as-is: the comment is already at the exact site and states the property, so
  there is nothing to add. Only becomes work if `poll` grows a second await before the
  `knownStrands.set`.
- **`CadreNode.launchStrand`'s already-tracked guard runs before an await-heavy
  `resolveCohortSeed`,** so two concurrent launches for the same strand can both pass it.
  Pre-existing, out of scope per the implement ticket, and benign today (the second reaches
  `startStrand`, sees the instance tracked, returns it; a failed pair now both reject,
  which is correct). Not re-parked — it is already described in the `launchStrand` doc
  comment at the site.

## Deliberately not pursued

- **`'this is not sql'` as an sApp schema starts a strand successfully.** The implementer
  found this while hunting for a schema that would actually fail (only genuinely malformed
  DDL like `create table (` throws). It is a real, separate question — should a garbage
  sApp schema be rejected at bring-up? — but it is about schema validation, not the launch
  retry path, and answering it means understanding what Quereus tolerates. No ticket filed
  this pass; recorded here so it is not lost.
- **Integration-level coverage** (real control DB row → watcher → failed launch → retry
  succeeds) still does not exist; everything here is unit-level. Not filed: the unit
  coverage pins each seam and the end-to-end gap is a general property of this subsystem,
  not something this change introduced.
- **`resumeStrand` still latches its error record** while `startStrand` no longer does.
  Intended (resume is retryable on the retained record) and now explained in both methods'
  doc comments; reads correctly to a fresh reader. Left alone.

# Validation

- `yarn typecheck` (packages/cadre-core): clean.
- `yarn lint` (repo root): clean, exit 0.
- `yarn vitest run` over every spec the diff touches plus `cadre-node.spec.ts`
  (`strand-watcher`, `strand-watcher-filters`, `strand-instance-manager`,
  `strand-founder-bootstrap`, `cadre-node-strand-added-failure`, `cadre-node`):
  **100 passed, 6 files.** This closes the implement stage's stated gap —
  `strand-founder-bootstrap.spec.ts` had been edited after its last run and never
  re-verified; it passes.
- Getting there required building the sibling `../quereus` workspace, whose stale `dist`
  was failing this repo's `global-setup.ts` freshness guard and blocking every vitest
  invocation. The TypeScript error the implementer hit there
  (`src/core/database.ts(1911,71): TS2554`) has since been resolved upstream;
  `yarn workspace @quereus/quereus build` now exits 0.

**Not re-run:** the full `packages/cadre-core` suite (~1382 tests). The soft token budget
was reached, so validation was scoped to the specs the diff touches. The implement stage's
full run reported 6 failures, 5 of them the known revocation failures already tracked in
`tickets/.pre-existing-known.md` (blocked ticket
`10-revocation-reissue-same-pk-update-unique-collision`) and the 6th the founder-bootstrap
test, now passing. No `.pre-existing-error.md` filed — nothing new surfaced.
