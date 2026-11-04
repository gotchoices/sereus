description: Adds two bookkeeping tables to the cadre's shared control record: one remembers which network identity each machine uses inside each private workspace, the other holds a replacement workspace membership key while the cadre moves onto it. Nothing in the running node writes them yet; this is the schema and database layer for making machine removal replace the key.
architecture: docs/architecture.md#control-schema-versions-and-migrations
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/test/fixtures/control-schema/v4.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/control-store-migration.spec.ts, docs/architecture.md
----
# Control schema v4: `StrandPeer` and `PendingStrandPartyKey`

First of the tickets that make `removeMachine` replace the party's membership key in each closed strand (the maintainer's decision of 2026-11-03). This one is the schema and database layer only; no production code calls the new methods yet.

## What was built

- **`StrandPeer`**: each machine's own signed statement of its peer id in one strand, keyed `(StrandId, PeerId)`. Nobody else can compute that id, because it derives from the machine's private seed. Rows are never updated or deleted, so a removed machine's rows keep its orphaned strand bindings attributable to it.
- **`PendingStrandPartyKey`**: the key the party is moving to in one strand, written before the strand is touched. Guarded as `StrandPartyKey` is: owner-signed, a one-off stamp, a tombstone with every delete, no reap branch.
- **`ControlDatabase`**: `insertStrandPeer`, `queryStrandPeers`, `insertPendingStrandPartyKey`, `deletePendingStrandPartyKey`, `queryPendingStrandPartyKey`, `queryPendingStrandPartyKeyStampId`. `signPendingStrandPartyKeyInsert` is separate so the next ticket can run it inside `removeMachine`'s transaction; removals compose through the existing `signGuardedRemoval` and `execGuardedRemoval`.
- **`CONTROL_SCHEMA_VERSION`** 3 → 4, with the `v4.qsql` fixture. `CONTROL_SCHEMA_BASELINE_VERSION` stays 3. The v3 → v4 diff is five statements: two `create table` and the version tag (`additive`), plus `drop` and `add` of `Revocation.RowIsGone` (`catalog-only`).

## Decisions made during implementation

- `insertStrandPeer(row, sign)` takes a signer, because `ControlDatabase` holds no private key. It returns `true` when a row was written.
- `queryPendingStrandPartyKey` reads a retired stamp as absent, so a replaced key cannot read as the key to move to. `queryPendingStrandPartyKeyStampId` stays raw, as the other stamp readers do.
- `insertPendingStrandPartyKey` refuses a malformed superseded key, because the column is comma-joined and only well-formed base64url keeps that reversible.
- A start that migrates does not wait for siblings: the bring-up quiet period holds connections off, so the apply commits alone. The `NOTE:` in `applyControlSchema` records this and when to revisit it.

## Known gaps

- **Tables added by a version have no collection on existing parties**, so on a party founded before v4 a read of either new table may fail while the other machines are offline. Unmeasured on a real offline cohort. Evidence is on `backlog/feat-strand-tables-added-by-a-later-schema-get-their-collection`, and the consequence for the reconciler is on `strand-peer-rows-and-sibling-binding`.
- **A stale pending row blocks its strand on that node**: an insert collides on the primary key and a delete's tombstone collides on `Revocation`'s key. By reading, not run; no writer reaches it yet. Noted on `machine-removal-rotates-party-member-key`.
- **Two machines replicating these rows is not exercised here.** The next tickets write them, and `scenario-machine-removal-rotates-party-key` proves it across a network.

## Review findings

Reviewed the diff of `ticket(implement): control-schema-strand-peer-and-pending-party-key` before the handoff, then read the schema rules, the stamp readers, `deleteStrandAndPartyKey`, the guarded removal path and the two downstream tickets.

### Validation

- `yarn lint`: exit 0. `yarn workspace @serfab/cadre-core typecheck`: exit 0.
- `yarn workspace @serfab/cadre-core test`, after the changes below: 190 files, 2577 passed, 1 skipped (the existing Windows-only `it.skipIf` in `key-store.spec.ts`).
- **Integration scenarios were not re-run in review.** `control-schema-migration-mixed-releases`, `control-db-two-node-convergence` and `control-delete-while-alone-convergence` were refused twice by the stale-build guard, because `../quereus` has uncommitted source edits in `packages/quereus/src/schema/` (`schema-differ.ts`, a new `dependency-order.ts`; its last commit is `ticket(fix): bug-apply-schema-alters-tables-in-declaration-order`). Nothing was built there and the guard was not bypassed. The only evidence is the implement stage's report of 3 files and 4 tests passing, which this review did not observe. Review changed no production statement since that run: only a schema comment and tests.
- **Re-run needed after the next Quereus build.** That edit changes how a schema diff orders its alters, and this version's migration runs through that diff. The implementer's flagged edit, `bug-alter-check-validation-cannot-reference-mutation-context`, is in the same path. Re-run `control-store-migration.spec.ts`, `control-schema-versions.spec.ts` and the three scenarios above. `strand-peer-rows-and-sibling-binding` is the next ticket to reach them.

