---
description: A phone's push-token row can be re-created or rewritten by replaying an old approval signature the owner issued once, so clearing a token on logout does not reliably stay cleared; give the row the same single-use approval treatment the membership rows already have.
files:
  - packages/cadre-core/src/control-schema.ts (DeviceToken + Revocation tables)
  - schemas/control.qsql (byte-identical twin of the above)
  - packages/cadre-core/src/peer-authorization.ts (deviceTokenAddDigest / deviceTokenRemoveDigest)
  - packages/cadre-core/src/control-authorization.ts (RevocableTable, ControlAction docs)
  - packages/cadre-core/src/control-database.ts (queryDeviceToken, updateSelfDeviceToken, GuardedKeyColumn, queryRevokedStamps)
  - packages/cadre-core/src/seed-bootstrap.ts (insertSelfDeviceToken, deleteDeviceToken)
  - packages/cadre-core/src/cadre-node.ts (registerDeviceToken, resolveDeviceToken)
  - packages/cadre-core/test/control-authorization-domain-separation.spec.ts (DeviceToken insert needs the new column)
  - packages/cadre-core/test/control-cadrepeer-voucher-constraint.spec.ts (pattern for the new crypto-free spec)
  - packages/cadre-core/test/device-token-registry.spec.ts, device-token.spec.ts
difficulty: medium
---

# DeviceToken authority actions: single-use nonce + whole-row binding

## What is wrong (reproduced)

`CadreControl.DeviceToken` is the row a phone publishes so a server peer can send it a
push notification to wake a suspended app. Inserting and deleting that row requires a
signature from a cadre owner key. Today that signature covers **only the peer id** and
carries **no single-use marker**, so the same signature is valid forever and for every
row with that peer id.

Three attacks were reproduced against the shipped schema (temporary spec, since removed;
harness copied from `control-authorization-domain-separation.spec.ts`, which boots a real
`CadreNode` with a real owner key):

- **A — resurrect after logout, with attacker-chosen contents.** Capture the owner's
  insert approval, let the owner delete the row (logout), then replay the same approval
  with a different `Platform` / `Token` / `UpdatedAt`. The insert is accepted.
- **B — unlimited reuse.** insert → delete → insert → delete → insert, all on one
  captured approval pair. Never rejected.
- **C — the dormant owner-update branch rewrites the row freely.** `AuthorizedUpdate`
  has an `or exists(... digest('CadreControl.DeviceToken', 'vouch', new.PeerId) ...)`
  branch whose signature also binds only the peer id, and which sits on the far side of
  the `or` from the `new.UpdatedAt > coalesce(old.UpdatedAt, 0)` monotonicity check. One
  captured owner approval therefore rewrites `Platform` / `Token` and rolls `UpdatedAt`
  *backwards*. No writer in the repo uses this branch — it is dormant, not unreachable.

Two of these have real consequence rather than being theoretical:

- **Logout does not stick.** A replayed insert can restore the exact row that was
  legitimately published — self-signature and all — and `CadreNode.resolveDeviceToken`
  (`cadre-node.ts:2157`) defaults `maxAgeMs` to `Number.POSITIVE_INFINITY`, so there is
  no age ceiling to retire it. Push wakes keep flowing to a device the owner revoked.
- **Wedge the peer's own updates.** Seat a row with a far-future `UpdatedAt`. The peer's
  legitimate self-updates all fail the strictly-increasing check from then on, and the
  bogus row fails signature verification at resolve time, so the peer can never be
  push-woken again.

The original ticket assumed this was defence-in-depth only, on the grounds that
`DeviceToken` does not store the authority signature on the row (unlike `CadrePeer`,
whose replicated `VouchSig` column hands every reader a reusable approval). That
distinction lowers how *easily* an approval is captured — it does not remove the replay,
and the missing age ceiling on the read path removes the natural bound. Treat it as a
real defect, at the same strength as `CadrePeer` got.

Note the action-scoped digest split the original ticket asked for (`'add'` vs `'remove'`
vs `'vouch'`) **already landed** with the domain-tagging work. What is missing is the
single-use nonce, whole-row binding, and retirement.

## Target design

