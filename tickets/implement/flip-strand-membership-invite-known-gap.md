description: Once optimystic rejects inserts that reuse an existing primary key, flip the invite test that currently documents the gap so it asserts a double-consume of the same invite is rejected.
files: packages/cadre-core/test/strand-membership-invite.spec.ts
difficulty: easy
----

## Background

`strand-membership-invite.spec.ts` contains a *"KNOWN GAP: a double consume currently
overwrites instead of rejecting"* test that pins today's buggy behavior: consuming the same
single-use invite twice silently overwrites the `Strand.ConsumedInvite` row (admitting a
second member) instead of being rejected, because the optimystic bootstrap-mode transactor
does not enforce primary-key uniqueness on `INSERT`.

The platform fix is tracked in optimystic as
`optimystic-insert-pk-uniqueness-not-enforced` (now in `../optimystic/tickets/`). Sereus
consumes it via root `resolutions`.

## Follow-up (this repo)

Once the optimystic insert PK-uniqueness enforcement lands:

- Flip the KNOWN GAP test to `rejects.toThrow()` with unchanged `ConsumedInvite` and `Member`
  counts (the second consume must not admit a second member).

## Notes

- Future concern gated on the upstream optimystic fix — promote out of `backlog/` only after
  it lands. Cross-repo, so there is no enforceable `prereq:` here.
