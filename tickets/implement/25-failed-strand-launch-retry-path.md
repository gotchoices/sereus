----
description: If starting a shared workspace fails partway (network or storage trouble), the app is left holding a dead workspace it can never restart. Make a failed start leave no trace, so the next attempt — manual or automatic — is a genuine retry.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, packages/cadre-core/test/strand-watcher.spec.ts
difficulty: medium
repro: verified
----

# What is broken

One transient launch failure permanently disables a strand id for the life of the process.
There are **three** independent latches on the retry path, and every one of them has to be
released for a retry to happen. Only the first was named in the original bug report; the other
two were found (and reproduced) while investigating it.

## Latch 1 — the tracked-instance map keeps a dead record

`StrandInstanceManager.startStrand` registers the instance and its retained launch config in
`instances` / `launchConfigs` *before* calling `buildStrandRuntime`. When the build throws, the
runtime handles are rolled back (`releaseRuntime`) but the record stays, with `status: 'error'`,
forever. Both already-tracked short-circuits then hand that dead record back instead of
retrying — `StrandInstanceManager.startStrand` (`instances.has`) and, upstream,
`CadreNode.launchStrand`. So `addStrand` *resolves successfully* with an instance that has no
libp2p node and no database, which reads as success to the hosting app.

**Reproduced** (`packages/cadre-core`, a throwaway spec driving `StrandInstanceManager`
directly with `requireSignedSchemas: false`, `mode: 'bootstrap'`, and an unparseable sApp
schema so `StrandDatabase.initialize()` throws):

```
after failure: tracked=true status=error error=Expected table name in declaration. … node=false db=false
after retry (with a valid schema): status=error node=false db=false
```

## Latch 2 — the watcher never re-fires for a strand whose launch threw

`StrandWatcher.poll` records the strand in `knownStrands` **before** awaiting
`onStrandAdded`, and its `catch` only logs. A strand whose launch threw is therefore
"known" forever, and no later poll ever calls `onStrandAdded` again. This is a second,
independent latch: fixing latch 1 alone still leaves the control-discovered path dead,
because it never re-enters the launch path at all.

**Reproduced**: a `StrandWatcher` over a queryable returning one row, with an
`onStrandAdded` that always throws — `onStrandAdded` call count after three polls is **1**.
(Note the pre-set is not gratuitous: it is also what stops the 5 s interval timer from
starting a *second* concurrent launch while the first is still awaiting. Keep that property.)

## Latch 3 — the failure never reaches the watcher anyway

`CadreNode.handleStrandAdded` catches the launch failure, emits `strand:error`, and
**returns normally**. Even with latch 2 released, the watcher would see a resolved promise
and mark the strand successfully added. The emit has to be followed by a rethrow.

# Decision (the ticket's open question, now settled)

**Drop the record entirely** on a failed launch; do *not* retain it in an
explicitly-non-running state.

Reasons:

- It matches the failure path that already exists. A launch that fails *before* the instance
  is registered (schema signature rejection) leaves nothing tracked, and
  `strand-instance-manager.spec.ts` already asserts exactly that
  (`expect(manager.getInstance('bad-sig-strand')).toBeUndefined()`). Two failure modes of the
  same call should not leave two different residues.
- Nothing is lost. The failure already reaches callers by two channels that survive the drop:
  the rejected `startStrand` / `addStrand` promise, and the `strand:error` event on the
  discovery path. `getStrand(id)?.error` was never a documented inspection route, and would
  in any case be readable only until the next retry overwrote it.
- The alternative costs far more. The tracked-instance map is public API
  (`CadreNode.getStrand` / `getStrands`) read by `cadre-cli`, `reference-app-web`,
  `reference-app-rn`, and `reference-app-ns` — `use-cadre.ts:176` uses
  `getStrands().has(strandId)` as its own "already joined" guard. Retaining an
  error record would require every one of those, plus ~10 sites in `cadre-node.ts`, to agree
  on "error means not running". Same user-visible outcome, much wider blast radius.

Keep the invariant **`launchConfigs` has an entry iff `instances` does** — drop both together.

