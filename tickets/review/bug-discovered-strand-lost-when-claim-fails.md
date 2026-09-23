description: An app that failed to join a shared conversation it had just been told about used to lose that conversation until restart; it is now offered again automatically, and a conversation the user deliberately stopped still stays stopped.
architecture: docs/architecture.md#cadre-node
files:
  - packages/cadre-core/src/strand-watcher.ts (new public `forgetStrand` / `suppressStrand`, the `suppressed` set, the extracted `catch` body)
  - packages/cadre-core/src/cadre-node.ts (`addStrand` ~4560 try/catch, `stopStrand` ~5895 suppress, `unpublishStrand` ~4947 detach-not-stop, `handleStrandAdded` ~4084 comment)
  - packages/cadre-core/src/types.ts (~1258 `strand:discovered` doc)
  - docs/architecture.md (~119 Cadre Node, ~621 unpublish vs stop)
  - packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts (arms 5 and 6, plus the extended `bareWatcher` harness)
repro: verified
----

# A failed claim no longer retires a discovered strand

## What changed

`StrandWatcher` gained two public methods and one piece of state.

`forgetStrand(strandId)` is the body that used to sit inline in the `catch` of `poll`'s added-strand loop — drop the id from `knownStrands` and `provisional`, record the backoff. That `catch` now calls it, so there is one copy of the logic and one place the retry ladder is defined. `CadreNode.addStrand` calls it when `launchStrand` rejects, which puts an app-driven failure on exactly the same `pollInterval * 2^(failures-1)` ladder a watcher-driven failure already had.

`suppressStrand(strandId)` plus a `suppressed: Set<string>` is the other half. `stopStrand` calls it; the added-strand loop consults it before anything else; it clears when the strand's control row disappears (beside the existing `failureStates` cleanup) and in `stop()`. This exists because `stopStrand`'s permanence used to be an accident of `knownStrands` never being un-set, and `forgetStrand` un-sets it. Without the suppression, the sequence "claim fails → watcher forgets → app gives up with `stopStrand` → `detachStrand` drops the sApp config → next poll re-offers as `strand:discovered`" makes the reference app auto-rejoin a strand the user deliberately stopped.

Only the `launchStrand` call inside `addStrand` is wrapped, deliberately — **not** the `whenWritable` first-sync wait after it. That wait's timeout rejects with the retryable `StrandAwaitingFirstSyncError` and leaves the instance running, so there is nothing to re-offer.

Because the failed claim leaves the sApp config registered, the retry takes `handleStrandAdded`'s auto-launch branch rather than emitting a second `strand:discovered`. The app sees `strand:error` per failed retry and `strand:started` when one succeeds. Both are already wired in the reference React Native app (`packages/reference-app-rn/src/use-cadre.ts:265-269` — `onStarted` and `onError` each call `refreshStrands`), so **no app-side change was needed** and none was made. Verified by reading the file, not just by taking the source ticket's word for it.

## One thing the source ticket did not anticipate

`CadreNode.unpublishStrand` converges locally by calling `stopStrand`. Once `stopStrand` suppresses, that route would suppress an id whose row was *already deleted* — and if the id were re-published before the next poll's suppression cleanup ran, it would never be offered again for the life of the session. Party-wide removal is not a local abandonment of a strand that still exists, so `unpublishStrand` now calls `detachStrand` directly (the same reasoning `handleStrandRemoved` already uses, and the `_running` guard `stopStrand` provides is already satisfied there by `requireOwnerSigningKey`). **This is worth a reviewer's eye** — it is a behaviour change to `unpublishStrand` that no test currently pins, and it is the only edit in the diff that was not in the plan.

## Tests

Two arms added to `packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts`, both on the existing `bareWatcher` harness (a real `StrandWatcher` over a fake queryable driving the real `CadreNode` handlers, no libp2p and no database — the pair runs in about 20 ms):

| Arm | What it pins |
| --- | --- |
| `re-offers a strand whose CLAIM failed, through the sApp config the failed claim left registered` | The strand is offered, `addStrand` rejects, a poll inside the backoff window does nothing, and the first poll past it re-attempts the launch — surfacing `strand:error`, and **not** a second `strand:discovered`. That last assertion is what records that the sApp config survived the failed claim and the retry ran the auto-launch branch. |
| `still lets a deliberate stopStrand mean stop, now that a failed claim can un-know a strand` | Same setup through the failed claim, then `stopStrand`, then a poll past the backoff: no `strand:discovered`, no re-attempt, `getDiscoveredStrands()` stays empty. |

**Both were confirmed load-bearing by disabling the production seams and re-running**, one at a time:

