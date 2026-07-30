description: A new three-node network test was written but never run — get it passing, check it is not flaky, and note it in the docs.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts (NEW, written but UNVALIDATED), packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/cadre-core/src/cadre-node.ts, docs/cadre-consistency.md, docs/architecture.md
difficulty: medium
----

## Status carried over

The predecessor ticket (`control-cohort-three-node-reconcile-isolation-test`,
now deleted) specified and this run **wrote** the whole scenario file:

`packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts`

It is complete as authored — header comment, helpers, `bootTrio()`, and both
`it()` blocks — but it has **never been type-checked, linted, or executed**. The
run hit its token budget immediately after the file was created. Treat the file
as a first draft that compiles in principle only.

## What the scenario is for (context, no prior session needed)

`reconcileControlCohort` on a cadre node proactively dials the party's other
nodes so the control-database collections form a connected, replicating group.
In a two-node party that routine can never be the thing that forms the first
connection — the cold-start seed path always gets there first. So the case where
the reconcile dial is the *only* reason a connection exists had no end-to-end
proof.

The new file adds a three-node party: A (owner + storage, listens), B
(client-only, listens on **nothing**), C (listens). B and C each cold-start from
a seed A mints. B learns C exists only because C's signed address row replicated
to B through A. Because B listens on nothing, C physically cannot dial B, so any
B↔C connection is one B opened.

Two test cases in one file:
- **automatic** — B's reconcile interval set to 2s; the test just waits for B to
  acquire an outbound connection to C.
- **load-bearing** — B's reconcile interval set to 10 minutes so the timer never
  fires; a ~5s negative window asserts B has no connection to C and no libp2p
  peerStore address for C *while* C's record resolves fine, then explicit
  `reconcileControlCohort()` passes form the link.

Neither case calls `dial()` from the test.

## Remaining work

- Type-check: `yarn workspace @serfab/integration-tests typecheck`.
  Watch for: `ControlNetworkSeed` type import (re-exported from
  `@serfab/cadre-core` via `export * from './types.js'` — confirmed present),
  the `trustedOwners: { pinnedKeys }` field on `CadreNodeConfig`, the
  `peerStore.get` `NotFoundError` name-check in `peerStoreAddrsFor`, and the
  `Connection.status === 'open'` / `direction === 'outbound'` accessors in
  `hasOutboundTo`.
- Run just this file (streaming output — never silent-redirect; the runner kills
  on a 10-minute idle):
  `yarn workspace @serfab/integration-tests test src/scenarios/control-cohort-three-node-isolation.integration.ts 2>&1 | tee /tmp/cohort3.log`
  Run it **at least twice** to shake out ordering flake. The full package suite
  is long; running the single file is the intended validation here, and the
  handoff should say so.
- `yarn lint` must pass.
- Add one line to `docs/cadre-consistency.md` (or the Control Network section of
  `docs/architecture.md`, whichever already describes the cohort reconcile)
  noting that the reconcile-as-sole-connector path now has an end-to-end proof,
  naming the scenario file.
- Hand off to `review/` with an honest note on: which assertions are ordering
  properties versus wire proofs, and whether the negative window in case 2 was
  stable across runs.

## Known risks in the draft (check these first if it fails)

- **Case 2 negative window may be defeated by a non-timer reconcile trigger.**
  `reconcileControlCohort` is also invoked eagerly at start and from the
  `self:peer:update` handler. B has no listen addresses so its own address record
  should not change mid-test, but if the negative window fails because B connects
  to C on its own, that is the cause to check — do **not** weaken the window;
  either the trigger is legitimate (then re-scope the case-2 claim and say so
  plainly) or it is a real product finding worth its own ticket.
- **C's self-published record must replicate back to A and on to B.** If step 6
  of `bootTrio` (B resolving C's record) times out, that is a real product
  finding. Do **not** work around it by having A write C's record with a
  test-held key — an owner-written row carries a null self-signature and
  `resolvePeerAddrs` rejects it, which would silently gut the test. File a
  `fix/` ticket instead.
- **Transient inbound deny on C.** If B dials C before B's membership row has
  replicated to C, C refuses the inbound and the connection dies moments after
  the dial resolves. The draft already polls rather than asserting on a dial's
  return value; if it still flakes, widen the poll, don't assert on a single
  pass.
- **B's address-less self row.** B listens on nothing. If anything in the run
  shows `registerSelf` throwing on B, or the control-database update rejecting an
  empty address column, that is a product bug worth its own ticket, not a test
  workaround. (The draft never drives `B.registerSelf()`, so this should not
  arise.)
- **peerStore emptiness is only assertable pre-dial.** After the dial, libp2p
  identify populates B's peerStore with C. Keep the emptiness assertions at the
  pre-dial checkpoints only.

## TODO

- Type-check the new scenario file and fix any compile errors.
- Run the file twice; fix ordering flake without weakening the isolation
  assertions.
- `yarn lint`.
- Add the one-line docs note.
- Write the `review/` handoff.
