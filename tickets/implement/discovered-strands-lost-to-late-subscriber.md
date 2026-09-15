description: When an app restarts and reconnects to the same party, the strands it already had never come back — the node announces each stored strand once, a fraction of a second before the app is ready to listen, and never mentions it again. Make the node remember which strands nobody claimed, so an app that starts listening a moment late can still pick them up.
prereq: phone-control-storage-shared-across-parties
files:
  - packages/cadre-core/src/cadre-node.ts (`sAppConfigs` ~389; `getStrands` ~866; `handleStrandAdded` ~3896 and the `strand:discovered` emit ~3908; `cleanup` ~4029; `addStrand` ~4351; `stopStrand` doc ~5619; `detachStrand` ~5647)
  - packages/cadre-core/src/types.ts (`'strand:discovered'` event doc ~1099-1102)
  - packages/cadre-core/src/strand-watcher.ts (`start` defers the first poll 100 ms; `poll` sets `knownStrands` before awaiting `onStrandAdded`)
  - packages/reference-app-rn/src/use-cadre.ts (`strand:discovered` subscription, ~157-206)
  - packages/reference-app-rn/src/chat-strand.ts (`joinChatStrand` ~108)
  - packages/cadre-core/test/control-db-node-helpers.ts (`controlNodeConfig`, `freshPartyId` — the solo-node harness the regression test uses)
  - packages/cadre-core/test/strand-solo-write-budget.spec.ts (~147 — the memoizing storage-provider pattern to copy)
  - packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts (the existing spec covering the no-config branch of `handleStrandAdded`)
difficulty: medium
repro: verified
----

# Keep unclaimed strand discoveries claimable

## What is wrong

A `CadreNode` learns about the party's strands by polling the control database's `Strand` table (`StrandWatcher`). For each row it has never seen, it calls `handleStrandAdded`. That method looks up an **sApp config** for the strand — the app-supplied record saying "I know what this strand is and I want to run it". If a config is present, the node launches the strand. If not, the node emits a `strand:discovered` event so the hosting app can decide whether to join, and returns.

sApp configs are held in memory only. They are cleared on every `stop()` and never written to disk. So after any restart, **every** stored strand takes the no-config branch: one `strand:discovered` event, then nothing. The watcher records the strand as handled, and no later poll offers it again. The event is the only notice, and it is fired exactly once.

That would be workable if the app were always listening by then. It is not. The watcher runs its first poll 100 ms after `StrandWatcher.start()`, which is inside `CadreNode.start()`. The React Native reference app subscribes in a React effect that cannot run until `startPhoneNode` has resolved — and `startPhoneNode` still has `runOwnerGenesis` to await after `node.start()` returns. Every discovery fires into an empty listener list and is dropped. The strands are still in the database; the node simply never mentions them again.

The result on a phone is that a reconnect to a party you already have strands in shows `Connected · 0 strand(s) · 0 member(s)`, permanently.

## How it was reproduced

**On the device** (Galaxy Note 9, debug `reference-app-rn`, 2026-09-15): create a chat strand, send a message, force-stop the app, relaunch, type the same party id, connect. The chat shows `0 strand(s)` and stays there. Read live through the debugger: the control `Strand` table held the strand's row, `node.getStrands()` was empty, and `strandWatcher.knownStrands` already listed every stored strand id with no recorded failures. Deleting one id from `knownStrands` and calling `forcePoll()` — with a listener now attached — re-attached that strand in 2157 ms, status `active`, with its pre-restart message intact.

**In process** (run 2026-09-15, then removed; it returns as the regression guard below). A real `StrandWatcher` over a queryable holding one open strand row, with the real `CadreNode.handleStrandAdded` as its `onStrandAdded`. Start the watcher, wait past the first poll, *then* subscribe to `strand:discovered`, then force two more polls:

```
knownStrands after start: [ 'c7160779-…' ]
discovered seen by late subscriber: []
```

