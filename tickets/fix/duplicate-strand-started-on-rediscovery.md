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
