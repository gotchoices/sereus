description: When an app starts a shared workspace and then announces it to the rest of the group, the app is told twice that the workspace started — so any setup work it does on that signal runs twice.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-unpublish.spec.ts
difficulty: easy
repro: verified
----

# What happens

`CadreNode.addStrand(config)` starts a strand instance locally and emits `strand:started`.
`CadreNode.publishStrand(id)` then writes the `Strand` row to the shared control database. On
its next poll (default 5 s) this same node's own `StrandWatcher` sees a row it has never seen
before, admits it, and calls `handleStrandAdded`. The sApp config is already registered — that
is what `addStrand` did — so it takes the auto-start branch into `launchStrand`, which emits a
**second** `strand:started` for the instance that is already running.

Add-then-publish is the ordinary founding sequence for an app that creates a strand rather than
joining one, so the duplicate is on the normal path, not an edge case.

## Root cause — one site

`CadreNode.launchStrand` (`packages/cadre-core/src/cadre-node.ts`, the tail of the method) does
its post-start work unconditionally:

```ts
const instance = await this.strandManager.startStrand({ /* … */ });
this.hibernationManager.trackStrand(instance);
this.emit('strand:started', { strandId: strand.Id });
```

`StrandInstanceManager.startStrand` is idempotent — for an id it already holds it logs
"Strand %s already running" and returns the existing instance
(`packages/cadre-core/src/strand-instance-manager.ts`, the `this.instances.has(strandId)`
early return). `launchStrand` cannot tell that answer apart from a fresh launch, so it emits
and re-tracks either way. The fix belongs here: the post-start work should run only when the
instance was newly created.

`trackStrand` → `scheduleIdleTransition` clears the previous timer before arming a new one, so
**no timer leaks** — the re-track only pushes the hibernation countdown back to zero. The
duplicate event is the user-visible half.

Also wasted on the re-entry: `launchStrand` re-runs `resolveCohortSeed` before reaching the
idempotent `startStrand`, which is a control-mesh RPC fan-out to every connected sibling. Once
per strand per rediscovery, for an instance that is already up. Not measured under load — the
claim here is only that the round trips happen, not that they are a bottleneck.

# Expected behaviour

- `strand:started` fires **once per actual start** of an instance. A watcher poll that
  rediscovers a strand this node is already running is a no-op: no event, no re-track, and
  ideally no cohort-seed resolution.
- The genuine restart case is unaffected: stop (or party-wide removal) then start again must
  still emit `strand:started` on the new launch.

# Reproduction

Verified 2026-07-31 against `master` at `e695c6c` with a throwaway spec (since removed) in
`packages/cadre-core/test/`: start a self-owner `CadreNode` with `strandWatchInterval: 200`,
collect `strand:started`, `addStrand(config)` then `publishStrand(id)`, wait ~1.5 s. Observed
the id twice; expected once.

A permanent regression test belongs beside the existing lifecycle coverage in
`packages/cadre-core/test/strand-unpublish.spec.ts`, whose first watcher test currently orders
`publishStrand` before `addStrand` specifically to route around this duplicate (see the comment
there naming this ticket) — that ordering constraint can relax once this is fixed.

# Arm added 2026-07-31 (review of `debt-strand-unpublish-sibling-convergence-e2e`)

The mirror-image defect lives two methods away and should be fixed in the same pass: a node can
emit `strand:stopped` for a strand it never started.

`CadreNode.detachStrand` (`packages/cadre-core/src/cadre-node.ts`) ends with:

```ts
await this.strandManager.stopStrand(strandId);
this.emit('strand:stopped', { strandId });
```

`StrandInstanceManager.stopStrand` returns early — logging "Strand %s not found" — for an id it
does not hold (`packages/cadre-core/src/strand-instance-manager.ts`, the `this.instances.get`
early return). `detachStrand` cannot tell that answer apart from a real teardown, so it emits
regardless. Exactly the same shape as `launchStrand` above: an unconditional lifecycle event
after an idempotent manager call.

Two reachable ways in, both on ordinary paths:

- **Party owner that publishes but does not run the strand.** Its own `StrandWatcher` tracks the
  row it just published (`knownStrands.set` happens before the no-config `strand:discovered`
  branch), so a later `unpublishStrand` → `forcePoll` → `handleStrandRemoved` → `detachStrand`
  fires `strand:stopped` for an instance that never existed. This is the exact shape of node A in
  `packages/integration-tests/src/scenarios/strand-unpublish-sibling-convergence.integration.ts`.
- **`CadreNode.stopStrand(id)` called for a strand that is not running** — the public API emits
  the event unconditionally too.

Expected behaviour: `strand:stopped` fires once per actual teardown of a running instance. A
removal (or an explicit stop) for an id this node holds no instance for is a no-op: no event.

Note the interaction with the existing `unpublishStrand` comment, which says the watcher path and
the explicit-stop path "cannot double-stop into an error" *because* the manager no-ops. That stays
true; gating the emit on a real stop is what removes the spurious event without disturbing it.

`repro: static` for this arm — read from the code paths above, not run. Confirming it takes a
listener on a self-owner node that calls `publishStrand` without `addStrand`, then
`unpublishStrand`, and asserts `strand:stopped` never fires.
