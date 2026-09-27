description: An app that failed to join a shared conversation it had just been told about used to lose that conversation until restart; it is now offered again automatically, a conversation the user deliberately stopped still stays stopped, and re-joining a stopped one puts it back under the node's supervision.
architecture: docs/architecture.md#cadre-node
files:
  - packages/cadre-core/src/strand-watcher.ts (`forgetStrand`, `suppressStrand`, `unsuppressStrand`, the `suppressed` set)
  - packages/cadre-core/src/cadre-node.ts (`addStrand` try/catch + unsuppress, `stopStrand` suppress, `unpublishStrand` detach-not-stop, `handleStrandAdded` comment, `crossPartyStrandAddrs` note)
  - packages/cadre-core/src/types.ts (`strand:discovered` doc)
  - docs/architecture.md (Cadre Node, unpublish vs stop)
  - packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts (arms 5–7, extended `bareWatcher` harness)
repro: verified
----

# A failed claim no longer retires a discovered strand

## What shipped

`StrandWatcher` gained a `suppressed: Set<string>` and three public methods around it and around the retry ladder:

- `forgetStrand(strandId)` — the body that used to sit inline in the `catch` of `poll`'s added-strand loop (drop the id from `knownStrands` and `provisional`, record the backoff). `CadreNode.addStrand` calls it when `launchStrand` rejects, so an app-driven failure lands on exactly the `pollInterval * 2^(failures-1)` ladder a watcher-driven failure already had. Only the `launchStrand` call is wrapped, not the `whenWritable` first-sync wait after it: that wait's timeout leaves the instance running, so there is nothing to re-offer.
- `suppressStrand(strandId)` — called by `stopStrand`, consulted by the added-strand loop before anything else. `stopStrand`'s permanence used to be an accident of `knownStrands` never being un-set, and `forgetStrand` un-sets it; without the suppression, "claim fails → watcher forgets → app gives up with `stopStrand` → next poll re-offers" makes the reference app auto-rejoin a strand the user deliberately stopped.
- `unsuppressStrand(strandId)` — **added during this review**; see the findings below.

Because a failed claim leaves the sApp config registered, the retry takes `handleStrandAdded`'s auto-launch branch rather than emitting a second `strand:discovered`: the app sees `strand:error` per failed retry and `strand:started` when one succeeds. Both are already wired in the reference React Native app (`packages/reference-app-rn/src/use-cadre.ts`), so no app-side change was needed and none was made.

`CadreNode.unpublishStrand` converges locally by calling `detachStrand` directly rather than `stopStrand`, so a party-wide removal does not suppress an id whose row is already gone.

## Review findings

The implement-stage diff was read before its handoff summary, and every site it touched was re-read against the code.

### Fixed in this pass

**A deliberate re-claim did not lift the suppression (correctness, found in review).** `suppressStrand` had three exits — the control row disappearing, `stop()`, and nothing else. But the suppression check runs *before* the `knownStrands` check, so a suppressed id is never re-recorded in `knownStrands`, and `knownStrands` is the set the removed-strand loop iterates. A strand stopped and then claimed again with `addStrand` in the same session therefore ran with the watcher blind to it: a party-wide removal of the row would never stop it on this node. Reachable whenever the stop found the id already un-known — i.e. after a claim that failed (exactly the sequence this ticket introduces) or for a strand the `strandFilter` never admitted. Fixed by adding `StrandWatcher.unsuppressStrand` and calling it from `addStrand` beside the `discoveredStrands.delete`, where the strand is already being recorded as claimed. Arm 7 of `discovered-strands-late-subscriber.spec.ts` pins it, and was confirmed load-bearing: with the `unsuppressStrand` call removed, arm 7 fails (`expected [] to deeply equal [ 'reclaimed-stop-…' ]` — the watcher never re-attempts) and arms 5 and 6 still pass, so it is not a restatement of either.

**A comment the change falsified (documentation).** The `crossPartyStrandAddrs` note in `cadre-node.ts` justified retaining seed addresses across a `stopStrand` because "a stopped strand may be rediscovered by the watcher". With the suppression, the watcher will not re-offer a stopped strand at all. The retention is still right — an explicit `addStrand` re-claim needs the seed — so the note now says that instead. Both `docs/architecture.md` sites the implementer updated gained the `addStrand` exit alongside the two they already listed.

