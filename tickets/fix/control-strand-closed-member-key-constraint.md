description: The cadre control database lets a strand record carry a private member key even when the strand is open, when that key should only ever exist for closed strands — add the missing guard so the data can't get into a contradictory state.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/control-formation-invite.spec.ts
----

# Strand "member key only if closed" constraint

The control-network `Strand` table carries `MemberPrivateKey` (the read-gating
secret for a **closed** strand). An **open** strand (`Type:'o'`) has no membership
gate and must not carry a member key. That invariant is currently unenforced — a
standing TODO in the schema:

`packages/cadre-core/src/control-schema.ts:56` — `-- TODO: constraint to ensure member private key only if closed`

(The schema is duplicated in `schemas/control.qsql`; both copies must stay
byte-identical — a `control-schema-drift` guard enforces this, so any constraint
must be added to **both**.)

## Desired behavior

A `Strand` insert/update must satisfy: `MemberPrivateKey is null when Type = 'o'`
(equivalently, a non-null `MemberPrivateKey` requires `Type = 'c'`). A violating row
is rejected at commit.

## Why it surfaced

The live formation→convergence e2e (`formation-convergence-e2e-wire-and-spec`) wants
to assert closed-strand membership ("a read needs the minted member key"). Without
this constraint the strongest control-layer assertion is metadata-level (the formed
strand is `type:'c'` with a key present). Landing this CHECK lets that tier — and
the cadre RBAC story generally — assert the open/closed/member-key invariant
directly at the control insert. Not a blocker for the e2e tier; a correctness
hardening of the control schema.

## Notes for whoever picks this up

- Mirror the existing `Strand.Authorized` CHECK style (a row-level `check (...)`),
  keeping SQL reserved words lowercase per repo style.
- Add a focused case to `packages/cadre-core/test/control-formation-invite.spec.ts`
  (or a sibling): an open strand with a non-null `MemberPrivateKey` is rejected; a
  closed strand with one is accepted; an open strand with null is accepted.
- Verify the consent-redemption path (`redeemInvitation`, which inserts a `Type:'c'`
  strand with a member key) still passes — it should, since formed strands are
  always closed.
