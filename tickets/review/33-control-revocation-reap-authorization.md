----
description: Review the new schema rule that lets a machine delete a member record it can already prove was revoked (a committed tombstone authorizes the delete), plus the single-row delete method that uses it. Nothing calls it automatically yet.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-revocation-reap.spec.ts, eslint.config.mjs, docs/architecture.md
----

# Reap authorization: implement handoff

## What landed

**Schema (both copies — `schemas/control.qsql` and `CONTROL_SCHEMA` in
`packages/cadre-core/src/control-schema.ts`, drift guard green):**

- `CadrePeer.AuthorizedDelete` gained a REAP branch with the full rationale comment:
  `or exists (select 1 from committed.Revocation R where R.TableName = 'CadrePeer' and
  R.RowKey = old.PeerId and R.StampId = old.StampId)`. An already-committed tombstone
  naming this exact row incarnation authorizes the delete — no owner signature needed.
- `DeviceToken.AuthorizedDelete` and `ValidationKey.AuthorizedDelete` gained the same
  branch with a short cross-reference comment (house style), keyed on their own
  TableName / key column.
- `Strand.AuthorizedDelete` gained a comment recording the branch is **deliberately
  absent** (row carries `MemberPrivateKey`; `tickets/backlog/debt-strand-tombstone-reap.md`
  owns any future change). No behavioral change to Strand.

**Database (`control-database.ts`):**

- `REAPABLE_TABLES` / `ReapableTable` (`CadrePeer` | `DeviceToken` | `ValidationKey`),
  exported from `packages/cadre-core/src/index.ts`.
- `ControlDatabase.reapRevokedRow(table, rowKey, stampId): Promise<boolean>` — guard read
  via the raw `queryStampId` (row absent → `false`; live stamp ≠ `stampId` → `false`, no
  write), then ONE unsigned delete with `where <key> = ? and StampId = ?` and a PRESENT
  `with context OwnerKey = null, Signature = null` clause. `CadrePeer` routes through
  `mutateCadrePeer('peer-reap', …)` (invariant intact, notify is a documented redundant
  refresh); the other two through `execWrite`. Logs each reap. Writes nothing to
  `Revocation`.
- Nothing calls it automatically — the sweep is `control-revocation-reap-sweep` (not yet
  on the board).

**Other:** `eslint.config.mjs` exemption list gained the new spec (it drives raw
`CadreControl.CadrePeer` SQL as a constraint fixture, like the replay spec).
`docs/architecture.md` updated at the `Revocation` table row and the delete-while-alone
residuals paragraph.

## Validation performed (all on this machine, real engine)

- `npx vitest run test/control-revocation-reap.spec.ts` — **9/9 green** (new spec).
- Ticket's validation bundle (reap + schema-drift + revocation-replay +
  authorization-binding): **77 passed, 1 failed** — the failure is
  `control-revocation-replay.spec.ts > "a tombstone is permanent …"` with
  `context.OwnerKey isn't a column`, byte-for-byte the **known pre-existing** entry in
  `tickets/.pre-existing-known.md` (owned by `10-control-revocation-reissue-test-fixes`,
  blocked on `10-revocation-reissue-same-pk-update-unique-collision`). Not re-triaged,
  not touched. Nothing in this ticket updates `Revocation`.
- Blast radius (`control-membership-hub`, `device-token-registry`,
  `validation-key-enrollment`, `strand-unpublish`): **46/46 green**.
- `yarn workspace @serfab/cadre-core build` and root `yarn lint`: clean.
- Caveat: the sibling `../quereus` workspace was under **live human edit** during
  validation (planner files changing minutes apart); the stale-build guard tripped once
  mid-session and cleared after that workspace rebuilt. All results above are from runs
  where the guard passed.

## Test coverage map (what the reviewer can lean on)

Negatives, **real schema** (all constructible by local writes):

- Reap of a live never-revoked row → thrown constraint failure, row survives.
- Owner re-seat: old incarnation's stamp → `false`, no write, new row intact; current
  stamp → thrown, row intact (the single most important case per the ticket).
- Row absent locally → `false` on all three tables.
- Unsigned delete + SAME-transaction owner-signed tombstone → refused, pinned to
  `AuthorizedDelete` as single rejector, on **all three** tables (the `committed.*`
  proof — RevocationRecorded/RowIsGone/Authorized all satisfied by construction).

Positives, **RowIsGone-stripped schema** (the merge-only state; strip helper throws if
the regex ever stops matching, so a future schema edit cannot leave the suite silently
asserting nothing):

- All three tables: seat → hand-file owner-signed tombstone against the live row → reap
  returns `true`, stamp reads null, `queryRevocations()` count unchanged.
- `Strand`: reap-shaped delete refused (`AuthorizedDelete` single rejector) even with a
  committed tombstone — pins the deliberate exclusion.
- Wrong-RowKey tombstone at the right stamp → reap refused, row intact.

## Honest gaps / notes for review

- **Two assertions accept either of two constraint names**
  (`AuthorizedDelete|RevocationRecorded`): a bare unsigned delete with no tombstone
  violates BOTH constraints, and the engine reports one; same for the wrong-RowKey case.
  Documented in-spec. The strict single-name pins are carried by the same-transaction
  tests. If the reviewer wants the exact reported name pinned, that couples the test to
  engine deferred-constraint ordering — deliberate choice not to.
- **The reap branch's RowKey clause is not independently pinnable**: `RevocationRecorded`
  binds the same `(RowKey, StampId)` pair, and `Revocation`'s `(TableName, StampId)`
  primary key means a correct and a misnamed tombstone for one stamp cannot coexist. The
  wrong-RowKey test proves the *pair* of constraints refuses a misnamed tombstone; the
  clause itself is defense in depth.
- **Post-guard race returns `true` without proof of removal**: an owner re-seat landing
  between the guard read and the delete makes the statement match nothing while
  `reapRevokedRow` still returns `true`. Same documented looseness as
  `reauthorizeCadrePeer`; harmless (nothing deleted, next sweep re-reads) and noted in
  the jsdoc.
- **`committed.Revocation` cross-table** inside another table's CHECK is a first (prior
  uses read the constraint's own table). It works under the linked quereus — proven both
  directions (same-transaction refusal, committed acceptance) — but is engine-behavior
  the schema now depends on.
- **No schema-copy change was needed for null context**: nulls through a present
  `with context` clause worked on every table, so the ticket's fallback (declaring
  `Signature text null`) was not exercised.
- **Retired-stamp read filters untouched** (`queryCadrePeers`, `queryPeerRecord`,
  `resolveDeviceToken`) — still load-bearing until a sweep exists, permanently for
  `Strand` and never-reaping nodes.
- Pre-existing `deleteGuardedRow` collision on re-issued owner deletes against a node
  holding row + tombstone (tombstone PK collision) is unchanged by this ticket; a reap
  incidentally removes the trigger condition. Not fixed here, per ticket.
