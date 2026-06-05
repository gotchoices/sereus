description: Harden the FormationInvite authority signature: it is currently a BARE STAMP (signs only digest(StampId)), not bound to the invite row and not single-use. A captured (StampId, Signature) pair can be transplanted onto a different FormationInvite row and replayed. Bind the signature to the row (Token/sAppId/ExpiresAt/TotalUses/ValidationUrl) and add a unique StampId column, mirroring the row-bound + single-use scheme already applied to AuthorityKey/ValidationKey/Strand/CadrePeer.
prereq: formationinvite-fix-curve-and-wire-consent
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts
----

## Problem

`FormationInvite.AuthorizedAddOrRemove` verifies an authority signature over only
`digest(context.StampId, 'sha256', 'utf8')`, where `StampId` is a **context value**
(not a column). Compare the privileged tables hardened by
`control-key-constraints-bind-row-and-single-use-stamp`:

- `AuthorityKey` / `ValidationKey` / `Strand` sign over the **row contents**
  concatenated with the StampId, and persist `StampId` as a `not null unique`
  column (single-use anti-replay).
- `FormationInvite` signs neither the row contents nor a persisted unique column.

Consequences (confirmed during review of `formationinvite-fix-curve-and-wire-consent`):

1. **Transplant.** A captured `(StampId, Signature)` from one invite authorizes the
   insert of a *different* invite row (different Token/sAppId/expiry/uses), because
   nothing in the signed message ties the signature to the row being inserted.
2. **Replay.** The same `(StampId, Signature)` can be replayed to re-insert an invite
   after deletion, because `StampId` is not a unique column and is not retained.

The current shape matches what the originating ticket prescribed (it modeled the
minimal fix on `CadrePeer`'s bare-stamp insert and explicitly scoped row-binding
out), so this is a tracked residual weakness, not a regression.

## Desired behavior

Mirror the `Strand` hardening:

- Add `StampId text not null unique` column to `FormationInvite`.
- `AuthorizedAddOrRemove` verifies an authority signature over a canonical row-bound
  message — concatenated per-field `digest(..., 'sha256','utf8','hex')` over
  `(Token, sAppId, coalesce(ExpiresAt,''), coalesce(TotalUses,''), coalesce(ValidationUrl,''), StampId)`
  (final field order to be settled in implement; must match the writer in
  `control-database.ts:insertFormationInvite`, which already uses
  `buildAuthorizationMessage([...])` for the other tables).
- Apply byte-identically to BOTH schema copies (`schemas/control.qsql` and the
  embedded `CONTROL_SCHEMA` in `control-schema.ts`); the `control-schema-drift`
  guard must stay green.
- Update `insertFormationInvite` to build the row-bound message + persist the unique
  `StampId` column (drop the `with context StampId` value, as `Strand` did).
- Add tests: transplant of a captured signature onto a different invite row is
  rejected; replay (re-insert after delete with the same StampId) is rejected by the
  unique column.

Note the `delete` branch (`check on insert, delete`) also reads `context.StampId`;
on delete there is no `new` row, so the delete authorization message shape needs its
own decision (sign over `old` row contents, or keep a stamp-only delete path).
Resolve in implement.
