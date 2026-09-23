description: If an app tries to join a shared conversation it was just told about and that attempt fails — a dropped connection, a slow network — the app is never told about that conversation again, so it stays missing until the app is restarted. Make the node offer it again, while keeping a deliberate "stop this conversation" meaning exactly that.
architecture: docs/architecture.md#cadre-node
files:
  - packages/cadre-core/src/strand-watcher.ts (add the two public seams; `poll` ~160 already has the forget-and-back-off pattern inline in its added-strand `catch`)
  - packages/cadre-core/src/cadre-node.ts (`addStrand` ~4538 — the failure path; `stopStrand` ~5871 — the suppression it must keep; `detachStrand` ~5898 — must NOT suppress)
  - packages/cadre-core/src/types.ts (~1258 — the `strand:discovered` doc says "fired exactly ONCE per strand per session")
  - docs/architecture.md (~119 Cadre Node, ~621 unpublish vs stop — both state that no later poll re-offers a strand)
  - packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts (the `bareWatcher` harness the new arms extend)
repro: verified
----

# A failed claim must not retire a discovered strand

## The bug, confirmed

Run against the tree as it stands: a bare `StrandWatcher` over a fake queryable, driving the real `CadreNode.handleStrandAdded` (the `bareWatcher` helper at the bottom of `discovered-strands-late-subscriber.spec.ts`). The watcher's first poll offers an unclaimed strand, so `getDiscoveredStrands()` holds it. Then `addStrand` is called for that strand and rejects. After two further polls:

```
discovered: []            // getDiscoveredStrands() — addStrand dropped it before launching
events:     []            // no further strand:discovered
known:      [<strandId>]  // the watcher still counts the strand as offered
strands:    []            // nothing is running
```

Nothing runs the strand and nothing will ever mention it again. A restart is the only recovery.

The rejection used in the reproduction is a real one, not a mock: an `SAppConfig` with no `signature` fails `assertSchemaSignature` at the top of `StrandInstanceManager.startStrand`, before any network or storage work, so the whole arm costs about ten milliseconds.

The one test-only reach-in it needs is `_running`: `addStrand` refuses on a node that never started, and the `bareWatcher` node deliberately never starts. Setting the private `_running` to `true` for the duration of the arm is the same kind of test-only window the spec already uses for `strandWatcher`; do it through a narrow, named interface as the existing file does, and restore it in a `finally`.

## The fix

Decided during the fix stage and carried over from the source ticket: **re-offer through the watcher**. A failed app-driven `addStrand` tells the watcher to forget the strand, so a later poll offers it again, with the same exponential backoff a watcher-driven launch failure gets. One retry mechanism for both failure routes, and `discoveredStrands` keeps its documented meaning ("strands no local sApp config claims") — a failed claim leaves the sApp config registered on purpose, so the strand is genuinely no longer unclaimed.

Because the config stays registered, the re-offer does **not** produce a second `strand:discovered`: `handleStrandAdded` finds the config and takes the auto-launch branch. So what the app sees is `strand:error` on each failed retry and `strand:started` when one succeeds — both already handled by the reference React Native app (`onError` and `onStarted` in `use-cadre.ts` each call `refreshStrands`), so no app-side change is required. Confirmed by prototype: with the forget simulated through the watcher's private state, the strand is left alone while the backoff is unexpired and re-attempted on the first poll after it elapses.

### The catch this introduces, and its other half

Today `stopStrand` means "do not offer this strand again" purely because nothing ever removes an id from `StrandWatcher.knownStrands`. The moment a failed claim *does* remove one, that guarantee is gone for exactly this sequence: claim fails → watcher forgets → app gives up with `stopStrand` → `detachStrand` drops the sApp config → the next poll re-offers the strand as `strand:discovered`, and it lands back in `getDiscoveredStrands()`. In the reference app that means a strand the user deliberately stopped is auto-rejoined. Prototyped and observed:

```
discovered: [<strandId>]   // after stopStrand, on the first poll past the backoff
backlog:    [<strandId>]
```

So the implicit guarantee has to become an explicit one. Give the watcher a suppression set: ids it must not offer, consulted at the top of the added-strand loop. `CadreNode.stopStrand` — the deliberate, caller-driven abandonment — suppresses; `detachStrand` does **not**, because its other caller is `handleStrandRemoved`, which arrives precisely because the control row is gone, and a row that later reappears is a fresh strand that should be offered. Clear a suppressed id when its control row disappears, alongside the existing `failureStates` cleanup at the end of `poll` and for the same reason, and clear the set in `stop()` with the other per-session state.

### Shape of the seams