### Fixed in this pass (minor)

- `control-store-migration.spec.ts`: the baseline migration case now files a tombstone before migrating and checks it reads back afterwards. The case ran with an empty `Revocation`, which no real party has, so re-adding `RowIsGone` over stored rows was stated in the handoff but not run. It passes.
- `control-schema-apply-unwind.spec.ts`: a doc comment still said seventeen tables; now nineteen.
- `schemas/control.qsql`, `control-schema.ts`, `v4.qsql`: rewrapped one overlong header comment line in all three copies. A comment-only edit, which the versions spec's hash ignores, and v4 has not shipped.

### Major, added to open tickets (no new tickets)

Both are defects in plans not yet implemented, found by reading and not run, and each has a named site in a ticket already on the board.

- **A strand that leaves the party while its rotation is pending** leaves a private key in a row nothing removes or reaps, because `deleteStrandAndPartyKey`, `deleteJoinedStrand` and a strand move do not touch the pending row. Added to `machine-removal-rotates-party-member-key`.
- **A `StrandPeer` row naming another machine's strand peer id.** The signature proves who stated the id, not that it is theirs, and no check can. A machine that states a sibling's id before its removal puts that id in both the `live` and `removed` lists, so the reconciler clears on every pass the binding it writes. The plan's "adds no power" argument covers binding a bogus id, not clearing a live one. Added to `strand-peer-rows-and-sibling-binding`.

### Checked, nothing to change

- **Rules and digests:** the `PendingStrandPartyKey` rules match `StrandPartyKey`'s, with `Superseded` bound into the add digest. The signer and reader field order matches the SQL for both tables, and the specs drive that through the engine.
- **Not re-checking revocation in `StrandPeer.Authorized`:** a removed machine holding a stale `CadrePeer` row can still state a row. Accepted: `CadrePeer.AuthorizedUpdate`'s publish branch has no such check either, and the reader judges liveness. The one harm this leaves is the arm above.
- **Cost of the new `RowIsGone` branch for other tombstones:** Quereus short-circuits `and`/`or` whose right side has a subquery (`runtime/emit/binary.ts`), so a tombstone for another table does not read the new table, whose collection may be missing. By reading, not run.
- **The ALTER path:** Quereus validates only row-invariant CHECKs over stored rows, and `RowIsGone` is `on insert`. Read in `constraint-builder.ts`, and the strengthened migration case now runs it.
- **Real member keys pass the superseded check:** `strandMemberKeyPair` gives the base64url public key that `requireEd25519PublicKeyB64` accepts. By reading.
- **Reap and tombstone consumers:** `PendingStrandPartyKey` is outside `REAPABLE_TABLES`, and the runtime tombstone filters in `cadre-node.ts` and `reapRevokedRow`'s sweep name only `CadrePeer` and `DeviceToken`. A new table name is ignored there.
- **Mixed releases:** a v3 machine does not re-check replicated rows and its self-publish touches only `CadrePeer`. By reading the architecture section, not re-run (see Validation).
- **Docs:** `docs/architecture.md` matches the code for both tables, `Revocation`, the tombstone list, the reap exclusions and the missing-collection paragraph. `docs/strands.md` needs no change until the next ticket gives these tables behaviour, and that ticket lists it.
- **Tests kept:** all three in `control-database-strand-peer.spec.ts` and the migration case pin a named contract with real branching and no mocks. The re-pinned budgets carry their provenance. No test was cut. The budgets' numbers were not re-measured in review; they passed.
- **The 117 ms measurement in the `applyControlSchema` `NOTE:`** came from a since-deleted spec and was not reproduced. Its reasoning matches "Every machine migrates its own catalog" in `docs/architecture.md`.
- **Error handling and resource cleanup:** read failures propagate rather than reading as "no rows", and `verifyStrandPeerRow` logs and returns false. No new long-lived resource.

### Size

`control-database.ts` is 5791 lines (`wc -l`), about 210 more than before this ticket. No ticket filed: the additions follow the file's existing pattern, and nothing here makes a split harder.

### Tripwires and declined findings

No new tripwires from review. The implementer's `NOTE:`s stand: at `PendingStrandPartyKey` (no re-issue path for a row committed alone), `STRAND_TRANSPORT_KEY_DOMAIN` (a `.v2` makes every `StrandPeer` row stale), `readStrandPeerRows` (walks every strand's rows per call), `queryStrandPeers` (the missing collection) and `applyControlSchema`. No accepted-tradeoff `NOTE:` applied to any finding.