No libp2p node and no database are involved, so this costs a few hundred milliseconds.

## The fix

**Make the set of unclaimed strands node state, not a one-shot notification.** The event stays exactly as it is — emitted once, when the strand is first found unclaimed — but it stops being the only way to learn about the strand. `CadreNode` keeps the unclaimed rows and exposes them, so an app that attaches its listener a moment late can ask what it missed.

### In cadre-core

Add a private `discoveredStrands: Map<string, StrandRow>` beside `sAppConfigs` (~389), and a public accessor mirroring `getStrands()`:

```ts
/**
 * Strands the control network advertises that no local sAppConfig claims —
 * the backlog behind `strand:discovered`.
 *
 * The event fires once per strand, and it can fire before the app has
 * subscribed (the watcher's first poll runs inside `start()`). So an app that
 * auto-joins discovered strands must subscribe FIRST and then drain this map,
 * not rely on the event alone. Entries leave the map when the strand is
 * claimed (`addStrand`) or its control row disappears.
 */
getDiscoveredStrands(): Map<string, StrandRow>;
```

Maintain it at four sites, all of which already exist:

- `handleStrandAdded` (~3896), no-config branch: `this.discoveredStrands.set(strand.Id, strand)` before the emit.
- `addStrand` (~4351), where `sAppConfigs.set` runs: delete the id. The strand is claimed; it must not come back on a later drain.
- `detachStrand` (~5647), which already drops `sAppConfigs` and `strandLaunchRefusals`: delete the id there too. This is the path `handleStrandRemoved` takes when the control row is gone.
- `cleanup` (~4029), alongside `sAppConfigs.clear()`.

Note what the `detachStrand` placement means and make sure it is what lands: an explicit `stopStrand` also routes through `detachStrand`, so a strand the user deliberately stopped leaves the map and is **not** re-offered to a drain. That is correct — a drain must never undo a deliberate stop — but it also makes the doc comment on `stopStrand` (~5619) wrong today, before this change: it claims the strand "is rediscovered and surfaces as `strand:discovered` again" on "the next node restart (or watcher poll)". The watcher-poll half has never been true; `knownStrands` retains the id for the life of the process. Correct that sentence to say restart only.

Rewrite the `'strand:discovered'` doc in `types.ts` (~1099) to state the contract plainly: fired once, can precede the app's subscription, and `getDiscoveredStrands()` is how a late subscriber catches up. This is the piece that stops the next embedder from rebuilding the same race.

The map is bounded by the number of strands the party has that this node does not run. With the prereq landed the control database holds only this party's rows, so it is small; say so in the doc rather than adding a cap.

### In the React Native app

Two changes in the `strand:discovered` effect (`use-cadre.ts` ~157-206):

- After `node.on('strand:discovered', onDiscovered)`, drain `node.getDiscoveredStrands()` through the same handler body. Subscribe-then-drain, in that order, so a discovery landing between the two is seen twice rather than zero times.
- Factor the join out of the event closure so the event path and the drain path are one function, and give it an **in-flight guard**. The existing `node.getStrands().has(strandId)` check is not sufficient on its own: the strand manager only tracks an instance once `startStrand` has resolved, and the handler is fire-and-forget (`void (async () => …)`), so two offers for the same strand a few seconds apart can both pass that check and launch twice. A `Set<string>` of ids currently being claimed, cleared in a `finally`, closes it. Keep the existing `Type !== 'o'` gate — closed strands still require the explicit invite handshake, and they simply stay in the map unclaimed.

`joinChatStrand` itself (`chat-strand.ts` ~108) needs no change.

`startPhoneNode`'s ordering needs no change either, and deliberately so: the point of doing this in core is that the app no longer depends on winning a 100 ms race.

### Alternative considered and rejected

