description: Once an owner machine is connected to another machine, it now writes one permanent marker row into the party's revocation list, so that list stops being "never written" and machines stop asking each other about it on every membership lookup and every control-plane write.
prereq: control-plane-consult-budget-gate
files:
  - packages/cadre-core/src/control-schema.ts, schemas/control.qsql (`Revocation`: `RowIsGone` marker branch, table/column/`Authorized` comments)
  - packages/cadre-core/src/control-database.ts (`REVOCATION_LEDGER_MARKER`, `isRevocationLedgerConflict` + shared `errorChainMatches`, `openRevocationLedger`, private `revocationLedgerFiled`, `queryRevocations` skips the marker, cost NOTEs on `queryCadrePeers` / `queryRevokedStamps` / `reapRevokedRows`)
  - packages/cadre-core/src/seed-bootstrap.ts (`openRevocationLedger()` wrapper)
  - packages/cadre-core/src/types.ts (`RevocationLedgerOpenResult`; `RevocationRow` doc)
  - packages/cadre-core/src/cadre-node.ts (`revocationLedgerOpened` flag, cleared in `stop()`; `openRevocationLedgerIfDue`; the step inside `runReconcileControlCohort`'s connected-only gate, with its accepted-tradeoff NOTE)
  - packages/cadre-core/src/strand-membership-writer.ts (tripwire NOTE on `strandHasManagerRevocation`)
  - packages/cadre-core/test/control-revocation-ledger-marker.spec.ts, cadre-node-control-cohort.spec.ts, control-founding-consult-budget.spec.ts
  - eslint.config.mjs (raw-`CadrePeer`-SQL exemption for the new spec)
  - docs/architecture.md (the `Revocation` row), docs/testing.md (consult-budget entry)
----
# The `Revocation` ledger marker

## What was built

`CadreControl.Revocation` is read before almost every membership question and inside every guarded control-plane insert. On a party that has never revoked anyone the table was never written, and Optimystic consults a block's cohort on every read of a block the node does not hold. On a multi-machine party each consult is a round trip to every other member.

An owner now files one row that retires nothing: `('Revocation', 'ledger', 'opened')`, `ReissuedAt = 0`.

- **Schema.** `RowIsGone` admits that exact triple and nothing else under `TableName = 'Revocation'`; with the primary key `(TableName, StampId)` it is a singleton. It is owner-signed under the unchanged `Authorized` rule. Both schema copies were edited identically.
- **Readers.** Every schema reader of `Revocation` filters on its own guarded `TableName`, and `queryRevocations()` skips the marker, so neither the reap sweep nor the growth re-issue sweep sees it.
- **`ControlDatabase.openRevocationLedger`.** Returns `'opened' | 'already-open'`. The signature is minted outside the write lock. An in-lock scan guard runs first, and a primary-key refusal maps to `'already-open'`.
- **`CadreNode`.** Inside the reconcile pass's connected-only gate, after the reap, an owner-capable node files the marker once per process. The flag is set on either outcome, and a failure is logged and retried next pass.

Measured on a solo node (pinned in `control-founding-consult-budget.spec.ts`): after the marker, `queryRevokedStamps` costs 1 consult on its first call and then 0; `queryCadrePeers` 0; `authorizePeer` 0 (was 5); an idle reconcile pass 0 (was 8). Filing the marker itself cost 4 consults and 2 commits. The solo founding budgets did not move.

## Review findings

**Method.** I read the implement diff (a54e991) before the handoff and compared it against the planned implement ticket. The build matches the plan. Its one deviation is documented: the first read after the marker pays 1 consult, on the tree block the marker's own commit created.

**Correctness / schema — checked, no defect.**

- I re-read all 17 schema sites that read `Revocation`: `NotRevoked` ×6, `RevocationRecorded` ×6, the `committed.Revocation` reap branches ×3, and the `Strand` consent branch (`control-schema.ts:282`, `R.TableName = 'Strand' and R.RowKey = new.Id`). Every one filters on its own guarded `TableName`.
- `FreshTombstone` passes the marker, because `ReissuedAt` defaults to 0.
- `ReissueOnly` / `AuthorizedReissue` would let an owner bump the marker's counter. That is harmless, and nothing does it (`queryRevocations` skips the marker).
- No package outside cadre-core reads `CadreControl.Revocation`, checked by grep. The strand schema's own `Revocation` table is untouched.
- The `'opened'` literal cannot collide with a 43-character stamp, and the primary key includes `TableName` anyway.

**Security — checked, no defect.** A captured marker signature can only re-file the identical row, whose key is already taken. The `'CadreControl.Revocation'` domain tag keeps it disjoint from other rules. Non-owners are refused by `Authorized`, which is tested.

**Error handling — checked, no defect.**

- The conflict classifier is text-matched and fails closed. The live engine wording is pinned by a test, and non-conflict refusals propagate (tested).
- `lockedWithRetry` retries only transient cluster failures. Because the signature is minted outside the lock, a retried attempt re-presents it, and a retry after a commit that reported failure hits the guard and answers `'already-open'`.
- The reconcile step logs failures and never aborts the pass (tested).

**Type safety — checked, no defect.** `RevocationRow.tableName` stays a `RevocableTable` because the marker is skipped before the cast. The outcome is a closed string union.

**DRY / modularity — one minor fix.** Extracting `errorChainMatches` shared the cause-chain matching with `isStrandIdConflict`, which is good. **Fixed:** `revocationLedgerFiled(retry)` was only ever called with `false`. I dropped the parameter, and the method now passes `false` itself, with the reason in its doc comment. The spec's spy was updated to match.

**Performance — checked.** The solo numbers are pinned before and after by the budget spec, which passed in the full run. The multi-machine saving was not measured; it is part of the backlog ticket below.

**Resource cleanup — checked, no defect.** No new timers, listeners or handles. The process flag is cleared in `stop()` alongside the other per-process replication flags.

**Tests.**

- **Added:** `SeedBootstrapService.openRevocationLedger()` on a keyless (seed-listener) service throws `Owner private key required…` and writes nothing. This was untested in the handoff.
- **Declined:** a test for `stop()` clearing `revocationLedgerOpened`. It is one assignment in the same reset block as `reissuedHeldRevocations`, `reconstructedLocalOnlyWrites` and the rest, none of which has its own stop-reset test. A test that sets a private field, calls stop and reads it back would add little over reading the reset block.
- **Gap, filed as a ticket:** no real-network run of the connected owner filing. I ran two integration scenarios against a rebuilt cadre-core. `control-delete-while-alone-convergence` passed 2/2, but no reconcile pass ran inside its ~1.5 s tests. `control-cohort-three-node-isolation` passed 2/2 with 22 reconcile passes, all on the non-owner nodes; owner A's connected pass (every 15 s) never fell inside the tests. So the marker was never filed live.
- The concurrent-owner last-writer-wins case is still argued rather than tested (byte-identical rows), as the handoff says. No ticket: the outcome is identical rows either way, and the upstream behaviour is already tracked in `tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md`.

**Docs.**

- `docs/architecture.md`'s `Revocation` row: read, and it reflects the marker.
- **Updated** `docs/testing.md`'s consult-budget entry to mention the second, before/after-marker test.
- The "Delete-while-alone durability" bullet describes the reap but not the marker. I left it, because the table row is the canonical home and the bullet is about delete durability.

**Accuracy fix to this ticket's own NOTE.** The accepted-tradeoff NOTE at the marker step said a solo founder never files "until its first sibling connects". The gate is `getControlConnectionCount() > 0`, which also counts a relay or bootstrap connection, so a relay-connected solo founder does file. I reworded the NOTE to say so. The decision itself is unchanged: that residual is the reap's existing one, already documented on `getControlConnectionCount` as a lower-bound proxy.

**Source hygiene / size.**

- `cadre-node.ts` is 6,895 lines (`wc -l`, 2026-09-15). Already tracked by backlog `debt-cadre-node-single-file-size`, whose description still said 4,770; I appended the current measurement there.
- `control-database.ts` is 2,937 lines, with no size ticket of its own; the size ticket above already notes it. This change added small single-purpose members (a constant, a classifier, one public method, one private guard). I did not file a ticket: nothing here makes the file harder to split than before.
- Comments are long but specific, and match the density of the surrounding file.

**Tripwires.** The implementer's `Strand.Revocation` NOTE on `strandHasManagerRevocation` is present and accurate. I added no new tripwires.

**Tickets filed.** `backlog/debt-revocation-ledger-marker-live-network-scenario`: prove on a real multi-machine network that a connected owner files the marker, and that other machines still read `Revocation` without error afterwards. The risk to rule out is the header-block single-holder problem recorded in `tickets/blocked/block-held-by-only-one-machine-is-unreadable.md`, which is inferred from code, not observed.

**Validation run (2026-09-15).**

- `yarn workspace @serfab/cadre-core typecheck`: exit 0.
- Root `yarn lint`: exit 0.
- `packages/cadre-core` full suite: 127 files, 2083 passed, 1 skipped.
- Targeted marker spec: 15/15.
- Integration: `control-delete-while-alone-convergence` 2/2 and `control-cohort-three-node-isolation` 2/2, after `yarn workspace @serfab/cadre-core build`.
- Logs are in `tickets/.logs/revocation-ledger-marker-review.*.log`.
- No pre-existing failures surfaced.
