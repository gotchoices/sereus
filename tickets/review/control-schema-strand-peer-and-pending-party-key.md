description: Adds two bookkeeping tables to the cadre's shared control record: one remembers which network identity each machine uses inside each private workspace, the other holds a replacement workspace membership key while the cadre moves onto it. Nothing in the running node writes them yet; this is the schema and database layer for making machine removal replace the key.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/test/fixtures/control-schema/v4.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/control-store-migration.spec.ts, docs/architecture.md
----
# Control schema v4: `StrandPeer` and `PendingStrandPartyKey`

First of the tickets that make `removeMachine` replace the party's membership key in each closed strand (the maintainer's decision of 2026-11-03). This one is the schema and database layer only; no production code calls the new methods yet.

## What was built

- **`StrandPeer`**: each machine's own signed statement of its peer id in one strand, keyed `(StrandId, PeerId)`. Nobody else can compute that id, because it derives from the machine's private seed. Rows are never updated or deleted, so a removed machine's rows keep its orphaned strand bindings attributable to it.
- **`PendingStrandPartyKey`**: the key the party is moving to in one strand, written before the strand is touched. Guarded exactly as `StrandPartyKey` is: owner-signed, a one-off stamp, a tombstone with every delete, no reap branch.
- **`ControlDatabase`**: `insertStrandPeer`, `queryStrandPeers`, `insertPendingStrandPartyKey`, `deletePendingStrandPartyKey`, `queryPendingStrandPartyKey`, `queryPendingStrandPartyKeyStampId`. `signPendingStrandPartyKeyInsert` is separate so the next ticket can run it inside `removeMachine`'s transaction; removals compose through the existing `signGuardedRemoval` and `execGuardedRemoval`.
- **`CONTROL_SCHEMA_VERSION`** 3 → 4, with the `v4.qsql` fixture. `CONTROL_SCHEMA_BASELINE_VERSION` stays 3.

## Where this differs from the plan

Please judge these rather than assume them.

- **`insertStrandPeer(row, sign)` takes a signer**, where the plan had `insertStrandPeer(row)`. `ControlDatabase` holds no private key, and `updateSelfPeerRecord` takes a callback for the same reason. It also returns a boolean (`true` when written), as `insertCadrePeer` does.
- **v3 → v4 is five statements, not two `create table`s.** Printed from the two fixtures: two `create table` and the version tag (`additive`), plus `drop` and `add` of `Revocation.RowIsGone` (`catalog-only`), whose body gained the new branch. The versions spec accepts this. The re-added CHECK does not scan stored rows: it is `on insert`, so Quereus's `isRowInvariantCheck` excludes it, confirmed by reading that code.
- **The "digest builders beside the `StrandPartyKey` ones" had nowhere to go**, because `StrandPartyKey` has none; its digest is inline. Added `strandPeerRowFields` and `pendingStrandPartyKeyRowFields` on the `cadreInviteRowFields` idiom, plus `strandPeerAddDigest` and `verifyStrandPeerRow` in `peer-authorization.ts`.
- **`queryPendingStrandPartyKey` reads a retired stamp as absent**, which the plan did not ask for. Otherwise a replaced key, possibly one a removed machine holds, could read as the key to move to on a node holding the stale row or a replayed approval. `queryPendingStrandPartyKeyStampId` stays raw, as the other stamp readers do.
- **`insertPendingStrandPartyKey` refuses a malformed superseded key**, because the column is comma-joined and only well-formed base64url keeps that reversible.
- **The `NOTE:` in `applyControlSchema` asked the first migrating version to decide whether a start waits. Decided: it does not.** Measured with a throwaway spec, since deleted: a real `CadreNode` on a v3 store with one sibling at an unrouted address migrated to v4 in a 117 ms start. The bring-up quiet period holds connections off, so the apply commits alone. The `NOTE:` now says this and when to revisit. No permanent test pins the offline case.

## Known gaps

- **Tables added by a version have no collection on existing parties**, so on a party founded before v4 a read of either new table may fail while the other machines are offline. I did not reproduce a failure: on my single node with a phantom sibling both reads returned empty in about 1 ms, so a real offline cohort is unmeasured. Evidence appended to `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`, and the reconciler consequence noted on `strand-peer-rows-and-sibling-binding`.
- **A stale pending row blocks its strand on that node.** If a node holds a physical pending row whose stamp is retired, the reader says no rotation is pending, an insert collides on the primary key, and a delete's tombstone collides on `Revocation`'s key. By reading, not run; no writer reaches it yet. Noted on `machine-removal-rotates-party-member-key`, whose replace path can.
- **The full integration suite was not run**, only the three scenarios below.
- **Not exercised here:** two machines replicating these rows. The next tickets write them, and `scenario-machine-removal-rotates-party-key` proves it across a network.

## Tests

- `control-database-strand-peer.spec.ts`
  - `StrandPeer` needs the named machine's signature against its `CadrePeer` row: refused when that row is absent and when another key signs; reads back when correct; a repeat is a no-op that signs nothing.
  - A row signed by a key other than the one behind its peer id does not read back. The plan left this to inspection. Added because it is the reader's only defence, and it can be driven through the engine since an owner may store any `PublicKey`.
  - `PendingStrandPartyKey` inserts under an owner and round-trips `Superseded`; a tombstoned delete reads as absent; replaying the first approval is refused by `NotRevoked`.
- `control-store-migration.spec.ts`, one new case: the real baseline fixture migrates to this build over the optimystic module, and a table added since runs its guarded delete through the changed `RowIsGone`. The plan did not list this. Added because the versions spec classifies these statements on in-memory tables and never runs them, and the existing migration case uses synthetic releases.
- Re-pinned with provenance, no new behaviour: `control-founding-consult-budget.spec.ts` (cold 44 consults over 36 blocks; genesis 26 over 25, 36 commits), `control-start-storage-op-budget.spec.ts` (cold 63 ops over 38 blocks, warm unchanged at 13), and the table list in `control-schema-apply-unwind.spec.ts`. Measured at optimystic `fe7069f0`, whose tree carried one uncommitted file.
- `createControlNode` in `control-db-node-helpers.ts` gained an optional identity key.

## Validation run

- `yarn lint` and `yarn workspace @serfab/cadre-core typecheck`: exit 0. `check:test-file-typecheck-coverage` and `check:vitest-typecheck-coverage`: pass.
- `yarn workspace @serfab/cadre-core test`: 190 files, 2577 passed, 1 skipped (the existing Windows-only `it.skipIf` in `key-store.spec.ts`).
- Integration, after building `cadre-core`: `control-schema-migration-mixed-releases`, `control-db-two-node-convergence`, `control-delete-while-alone-convergence`: 3 files, 4 tests passed.
- The first full-suite attempt stopped on the stale-build guard because another agent was editing `../quereus`. I built nothing there; the guard cleared on its own and the numbers above are from the later run. That edit (`bug-alter-check-validation-cannot-reference-mutation-context`) touches the ALTER-path CHECK validation, which `RowIsGone`'s re-add goes through, so a later Quereus build deserves one re-run of the migration specs.

## Tripwires parked

`NOTE:` at `PendingStrandPartyKey` (no re-issue path for a row committed alone), at `STRAND_TRANSPORT_KEY_DOMAIN` (a `.v2` makes every `StrandPeer` row stale), at `readStrandPeerRows` (walks every strand's rows per call), at `queryStrandPeers` (the missing collection), and the rewritten one in `applyControlSchema`.
