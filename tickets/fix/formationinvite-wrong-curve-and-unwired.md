----
description: FormationInvite authorization omits the ed25519 curve arg (defaults to secp256k1) so it can never validate an authority signature, and no code inserts FormationInvite/FormationUsage.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-formation-manager.ts
----
The control-plane schema defines a consent/invitation model for strand formation: a party publishes a `FormationInvite` (an open invitation token), and an invited peer records a `FormationUsage` against that token to authorize a strand without needing an authority signature. Two defects make this model both incorrect at the crypto layer and entirely unreachable at runtime.

## Wrong signature curve on FormationInvite

Every other `CadreControl` authorization constraint verifies an authority signature with a consistent shape: `verify(digest(<value>, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519')`. For example, `CadrePeer`'s authorization branch (schemas/control.qsql:56) calls `verify(digest(new.PeerId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519')`.

`FormationInvite`'s `AuthorizedAddOrRemove` constraint diverges. It calls `verify(digest(context.StampId), context.Signature, A.Key)` (schemas/control.qsql:67-70, and the identical embedded copy in `CONTROL_SCHEMA` at packages/cadre-core/src/control-database.ts:85-89). This is wrong in two ways:

- The digest omits the `'sha256', 'utf8'` input-encoding arguments used everywhere else.
- Critically, it omits the `'ed25519'` curve argument. The crypto plugin defaults to `secp256k1`, but authority keys are ed25519. With the wrong curve, this constraint can never validate a real authority signature, so a properly signed `FormationInvite` insert/delete will always be rejected.

## FormationInvite / FormationUsage are never written

The `Strand.Authorized` constraint has two branches: the authority-key branch, and a second branch `or exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)`. The second branch is the mechanism by which an invited peer authorizes a strand at the DB layer without an authority signature — it is the realization of the invitation-only consent model.

However, no code anywhere inserts `FormationInvite` or `FormationUsage` rows. As a result the `FormationUsage` branch of `Strand.Authorized` is never satisfied, strand insertion only ever uses the authority-key branch, and the consent-based authorization path is dead. The strand formation flow (packages/cadre-core/src/strand-formation-manager.ts) does not exercise it.

## Consequence

The consent/invitation-driven control-plane authorization is currently unreachable. The moment the formation flow is wired to use it, the `FormationInvite` curve bug will block it — a correctly signed invite will fail authorization because the constraint verifies against the wrong curve. The bug exists identically in `schemas/control.qsql` and the embedded `CONTROL_SCHEMA` copy in `control-database.ts`, so both must be kept in sync.

## Expected behavior

- `FormationInvite`'s `AuthorizedAddOrRemove` constraint must verify authority signatures with the same shape as the other tables: a `utf8`-encoded `sha256` digest and the explicit `'ed25519'` curve argument, so a real authority signature validates. The fix must be applied to both `schemas/control.qsql` and the embedded `CONTROL_SCHEMA` in `packages/cadre-core/src/control-database.ts`.
- The invitation flow must actually insert `FormationInvite` (when a party offers an invitation) and `FormationUsage` (when an invited peer redeems it), so the consent-based `Strand.Authorized` branch is exercised and the invitation-only formation path works end to end.

## Key references

- schemas/control.qsql:67-70 — `FormationInvite.AuthorizedAddOrRemove` constraint (wrong curve).
- schemas/control.qsql:56 — `CadrePeer` authorization branch (correct shape to match).
- packages/cadre-core/src/control-database.ts:85-89 — embedded `CONTROL_SCHEMA` copy with the same bug.
- `Strand.Authorized` constraint's `FormationUsage` branch — the consent path that is never reached.
- packages/cadre-core/src/strand-formation-manager.ts — strand formation flow that must drive the invitation inserts.