Mirror `CadrePeer` exactly — it is the sibling table, and the reasoning behind every
piece of its design is written out in the schema comments around
`control-schema.ts:243`.

### Schema (`control-schema.ts` **and** `schemas/control.qsql`, kept byte-identical)

Add to `DeviceToken`:

```
StampId text not null unique,   -- single-use authorization nonce; retired into Revocation on delete
```

Constraints, in the shape `CadrePeer` uses:

| constraint | what it becomes |
| --- | --- |
| `NotRevoked` (on insert) | new — `not exists (select 1 from Revocation R where R.TableName = 'DeviceToken' and R.StampId = new.StampId)` |
| `RevocationRecorded` (on delete) | new — the matching `Revocation` row must exist in the same transaction |
| `AuthorizedInsert` | digest binds the **whole row**: `digest('CadreControl.DeviceToken', 'add', new.PeerId, new.Platform, new.Token, coalesce(cast(new.UpdatedAt as text), ''), coalesce(new.Sig, ''), new.StampId)` |
| `AuthorizedDelete` | `digest('CadreControl.DeviceToken', 'remove', old.PeerId, old.StampId)` |
| `AuthorizedUpdate` | self-branch additionally requires `new.StampId = old.StampId`; owner branch **removed** (see below) |

Whole-row binding on insert is what `FormationInvite` and `Strand` already do, and it is
what closes the "seat attacker-chosen contents" half of attack A: with it, the only row a
replay could ever produce is the row that was legitimately approved — and `NotRevoked`
then stops even that.

`Revocation` also needs `DeviceToken` admitted: extend the `RowIsGone` disjunction with
`(new.TableName = 'DeviceToken' and not exists (select 1 from DeviceToken D where D.StampId = new.StampId))`
and update the `TableName` column comment.

**Recommendation: delete the owner branch of `AuthorizedUpdate`** rather than harden it.
No writer in the repo uses it, and an owner that genuinely needs to correct a row can
delete it (retiring the stamp) and insert a fresh one — the same path an owner already
takes for `CadrePeer` when a re-vouch will not do. If the implementer decides to keep it
instead, it must bind the whole row plus `StampId`, keep `new.StampId = old.StampId`, and
sit **inside** the `new.UpdatedAt > coalesce(old.UpdatedAt, 0)` requirement rather than
beside it — otherwise attack C survives verbatim.

Removing that branch means `ControlAction`'s doc comment in `control-authorization.ts`
(which lists "the `DeviceToken` owner re-touch" under `'vouch'`) needs its mention dropped.

### TypeScript

- `peer-authorization.ts` — `deviceTokenAddDigest` grows to the full field vector
  (`peerId, platform, token, updatedAt-or-'', sig-or-'', stampId`); `deviceTokenRemoveDigest`
  takes `(peerId, stampId)`. Both keep the existing "SQL mirror" doc-comment convention so
  the two sides cannot drift silently.
- `control-authorization.ts` — add `'DeviceToken'` to the `RevocableTable` `Extract<...>`.
- `control-database.ts` — add `queryDeviceTokenStampId(peerId)` mirroring
  `queryCadrePeerStampId` (`control-database.ts:467`); have `queryDeviceToken` also return
  the row's `StampId`; confirm `GuardedKeyColumn` still covers the new entry (`PeerId`,
  already present).
- `seed-bootstrap.ts` —
  - `insertSelfDeviceToken`: mint `generateStampId(record.peerId)`, sign the whole-row
    digest, insert the extra column.
  - `deleteDeviceToken`: read the row's `StampId` first (early-return when the row is
    absent, as `removePeer` does at `seed-bootstrap.ts:476`), then delete **and** append
    the `Revocation` tombstone in one transaction, each with its own owner signature —
    copy the transaction/rollback shape from `removePeer`.
- `cadre-node.ts` — `resolveDeviceToken` must drop a row whose `StampId` has been retired,
  the same read-side mitigation `listAuthorizedMembers` applies for `CadrePeer`
  (`cadre-node.ts:3171`, via `queryRevokedStamps`). Without it, a node that has not yet
  converged on the tombstone still honours the resurrected row — which is the whole point
  of the fix.

