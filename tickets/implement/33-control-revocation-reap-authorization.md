----
description: Teach the control database's delete rules that a machine may remove a member record it can already prove was revoked, without needing the party owner's private key. This ticket only adds the rule and the single-row delete that uses it; nothing calls it automatically yet.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-revocation-reap.spec.ts (new), packages/cadre-core/test/control-constraint-helpers.ts, packages/cadre-core/test/control-schema-drift.spec.ts, docs/architecture.md
difficulty: hard
----

# Reap authorization: a committed tombstone authorizes deleting the row it retires

## Background (what exists today)

A guarded delete (`CadrePeer`, `DeviceToken`, `Strand`, `ValidationKey` — all four share
`ControlDatabase.deleteGuardedRow`, control-database.ts:1377) does two things in one
transaction:

1. deletes the row, authorized by an owner signature over a `'remove'`-tagged digest bound
   to the row's one-off `StampId`;
2. inserts a `CadreControl.Revocation` tombstone naming `(TableName, RowKey, StampId)`,
   itself owner-signed (`Revocation.Authorized`).

Replication carries the tombstone but **cannot carry the delete** — a delete of a row that
is already gone locally replays as nothing. So a node that was holding the member's row
when the revocation happened converges on the tombstone and keeps the row forever. The row
is inert (`queryCadrePeers` / `queryPeerRecord` / `resolveDeviceToken` all drop rows whose
stamp is retired), but it is permanent garbage and it means "what rows exist" differs from
node to node indefinitely.

**This live-row-plus-tombstone state is reachable only by replication merge.** It cannot be
built by local writes: `Revocation.RowIsGone` refuses a tombstone while the row is live, and
each guarded table's `NotRevoked` refuses an insert naming a retired stamp. That property is
what makes the fixture in the tests below need a schema override — see *Testing*.

## What this ticket adds

**One new authorization branch** on the delete rule of three guarded tables, plus the single
`ControlDatabase` method that uses it. No caller drives it automatically — the sweep and its
scheduling are `control-revocation-reap-sweep`, which is prereq'd on this ticket.

The branch authorizes a delete by the **existence of an already-committed `Revocation` row
naming this exact row incarnation**. Same shape as the consent branch of
`Strand.AuthorizedInsert`: authorization by the existence of a row rather than by a
signature — and that row is itself owner-signed, so this widens **who may execute** a
removal, never **who may decide** one.

### Scope: three tables, not four

| table | reap branch | why |
|---|---|---|
| `CadrePeer` | **yes** | the table with the fork problem; the stale row is pure garbage |
| `DeviceToken` | **yes** | a cleared push token is garbage; identical rule, no secret on the row |
| `ValidationKey` | **yes** | row holds a public key only; nothing is lost by removing it |
| `Strand` | **no** | the row carries `MemberPrivateKey`, the party's own membership secret for that network, stored nowhere else — the one guarded delete whose effect is unrecoverable. A stale `Strand` row is also already inert for the purpose the tombstone serves (`Strand.AuthorizedInsert`'s consent branch refuses any id ever tombstoned). Deferred to `tickets/backlog/debt-strand-tombstone-reap.md`, which must also settle the strand-runtime teardown that a bare row reap would trigger via `StrandWatcher`. |
| `OwnerKey` | **no** | already outside `deleteGuardedRow`'s table union; no production owner-removal path exists, and `MinOneOwner` makes an automated owner-key reap a party-bricking hazard |

Add a short comment on `Strand.AuthorizedDelete` recording that the branch is
**deliberately** absent, so nobody later "fixes" the asymmetry.

### The schema branch

Both copies of the schema must be edited identically — `schemas/control.qsql` and
`CONTROL_SCHEMA` in `packages/cadre-core/src/control-schema.ts`. `control-schema-drift.spec.ts`
fails the build on any divergence, including whitespace inside a line. Remember the embedded
copy is a template literal: backticks and `${` in comments must stay escaped as they already
are.

On `CadrePeer.AuthorizedDelete`, append to the existing `exists (... verify ...)` clause:

