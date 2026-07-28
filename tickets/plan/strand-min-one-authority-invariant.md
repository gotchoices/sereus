description: A strand admin can remove the very last admin (or drop down to a single admin), which can lock the group with no one able to ever add admins again — the rules should prevent removing the last one.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts
difficulty: medium
----

## Problem

`Strand.Authority.Authorized` has a bootstrap branch — `(select count(1) from Authority) <= 1`
— that exists so the FIRST authority can be seated with no prior signer. On a DELETE, that
same branch is evaluated at commit against the POST-delete row set, so it is true whenever a
delete drops the authority count to ≤ 1. Two bad outcomes follow once delete-side constraint
enforcement actually runs (today it does not — see `optimystic-deferred-check-not-enforced-on-delete`,
now in `../optimystic/tickets/`, which is why this is deferred behind it):

- **Second-to-last removal is unauthenticated.** Removing an authority when exactly two remain
  drops the count to 1, so the bootstrap branch is satisfied and ANY signature (or none) is
  accepted for that delete — the existing-authority / self branches are bypassed.
- **Last-authority removal orphans the strand.** Removing the final authority leaves an
  admin-less closed strand: no one can ever `addAuthority`/`issueInvite`/`addMemberByAuthority`
  again, because every admit path requires an existing `Authority` row. The strand is
  permanently frozen.

The current writer (`removeAuthority`) deliberately does NOT guard this — it was left to a
schema change rather than grown into the writer (a writer-side check is racy and bypassable by
a raw DML caller anyway; the invariant belongs in the schema constraint).

## Expected behavior

A closed strand must always retain at least one `Authority`. The `Authority` schema should
reject a DELETE that would leave zero authorities, and the rotation/removal authorization must
not silently weaken (accept any signature) as the count approaches 1. Options to weigh during
design:

- Split the bootstrap shortcut so it only applies to the **seeding INSERT** (e.g. gate
  `(select count(1) from Authority) <= 1` to `on insert`), not to deletes, so a delete always
  travels the signed existing-authority / former-authority-self branches.
- Add an explicit "at least one authority remains" check on delete (e.g.
  `(select count(1) from Authority) >= 1` evaluated post-delete, i.e. block the last removal).
- Keep `schemas/strand.qsql` and the embedded `STRAND_SCHEMA` in
  `packages/quereus-plugin-sereus/src/strand-schema.ts` byte-equivalent (the file header notes
  they must mirror).

## Why deferred / ordering

Right now `removeAuthority`'s authorization is unenforced for ALL deletes (the platform gap),
so this invariant has no teeth until that lands; it stays in `backlog/` until that cross-repo fix
lands (no enforceable `prereq:` here — the header was removed for that reason). Once delete-side checks
run, add tests to `strand-membership-peer-rotation.spec.ts`: (a) removing the last authority is
rejected and the row remains; (b) a second-to-last removal still requires a valid existing-
authority/self signature (no bootstrap bypass).
