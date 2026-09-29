description: When a periodic check-in or an on-demand service wake fails before it has rebuilt a sleeping strand, its cleanup can shut down a network node that a concurrent wake is building or has just brought up, leaving that wake's strand broken or asleep.
architecture: docs/architecture.md#strand-hibernation
files: packages/cadre-core/src/cadre-node.ts (handleStrandCheckIn catch, runServiceWake catch, runWakeWindow quiesce, rehibernateAfterFailedResume, handleStrandWake catch for the rule already applied), packages/cadre-core/src/strand-instance-manager.ts (resumeStrand, quiesceStrand — the latter does not wait for an in-flight build)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: It needs a control-database read (the cohort seed) to throw while a wake and a check-in overlap on one strand, which may be rare enough that a maintainer prefers to leave it until it is observed.
----
# A probe's failure cleanup must not tear down a runtime it does not own

## Background

A hibernating strand is brought back up by three callers in `CadreNode`: a wake (`handleStrandWake`, from `wakeStrand`, push-wake or app activity), the periodic check-in (`handleStrandCheckIn`), and the mobile on-demand `serviceWake`. Each first resolves the cohort discovery seed (`resolveCohortSeed`, which reads `CadrePeer` rows from the control database and can throw), then calls `StrandInstanceManager.resumeStrand`. Overlapping resumes of one strand share a single build (`resumesInFlight`), and a failed build already releases its own partial runtime inside `buildStrandRuntime` and leaves the instance `'error'`.

The check-in and `serviceWake` catch blocks call `rehibernateAfterFailedResume` for *any* failure: best-effort `quiesceStrand`, then status `'hibernating'`. That is right when the failure is theirs (their rebuild failed, or their window's quiesce threw), but the seed step runs before the rebuild, while the strand may belong to another caller:

- **Check-in, seed fails while a wake's rebuild is in flight** (status `'starting'`, libp2p node attached, database not yet): `quiesceStrand` does not wait for the build (`runtimeBuilds`), so it stops the node the build is still wiring up, and marks the strand `'hibernating'` under it.
- **Check-in, seed fails after a wake's rebuild finished**: it quiesces a strand the wake just reported as up. The wake's caller (a push-wake, `wakeHostStrandForFormation`, the founder `needs-resume` path) resolved believing the strand is live.
- **`serviceWake`**: its own wake goes through `handleStrandWake`, which already applies the rule below, but its catch then quiesces unconditionally, so the same two cases apply when it overlaps a check-in.

A related arm at a neighbouring site, same theme (a probe's teardown ignoring a concurrent wake): `runWakeWindow` reads `lastActivity` once at the end of the window and then awaits `quiesceStrand`. A wake that lands during that await finds the strand still `'active'` with its handles, takes `handleStrandWake`'s already-live branch and resolves, and the window then marks the strand `'hibernating'`. The waker was told the strand is up. Re-checking the activity mark after the quiesce (and resuming, or leaving it to the wake) would close it.

The review of `ticket(implement): bug-strand-resume-double-build-and-stuck-error` fixed the wake path: `handleStrandWake` now re-hibernates only when the instance reads `'error'` (its own or a joined rebuild failed), and rethrows every failure (`test/cadre-node.spec.ts` → `a wake that fails before rebuilding leaves a check-in's mid-build runtime alone`). The check-in and `serviceWake` catches were left as they were because, unlike a wake, they also own a window whose quiesce can fail with the strand live, so the same one-line guard does not fit them.

## Expected behaviour

A caller's failure cleanup releases only a runtime that caller built or joined. A failure before the rebuild leaves the strand's state to whoever is building or holding it. After a failed check-in that did not rebuild, the check-in chain still continues (the strand either reads `'hibernating'` and the chain escalates, or another caller owns it and that caller's outcome decides).

Possible shape, for the implementer to weigh: split each probe's `try` into the resume stage (re-hibernate only on `'error'`, as the wake does) and the window stage (quiesce on failure, as today); or make the rule structural by having `quiesceStrand` settle an in-flight build first, which covers the mid-build case for every caller but not the "already woke" case.

Confirm with a `CadreNode`-level test in the style of the wake test above: a check-in whose seed read throws while the fake manager holds the instance `'starting'` with a node attached must not quiesce it.
