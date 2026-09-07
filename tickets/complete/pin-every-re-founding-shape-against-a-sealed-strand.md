description: Added two tests proving a sealed (permanently frozen) strand cannot be re-founded — neither by a properly signed generation-0 insert nor by a non-zero-generation one — and reviewed them against the schema rule they claim to pin.
files: packages/cadre-core/test/strand-seal.spec.ts
----

# Re-founding a sealed strand — two new pinned shapes (reviewed, complete)

## What landed

`packages/cadre-core/test/strand-seal.spec.ts`, in `describe('Manager.Authorized seal branch')`,
gained two `it` blocks after the existing null-context re-founding case:

- **Signed generation-0 re-founding** — same founding-shaped insert as the pre-existing test but
  carrying a REAL self-signature over the `'add'` digest instead of a null context, so the
  rejection cannot be attributed to a missing or malformed signature.
- **Non-zero-generation re-founding** — `Generation = 1` with a real signature, which takes the
  founding branch out of contention on its own terms and exercises the promotion branch instead.

Both assert `rejects.toThrow(/Authorized/)` and then that `Manager` is still empty and the strand
still sealed. No production code changed.

## Review findings

**Diff read first, against `schemas/strand.qsql` `Manager.Authorized` (lines ~413-502) rather than
the handoff's summary of it.**

*Correctness of the pin claims* — verified each new test's comment against the schema text:

- Signed generation-0 case: sound. The founding branch is gated on `old.MemberKey is null and
  new.Generation = 0` plus the count/Member/Revocation conjuncts and never calls `verify()`, so a
  supplied signature genuinely changes nothing about that branch; the only other branch an
  `old.MemberKey is null` insert can reach is promotion, which needs an existing `Manager` row.
  The sibling constraints do pass as claimed: `NotRevoked` (fresh stamp), `MemberExists` (the
  founder is still a Member), `OnlyClosed` (closed strand) — `Authorized` is the sole rejector.
- Non-zero-generation case: **fixed inline.** The comment claimed the failure was solely the
  `exists()` over an empty `Manager` table, omitting the promotion branch's
  `A.MemberKey <> new.MemberKey` conjunct — which refuses a founder-signs-for-founder insert on a
  LIVE strand too, so the case is not seal-specific. Rewrote the comment to say so, and to note
  it could not be made seal-specific (a distinct subject key would fail `MemberExists`, since a
  sealed strand can never admit the second member such a key would need) and what it does pin: no
  branch answers a non-zero-generation insert, so a future loosening of the founding branch's
  `Generation = 0` surfaces as an unexpected ACCEPT.

*Coverage — is "every re-founding shape" actually pinned?* Enumerated the ways the founding branch
could be re-satisfied on a sealed strand:

- Generation 0, null context — pre-existing test.
- Generation 0, real signature — new test.
- Non-zero generation — new test.
- Generation 0 naming a DIFFERENT member key — unreachable: a sealed strand has exactly one
  member and can never admit another, so any other key fails `MemberExists` first. Nothing to pin.
- **Unfiling the seal tombstone to reopen the founding branch's `not exists (... Revocation ...)`
  gate** — the shape the ticket title implies but does not name. Checked: `Revocation.Immutable`
  is `check on update, delete (false)`, unconditional, and
  `strand-member-revocation.spec.ts:714` ("rejects updating or deleting an existing tombstone
  (Immutable)") already pins it. A composite delete-then-re-found transaction cannot get past a
  constraint that refuses every delete, so no additional test would add a claim. Not filed.

*Tests* — `yarn workspace @serfab/cadre-core test`: **106/106 files, 1702 passed, 1 skipped**, one
clean run. The handoff's transient `UNKNOWN: unknown error, read` at import time did not reproduce;
nothing recorded to `.pre-existing-known.md` or `.pre-existing-error.md`. `strand-seal.spec.ts` in
isolation: 18/18. `yarn lint`: exit 0.

*Source hygiene* — 584 lines, comfortably below the file's peers in the same directory
(`wc -l packages/cadre-core/test/*.ts` puts several siblings at 900-1669). No size debt. The
three-line seal setup repeated per test matches the file's existing idiom and stays local; the
cross-file helper duplication is already tracked by `debt-hoist-strand-tombstone-helpers`, which
the implementer correctly left alone.

*Docs* — read `docs/architecture.md`'s `sealStrand` entry, the only place naming this spec. It
already says the behavior is "Pinned by `cadre-core/test/strand-seal.spec.ts`" and describes the
seal branch and its irreversibility accurately; this change adds tests without changing behavior,
so nothing there went stale. No doc edits needed.

*Site claims* — `grep -rl` across the open stages found `debt-hoist-strand-tombstone-helpers` and
`strand-seal-binds-a-second-node` already touching this file; neither overlaps these findings, so
no arm appended and nothing new filed.

**Major findings: none** — the two tests do what they claim and the schema rules they cite hold as
written. **Tickets filed: none** — the one inaccuracy was a comment overstating a pin, fixed in
this pass. **Tripwires recorded: none** — nothing found that is fine now and only breaks under a
future condition; the tombstone-deletion shape above is closed unconditionally, not conditionally.
