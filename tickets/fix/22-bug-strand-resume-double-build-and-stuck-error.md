description: Bringing a sleeping (hibernating) strand back up has two gaps: a wake that lands while the periodic check-in is already bringing it up can rebuild it twice and leak a network node, and a wake that fails leaves the strand stuck offline with nothing that retries. Resuming a strand should run one rebuild at a time and leave a failed one retryable.
architecture: docs/architecture.md#strand-hibernation
files: packages/cadre-core/src/strand-instance-manager.ts (resumeStrand ~1294, buildStrandRuntime assigns instance.libp2pNode ~784), packages/cadre-core/src/cadre-node.ts (handleStrandWake ~4586, handleStrandCheckIn ~4659, resumeStrandRuntime), packages/cadre-core/src/hibernation-manager.ts (beginWake, runCheckIn), docs/architecture.md (Strand Hibernation → Wake Mechanisms item 3)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The double-build window is one runtime build long and needs a wake during a check-in, so it may rarely be seen; a failed wake is recoverable by an app-level retry or restart, so a maintainer could defer both until hibernation sees real multi-trigger traffic on flaky networks.
----

# Strand resume: concurrent resumes are not coalesced, and a failed wake is never retried

Two arms, both in the resume lifecycle (`StrandInstanceManager.resumeStrand` and its callers in `CadreNode`).

## Arm 1 — a wake during a check-in builds a second runtime

A hibernating strand has its network node and database shut down. Two separate paths bring it back:

- **Wakes** — `CadreNode.wakeStrand`, activity recorded by `HibernationManager.recordActivity`, a push-wake from another cadre peer (`StrandWakeService` → `wakeStrand`), `serviceWake`, and now an authorized closed-strand formation redemption (`CadreNode.wakeHostStrandForFormation`). These all go through `HibernationManager.beginWake`, which shares one in-flight promise per strand, so they coalesce with each other.
- **Check-ins** — `HibernationManager.runCheckIn` calls `CadreNode.handleStrandCheckIn` directly, which calls `resumeStrandRuntime` → `StrandInstanceManager.resumeStrand`. This path never enters `beginWake`'s promise map.

`resumeStrand`'s only double-resume guard is `if (instance.libp2pNode || instance.database) return instance`. It sets `status = 'starting'` and then awaits `buildStrandRuntime`, which assigns `instance.libp2pNode` only after `createLibp2pNode` resolves (`strand-instance-manager.ts` ~784). `handleStrandWake` likewise checks only `libp2pNode || database`, not status.

So: a check-in fires and starts resuming; before the new libp2p node is assigned, a push-wake (or any wake) arrives; `handleStrandWake` sees no node and no database and calls `resumeStrand` again; the second call also sees neither and runs a second `buildStrandRuntime`. The result is two libp2p nodes under the same derived peerId, the second overwriting `instance.libp2pNode`, the first never stopped (and similarly for the database and per-runtime services such as relay supervisors and backfill).

The formation wake narrows but does not avoid this: it wakes only when `status === 'hibernating'`, but `handleStrandCheckIn` awaits the transport-key derivation and `resolveCohortSeed` before `resumeStrand` sets `'starting'`, and a formation redemption landing in that gap passes the status check.

`docs/architecture.md` → Wake Mechanisms item 3 states that "resume coalescing prevents a push-wake racing a concurrent check-in". That is true of `beginWake` coalescing between wakes, but not between a wake and a check-in.

### Expected

At most one runtime build runs per strand at a time. Any caller that asks to resume a strand whose resume is already in flight waits for that build and gets its result (or its error). This is best enforced at `StrandInstanceManager.resumeStrand` itself (a per-strand in-flight promise), so every present and future caller is covered, rather than by routing check-ins through `beginWake`.

When fixed, the architecture doc sentence above should describe the real guarantee.

### How to confirm

A unit test on `StrandInstanceManager` with a `buildStrandRuntime` slowed down (or a real node, two `resumeStrand` calls issued without awaiting the first) would show two builds today: count `createLibp2pNode` invocations, or check that the first node is still running after both calls settle.

## Arm 2 — a failed wake leaves the strand in `'error'` with no retry

`resumeStrand` sets `status = 'error'` when `buildStrandRuntime` throws. `handleStrandCheckIn` catches that and forces the strand back to `'hibernating'` (after a cleanup quiesce), so its check-in chain retries on backoff. `handleStrandWake` (every wake path: `wakeStrand`, activity, push-wake, `serviceWake`, formation redemption) does not, so a wake that fails on a flaky network leaves the strand `'error'` with no runtime. Check-ins only run for `'hibernating'` strands and `recordActivity` only wakes `'idle'`/`'hibernating'` ones, so nothing brings it back until the app stops and relaunches the strand. For closed-strand formation this means every later join redemption is refused (`'error'` is not woken) until then.

### Expected

A failed wake leaves the strand in a state that the normal machinery retries (the check-in handling is the existing precedent), while the caller that awaited the wake still sees the error. Whether this belongs in `handleStrandWake` or in `resumeStrand` is for the implementer to decide alongside arm 1.

### How to confirm

Force `buildStrandRuntime` to throw on a resume from `wakeStrand` and observe `instance.status === 'error'` with no check-in timer armed.
