description: When a machine joining a shared workspace cannot finish setting up its copy on the first try, Sereus throws away its live network connection and starts over, so on a slow link it can end up "ready to write" while connected to no other member. Keep the connection and retry the setup on it instead.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime ~700-1060, the `joinWaitsForSeed` catch ~1050, deferUnreachableJoin / retryUnreachableJoin ~1076-1105, releaseRuntime), packages/quereus-plugin-sereus/src/compose-strand.ts (CollectionFactory shim ~19, the failure `catch` ~335), packages/cadre-core/src/strand-database.ts (initialize ~87), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/strands.md (Joining → "A launch whose seed peers have not answered")
repro: verified
----
# A deferred join tears down the one connection it had

Root cause of the reported case in gotchoices/sereus#44 (the reporter's scenario is committed as `joiner-first-commit-over-slow-relay.integration.ts`; its third arm, `it.fails`, is this bug).

## What happens

Traced with a scratch copy of the third arm (20 ms `serial` frame cap, event loop 70% busy) under `DEBUG=sereus:cadre:strand-manager,sereus:cadre:peer-join-backfill,sereus:cadre:strand-first-sync`, three runs, the same sequence every time:

1. The joiner's first strand runtime starts, and its strand node connects to the founder's strand node through the relay (about 9 s after the runtime started).
2. The founder's peer-join backfill pushes its whole store to the joiner: `catch-up peer=<joiner strand> offered=36 accepted=36`.
3. About 0.5 s later the joiner's `strandDb.initialize()` fails: its read of `optimystic/schema` had already timed out on the slow link (`cohort-unreachable`). `buildStrandRuntime` sets `joinWaitsForSeed`, calls `releaseRuntime` (which stops the strand libp2p node, closing the connection to the founder) and `deferUnreachableJoin` schedules a rebuild in 5 s.
4. The rebuilt runtime's strand node connects only to the relay. Its store now holds every block (step 2), so `initialize()` succeeds and the first-sync probe passes on the first try ("database published by the caller; first-sync gate not needed"). The strand is writable with no strand peer connected, 7 s after the rebuild started.
5. The joiner's first transaction resolves a cohort of only itself for every block and commits with `quorum: 'local'`; if the joiner then stops, the founder never gets the rows.

So the joiner did reach the founder and did sync; Sereus itself threw the connection away. The deferral was designed for "no seed peer has answered", but here one had: it answered the backfill, just later than the schema read's deadline.

## Why the runtime is torn down

`composeStrand`'s failure path (`compose-strand.ts`, the `catch` after the schema apply) calls `collectionFactory.shutdown()`, and Optimystic's `CollectionFactory.shutdown()` stops every libp2p node registered with it, the injected strand node included. So a failed `initialize()` leaves a stopped node, and `deferUnreachableJoin` has to rebuild the whole runtime ("A failed composition stops the injected libp2p node, so each retry rebuilds the whole runtime"). `CollectionFactory.dispose()` (public, `quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` ~767) releases the read caches and network watches without stopping nodes; `shutdown()` is `dispose()` plus the node stops.

## Expected behaviour

A join deferred because the database could not be built keeps its libp2p node, its connections and its background loops (relay supervisors, peer-join backfill, reconciler, revocation enforcer), and retries only the database build on the live node. A seed peer that answers late is then still connected when the build succeeds, and the first-sync probe that follows runs with it connected.

## Design notes

- `composeStrand`: on failure with an INJECTED node (`createdNode` null), release with `dispose()` instead of `shutdown()`; keep stopping a node it created itself. Add `dispose()` to the local `CollectionFactory` shim. The browser entry shares `composeStrand`, so it gets the same behaviour.
- `StrandInstanceManager`: split `buildStrandRuntime` so the database phase (new `StrandDatabase`, gate, `initialize()`, first-sync probe, publish, and whatever after it needs the database) can be re-run against the runtime already attached. The retry timer re-runs that phase instead of `buildStrandRuntime`; `releaseRuntime` still runs for a failure that is not `joinWaitsForSeed`, and a stop or quiesce during the wait still cancels the retry (it already clears `unreachableJoinRetries`).
- `StrandDatabase.initialize()` builds a fresh Quereus `Database` per call and leaves `initialized` false on failure; check a second `initialize()` on the same instance is clean after a failed one (closing the half-built `Database` first), or build a new `StrandDatabase` per attempt.
- The retry cadence (`UNREACHABLE_JOIN_RETRY_MS`, 5 s) existed partly because each attempt started a libp2p node; with the node kept, a shorter first retry may be reasonable. Measure before changing it.
- Update `docs/strands.md` → Joining → "A launch whose seed peers have not answered cannot build its database at all", which currently says the half-built runtime is torn down.

## How to verify

Re-run the reporter's scenario: `yarn workspace @serfab/integration-tests vitest run src/scenarios/joiner-first-commit-over-slow-relay.integration.ts`. Expected: the third arm's `it.fails` turns red (the inner assertion now passes), and its `joiner strand connections:` line names the founder's strand node. Then make it a plain `it`.

- If the third arm still fails, look at its connections line: a joiner that is writable while connected to the founder but still commits solo means the connection dropped between writable and the write, which is the residual `docs/strands.md` → Joining → "Writable does not mean connected" describes and `blocked/optimystic-write-made-alone-owes-no-one` covers. Record what you saw on that blocked ticket and keep `it.fails`.
- When the third arm passes, the fourth arm (restart) no longer starts from a solo commit (it logs `founder held the joiner's rows when it stopped: true`) and so no longer tests delivery after a restart. Delete that arm then, and the restart helpers with it, unless you find another way to make the joiner commit alone; say which in the handoff and update the scenario line in `docs/testing.md`.
- The arm takes about 4 minutes; run it in the foreground with output streaming.

## TODO

- `compose-strand.ts`: release with `dispose()` instead of `shutdown()` when the node was injected; extend the shim interface.
- `strand-instance-manager.ts`: retry only the database phase on the live runtime for a `joinWaitsForSeed` failure; keep `releaseRuntime` for every other failure; keep stop/quiesce cancelling the retry.
- Check `StrandDatabase.initialize()` is safe to call again after a failed attempt, or build a new instance per attempt.
- Unit-level: the deferred-join tests in `packages/cadre-core/test/strand-instance-manager.spec.ts` (grep `UNREACHABLE_JOIN_RETRY_MS`) assert a rebuild; update them to assert the node is kept and only the database retried.
- Run the reporter's scenario as above; flip the third arm to `it` if it passes, and handle the fourth arm as described.
- Update `docs/strands.md` (the deferred-join bullet) and the `deferUnreachableJoin` / `UNREACHABLE_JOIN_RETRY_MS` doc comments.
- `yarn lint`, cadre-core and quereus-plugin-sereus tests and typecheck.
