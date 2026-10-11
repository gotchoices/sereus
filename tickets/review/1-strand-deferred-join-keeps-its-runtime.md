description: When a machine joining a shared workspace cannot finish setting up its copy on the first try, Sereus now keeps its live network connection and retries only the setup, instead of throwing the connection away and starting over. The reporter's slow-phone scenario still fails, for a different reason found along the way.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime, buildStrandDatabase, discardDatabaseAttempt, deferUnreachableJoin, retryUnreachableJoin, isCurrentRuntime, isAwaitingFirstSync, attachSApp log, ensureFounderBootstrap message), packages/quereus-plugin-sereus/src/compose-strand.ts (releaseCollectionFactory, CollectionFactory shim), packages/cadre-core/src/strand-database.ts (comments only), packages/cadre-core/test/strand-instance-manager.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (header only), packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (comment only), packages/cadre-core/src/strand-first-sync-gate.ts (comment only), docs/strands.md
----
# A deferred join keeps its runtime and retries only the database

## What changed

A strand launch whose database cannot be built because a seed peer has not answered (`strandDb.initialize()` fails `cohort-unreachable`) no longer tears its runtime down. The libp2p node, its connections, the relay supervisors, peer-join backfill, membership reconciler and revocation enforcer stay up, the instance reports `'syncing'`, and every `UNREACHABLE_JOIN_RETRY_MS` (still 5 s) only the database phase runs again on the same node.

- `StrandInstanceManager.buildStrandDatabase` is the database phase split out of `buildStrandRuntime`: a new `StrandDatabase` per attempt behind its first-sync gate, `initialize()`, then publish or arm the gate. It returns `'built'`, `'awaiting-seed'` (the attempt's database is closed and its gate dropped; nothing else is touched) or `'released'` (a stop released the runtime while initialize ran). Any other failure throws with the attempt left on its gate for `releaseRuntime`.
- `buildStrandRuntime` arms the background loops after the database phase whatever its outcome, and schedules the retry only at the end of the build, so a retry never fires while the build is still in flight.
- `retryUnreachableJoin` re-reads the retained launch config each time (so an `attachSApp` or founder flip made during the wait is applied by the next attempt), is tracked in `runtimeBuilds` (wake, quiesce and `attachSApp` wait for it), is skipped while a quiesce is pending, and re-checks after the attempt that the instance and node are still current before scheduling the next one. A failure other than an unanswered seed releases the runtime and marks the strand `'error'`, as before.
- `isAwaitingFirstSync(strandId)` no longer needs the retry-timer arm: during the wait the node is attached and the database is not.
- `composeStrand` releases its collection factory with `dispose()` and stops a node only when it created it (`releaseCollectionFactory`), on the failure path AND in the returned `shutdown()`. The success path was changed too because a founder bootstrap that fails `cohort-unreachable` after composition closes a composed database, and its `shutdown()` used to stop the injected node. This makes the code match what the plugin README already said ("will not stop it on shutdown"). cadre-core's `releaseRuntime` stops the node itself, as it always did.
- Docs: `docs/strands.md` deferred-join bullet; doc comments on `UNREACHABLE_JOIN_RETRY_MS` (kept at 5 s; a `NOTE:` says to try a shorter first retry if the wait shows up in a measured join — not measured here), `deferUnreachableJoin`, `StrandDatabase`.

## Tests

- `packages/cadre-core/test/strand-instance-manager.spec.ts` — the existing "seed is unreachable" test now asserts the node is attached and `started` after the deferral, then (with a pass-through spy on `StrandDatabase.prototype.initialize`) waits for one retry and asserts it ran on the same node object, still started, still awaiting first sync. On the old code the node was gone after the deferral. Adds about 5 s.
- `packages/quereus-plugin-sereus/test/plugin.spec.ts` — the injected-node test now asserts `shutdown()` does not stop the injected node.

Run: cadre-core 161 files / 2426 tests pass; quereus-plugin-sereus 12 files / 156 tests pass; `yarn lint`; cadre-core, plugin and integration-tests typecheck. Integration: `joiner-first-commit-over-slow-relay` arms 1, 2 and 4 pass (130 s); `strand-chat-participants-converge` passes (its unreachable-host subject exercises the deferred path end to end).

## Known gap: the reporter's third arm still fails

`joiner-first-commit-over-slow-relay.integration.ts`'s third arm (20 ms `serial` frame cap, event loop 70% busy) is still an expected failure in three runs, so it stays `it.fails` and the fourth arm (restart) stays: it still starts from a solo commit (`founder held the joiner's rows when it stopped: false`). `docs/testing.md`'s scenario line is unchanged and still accurate.

Traced with a temporary instrumented copy (deleted) and libp2p's own logs: the fix works as designed (deferral keeps the node; the retry 5 s later builds the database from the blocks the founder's backfill delivered, 18 tables hydrated, and opens the gate), but the founder connection is already gone. About 2 s after the founder's catch-up push, the harness's dedicated relay logs `libp2p:connection-monitor:error aborting connection due to ping failure` for its connections to both strand nodes, which aborts the founder-to-joiner circuit on both ends and fails the joiner's in-flight schema read; nothing redials the founder before the retry. The harness relay runs libp2p's stock ping monitor while the ops relay pins a 30 s deadline. Copying the ops settings into the fixture (one run, reverted) stopped the cut but the joiner then took 454 s to become writable on a saturated link, still connected only to the relay, and the arm took 654 s. Recorded as:

- an arm on `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults` (the harness relay's parity gap, with the 454 s observation);
- a finding on `blocked/optimystic-write-made-alone-owes-no-one` (the arm still commits alone, so it still exercises that ticket);
- a note on `implement/strand-peers-redial-on-the-declared-link-budget`, whose redial supervisor covers exactly this state (a running strand node with no member connected): re-run the third arm after it lands.

The scenario's header paragraph now gives this cause instead of the torn-down runtime.

## Other things for the reviewer

- `stopStrand` does not wait for an in-flight database retry (it never waited for builds). The retry's gate identity check and `isCurrentRuntime` cover a stop during `initialize()`; a stop landing during the first-sync probe's `await` can still attach an already-closed database to the discarded instance. Harmless as far as I can see; the same window existed for `startStrand` builds before.
- A founder request (`foundExistingStrand`) against a launch waiting for a seed returns `'needs-resume'`; `CadreNode`'s wake is then a no-op (the runtime is live) and `ensureFounderBootstrap` throws, now with a message naming both causes. Before the change the rebuild-as-founder would also have been refused while the seed was unheard, so the outcome is the same; only reachable for a founder given a seed.
- No other integration scenario was run; the change touches every strand launch whose first database build fails `cohort-unreachable`.