### Recorded as a tripwire, not filed

**A watcher retry relaunches from the control row, not from what the caller passed.** `addStrand` hands the strand back to the watcher, whose retry reads the control-network row plus the registered sApp config — so a caller that enriched either (a synthetic `MemberPrivateKey`, as `joinClosedChatStrand` in the reference app builds, or an explicit `founder` / `partyMemberPrivateKey`) is retried with less than it asked for. Inert today, and checked rather than assumed: founder-ness re-derives from `FounderOwnerKey`, the party key re-reads from the `StrandPartyKey` control row, and the row's shared `MemberPrivateKey` is read only by the founder bootstrap (`StrandDatabase.bootstrapFounder` → `sharedMemberPublicKey`) — a joiner launch does nothing with it. `NOTE:` at the `forgetStrand` call site says what to do (gate the hand-back on the passed row matching the control one) if a joiner launch ever starts depending on that key. The watcher's own auto-launch branch has always had this property, so it is not new here.

The implementer's own tripwire — clearing a suppressed id needs a poll that actually sees the row absent, so an unpublish-then-republish inside one poll interval leaves the id suppressed for the session — was re-read and is still accurate after the `unsuppressStrand` addition.

### Checked and found correct

- **`unpublishStrand`'s switch from `stopStrand` to `detachStrand`**, the one edit the implementer flagged as unplanned and untested. Read against both methods: `stopStrand` is exactly `_running` guard + `suppressStrand` + `detachStrand`, the guard is already satisfied by `requireOwnerSigningKey` above the call, and `strand:stopped` is emitted from `detachStrand` — so the switch drops the suppression and nothing else. I agree with the implementer that a test pinning "unpublish does not suppress" is below the bar: it would assert the absence of a call, and the behaviour it protects is the contrived republish case already covered by the tripwire. `strand-unpublish.spec.ts` passes unchanged.
- **Concurrency between an app retry and the watcher's**, the second flagged gap, re-derived rather than trusted. `StrandInstanceManager.startStrand`'s `instances.has` early return and its `instances.set` are separated by `assertSchemaSignature` and `resolveStrandStorage`, both synchronous, so no second entrant can interleave; the loser gets the winner's still-`'starting'` instance. `CadreNode.startOrFoundStrand` *does* await before that point (party-key resolution, cohort seed), which is what makes the await-free window load-bearing — worth knowing, unchanged by this diff.
- **Suppression lifecycle otherwise.** Cleared in `stop()`, cleared on row absence, bounded by the party's strand count. A stop of a strand the watcher still knows leaves `knownStrands` intact, so removal detection keeps working on that path.
- **Docs.** Every file the change touched was re-read, plus the ones it should have touched: `docs/strands.md` carries no claim about re-offering; `packages/reference-app-rn/README.md`'s "fires once per strand per run" survives, because the retry produces no second `strand:discovered`; the `strand:discovered` doc in `types.ts` and the `handleStrandAdded` comment both state the exception correctly.
- **Tests.** Arms 5 and 6 each pin a distinct contract, neither restates the implementation, and the implementer's disable-and-rerun verification was reproduced in spirit by the same technique on arm 7. Nothing was cut. The `bareWatcher` additions (injected clock, `withRunning`, wiring `internals.strandWatcher`) are narrow and declared on the named `CadreNodeInternals` interface rather than ad-hoc casts.

### Not found

No filing-bar findings, so no tickets were opened — and no `blocked/` proposal, because nothing in the specification was silent or contradictory here. No accepted-tradeoff `NOTE:` sits at any of the sites touched.

## Validation

```
yarn workspace @serfab/cadre-core typecheck   # exit 0
yarn lint                                      # exit 0
yarn workspace @serfab/cadre-core test         # 136 files, 2243 passed, 1 skipped
```

The one skip is pre-existing and unrelated: `key-store.spec.ts:231` is `it.skipIf(process.platform === 'win32')`.