The public `CadreNode.registerDeviceToken` / `clearDeviceToken` signatures do not change,
so `reference-app-rn` and the other consumers need no edits.

## Tests

Two layers, matching how `CadrePeer` is covered:

- **Crypto-free constraint spec** — new
  `packages/cadre-core/test/control-devicetoken-stamp-constraint.spec.ts`, built exactly
  like `control-cadrepeer-voucher-constraint.spec.ts`: a minimal `Probe` schema carrying
  only the non-crypto predicates (unique `StampId`, `NotRevoked`, `RevocationRecorded`,
  stamp immutability on update) and a direct truth table over them.
- **Real-crypto replay spec** — extend
  `control-authorization-domain-separation.spec.ts` (it already owns the DeviceToken
  insert/delete domain-separation case and has the owner-key harness) with the three
  reproduced attacks, each asserted through `expectConstraintFailure` **by constraint
  name** so a mistyped statement cannot go green. Attack C's assertion depends on the
  owner-branch decision: if the branch is removed, assert the owner-signed update is
  rejected outright.

That spec's existing DeviceToken insert (line ~303) must gain the `StampId` column and
switch to the new digest, and its `tombstoneStamp` helper needs `'DeviceToken'` added to
its table-name union.

## Known trade-off, and one thing to leave as a note

`Revocation` is append-only and only ever grows (see the `NOTE:` already on the table).
Admitting `DeviceToken` adds one permanent row per token clear. Token *rotation* goes
through the self-update path and files nothing, so the growth is one row per explicit
logout — small, and the same bargain `CadrePeer` already makes. Do not add a pruning
mechanism as part of this ticket.

Leave a `NOTE:` comment at `resolveDeviceToken` recording that its freshness ceiling
defaults to infinite by design (a suspended phone must stay push-reachable long after
publish), so stamp retirement — not staleness — is what retires a cleared token.

## TODO

### Phase 1 — schema

- Add `StampId text not null unique` to `DeviceToken` in `control-schema.ts`, with a
  column comment in the style of `CadrePeer`'s
- Add `NotRevoked` (on insert) and `RevocationRecorded` (on delete) constraints
- Rewrite `AuthorizedInsert` to bind the whole row plus `StampId`
- Rewrite `AuthorizedDelete` to bind `(old.PeerId, old.StampId)`
- Add `new.StampId = old.StampId` to the `AuthorizedUpdate` self-branch; remove the owner
  branch (or harden it per the note above, if keeping)
- Extend `Revocation.RowIsGone` with the `DeviceToken` arm and update the `TableName` comment
- Mirror every edit into `schemas/control.qsql` byte-for-byte; `control-schema-drift.spec.ts`
  is the gate

### Phase 2 — TypeScript writers and readers

- `peer-authorization.ts`: widen `deviceTokenAddDigest` / `deviceTokenRemoveDigest`, keeping
  the SQL-mirror doc comments accurate
- `control-authorization.ts`: add `'DeviceToken'` to `RevocableTable`; drop the DeviceToken
  owner re-touch mention from the `ControlAction` `'vouch'` doc
- `control-database.ts`: add `queryDeviceTokenStampId`; return `StampId` from `queryDeviceToken`
- `seed-bootstrap.ts`: mint the stamp in `insertSelfDeviceToken`; make `deleteDeviceToken`
  a delete + tombstone transaction modelled on `removePeer`
- `cadre-node.ts`: filter revoked stamps in `resolveDeviceToken`; add the freshness `NOTE:`

### Phase 3 — tests and validation

- New `control-devicetoken-stamp-constraint.spec.ts` (crypto-free, `Probe` schema)
- Extend `control-authorization-domain-separation.spec.ts` with attacks A, B and C, plus
  the `StampId` column / `tombstoneStamp` union updates its existing DeviceToken case needs
- Update `device-token-registry.spec.ts` and any other spec that writes a `DeviceToken` row
  directly
- Run `yarn workspace @serfab/cadre-core test 2>&1 | tee` (stream it), plus
  `yarn workspace @serfab/cadre-core typecheck` and `yarn lint`
