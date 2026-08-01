description: If starting a shared workspace fails partway (network or storage trouble), the app is left holding a dead workspace it can never restart — every retry silently hands back the broken one instead of trying again.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts
difficulty: medium
repro: static
----

# What happens

`StrandInstanceManager.startStrand` registers the new instance (and its retained launch
config) in its `instances` / `launchConfigs` maps *before* building the runtime, so it can
roll back cleanly. When `buildStrandRuntime` throws, the runtime handles are released but
the instance record is **not** removed from those maps — it stays with `status: 'error'`
for the life of the process.

Every later attempt to start that same strand id then short-circuits on an
"already tracked" check and returns the dead record without retrying:

- `StrandInstanceManager.startStrand` returns the existing entry outright.
- `CadreNode.launchStrand` returns it before it even reaches the strand manager, so the
  caller gets a resolved promise, no `strand:error`, and no `strand:started`.

Net effect: one transient failure (a libp2p node that could not come up, a strand database
that failed to initialize) permanently disables that strand id until the process restarts.
`CadreNode.addStrand` resolves successfully with an instance that has no libp2p node and no
database, which reads as success to the hosting app.

The watcher-driven discovery path is affected the same way: `handleStrandAdded` catches the
first failure and emits `strand:error`, and every subsequent poll that re-enters the launch
path silently no-ops on the dead record.

# Why it is filed now rather than fixed inline

Found while reviewing `duplicate-strand-started-on-rediscovery`, whose new already-tracked
guard in `launchStrand` sits on this path. The guard did not introduce the problem — the
pre-existing guard inside `startStrand` had the same effect (it additionally emitted a
misleading `strand:started` for the dead instance, which the new guard no longer does) — but
it does mean the tracked-instance map is now the single arbiter of "is this strand running",
and that map can hold an entry that is not running and never will be.

# Expected behavior

A launch that fails before the instance is usable should leave no trace that blocks a retry:
the next `addStrand` (or the next watcher rediscovery) should attempt a genuine fresh launch,
and failures should keep surfacing as a rejected promise / `strand:error` rather than as a
silently-resolved dead instance.

Open question for whoever picks this up: whether a failed record should be dropped entirely,
or retained in an explicitly non-running state that the "already tracked" checks exclude.
The second keeps the failure inspectable (`getStrand(id)?.error`) but every tracked-instance
check in `cadre-node.ts` has to agree on what counts as running — worth deciding once, in
one place, rather than per call site.

# Scope note

Read from the code; not reproduced by running it. A confirming test would inject a
`buildStrandRuntime` failure (e.g. an sApp schema whose `initialize()` throws, or an
unusable storage provider), assert the first `addStrand` rejects, then assert a second
`addStrand` for the same id also attempts a launch rather than resolving with the dead
instance.