Having the watcher **re-offer** unclaimed strands instead — not counting them as added, and re-emitting on the existing exponential backoff — was the other candidate, and it has the appeal of requiring nothing at all from the embedder. It was rejected for three reasons. It changes `onStrandAdded`'s contract from `Promise<void>` to a claimed/unclaimed result, which reaches into the watcher's main loop and both of its spec files, where the current design leaves the watcher untouched. It re-emits forever for strands no app will ever claim — a closed strand on a phone would produce a `strand:discovered` every five minutes for the life of the process. And it does not remove the double-launch hazard: the app-side in-flight guard is needed either way, because `knownStrands` would no longer be doing that job for unclaimed ids.

## The regression guard

Two arms. The first is the property the ticket exists for; the second is the safety interlock the prereq buys, asserted at this seam rather than only at the storage layer.

**Restart re-attaches stored strands regardless of when the app subscribes.** In `packages/cadre-core/test/`, using the solo-node harness in `control-db-node-helpers.ts` (`controlNodeConfig`, `freshPartyId`) over a provider that memoizes each scope's `MemoryRawStorage` — the pattern `strand-solo-write-budget.spec.ts` (~147) already uses, so the same store survives a stop/start. Found an open strand, stop the node, build a second node on the same party over the same provider, `await node.start()`, and only **then** subscribe and drain. Assert the strand is offered and attaches. Write it so that it fails without the fix — subscribing after `start()` resolves is the whole point, so do not hoist the subscription.

**A restart re-attaches only the starting node's own party.** Two party ids over one memoizing provider. Party A founds a strand and stops. A node starts on party B over that same provider; its discovered set and its strands are both empty. This is what keeps a phone from joining a stranger's open strands when the two share a device — the prereq makes it true, and this arm is what notices if it ever stops being true.

Keep the in-process `StrandWatcher` + `handleStrandAdded` reproduction from above as a third, cheap arm if it reads well next to the others; it is the tightest statement of the defect but it says nothing the first arm does not also say.

## Notes for the reviewer

- `cadre-node.ts` is already flagged as oversized by `backlog/debt-cadre-node-single-file-size`. This adds one field, one accessor and four one-line deletes to it — worth noting in the handoff, not worth splitting the file here.
- The React Native app has no lifecycle tests at all (`backlog/debt-rn-cadre-phone-lifecycle-untested`), so the drain and the in-flight guard are covered by the cadre-core arms plus a device check, not by app-level tests.
- `reference-app-web` and `reference-app-ns` never subscribe to `strand:discovered`, so neither auto-joins discovered strands and neither is affected. Confirm that is still true at review time.
- `backlog/feat-rn-persist-node-start-options`: the phone does not remember its party id, so a restart usually starts a *new* party and the bug is masked. It shows whenever the same party id is re-entered.

## TODO

- Add `discoveredStrands` to `CadreNode` and the `getDiscoveredStrands()` accessor with the doc comment above; maintain it in `handleStrandAdded`, `addStrand`, `detachStrand` and `cleanup`.
- Rewrite the `'strand:discovered'` doc in `types.ts` to state the fire-once / late-subscriber contract and point at `getDiscoveredStrands()`.
- Correct the `stopStrand` doc comment (~5619): a stopped strand is rediscovered on a node restart, not on the next watcher poll.
- Confirm (rather than assume) that nothing new needs exporting from `index.ts` — `getDiscoveredStrands` is a method and `StrandRow` is already exported.
- React Native: factor the discovered-strand join into one function, add the in-flight `Set` guard, and drain `getDiscoveredStrands()` immediately after subscribing in the `use-cadre.ts` effect.
- Write both regression arms described above.
- Run `yarn lint`, the cadre-core suite, and a type-check of `reference-app-rn`.
- Device check, if a phone is available: create a strand, send a message, force-stop, relaunch into the same party id, and confirm the strand and its history come back. Record the timing in the review handoff — the device re-attach measured 2157 ms when forced by hand.