`sAppConfigs` in `CadreNode` is deliberately NOT dropped on failure: the retry (and the
watcher's automatic relaunch) needs the config to still be registered. `detachStrand` remains
the thing that clears it.

# Retry cadence

Once latches 2 and 3 are released, a strand that fails *permanently* (e.g. a locally-registered
sApp schema that can never apply) would re-attempt on every 5 s poll and emit `strand:error`
each time — an unbounded event storm in any app that surfaces that event. So the watcher's
retry needs a backoff:

- Per-strand consecutive-failure count, with the next attempt allowed no earlier than
  `pollInterval * 2^(failures-1)`, capped at 5 minutes. Attempts are never abandoned —
  the failure this ticket exists for is a transient one that may last a long time.
- Cleared on a successful add, when the strand's row disappears from the control DB, and
  on `stop()`.

Make the clock injectable rather than reaching for fake timers: `private poll(now = Date.now())`
with `forcePoll(now?: number)` passing through, so the backoff is assertable deterministically.

# Not in scope

`CadreNode.launchStrand`'s already-tracked guard runs before an await-heavy
`resolveCohortSeed`, so two concurrent launches for the same strand can both pass it. They
converge harmlessly — the second reaches `startStrand`, sees the instance tracked, and returns
it without building a second runtime. Pre-existing, not worsened here. If you touch that guard,
leave a `NOTE:` at the site rather than widening this ticket.

# TODO

## Phase 1 — release the three latches

- `strand-instance-manager.ts` / `startStrand`: in the `catch`, delete the strand from both
  `instances` and `launchConfigs` before rethrowing. Set `status`/`error` on the local
  `instance` object first (the thrown-away record is still the thing `log` reports on), then
  drop it. Update the method's doc comment: a failed launch leaves nothing tracked.
- `cadre-node.ts` / `handleStrandAdded`: rethrow after emitting `strand:error`. The only caller
  is the watcher callback, which already catches and logs. Say in the comment *why* it rethrows
  (the watcher uses the rejection to decide whether the strand was really added).
- `strand-watcher.ts` / `poll`: keep the `knownStrands.set` before the `await` (it is the
  in-flight guard against the interval timer starting a second launch), and in the `catch`
  delete the id from `knownStrands` and `provisional` so a later poll retries. Confirm the
  removed-strands loop below it is unaffected — a failed strand is no longer in `knownStrands`,
  so it correctly never fires `onStrandRemoved`.

## Phase 2 — backoff

- `strand-watcher.ts`: add the per-strand failure/backoff map described above, gate the
  added-strand loop on it, clear it on success, prune entries whose row is gone from
  `currentMap`, and clear it in `stop()` alongside `knownStrands` / `provisional`.
- Thread `now` through `poll` / `forcePoll` as described.

## Phase 3 — tests

- `strand-instance-manager.spec.ts`: a failed `buildStrandRuntime` (unparseable sApp schema,
  `requireSignedSchemas: false`, `mode: 'bootstrap'` — this is fast, the reproduction ran in
  ~80 ms with no network) rejects, leaves `getInstance(id)` undefined, and a second
  `startStrand` for the same id with a valid schema reaches `active`.
- `strand-watcher.spec.ts`: an `onStrandAdded` that throws is retried on a later poll; one that
  succeeds is not called again; backoff defers the retry until its due time (drive with the
  injected `now`); the failure state is cleared when the row disappears.
- `handleStrandAdded`'s rethrow: assert with the existing fake-strand-manager pattern in
  `cadre-node-strand-launch-key.spec.ts` (`injectFakeStrandManager`) — swap in a `startStrand`
  that throws, call `handleStrandAdded` directly, assert both that `strand:error` was emitted
  and that the returned promise rejects. No real node needs to boot.

## Phase 4 — validate

- `cd packages/cadre-core && yarn vitest run 2>&1 | tee /tmp/cadre-core-tests.log` (stream it;
  the suite is large). Then `yarn typecheck` and `yarn lint` at the repo root.
- Docs: `docs/strands.md` describes the strand lifecycle — check whether it states or implies
  that a launch failure leaves an inspectable `error` instance, and correct it if so.
