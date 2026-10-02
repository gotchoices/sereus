description: Added a table to a party's own control database that remembers a join request it could not finish yet, with its outcome once known, so every machine of the party can see it and carry it on.
architecture: docs/strands.md#what-a-joiners-node-remembers
files: schemas/control.qsql (PendingJoin after JoinedStrand; Revocation comments and RowIsGone), packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts (pendingJoinId, isPendingJoinConflict, PendingJoinChangedError, query/insert/replace/delete PendingJoin, signGuardedRemoval, execGuardedRemoval), packages/cadre-core/src/types.ts (PendingJoinRow), packages/cadre-core/test/control-pending-join.spec.ts, docs/architecture.md
----
# `CadreControl.PendingJoin` table and its `ControlDatabase` methods

Part of gotchoices/sereus#25. Landed in `ticket(implement): pending-join-control-table`; reviewed here. `pending-join-retry-loop` (in `implement/`) adds the `CadreNode` API and the retry loop that use this table.

## What exists now

- **Table** `CadreControl.PendingJoin`, one row per invitation, keyed by `pendingJoinId(token)` (base64url sha256 of the invitation token), so the bearer token never reaches the `Revocation` ledger. Insert and delete only. Every insert is owner-signed over every column, and there is no branch for a machine that is not an owner (`blocked/decide-non-owner-machine-completes-a-pending-join`). `OutcomeShape` pins which columns each outcome (pending, `'joined'`, `'failed'`) carries. It has a reap branch, like `JoinedStrand`. `Revocation.RowIsGone` has a `PendingJoin` branch.
- **`ControlDatabase`**:
  - `queryPendingJoins` and `queryPendingJoin` drop rows whose stamp is retired.
  - `insertPendingJoin` returns the row as written. A repeat insert for the same invitation is classified by `isPendingJoinConflict`.
  - `replacePendingJoin(expectedStampId, next, ...)` is the only way an outcome is written. It deletes the row, files its tombstone and inserts the successor in one locked transaction, and throws `PendingJoinChangedError` when the live row is not the one the caller read.
  - `deletePendingJoin` removes a row and files its tombstone.
- **Existing parties must be recreated.** Adding the `RowIsGone` branch edits an existing constraint's text, which `docs/architecture.md` records as breaking a warm start on a store written by an earlier build. Under the no-backwards-compatibility policy, such a party is recreated, not migrated.

## Review findings

**Checked:** the full implement diff (schema, mirror, types, `ControlDatabase` methods, every spec change, docs); the `AuthorizedInsert` field order against `pendingJoinAddFields`; how `replacePendingJoin` behaves when a sibling machine's write lands concurrently; whether the reap and re-issue sweeps pick up the table (they do, via `RevocableTable`); every file that enumerates `JoinedStrand` alongside the other guarded tables, to find enumerations the change missed; that log lines print only ids and outcomes.

**Fixed in this pass:**

- *Duplicated code.* `replacePendingJoin` was a third hand-written copy of the "owner-signed delete plus its `Revocation` tombstone" statement pair, signatures included. The other two copies are in `deleteGuardedRow` and `deleteStrandAndPartyKey`, and a `NOTE:` on the latter said to generalize rather than copy a third time. I extracted the shared parts:
  - `signGuardedRemoval` (module function) mints both signatures.
  - `ControlDatabase.execGuardedRemoval` runs the delete and the tombstone insert inside the caller's transaction.
  - All three call sites now use both, and the drift `NOTE:` on `deleteStrandAndPartyKey` is replaced by a statement that the two bodies share them.
  - The shared delete now matches `StampId` as well as the key everywhere, not only in the replace. For the two existing callers this changes nothing: they read the stamp under the same lock, and a concurrent removal still fails on the tombstone's primary key.
- *Sync throw.* `replacePendingJoin` was a non-`async` function that could throw synchronously (`ensureInitialized`, `signMessage`) instead of rejecting. It is now `async`.
- *Docs.* `docs/architecture.md` → "The tombstone" did not list `deletePendingJoin` or `replacePendingJoin` among the guarded deletes, and → "The tombstone authorizes a local reap" did not list `PendingJoin` among the reap branches. Both now do.
- *Undocumented behaviour.* `replacePendingJoin`'s doc now says what a retry after an attempt that committed but reported failure does: it throws `PendingJoinChangedError` carrying the caller's own new stamp, so a caller that re-reads finds its write. The next ticket's caller relies on this.

**Considered and kept:**

- `KnownOutcome` is logically implied by `OutcomeShape`: any other `Outcome` value fails all three branches of the shape rule. I kept it because the ticket specified it and it gives a bad value its own constraint name. It is not worth a schema edit.
- Filtering retired stamps on reads (the implementer's documented deviation) is kept. It is the safer reading, and its side effect (an adopting re-read can come back empty until the next reap pass) is recorded in a `NOTE:` at `isPendingJoinConflict`.
- The signing of nulls (`coalesce(x, '')` signs null and `''` identically) and of integers as text matches `JoinedStrand` and `CadrePeer`, so no change.

**Tests:** the five new cases each pin a schema rule or a contract the next ticket relies on (authorization, the conflict text match against the live engine, `OutcomeShape`, replace success, stale-stamp refusal). None restates the implementation, so none was cut. I added none: the refactor is covered by the existing guarded-delete, strand-delete and replace specs, all of which pass.

**Tickets filed:** none. No major finding. The "writing while alone" gap (an inserted row is not re-broadcast) is consumer policy and was already added as an edge-case bullet in `implement/5-pending-join-retry-loop.md` by the implementer.

**Tripwires:** none new.

**Docs not changed, with reason:** `docs/strands.md#what-a-joiners-node-remembers` does not mention the table yet. Nothing reads or writes it outside `ControlDatabase`, and the plan assigns the behaviour docs to `pending-join-retry-loop`.

**Validation:**

- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core typecheck`: 36 errors, all the tracked libp2p identity mismatch (`.pre-existing-known.md`, `in-flight`), none in the changed files.
- `yarn workspace @serfab/cadre-core test`: 148 of 148 files passed (2355 tests, 1 skipped). That includes `link-budget.spec.ts`, which failed at implement time and has since been triaged.
- The integration suite was not run. The only integration change is a comment.