`StrandWatcher` gains two small public methods. Both are thin wrappers over existing private state; the first is the body the `catch` inside `poll`'s added-strand loop already runs inline, so extract it and have that `catch` call it rather than writing the logic twice.

```ts
/**
 * Forget a strand whose launch failed outside this watcher, so a later poll
 * re-offers it — gated by the same backoff a watcher-driven failure gets.
 */
forgetStrand(strandId: string): void

/**
 * Never offer this strand again this session: a deliberate local stop, as
 * opposed to a failed launch. Cleared when the strand's control row disappears.
 */
suppressStrand(strandId: string): void
```

`CadreNode.addStrand` wraps the `launchStrand` call — and only that call — in a `try`/`catch` that calls `forgetStrand` and rethrows. Not the `whenWritable` wait that follows it: a first-sync timeout rejects with the retryable `StrandAwaitingFirstSyncError` and deliberately **leaves the instance running**, so there is nothing to re-offer and forgetting it would only have the watcher re-enter a launch for a strand that is already up.

`addStrand` is also the attach half of the founder path (`foundStrand` → `publishStrand` + `addStrand`), where the watcher may not have offered the strand at all. `forgetStrand` is harmless there: the `knownStrands` delete is a no-op, and the recorded backoff only delays the watcher's own first attempt by one poll interval, which is what should happen right after an attempt that just failed.

## Tests

Two arms in `discovered-strands-late-subscriber.spec.ts`, both on the existing `bareWatcher` harness. Extend that helper to expose the `_running` flip and to accept an injected clock — `StrandWatcher`'s constructor already takes a `now` as its sixth argument, which is what lets the backoff be crossed without fake timers or real waiting.

- **The re-offer.** Offer the strand, fail the claim, poll once inside the backoff window and assert nothing was re-attempted, advance the injected clock past `pollInterval`, poll again and assert the strand was re-attempted (`strand:error` fires for it). Assert no second `strand:discovered`, which is what records that the sApp config stayed registered and the retry goes through the auto-launch branch.
- **The stop still means stop.** Same setup, then `stopStrand`, then advance the clock past the backoff and poll: no `strand:discovered`, no re-attempt, and `getDiscoveredStrands()` stays empty.

Both arms fail on the tree as it stands — the first sees no retry, the second sees the strand come back — so each one is load-bearing.

## Documentation to correct

Four places assert the behaviour this ticket changes; all four are wrong the moment it lands.

- `packages/cadre-core/src/types.ts` (~1258), the `strand:discovered` doc: "**Fired exactly ONCE per strand per session**", and "the watcher then records the strand as seen and no later poll re-offers it". Still true for the ordinary case; now qualified by the failed-claim re-offer. The subscribe-then-drain instruction and the idempotence requirement are unchanged and should stay.
- `docs/architecture.md` line ~119 (Cadre Node): the clause "with no later poll re-offering it" — say that a failed claim is the exception, and that the retry then runs through the registered sApp config rather than a fresh `strand:discovered`.
- `docs/architecture.md` line ~621 (`unpublishStrand` vs `stopStrand`): "not on a later poll, which never re-offers a strand the watcher already knows" — the mechanism behind the stop's permanence is now the explicit suppression set, not `knownStrands` retention. Say so.
- `CadreNode.addStrand`'s own doc comment (~4525) currently describes this gap in full and points at `backlog/bug-discovered-strand-lost-when-claim-fails`. Replace that paragraph with what the code then does, and delete the ticket pointer.

## TODO

- [ ] Extract the forget-and-back-off body from the `catch` in `StrandWatcher.poll`'s added-strand loop into a public `forgetStrand(strandId)`; have that `catch` call it.
- [ ] Add `suppressStrand(strandId)` plus the `suppressed` set: consulted at the top of the added-strand loop, cleared when the control row is gone (beside the `failureStates` cleanup) and in `stop()`.
- [ ] Wrap `CadreNode.addStrand`'s `launchStrand` call — and not the `whenWritable` wait — in a `try`/`catch` that calls `forgetStrand` and rethrows.
- [ ] Call `suppressStrand` from `CadreNode.stopStrand`; leave `detachStrand` alone so `handleStrandRemoved` does not suppress.
- [ ] Extend the `bareWatcher` helper: injected clock, and a named test-only window for the `_running` flip.
- [ ] Add the re-offer arm and the stop-still-means-stop arm.
- [ ] Correct the four documentation sites listed above.
- [ ] `yarn workspace @serfab/cadre-core test`, plus `yarn lint` and `yarn workspace @serfab/cadre-core typecheck`.
