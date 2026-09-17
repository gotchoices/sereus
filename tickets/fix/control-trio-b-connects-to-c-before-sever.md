description: In the three-machine test that checks data crosses a newly opened connection, machine B sometimes already has a connection to machine C before the test cuts B off, which the test forbids by design, so the run fails before measuring anything. We need to find out who opens that connection.
prereq: isolated-node-reads-unwritten-revocation-table-as-empty
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/harness/control-trio.ts, packages/cadre-core/src/cadre-node.ts
repro: verified
----

# B holds a connection to C before the sever in the control trio

`control-cohort-edge-carries-data.integration.ts` step 2 asserts, before severing B from A, that B has no connection to C:

```
AssertionError: expected [ Connection {} ] to have a length of +0 but got 1
 ❯ src/scenarios/control-cohort-edge-carries-data.integration.ts:217:38
    217|    expect(connectionsTo(B, cPeerId)).toHaveLength(0);
```

Observed 2026-09-16 in 2 of 5 runs from `packages/integration-tests` (`yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts`), failing at about 6.6 s. One run was under `DEBUG=sereus:cadre:node`, and one was with the Revocation read fix from `isolated-node-reads-unwritten-revocation-table-as-empty` applied locally. The other three runs got past this line: one hit the Revocation `cohort-unreachable` failure, two passed.

The whole scenario rests on this precondition. B listens on nothing, so only B can open a B↔C connection, and the test argues that only `B.reconcileControlCohort()` in step 6 does so. If something opens B→C during boot, the "R1 crossed the B↔C edge" ordering argument has nothing to stand on.

`bootControlTrio` (`harness/control-trio.ts` ~176-194) drains B's one start-time reconcile pass before C starts, and B's recurring reconcile runs every 10 minutes. The debug log of the failing run shows two B-side `reconcileControlCohort: pass complete (siblings=1, selected=1, dialed=0)` lines, both before C was created. Candidate openers, none confirmed:

- a reconcile triggered by `self:peer:update` (`cadre-node.ts` ~2364-2365), which the scenario's own step-4 `NOTE:` names as the first suspect. It fires independently of the 10-minute cadence.
- optimystic's transactor or FRET dialling C by peer id after B learned C's addresses through A (identify or peer exchange). The test asserts B's peerStore holds no address for C only after the sever.
- the membership gate or registerSelf path on B dialling a sibling after C's `CadrePeer` row replicates.

Find out which with connection-open logging on B (a `connection:open` listener recording the stack or the libp2p dial source), then fix the opener or the harness. Do not loosen the assertion: it is the precondition the scenario proves.
