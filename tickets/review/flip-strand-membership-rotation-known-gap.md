description: Confirmed that removing a strand manager without authorization is now correctly rejected, and brought stale documentation that still described the old (insecure) behavior up to date.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, schemas/strand.qsql, docs/architecture.md, packages/cadre-core/src/strand-membership-writer.ts
difficulty: easy
----

## Summary

The original ticket asked to flip a `KNOWN GAP` test in `strand-membership-peer-rotation.spec.ts`
that pinned a bug: the optimystic bootstrap-mode transactor did not evaluate deferred
(subquery-bearing) `CHECK` constraints on `DELETE`, so a `Strand.Manager` row could be removed
by anyone, with any (even null/garbage) signature — `Manager.Authorized` is a deferred `CHECK`
and was never consulted on delete.

The upstream fix (tracked as `optimystic-deferred-check-not-enforced-on-delete` in the sibling
`optimystic` repo's ticket board) had already landed, and the test was already flipped by commit
`92f03b3` ("tess: triage pre-existing test failure") during an earlier, unrelated ticket run —
well before this ticket file was even created. This implement pass made **no source change**
to the test; it verified the flip is genuine and correct, then fixed stale documentation the
earlier flip left behind.

## What the test now asserts (`strand-membership-peer-rotation.spec.ts:322`)

`describe('removeManager') → 'a non-manager removal is rejected (deferred CHECK enforced on
delete)'`: starting from 3 managers, a `removeManager` call signed by a key that is neither an
existing manager nor the removal target throws, and the `Manager` table is unchanged at 3 rows
(the specific target row is asserted still present). This replaced the old test that asserted
the opposite (`resolves.toBeUndefined()` + count dropped to 2, i.e. the insecure behavior).

## Verification performed this pass

- Re-derived the full history of the test file (`git log --follow`) to confirm the flip's
  origin (`92f03b3`) and that no later commit (the `Authority`→`Manager` rename, or the sibling
  `flip-strand-membership-invite-known-gap` ticket) reverted or weakened it.
- Ran `yarn vitest run test/strand-membership-peer-rotation.spec.ts` in `packages/cadre-core`
  directly against the real optimystic bootstrap-mode transactor (not a mock) — **14/14 pass**,
  including the flipped test. This is the load-bearing verification: it proves the upstream
  delete-side `CHECK` enforcement is actually in effect in the currently-installed `optimystic`
  dependency, not just that the test file's text was edited.
- Ran the full `cadre-core` suite: **52 files, 721 passed, 1 skipped** (a pre-existing
  Windows-only platform guard in `key-store.spec.ts`, unrelated). `yarn build` at the repo root
  is clean.

## Second ask: `removeMemberPeer` feasibility (still infeasible — schema gap, unchanged)

The ticket also asked to re-examine whether a `removeMemberPeer` writer is now feasible now that
delete-side `CHECK` enforcement has landed. **Still no** — a different, independent schema gap
blocks it: `MemberPeer.MemberExists` (`schemas/strand.qsql:123`) reads `new.MemberKey`
unconditionally:

```
constraint MemberExists check (exists (select 1 from Member M where M.Key = new.MemberKey)),
```

On `DELETE`, `new.MemberKey` is `NULL` (there is no new row), so the `exists` subquery is always
false and the constraint unconditionally rejects — a `MemberPeer` delete is rejected regardless
of signer, deferred-CHECK-on-delete enforcement notwithstanding. `MemberPeer.Authorized`
(the sibling constraint, line 126) already uses `coalesce(new.MemberKey, old.MemberKey)`, and
`Manager.Authorized` uses the same pattern for its delete branch (`schemas/strand.qsql:155`) — so
the fix, when someone takes it up, is a one-line schema change:
`coalesce(new.MemberKey, old.MemberKey)` in `MemberExists`. No `removeMemberPeer` writer function
exists today (`registerMemberPeer`'s doc comment in `strand-membership-writer.ts:487` states this
is out of scope), and this pass did not add one — the ticket said "re-examine feasibility," not
implement it, and it's still a schema change plus a new writer plus new tests, not a one-line
follow-up.

## Documentation fixed this pass

`docs/architecture.md` (`#### MemberPeer registration + manager rotation`) had two stale spots
left over from before the delete-enforcement fix landed:

- The **"Manager-removal hazards"** paragraph still had a "⚠️ Known platform gap" warning saying
  `removeManager` was "unauthenticated at runtime" — false as of `92f03b3`. Rewritten to describe
  the now-enforced behavior and name the pinning test. The separate, still-real
  "min-one-manager" schema hazard in the same paragraph (removing the last manager orphans the
  strand) was left as-is — that one is unrelated to the delete-enforcement gap and still open.
- The `registerMemberPeer` bullet referenced "the platform's unenforced PK-uniqueness — see the
  gap below," which was already stale before this pass (PK-uniqueness was fixed and documented
  by the sibling `flip-strand-membership-invite-known-gap` ticket, and "the gap below" no longer
  pointed at anything about PK uniqueness). Reworded, and expanded the peer-deletion note to name
  the actual current blocker (the `MemberExists` gap above) instead of a vague "would need a
  schema tweak."

## Review findings

None filed as new tickets — no major finding surfaced. The `MemberExists`-on-delete gap
described above is a **known, documented, out-of-scope** limitation (no code path calls a
`MemberPeer` delete; `removeMemberPeer` does not exist), not a live defect — it was already
called out as out-of-scope in the original ticket text and in the writer's own doc comment
before this pass. Recorded here (not filed as a ticket) per the tripwire convention: fine as
documented today; becomes real work only if/when someone decides `MemberPeer` removal is needed,
at which point the fix is already scoped above (one schema line + a new writer + tests).

## Validation

- `yarn build` (repo root) — clean, exit 0.
- `yarn vitest run` in `packages/cadre-core` — 52 files, 721 passed, 1 skipped (pre-existing,
  unrelated Windows platform guard).
- No pre-existing failures surfaced in this scope.
