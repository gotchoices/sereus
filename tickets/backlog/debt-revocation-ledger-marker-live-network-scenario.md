description: No test runs the new revocation-list marker on a real network of several machines, so nobody has seen an owner machine file it while connected, or confirmed that the other machines can still read the revocation list afterwards.
files: packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/src/cadre-node.ts (openRevocationLedgerIfDue, the connected-only step in runReconcileControlCohort), packages/cadre-core/src/control-database.ts (openRevocationLedger), tickets/blocked/block-held-by-only-one-machine-is-unreadable.md
tradeoffs: The integration suite is slow and the control-cohort scenarios are already intermittent, so one more multi-machine scenario adds run time and flake exposure for a write whose logic unit tests already cover.
----
# Prove the `Revocation` ledger marker on a real multi-machine network

## Background

`CadreControl.Revocation` (the party's list of retired row stamps) is read by every membership lookup and every guarded control-plane insert. On a party that has never revoked anyone the table was never written, so every read asked the other machines whether it existed. An owner machine now writes one permanent marker row, `('Revocation', 'ledger', 'opened')`, the first time its periodic reconcile pass runs while it holds a control connection (`CadreNode.openRevocationLedgerIfDue` → `ControlDatabase.openRevocationLedger`). After that the table exists and is re-checked on the storage layer's normal schedule.

## What is covered today

- Unit and single-node tests: the schema rules, the insert-if-absent logic, the "already filed" mapping, that no reader treats the marker as a retirement, when the reconcile pass files it (with a faked node and database), and the consult counts before and after, on a solo node.

## What is not covered

No integration scenario ever has an **owner** node run a reconcile pass while connected to another machine within the test's lifetime:

- `control-delete-while-alone-convergence`: each test finishes in about 1.5 s, before any reconcile pass runs (0 reconcile log lines under `DEBUG=sereus:*`, measured 2026-09-15).
- `control-cohort-three-node-isolation` (the `control-trio` harness): 22 reconcile log lines, all from the non-owner nodes B and C, which cannot sign. Owner A's only pass runs at start, before any connection, and its next is 15 s later (`DEFAULT_CONTROL_COHORT_RECONCILE_MS`), after the tests end. No `revocation ledger marker` line appeared (measured 2026-09-15).

## Why it matters

The marker's insert is what creates the `Revocation` collection on the network. `tickets/blocked/block-held-by-only-one-machine-is-unreadable.md` records that a collection's header block is written exactly once, at creation, and never re-broadcast, and that a block held by only one machine can be refused as unreadable by the others (`claimed-elsewhere`). If that happened to the marker's collection, other machines' reads of `Revocation` would go from "consult, find nothing, answer empty" to an error, on every membership lookup. This is inferred from the code and that ticket, not observed. The unit tests cannot see it, because it needs real replication.

The latency the marker saves on a multi-machine party was also never measured; the consult counts in `control-founding-consult-budget.spec.ts` are from a solo node.

## Expected behaviour to prove

- An owner node connected to a non-owner node runs a reconcile pass and files the marker (`'opened'`); a second pass does not file again.
- Afterwards the non-owner node's membership reads (`queryCadrePeers`, `queryRevokedStamps`) and a guarded insert succeed, with no `Revocation` read error.
- A third machine that joins afterwards also reads `Revocation` without error.
- Optionally, count consults on the non-owner node before and after, to record what the marker saves on a real network.