```sql
                -- or REAP: this node already holds a COMMITTED tombstone retiring THIS EXACT row
                -- incarnation, so the party owner has already authorized this row's removal and this
                -- node is merely catching up. That is what lets a node which was offline at
                -- revocation time delete the stale row locally, with no owner private key
                -- (control-database.ts:reapRevokedRow). Same shape as the consent branch of
                -- Strand.AuthorizedInsert: authorization by the EXISTENCE of a row rather than by a
                -- signature — and that row is itself owner-signed (Revocation.Authorized), so this
                -- widens WHO may execute a removal, never WHO may decide one. RevocationRecorded is
                -- satisfied by the same committed tombstone, so a reap files no second one.
                --
                -- committed.Revocation, NOT Revocation — and the stamp clause — are both load-bearing:
                --   * committed.* : this CHECK defers to commit (it has a subquery), by which point a
                --     tombstone written in the SAME transaction is live. Reading plain Revocation
                --     would therefore let deleteGuardedRow's own sibling tombstone satisfy this
                --     branch, making the 'remove'-tagged delete signature above dead weight and
                --     collapsing two domain-separated approvals into one. committed.* states the rule
                --     exactly: the tombstone must have existed BEFORE this transaction.
                --   * R.StampId = old.StampId : binds the ROW INCARNATION, not the name. One name may
                --     legitimately carry several tombstones over its life (seat -> delete -> owner
                --     re-seat -> delete). Without this clause a tombstone from a PREVIOUS incarnation
                --     would authorize deleting the CURRENT row, which the owner never removed.
                or exists (select 1 from committed.Revocation R where R.TableName = 'CadrePeer' and R.RowKey = old.PeerId and R.StampId = old.StampId)
```

