description: Once an owner machine is connected to another machine, it now writes one permanent marker row into the party's revocation list, so that list stops being "never written" and machines stop asking each other about it on every membership lookup and every control-plane write.
prereq: control-plane-consult-budget-gate
files:
  - packages/cadre-core/src/control-schema.ts, schemas/control.qsql (`Revocation`: `RowIsGone` marker branch, table/column/`Authorized` comments)
  - packages/cadre-core/src/control-database.ts (`REVOCATION_LEDGER_MARKER`, `isRevocationLedgerConflict` + shared `errorChainMatches`, `openRevocationLedger`, private `revocationLedgerFiled`, `queryRevocations` skips the marker, rewritten cost NOTEs on `queryCadrePeers` / `queryRevokedStamps` / `reapRevokedRows`)
  - packages/cadre-core/src/seed-bootstrap.ts (`openRevocationLedger()` wrapper)
  - packages/cadre-core/src/types.ts (`RevocationLedgerOpenResult`; `RevocationRow` doc)
  - packages/cadre-core/src/cadre-node.ts (`revocationLedgerOpened` flag, cleared in `stop()`; `openRevocationLedgerIfDue`; the step inside `runReconcileControlCohort`'s connected-only gate, with its accepted-tradeoff NOTE; updated NOTE on the pass's `CadrePeer` reads)
  - packages/cadre-core/src/strand-membership-writer.ts (tripwire NOTE on `strandHasManagerRevocation`)
  - packages/cadre-core/test/control-revocation-ledger-marker.spec.ts (new)
  - packages/cadre-core/test/cadre-node-control-cohort.spec.ts (new describe: revocation ledger marker)
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts (second test: before/after the marker; `soloNode()` extracted)
  - eslint.config.mjs (the new spec added to the raw-`CadrePeer`-SQL exemption list)
  - docs/architecture.md (the `Revocation` row of the control-table list)
----
# Review: the `Revocation` ledger marker

## What was built

`CadreControl.Revocation` is read before almost every membership question and inside every guarded control-plane insert. On a party that has never revoked anyone the table was never written, so its block is missing on every node, and Optimystic consults the block's cohort on every read of a missing block. On a multi-machine party each consult is a round trip to every other member.

The fix writes one row that retires nothing: `('Revocation', 'ledger', 'opened')`, `ReissuedAt = 0`.

- **Schema.** `RowIsGone` gains `or (new.TableName = 'Revocation' and new.RowKey = 'ledger' and new.StampId = 'opened')`. The whole triple is pinned, so with the primary key `(TableName, StampId)` it is a singleton. `Authorized`, `NoDelete`, `FreshTombstone`, `ReissueOnly` and `AuthorizedReissue` are unchanged; the marker is owner-signed over `digest('CadreControl.Revocation', 'remove', 'Revocation', 'ledger', 'opened')`. Both schema copies were edited identically.
- **Why it can never read as a retirement.** Every schema reader of `Revocation` filters on its own guarded `TableName`. That was re-checked during implementation: all six `NotRevoked` and `RevocationRecorded` checks, the three `committed.Revocation` reap branches, and the `Strand` consent branch (`R.TableName = 'Strand' and R.RowKey = new.Id`). `'Revocation'` is not a `RevocableTable`, and `queryRevocations()` skips the marker, so neither the reap sweep nor the growth re-issue sweep sees it.
- **`ControlDatabase.openRevocationLedger(ownerKey, signMessage)`** returns `'opened' | 'already-open'`. The signature is minted outside the lock. Inside `lockedWithRetry`, a guard scans `select StampId … where TableName = ?` with `retry: false` and compares in TypeScript, then inserts. A `UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` refusal maps to `'already-open'` (text-matched through the cause chain, like `isStrandIdConflict`); every other failure propagates.
- **`CadreNode`.** Inside the same `getControlConnectionCount() > 0` gate as the reap, after it: `openRevocationLedgerIfDue()` files the marker when `seedBootstrapService?.canAuthorize()` and the process flag is clear. It sets the flag on either outcome, and logs and leaves the flag clear on failure. The accepted-tradeoff NOTE at the call site records that a solo founder keeps paying one local `findCluster` per missing-block read until its first sibling connects. The flag is also cleared in `stop()`, so a restarted node re-checks its database (one extra guard scan per process).

## Measured effect (solo node, 2026-09-15, pinned in `control-founding-consult-budget.spec.ts`)

| path | before the marker (`CadrePeer` held, `Revocation` missing) | after |
|---|---|---|
| `queryRevokedStamps('CadrePeer')` per call ×6 | 2 each | **1, 0, 0, 0, 0, 0** |
| `queryCadrePeers()` per call ×6 | 2 each | 0 each |
| `authorizePeer` (a guarded insert) | 5 | 0 |
| idle `reconcileControlCohort` (3 address-less siblings) | 8, all on `Revocation` | 0 |
| filing the marker itself | — | 4 consults, 2 commits |

