description: Once optimystic enforces permission rules on row deletes, flip the strand membership/rotation test that currently documents the gap so it asserts an unauthorized delete is correctly rejected.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, schemas/strand.qsql
difficulty: easy
----

## Background

`strand-membership-peer-rotation.spec.ts` contains a *"KNOWN GAP: a non-authority removal
currently SUCCEEDS (deferred CHECK not enforced on delete)"* test that pins today's buggy
behavior: a `Strand.Authority` row can be deleted with a null/garbage signature because the
optimystic bootstrap-mode transactor does not evaluate deferred `CHECK` constraints on `DELETE`.

The platform fix is tracked in optimystic as
`optimystic-deferred-check-not-enforced-on-delete` (now in `../optimystic/tickets/`). Sereus
consumes it via root `resolutions`.

## Follow-up (this repo)

Once the optimystic delete-side CHECK enforcement lands:

- Flip the KNOWN GAP test to `rejects.toThrow()` with an unchanged authority count of 3.
- Re-examine `removeMemberPeer` feasibility (currently out of scope, also blocked by
  `MemberExists` reading the null `new.MemberKey` on delete — see `schemas/strand.qsql`).

## Notes

- Future concern gated on the upstream optimystic fix — promote out of `backlog/` only after
  it lands. Cross-repo, so there is no enforceable `prereq:` here.
