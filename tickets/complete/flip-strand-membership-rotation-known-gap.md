description: Confirmed that removing a strand manager without authorization is now correctly rejected, brought stale documentation up to date, and added a test for a removal signed over the wrong key.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, docs/architecture.md, schemas/strand.qsql
----

## Summary

A strand's manager list (`Strand.Manager`) is guarded by a signature constraint (`Manager.Authorized`).
That constraint uses a subquery, so the storage engine treats it as *deferred* (evaluated at commit).
The engine used to evaluate deferred constraints only on insert — never on delete — so **anyone could
delete a manager row with any signature**. The engine fix landed upstream (in the sibling `optimystic`
repo). This ticket's job was to confirm the fix is genuinely in effect here and clean up everything
that still described the old, insecure behavior.

Result: the fix is real and verified against the actual engine (not a mock). Docs and code comments
that still claimed "unenforced" are now corrected. One test gap on the delete path was closed.

## What was verified

- The pinning test `strand-membership-peer-rotation.spec.ts` →
  `describe('removeManager')` → `'a non-manager removal is rejected (deferred CHECK enforced on
  delete)'` passes against a real closed strand database in bootstrap mode (real libp2p node,
  real storage, real transactor). Starting from 3 managers, a removal signed by a key that is
  neither a manager nor the target throws, and all 3 rows survive.
- Full `cadre-core` suite green.

## Changes made in this review pass

- **`packages/cadre-core/src/strand-membership-writer.ts`** — `removeManager`'s doc comment still
  carried a `KNOWN PLATFORM GAP` block asserting authorization was "effectively unenforced at
  runtime", and referenced a PK-uniqueness gap that also closed earlier. The implement pass fixed
  `docs/architecture.md` but missed this source comment — the one a reader of the writer actually
  meets. Replaced with a statement of the enforced behavior. The separate `KNOWN SCHEMA HAZARD`
  block below it (min-one-manager) is still accurate and was left alone.
- **`strand-membership-peer-rotation.spec.ts`** — dropped a stale "once delete enforcement lands"
  aside, fixed two "an manager" grammar slips left over from the `Authority`→`Manager` rename, and
  added a test: **a real manager signs a removal over the wrong key → rejected, 3 rows intact.**
  This is the delete-side analog of the existing `addManager` signature-binding test and covers a
  branch nothing exercised before (signer *is* a manager, but the signature doesn't bind the row
  being deleted). It fails correctly, i.e. the engine's delete-side evaluation binds
  `old.MemberKey` as intended, not merely "some deferred check ran".

## Review findings

**Checked:** the implement diff (docs-only, 4 lines in `docs/architecture.md`); the full history of
the test file to confirm the flip is genuine and never reverted; `schemas/strand.qsql`
`Manager.Authorized` / `MemberPeer.MemberExists` / `MemberPeer.Authorized` against every prose claim
made about them; a repo-wide sweep for surviving "known gap" / "unenforced" / "not enforced on
delete" text across `docs/`, `packages/`, `schemas/`; test coverage of both the insert and delete
sides of manager rotation.

**Found and fixed inline (minor):** the stale `KNOWN PLATFORM GAP` doc comment in
`strand-membership-writer.ts`; the stale test comment and two grammar slips; the missing
delete-side signature-binding test. All listed above.

**Filed as new tickets: none.** No major finding surfaced. The implement pass's core claim (the
flip is genuine, verified against the real engine) held up under re-verification; its documentation
edits to `docs/architecture.md` are accurate as written. What it missed was one stale comment in
the source file it names in its own `files:` header — a miss, but a one-line one, fixed here.

**Tripwires (recorded, not ticketed):**

- *`MemberPeer` rows can never be deleted.* `MemberPeer.MemberExists` (`schemas/strand.qsql:123`)
  reads `new.MemberKey`, which is null on a delete, so the constraint rejects every `MemberPeer`
  delete regardless of who signs it — delete-side enforcement of the *other* constraint doesn't
  help. Genuinely conditional today: no code path deletes a `MemberPeer`, and no `removeMemberPeer`
  writer exists. It becomes real work only if someone decides members must be able to unbind a
  device, at which point the fix is one schema line (`coalesce(new.MemberKey, old.MemberKey)`,
  mirroring the sibling `Authorized` constraint) plus a writer plus tests. Parked as a doc note in
  `registerMemberPeer`'s comment (`strand-membership-writer.ts:487`) and in `docs/architecture.md`.
- *A stale premise in a queued plan ticket.* `tickets/plan/strand-min-one-authority-invariant.md`
  still states that manager-removal authorization "today it does not" run — written before the
  engine fix landed, and now false. Not edited here (that ticket belongs to another stage and may
  be in flight); flagged so whoever picks it up re-reads the schema rather than trusting the
  premise. The *substance* of that ticket — removing the last manager orphans the strand — is
  unaffected and still open.

**Not done, deliberately:** no pinning test was added for the min-one-manager hazard (removing
down to ≤ 1 manager is accepted regardless of signature, because the schema's bootstrap branch
`count(Manager) <= 1` is true at commit). That's the subject of the open plan ticket above, and
pinning insecure behavior in a test here would duplicate work that ticket owns.

## Validation

- `yarn lint` (repo root) — exit 0, clean.
- `yarn build` (repo root) — exit 0.
- `yarn vitest run test/strand-membership-peer-rotation.spec.ts` in `packages/cadre-core` —
  15/15 pass (was 14; +1 new).
- `yarn vitest run` in `packages/cadre-core` — 52 files, 722 passed, 1 skipped (the skip is a
  pre-existing Windows-only platform guard in `key-store.spec.ts`, unrelated to this work).
- No pre-existing failures surfaced.