- With `forgetStrand` disabled in `addStrand`: arm 5 fails (`expected [] to deeply equal [ 'failed-claim-…' ]` — no retry ever happens). Arm 6 passes, correctly — with nothing un-knowing the strand, the old `knownStrands` retention still makes the stop permanent. Arm 6 is only meaningful *given* the re-offer.
- With `forgetStrand` re-enabled and `suppressStrand` disabled in `stopStrand`: arm 6 fails (`a strand the app deliberately stopped was offered again` — a second `strand:discovered` arrives).

The failure it exercises is real, not mocked: an `SAppConfig` with no `signature` is refused by `assertSchemaSignature` at the top of `StrandInstanceManager.startStrand`, before any network or storage work.

### Harness changes worth reviewing

`bareWatcher` grew three things, all test-only and all narrow:

- **An injected clock.** `StrandWatcher`'s constructor already takes `now` as its sixth argument; the harness passes a closure over a mutable `clock` and returns an `advance(ms)`. This is what lets a 5-second backoff be crossed without fake timers or real waiting.
- **`withRunning(fn)`.** `addStrand`/`stopStrand` refuse on a node that never started, and the bare node deliberately never starts. The helper sets the private `_running`, awaits, and restores the prior value in a `finally` — the same kind of test-only window the file already used for `strandWatcher`, and declared on the same named `CadreNodeInternals` interface.
- **Wiring `internals.strandWatcher = watcher`**, the assignment `CadreNode.start()` normally does. Without it both new arms would pass vacuously against a node whose watcher is `null`, since `addStrand`/`stopStrand` reach the watcher through that field with `?.`.

No other test was touched. The existing four arms still pass unchanged.

## Documentation corrected

All four sites the ticket named, plus one it missed:

- `packages/cadre-core/src/types.ts` (~1258) — `strand:discovered` no longer claims "exactly ONCE per strand per session"; the failed-claim exception is stated along with the fact that it produces no second event. The subscribe-then-drain instruction and the idempotence requirement are unchanged.
- `docs/architecture.md` ~119 (Cadre Node) — the "no later poll re-offering it" clause now names the exception and says the retry runs through the registered sApp config.
- `docs/architecture.md` ~621 (unpublish vs stop) — the mechanism behind a stop's permanence is now stated as the suppression set, not `knownStrands` retention.
- `CadreNode.addStrand`'s doc comment — the paragraph describing the gap (and its `backlog/bug-discovered-strand-lost-when-claim-fails` pointer) is replaced by what the code now does.
- **Not in the ticket:** the comment inside `handleStrandAdded` (~4084) asserted the same "never offers the same strand twice" claim and is now qualified the same way. `detachStrand`'s doc gained a line saying the suppression is deliberately *not* there, so a future reader does not move it down.

## Tripwire recorded

`NOTE:` at the suppression-cleanup loop in `strand-watcher.ts`: clearing a suppressed id needs a poll that actually sees the row absent, so a sibling that unpublishes and re-publishes a locally-stopped id inside one poll interval leaves it suppressed for the session. Contrived today (re-seating a removed id is owner-gated and manual) and there is no row version to distinguish the new row from the old; the note says what to do — a generation column on the row — if re-publishing a removed id ever becomes routine. This is a narrow regression against the previous behaviour, where the removed-strand loop would have cleared `knownStrands` and allowed the re-offer.

## Known gaps for the reviewer

- **`unpublishStrand`'s switch to `detachStrand` is untested.** `packages/cadre-core/test/strand-unpublish.spec.ts` passes unchanged, but nothing pins "unpublish does not suppress". I judged a test for it below the bar (it would be pinning the absence of a call), but that is a judgment call worth a second opinion.
- **Concurrency between an app's own retry and the watcher's.** Before this change a failed `addStrand` produced no watcher retry, so an app that retries on failure was alone; now both may be in flight. I checked the guard: `StrandInstanceManager.startStrand`'s `instances.has` check and its `instances.set` are separated by no `await`, so the second entrant returns the first's still-`'starting'` instance. No new hazard found, but it is the kind of thing worth re-deriving rather than trusting.
- **No integration-level coverage.** Both arms are unit-level on the bare harness. A real two-node arm would cost minutes and says nothing these do not; I did not add one.

## Validation run

```
yarn workspace @serfab/cadre-core typecheck   # clean
yarn lint                                      # clean
yarn workspace @serfab/cadre-core test         # 136 files, 2242 passed, 1 skipped
```

The one skip is pre-existing and unrelated — `key-store.spec.ts:231` is `it.skipIf(process.platform === 'win32')`.

One run was interrupted by the shared build-freshness guard reporting `@optimystic/db-p2p: dist is stale`. That was a concurrent agent session actively editing and rebuilding the linked `C:\projects\optimystic` workspace (its own eslint and tsserver were running against it, and its `dist` was mid-rebuild). It cleared on its own once that build finished, and every run since has been green. Nothing in this repo caused it and nothing was done about it; noted only so the next reader does not treat it as a signal.
