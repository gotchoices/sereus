description: Review the new table in a party's own control database that remembers a join request it could not finish yet, with its outcome once known, so every machine of the party can see it and carry it on.
architecture: docs/strands.md#what-a-joiners-node-remembers
files: schemas/control.qsql (PendingJoin after JoinedStrand; Revocation TableName/RowKey comments and RowIsGone), packages/cadre-core/src/control-schema.ts (regenerated mirror), packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts (pendingJoinId, isPendingJoinConflict, PendingJoinChangedError, idConflictPattern, PENDING_JOIN_* helpers, queryPendingJoins/queryPendingJoin, insertPendingJoin, replacePendingJoin, deletePendingJoin, signPendingJoinInsert, REAPABLE_TABLES, GUARDED_KEY_COLUMN), packages/cadre-core/src/types.ts (PendingJoinRow, StrandMembershipInvite doc), packages/cadre-core/test/control-pending-join.spec.ts (new), packages/cadre-core/test/control-revocation-reap.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-revocation-ledger-marker.spec.ts, packages/cadre-core/test/control-schema-apply-unwind.spec.ts, packages/cadre-core/test/control-start-storage-op-budget.spec.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts, packages/integration-tests/src/scenarios/control-cross-machine-unique-column.integration.ts (comment only), docs/architecture.md (control table list), tickets/implement/5-pending-join-retry-loop.md (one edge-case bullet)
----
# Review: `CadreControl.PendingJoin` table and its `ControlDatabase` methods

Part of gotchoices/sereus#25. This adds the table and the database methods only; `pending-join-retry-loop` (already in `implement/`, deferred behind this) adds the `CadreNode` API and the loop. The template was commit `b32bad70` (`JoinedStrand`), and the file list matches it.

## What landed

**Schema** (`schemas/control.qsql`, mirrored byte-for-byte into `control-schema.ts` by regenerating the embedded string from the `.qsql` file). `PendingJoin` sits right after `JoinedStrand`. Columns are as the ticket specified. Constraints:

- `NotRevoked`, `RevocationRecorded`, `NoUpdate`: same shape as `JoinedStrand`'s.
- `KnownOutcome`: `Outcome` is null, `'joined'` or `'failed'`.
- `OutcomeShape`: pending carries no outcome columns. `'joined'` needs `OutcomeAt` and `StrandId` and no failure columns. `'failed'` needs `OutcomeAt` and `FailureCode` and no `StrandId` or `MembershipInvite`. `FailureReason` may be null on `'failed'`, and `MembershipInvite` may be null on `'joined'` (open strands).
- `AuthorizedInsert`: owner-signed over every column, ending with `StampId`. Nullable columns are signed as `''` via `coalesce`, and integers as `cast(... as text)`. There is no non-owner branch; the comment points at `blocked/decide-non-owner-machine-completes-a-pending-join`.
- `AuthorizedDelete`: an owner-signed `'remove'` over (`Id`, `StampId`), **or** the reap branch.
- `Revocation`: `'PendingJoin'` is added to the `TableName`/`RowKey` comments and gets a `RowIsGone` branch. `Revocation.Authorized` does not enumerate tables (checked), so it is unchanged.

**Types.** `'PendingJoin'` is added to `CONTROL_TABLES` (in schema order) and to `RevocableTable`. `PendingJoinRow` is new in `types.ts`. `Outcome` is typed `null | 'joined' | 'failed'` because `KnownOutcome` backs that cast. `FailureCode` is plain `string | null` because no CHECK backs a narrower type. `StrandMembershipInvite.invitePrivateKey`'s doc now says the joining side may copy it into its own `PendingJoin` row.

**`ControlDatabase`:**

- `pendingJoinId(token)` (exported) returns the crypto plugin's base64url sha256 `digest([token])`. It is only ever computed in TypeScript and never checked by SQL.
- `queryPendingJoins()` and `queryPendingJoin(id)` drop rows whose stamp is retired, in the way `queryCadrePeers` does.
- `insertPendingJoin(row, ownerKey, sign)` returns the row as written, including its fresh `StampId`, so the caller can replace it without re-reading.
- `isPendingJoinConflict(error)` text-matches `UNIQUE constraint failed: PendingJoin.Id`. It shares `idConflictPattern` with `isStrandIdConflict` (renamed from `strandIdConflictPattern`).
- `replacePendingJoin(expectedStampId, next, ownerKey, sign)` mints its signatures and the new stamp before taking the lock. Under the lock it reads the live stamp (`retry: false`) and throws `PendingJoinChangedError` (with `liveStampId`) when the stamp differs or the row is gone. It then deletes `where Id = ? and StampId = ?`, files the tombstone and inserts the successor, all in one `inTransaction`. After commit it fires `notifyGuardedDelete`, so a replace committed while alone has its tombstone re-issued.
- `deletePendingJoin(id, ...)` goes through `deleteGuardedRow` and returns `false` when the row is absent.
- `REAPABLE_TABLES` and `GUARDED_KEY_COLUMN` include `PendingJoin`. The reap sweep and the cohort re-issue sweep (`CadreNode.drainPendingRevocations`) are table-agnostic, confirmed by reading both.
- Logs print the id and outcome only. The engine's uniqueness and CHECK messages name columns, never values (checked in optimystic's `uniqueConstraintMessage`).

