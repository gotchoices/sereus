description: If an app tries to join a shared conversation it was just told about and that attempt fails — a dropped connection, a slow network — the app is never told about that conversation again, so it stays missing until the app is restarted.
files:
  - packages/cadre-core/src/cadre-node.ts (`addStrand` ~4390 — drops the strand from the unclaimed backlog before the launch that can fail; its own doc comment now states the gap)
  - packages/cadre-core/src/strand-watcher.ts (`poll` ~160 — `knownStrands` is what makes the re-offer impossible; the failed-launch path already has the pattern: forget the strand + back off)
  - packages/reference-app-rn/src/use-cadre.ts (`claimDiscovered` ~197 — warns and gives up, which is only safe if the node re-offers)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: A user who reopens the app gets the strand anyway, so this only matters for the window between one failed join and the next restart — and the fix has to settle what the unclaimed-strand map means while a claim is in flight, which is more design than the symptom is worth if launch failures turn out to be rare in practice.
----

# A failed claim retires a discovered strand for the rest of the session

## What happens

A cadre node learns about the party's strands by polling the control database. A strand it holds no app config for is offered to the embedding app once — as the `strand:discovered` event, and (since `discovered-strands-lost-to-late-subscriber`) as an entry in `CadreNode.getDiscoveredStrands()`, which is what lets an app that subscribed late still find it.

The app claims such a strand by calling `CadreNode.addStrand`. That call removes the strand from the unclaimed map **first** and then starts the local instance, which can fail — the launch resolves a cohort seed over the network, and the whole `strand:error` / retry-backoff machinery in `StrandWatcher` exists because launches do fail. When it fails:

- the strand is no longer in `getDiscoveredStrands()`, so a later drain does not re-offer it;
- the watcher already recorded the strand in its `knownStrands` when it offered it, so no later poll re-offers it either;
- the watcher's automatic relaunch does not apply — that only retries a strand whose launch **the watcher itself** drove (`onStrandAdded` threw). Here `onStrandAdded` returned normally; it was the app's own later `addStrand` that failed.

So nothing ever mentions the strand again. In the React Native app the failure is a `console.warn` and the strand is simply absent from the list until the user force-quits and relaunches — the same symptom `discovered-strands-lost-to-late-subscriber` fixed, reached by a different route.

`CadreNode.addStrand`'s doc comment previously claimed the opposite ("a failed launch keeps being re-attempted in the background until it succeeds"); it was corrected during the review of that ticket to describe what actually happens, and points here.

## Expected behavior

A strand that this node is not running and has not deliberately stopped should always be claimable again. Concretely: after a failed claim, the app should get another chance at that strand without a restart — either because the strand returns to `getDiscoveredStrands()` for the next drain, or because the node is re-offered it on a later poll (with the same kind of backoff a watcher-driven launch failure gets, so a permanently unlaunchable strand does not storm the app).

A deliberate `stopStrand` must keep meaning "do not offer this again" — that distinction is what `detachStrand` currently draws, and a fix must not blur it.

## What the design has to settle

The unclaimed map is documented as "strands no local sApp config claims". A failed `addStrand` leaves the sApp config registered on purpose (an explicit retry needs it), so simply putting the strand back would make the map's stated meaning false. Two shapes, either fine if documented:

- **Re-offer through the watcher.** Have the node tell the watcher to forget a strand whose app-driven claim failed, so the next poll re-offers it — one mechanism for both failure routes, and it reuses the existing backoff. Needs a small public seam on `StrandWatcher` (it has no "forget" today).
- **Restore the backlog entry** on a failed claim, and redefine the map as "strands this node is not running and has not stopped".

## What would confirm it

Claim a discovered strand with an `addStrand` that rejects once (a stub launch failure is enough), then let the watcher poll several more times: no `strand:discovered` fires and `getDiscoveredStrands()` stays empty, so no path exists to retry the strand. `packages/cadre-core/test/discovered-strands-late-subscriber.spec.ts` already has a bare-watcher harness (no libp2p, no database) this arm can be written against.

## Decision (tending, 2026-09-23)

**Re-offer through the watcher.** A failed app-driven `addStrand` tells the watcher to forget that strand, so a later poll offers it again (`strand:discovered`, and `getDiscoveredStrands()`), with the same backoff a watcher-driven launch failure gets. This keeps one retry mechanism for both failure routes, and the unclaimed map keeps its documented meaning. Add the small public seam on `StrandWatcher` this needs. A deliberate `stopStrand` / `detachStrand` must still mean "don't offer again", so test that too. The reason this matters now: a join on a slow or flaky phone connection is exactly the launch that fails (gotchoices/sereus#13).