Two back-to-back runs gave identical counts. **One deviation from the plan:** the first read after the marker costs 1 consult, on the tree block the marker's own commit created, paid by whichever read runs first; the plan predicted 0 from the first call. The steady state is 0. `foundStrand`'s control figures already count a consult of the same kind on the tree block its commit creates.

The solo founding budgets (cold 30, genesis 14, founding 25+25, per-call 2 and 4, idle reconcile 8) did **not** move, as predicted, because a solo node never takes the connected-only step.

## How to validate

- `cd packages/cadre-core && yarn vitest run control-revocation-ledger-marker cadre-node-control-cohort control-founding-consult-budget control-revocation control-schema-drift`
- For the numbers: `yarn vitest run control-founding-consult-budget --reporter=verbose` and read the `[consult-budget] before the marker` / `after the marker` lines.

Use cases each test covers:

- **Filing:** opened then already-open, exactly one row at counter 0. The live engine refuses a second marker row with the exact `UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` wording the classifier matches. A primary-key refusal after a blinded guard answers `'already-open'`. A non-owner signer's `Authorized` refusal still propagates. The `SeedBootstrapService` wrapper signs with the configured owner key.
- **Schema refusals:** unsigned marker and a stranger's signature (`Authorized`, single rejector). `TableName = 'Revocation'` with the wrong `RowKey`, the wrong `StampId`, or both, each validly owner-signed (`RowIsGone`, single rejector). Deleting the marker, owner-signed (`NoDelete`).
- **Not a retirement:** a `CadrePeer` row and a `ValidationKey` row whose `StampId` is literally `'opened'` pass `NotRevoked` and read as live. `queryRevokedStamps(t)` never contains `'opened'` for all six revocable tables. `queryRevocations()` returns `[]` with only the marker, and returns a real tombstone next to it. `reapRevokedRows` returns 0 without a per-row reap attempt. The first-growth re-issue sweep (`drainPendingRevocations`, driven through a cast) calls `reissueRevocations` zero times, still marks the sweep done, and leaves the marker at counter 0.
- **Scheduling** (cohort spec, faked control node and database): files once on a connected owner node and never again. Not while alone. Not on a node that cannot sign. `'already-open'` also ends attempts. A thrown filing does not abort the pass (reap and dial still run), and the next connected pass retries. It also files when the pass takes the no-siblings early return.

## Validation run

- Full `packages/cadre-core` suite: 127 files, 2082 passed, 1 skipped (log: `tickets/.logs/revocation-ledger-marker.test.log`).
- `yarn workspace @serfab/cadre-core typecheck` (covers `test/`): exit 0. Root `yarn lint`: exit 0.
- The stale-build guard initially refused to run because `../optimystic`'s `@optimystic/db-p2p` source was newer than its build. That tree was clean (only committed changes), so I rebuilt it with `yarn workspace @optimystic/db-p2p build`. Nothing was changed there.

## Known gaps — treat these as the reviewer's starting points

- **No multi-machine proof.** The connected-only filing, a drone acquiring the owner's marker by reading, and two owners racing are all covered by unit tests or by faking, never on a real network. The latency saved on a real multi-machine party was **not measured**; the consult counts above are solo.
- **Concurrent owners are modelled**, by spying on the private guard `revocationLedgerFiled` to return false once. The last-writer-wins case (`tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`) is argued harmless (byte-identical rows), not tested.
- **Untested:** the `stop()` reset of `revocationLedgerOpened`, and `SeedBootstrapService.openRevocationLedger()` on a keyless service. It uses the same `requireOwnerPublicKey()` precondition as the sibling wrappers, whose keyless behaviour is tested elsewhere.
- **`NotRevoked` stamp-twin coverage** is `CadrePeer` and `ValidationKey` only; the other four guarded tables rely on the schema review above plus the six-table `queryRevokedStamps` loop.
- **The connected gate** counts any control-node connection, including a non-member relay or bootstrap peer. That is the reap's existing residual, not new; a marker filed while connected only to a relay is still local-only to the party.
- **Ordering choice:** the marker step runs after the reap in the gate, for readability. On the first connected pass, the reap's `queryRevocations` scan therefore still pays the missing-block consults once. Moving it first would save that one scan's consults; correctness is the same either way.
- **Lint exemption:** the new spec was added to `eslint.config.mjs`'s raw-`CadrePeer`-SQL exemption list, because `insertCadrePeer` mints its own stamp and cannot plant the `'opened'` twin. That turns `no-restricted-syntax` off for the whole file, like the reap spec.
- **Tripwire parked (not a ticket):** `Strand.Revocation` has the same missing-block cost on a strand that has never revoked anyone. Recorded as a `NOTE:` on `strandHasManagerRevocation`; not measured.
