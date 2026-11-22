description: A real-network test showing that a phone which uses a party's closed shared workspace without storing it keeps working after the party removes one of its other machines, which is the situation that used to lock the phone out for good.
prereq: client-publishes-its-strand-peer-row-marked-client
architecture: docs/strands/keys.md#replacing-the-partys-key
files: packages/integration-tests/src/scenarios/client-survives-party-key-replacement.integration.ts, packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts, packages/integration-tests/src/harness/strand-machine.ts, packages/integration-tests/src/harness/topology.ts, docs/contributing/topology-coverage.md
difficulty: medium
----

# Scenario: a client survives its party's key replacement

Last of three tickets for `client-locked-out-of-closed-strand-after-party-key-replacement`. The filed ticket named what would confirm the defect: one party of an owner server, a second server and a client, a closed strand on all three; remove the second server; the client's next read or write is refused and never recovers. After the two preceding tickets the same run must show the client bound under the new key and still writing. No unit layer reproduces this: the lockout is the revoked-peer gate on the serving machines refusing the client's streams after the old key leaves, which needs real nodes.

## Shape

A new scenario file, `client-survives-party-key-replacement.integration.ts`, rather than a third case in `machine-removal-rotates-party-key.integration.ts`. That scenario's two cases share a four-machine, two-party bring-up whose timing is already at its gates, and the client adds a machine to every case. Reuse its harness: `bootTopology` with `roles: { strandCohortMember: false }` on the client machine (as `strand-client-node-holds-no-blocks.integration.ts` does), `strand-machine.ts` for the strand handles and membership-row reads, and the removal scenario's helpers for the swap, the bindings and the cut (`awaitSwapOn`, `memberPeerBindings`, `binding`, `awaitCut`, `expectConnected`), moving any that are file-local into the harness.

One party, four machines, one closed strand founded by the owner, no second party, so the replacement runs every step on the owner (the old key is a manager and seats the new one itself):

- **A1**, the owner: founds the cadre and the closed strand, removes A3.
- **A2**, an always-on serving machine, online throughout.
- **A3**, a serving machine, the one removed.
- **A4**, a `device` with `strandCohortMember: false`, with the app, launched after the two serving machines so a coordinator is reachable from the start, and connected to A1 and A2 before the removal.

Membership reconciliation and the control cohort reconcile run on the harness's short intervals, as in the removal scenario.

## What is asserted, in order

1. Before the removal: A4's `StrandPeer` row is in A1's control database with role `'client'`, A2's and A3's rows have none, and A4 is bound under the party's current key. A4 writes a row the app schema holds and A2 converges on it.
2. `removeMachine(A3)` reports the strand `rotated`; the control row names a new key; the pending row is gone.
3. A4 is bound under the new key: `memberPeerBindings` on A2 includes `binding(newMemberKey, a4)`, and A4's own loop reports done under the new key once the swap reaches it (`runningPartyKey`, `membershipLoopDone` as the removal scenario reads them).
4. A4 still has an open connection to A1 or A2 after the old key's departure replicated to them, and A4 writes a second row that A2 converges on. This is the step that failed before: without the binding, the serving machines refuse A4's streams once the old key leaves.
5. A3 is cut: no connection from A1 or A2, and it fails to converge on the second row while A2's paired read succeeds (the removal scenario's two-direction cut claim).
6. Negative control on the queue: A2's `getUnreachedStrandMachines(strandId)` never names A4 (the serving machines run with offline mode on, as `strand-offline-waits-for-party-machine.integration.ts` configures it, or this step is dropped if that doubles the bring-up cost; say which in the handoff).

## Edge cases & interactions

- **A4's row must be in A1's control database before the removal**, or the run asserts the recovery path instead of the direct one. Gate step 1 on the row and the binding, with the convergence budget the removal scenario uses. The recovery path (a sibling binds the client when its row arrives late) is not asserted here; it is the existing sibling-binding mechanism and stays by inspection.
- **The client's own revoked-peer gate hears of the removal late** (`docs/cadre/node.md`: a client wakes that gate on the backstop). Nothing here depends on A4 refusing A3; only A1 and A2's refusal of A3 is asserted.
- **A4 is a `device`**, so it dials out and keeps its connections; the scenario hand-dials it to A1 and A2 as the client scenario does, so no claim rides on seed timing.
- **Wall clock.** Four machines and one replacement should sit near the removal scenario's online case. If the file runs past the agent-runnable budget (about ten minutes), trim step 6 first, then the second write's convergence on A3, and record what was cut.

## Coverage map

Add a row to `docs/contributing/topology-coverage.md` for the new file. While there, correct the row for `strand-client-node-holds-no-blocks.integration.ts`: its notes say "a closed strand", but the scenario launches an open-strand row (its own comment at the `openStrandRow` helper says so).

## TODO

- Write the scenario with the shape and assertions above; hoist shared helpers from the removal scenario into the harness rather than copying them.
- Run the new file in the foreground: `yarn workspace integration-tests test -- client-survives-party-key-replacement` (check the package's actual test script name first). Run `machine-removal-rotates-party-key.integration.ts` once if helpers moved.
- Coverage map row and the correction.
- `yarn lint`.