## Deviations from the ticket, and things to weigh

- **Retired-stamp filter.** The ticket says to filter retired stamps "the way `queryJoinedStrands` filters them", but `queryJoinedStrands` reads raw. I followed the explicit instruction to filter, using the `queryCadrePeers` pattern, so a dismissed join cannot come back through a replayed approval. The side effect is noted at `isPendingJoinConflict`: while a retired-but-not-yet-reaped row holds the id, an insert collides and the adopting re-read returns null until the next reap pass. Each query also costs one extra `Revocation` read.
- **Existing parties do not just "get the table on next start".** The ticket says they do. `docs/architecture.md` (just below the table list) records that editing a control-table constraint's text breaks a warm start on a store written by an earlier build, because the diff issues `DROP CONSTRAINT` and optimystic refuses it. This ticket edits `Revocation.RowIsGone`, so a party created before this change must be recreated. That is consistent with the no-backwards-compatibility policy, but I did **not** re-measure it; the doc's 2026-09-28 measurement is the evidence.
- **How nulls and integers are signed**, accepted as on `JoinedStrand` and `CadrePeer`:
  - `coalesce(x, '')` signs null and `''` identically, so a captured approval for `FailureReason = null` also admits `FailureReason = ''`.
  - Integers sign as `String(n)` against SQL `cast(n as text)`. The round trip is pinned by the first test (insert, then read back `toEqual` the returned row). A non-integer `RequestedAt` would fail as an opaque `AuthorizedInsert`; callers pass `Date.now()`.
- **Writing while alone.** A `PendingJoin` insert or replace committed with zero control connections is local-only. The tombstone half is queued for re-issue; the inserted row is not re-broadcast. This is the consumer's policy, so I added it as an edge-case bullet in `implement/5-pending-join-retry-loop.md` rather than solving it here.
- **Release note.** None added. `JoinedStrand` added none either, and the retry-loop ticket owns the user-facing note.

## Tests

New, `test/control-pending-join.spec.ts` (one node, five cases):

- An owner-signed row lands and reads back whole, through both queries. The same row signed by a machine key enrolled as a `CadrePeer` (via `insertCadrePeer`) is refused with `AuthorizedInsert`. This pins "no non-owner branch".
- A second insert of the same invitation is classified by `isPendingJoinConflict`. This pins the text match against the live engine error, which the next ticket's adopt path relies on.
- `OutcomeShape` refuses a `'joined'` row with no `StrandId` and a pending row carrying a `FailureCode`. Both inserts are correctly signed, so only the shape rule can refuse them.
- `replacePendingJoin` pending → joined: the new stamp differs, the new row is live, and the old stamp is in `queryRevokedStamps('PendingJoin')`.
- `replacePendingJoin` with a stale stamp throws `PendingJoinChangedError` with the live stamp, and leaves both the row and the revoked set unchanged.

Extended:

- `control-revocation-reap.spec.ts`, the "reaps every reapable table in one pass" case now includes a `PendingJoin` row (count 3 → 4). It is asserted with a **raw** select, because `queryPendingJoin` hides a retired stamp and would pass without a reap.
- `control-revocation-replay.spec.ts`: the `RowIsGone` live-stamp case now includes `PendingJoin`.
- `control-revocation-ledger-marker.spec.ts`: `REVOCABLE_TABLES` gains `'PendingJoin'`.
- `control-schema-apply-unwind.spec.ts`: eleven tables, and the `CadrePeer` failure is now "six tables in", since `PendingJoin` is created before `CadrePeer`.

Budget re-measurements (2026-10-01, optimystic `461a01bc`):

- `control-start-storage-op-budget.spec.ts`: cold 48/23 → **50 ops over 25 blocks** (two more `getMetadata` blocks, nothing else moved). Warm is unchanged at 13/3. The budget is now 60/29.
- `control-founding-consult-budget.spec.ts`: cold **31 consults over 23 blocks** (budget 35/26). This was 26/19 in the spec; `JoinedStrand` had silently used up the headroom (+3, to 29 of 30) without updating it, and `PendingJoin` adds +2 (table and stamp index, read by nothing at start). All other phases re-measured unchanged.
- Caveat for both: optimystic's working tree carried uncommitted dial-deadline edits at measurement time, stated in the consult spec's comment.

## Validation run

- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core typecheck`: 37 errors, none in this diff. 36 are the tracked libp2p 3.1 vs 3.3 identity mismatch (`.pre-existing-known.md`, `in-flight`). The 37th is `link-budget.spec.ts:75`, reported below.
- `yarn workspace @serfab/cadre-core test`: 146 of 148 files passed. The two failures:
  - The consult budget, fixed above.
  - `link-budget.spec.ts`: "gets a listener limit from Optimystic that outlasts cadre's relayed dial". This is caused by an **uncommitted** edit in `../optimystic`, now compiled into its dist, that renames `LinkDeadlines.connectionTimeoutMs`. It is reported in `tickets/.pre-existing-error.md` and not touched here.
- After the budget update, the 9 affected specs pass (84 tests).
- During the work the stale-build guard blocked every test run for about 5 minutes while optimystic was being edited. I waited for its own rebuild and did not build it.
- The integration suite was not run. The only integration change is a comment.