`DeviceToken.AuthorizedDelete` and `ValidationKey.AuthorizedDelete` get the same branch with
a short cross-reference instead of the full rationale (house style — cf.
`ValidationKey.NotRevoked`, which says "Same rationale as OwnerKey.NotRevoked, stated in full
there"):

```sql
                -- or REAP: a COMMITTED tombstone already retires this exact row incarnation, so a node
                -- that was offline at removal time may delete the stale row locally with no owner key.
                -- Why committed.* and why the stamp must be bound: stated in full on
                -- CadrePeer.AuthorizedDelete.
                or exists (select 1 from committed.Revocation R where R.TableName = 'DeviceToken' and R.RowKey = old.PeerId and R.StampId = old.StampId)
```

(`ValidationKey` uses `R.TableName = 'ValidationKey' and R.RowKey = old.Key`.)

`committed.<Table>` is already used by `OwnerKey.Authorized` (`committed.OwnerKey`) and
`FormationUsage.Monotonic` (`committed.FormationUsage`), so the prefix is supported on a
same-schema table inside a deferred CHECK.

### `ControlDatabase.reapRevokedRow`

```ts
/** Guarded tables a node may reap locally once their tombstone has committed. */
export const REAPABLE_TABLES = ['CadrePeer', 'DeviceToken', 'ValidationKey'] as const;
export type ReapableTable = (typeof REAPABLE_TABLES)[number];

/**
 * Delete one guarded row that an ALREADY-COMMITTED Revocation tombstone retires...
 * Returns whether a row was removed.
 */
async reapRevokedRow(table: ReapableTable, rowKey: string, stampId: string): Promise<boolean>
```

Body:

- `ensureInitialized()`, then read the live stamp through the existing `queryStampId(table, rowKey)`
  (deliberately raw — no retired-stamp filter, which is exactly what a reaper needs). If it is
  `null` (row not held here) or `!== stampId` (a fresh incarnation the owner re-seated), return
  `false` without writing.
- Otherwise run **one** statement:

```sql
delete from CadreControl.<table>
  with context OwnerKey = null, Signature = null
  where <GUARDED_KEY_COLUMN[table]> = ? and StampId = ?
```

  Both `table` and its key column come from closed literal unions, matching
  `deleteGuardedRow`'s injection-surface discipline.

- **The `and StampId = ?` clause is required, not belt-and-braces.** It closes the
  read→write race: an owner may re-seat the row (fresh stamp) between the `queryStampId`
  above and this statement, and without the clause the reap would delete the owner's brand-new
  row. With it the statement matches nothing and the reap is a silent no-op. (The schema
  branch would also refuse that delete, but as a `ConstraintError` thrown into a background
  sweep — a matched-nothing no-op is the better failure mode.)
- **The `with context` clause must be PRESENT and bound to nulls**, never omitted. Quereus
  cannot resolve `context.OwnerKey` at plan time when the clause is absent while a constraint
  references `context.*` — measured and recorded in `tickets/.pre-existing-known.md`. Nulls
  through a present clause are a shipping production shape (`redeemInvitation`'s consent-branch
  `Strand` insert, control-database.ts:1919), which also proves `verify(...)` with a null
  signature evaluates falsy rather than throwing. If the engine nonetheless rejects a null
  `Signature` on these tables, mark the context column `Signature text null` in both schema
  copies and say so in the handoff.
- **Locking.** `CadrePeer` goes through `mutateCadrePeer('peer-reap', body)` with a bare
  `this.db!.exec` inside (the pattern `insertCadrePeer` uses); the other two go through
  `execWrite`. Routing `CadrePeer` through `mutateCadrePeer` keeps the "EVERY `CadrePeer`
  writer goes through here" invariant intact with no new documented exception. The membership
  snapshot cannot actually change (the reaped row was already filtered out by the retired-stamp
  gate in `queryCadrePeers`), so the notify is a redundant refresh — note that at the call
  site rather than adding an exception.
- Log the reap (table, row key, stamp) — a row leaving the control plane without an owner
  signature at the write site should be visible in a log.
- Export `ReapableTable` / `REAPABLE_TABLES` from `packages/cadre-core/src/index.ts`
  alongside `RevokedRowRef`.

### What does NOT change

- **Do not remove or weaken the retired-stamp filters** in `queryCadrePeers`,
  `queryPeerRecord`, or `CadreNode.resolveDeviceToken`. They stay load-bearing for every
  moment between converging on a tombstone and reaping the row, and permanently for a node
  that never reaps (no connectivity — see the sweep ticket's gate) and for `Strand`, which has
  no reap branch at all. They become belt-and-braces only for rows that have actually been
  reaped.
- `deleteGuardedRow` is untouched. Its owner-signed path is unchanged and still the only way
  to *decide* a removal.

## Edge cases & interactions

- **Stale tombstone must not kill the current incarnation.** Seat a peer (stamp S1),
  owner-delete it (tombstone S1 committed), owner re-seat it (fresh stamp S2). The live row
  now coexists with a committed tombstone for the same `RowKey` at a different stamp.
  `reapRevokedRow(..., S2)` must be refused by the schema (no tombstone for S2);
  `reapRevokedRow(..., S1)` must be a no-op returning `false` with the row intact. This is
  the single most important test in the ticket.
- **No tombstone at all.** A reap of a live, never-revoked row must be refused by
  `AuthorizedDelete` (no owner signature, no committed tombstone) — a thrown constraint
  failure, not a silent success.
- **Tombstone naming a different row key at the same stamp** is not constructible (stamps are
  128-bit CSPRNG per incarnation), but the branch binds `RowKey` anyway; assert the `RowKey`
  clause by hand-filing a tombstone whose `RowKey` is wrong for the stamp and confirming the
  reap is refused.
- **Same-transaction tombstone must not authorize.** A `deleteGuardedRow` still requires its
  own `'remove'` signature: an unsigned delete accompanied by an owner-signed tombstone in the
  same transaction must be refused (this is what `committed.*` buys). Test it by hand-rolled
  SQL — delete with `OwnerKey = null, Signature = null` plus a tombstone insert, one
  transaction.
- **Row absent locally.** The common case on most nodes: `queryStampId` returns `null`, reap
  returns `false`, nothing is written.
- **Non-owner node.** A reap needs no owner key; a drone holding row + tombstone must be able
  to reap. Assert this explicitly — it is the whole point of the branch.
- **`deleteGuardedRow` on a node holding row + tombstone** currently collides on
  `Revocation`'s `(TableName, StampId)` primary key when the owner re-issues the same delete
  there. Pre-existing, not made worse by this ticket, and the reap incidentally removes the
  trigger (after a reap, `deleteGuardedRow` reads a null stamp and no-ops). Note it, do not
  fix it here.
- **`ReissueOnly` / `FreshTombstone` / `NoDelete` are untouched.** A reap writes nothing to
  `Revocation`. If a reap ever appears to touch that table, the implementation is wrong.
- **Blocked upstream, do not chase:** `Revocation` *updates* (`reissueRevocations`) are red
  under quereus v4.6.0 on a false UNIQUE failure —
  `tickets/blocked/10-revocation-reissue-same-pk-update-unique-collision`, tests owned by
  `tickets/implement/10-control-revocation-reissue-test-fixes`. Nothing in this ticket updates
  `Revocation`, so that blocker should not be reachable here; if a reap test trips it, you have
  written a `Revocation` update by mistake.

## Testing

New spec: `packages/cadre-core/test/control-revocation-reap.spec.ts`. Reuse
`control-constraint-helpers.ts` (`expectConstraintFailure`, `freshKeyPair`, `freshStamp`,
`signAs`, `revocationMessage`) and follow `control-revocation-replay.spec.ts` for harness
shape.

**Negative cases run against the real schema** — all of them are constructible with ordinary
local writes:

- reap of a live row with no tombstone → refused, pinned to `/AuthorizedDelete/`
- reap of a re-seated row using the previous incarnation's stamp → `false`, row survives
- reap of a re-seated row using the current stamp → refused (no tombstone for it)
- unsigned `deleteGuardedRow`-shaped delete + same-transaction tombstone → refused
  (`committed.*` proof)
- `Strand`: a hand-built reap-shaped delete is refused even with a committed tombstone —
  pins the deliberate absence of the branch

**The positive case needs a schema override.** The live-row-plus-tombstone state is
merge-only and cannot be built locally, because `Revocation.RowIsGone` refuses a tombstone
while the row is live. Build the fixture by starting a `CadreNode` whose
`config.controlNetwork.schemaPath` points at a temp file holding `CONTROL_SCHEMA` with **only
the `Revocation.RowIsGone` constraint** stripped:

- Strip exactly one constraint, and assert the strip actually changed the text — a silent
  no-match would leave the test asserting nothing after a future schema edit.
- `RowIsGone` is the right one to drop: its only job is stopping an owner from retiring a
  stamp *early* via a local write, which is precisely the guard replication merge bypasses.
  `NotRevoked`, `RevocationRecorded` and `AuthorizedDelete` — the rules actually under test —
  stay intact.
- Sequence: found the party, seat a `CadrePeer` row, read its stamp via
  `queryCadrePeerStampId`, hand-insert an owner-signed tombstone naming
  `('CadrePeer', peerId, stamp)` through `getDatabase().exec`, then assert
  `reapRevokedRow` returns `true`, `queryCadrePeerStampId` returns `null`, and no new
  `Revocation` row appeared (`queryRevocations().length` unchanged).
- Cover the same positive path for `DeviceToken` and `ValidationKey`, and cover a
  **non-owner** reap (a node with no owner signing key).

Do not weaken the drift guard to accommodate the temp schema file — it is written to a temp
directory at test time and compared to nothing.

## Validation

- `cd packages/cadre-core && npx vitest run test/control-revocation-reap.spec.ts test/control-schema-drift.spec.ts test/control-revocation-replay.spec.ts test/control-authorization-binding.spec.ts 2>&1 | tee /tmp/reap.log`
  (stream it — silent redirection loses the run to the 10-minute idle timeout)
- Blast radius of a widened delete rule: `npx vitest run test/control-membership-hub.spec.ts test/device-token-registry.spec.ts test/validation-key-enrollment.spec.ts test/strand-unpublish.spec.ts`
- `yarn workspace @serfab/cadre-core build`, root `yarn lint`
- Check any new failure against `tickets/.pre-existing-known.md` before treating it as yours.

## Docs

`docs/architecture.md:204` ("Delete-while-alone durability (revocation tombstone)") states as
a residual that "the removed row itself is **not** physically deleted on nodes that already
held it". Update it to say the tombstone now also *authorizes* the reap for
`CadrePeer` / `DeviceToken` / `ValidationKey`, that `Strand` is deliberately excluded and why,
and that nothing drives the reap yet (that is the sweep ticket). Also update the `Revocation`
row in the control-table reference (`docs/architecture.md:41`) to mention the reap branch.

## TODO

Phase 1 — schema

- Add the reap branch to `CadrePeer.AuthorizedDelete` in `schemas/control.qsql` with the full
  rationale comment above
- Add the cross-referencing branch to `DeviceToken.AuthorizedDelete` and
  `ValidationKey.AuthorizedDelete`
- Add the "deliberately no reap branch" note to `Strand.AuthorizedDelete`
- Mirror all four edits byte-for-byte into `CONTROL_SCHEMA` in `control-schema.ts`; run
  `control-schema-drift.spec.ts` before going further

Phase 2 — database

- Add `REAPABLE_TABLES` / `ReapableTable` and `ControlDatabase.reapRevokedRow` per the shape
  above; export the types from `packages/cadre-core/src/index.ts`
- Route the `CadrePeer` arm through `mutateCadrePeer`, the other two through `execWrite`

Phase 3 — tests

- Write `control-revocation-reap.spec.ts`: every negative case against the real schema, then
  the positive cases against a `RowIsGone`-stripped schema loaded via
  `controlNetwork.schemaPath`
- Include the non-owner reap and the `Strand`-is-excluded pin

Phase 4 — docs + validation

- Update `docs/architecture.md` lines 41 and 204
- Run the validation commands above, streaming output; record results honestly in the
  review handoff, including anything you could not prove
