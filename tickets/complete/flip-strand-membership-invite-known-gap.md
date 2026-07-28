description: Confirmed that reusing the same one-time strand invite twice is now correctly refused, and brought the stale documentation and code comments that still said otherwise up to date.
files: packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/src/strand-membership-writer.ts, docs/architecture.md
difficulty: easy
----

## Summary

The original ticket asked to flip a test in `strand-membership-invite.spec.ts` that pinned a
bug: a single-use strand invite could be consumed twice, silently overwriting the
`Strand.ConsumedInvite` row and admitting a second member (a replay). The root cause lived
in the `optimystic` workspace — its virtual-table transactor did not reject an `INSERT`
that reused an existing primary key.

The upstream fix landed, and the test was already flipped by commit `92f03b3`
("tess: triage pre-existing test failure") during an earlier ticket run. The implement pass
for this ticket therefore made no source change; it only moved the ticket file forward.

This review pass verified the claim independently, then fixed the documentation and comments
that the earlier flip left behind.

## What the invite path does now

`consumeInvite` inserts a `Strand.Member` row and a `Strand.ConsumedInvite` row inside one
transaction. `ConsumedInvite`'s primary key is `InviteKey`, so a second consume of the same
invite collides on that key and is rejected with
`UNIQUE constraint failed: ConsumedInvite.InviteKey`. The whole transaction rolls back, so
no second member is admitted and the first consumer's row survives untouched.

## Review findings

### Verification of the implement pass's central claim

- Read the implement commit `905711d` first: it is a ticket-file move only — zero source
  diff. The handoff's own summary says as much, and that checks out.
- Independently confirmed the flip in `92f03b3` and read the current test at
  `packages/cadre-core/test/strand-membership-invite.spec.ts:358`.
- **Checked that the test can't pass for the wrong reason.** This was the main risk: if
  `consumeInvite` deleted the `Invite` row on consume, the second call would fail with
  "no matching invite" and the test would go green without ever exercising primary-key
  uniqueness. Read `strand-membership-writer.ts:371` — `consumeInvite` does **not** delete
  the invite, and the replaying member uses a fresh key so its `Member` insert succeeds.
  The rejection genuinely comes from the `ConsumedInvite` primary key.

### Minor findings — all fixed in this pass

- **The test's rejection assertion was unspecific.** It asserted only "throws". Tightened it
  to match the message `UNIQUE constraint failed: ConsumedInvite.InviteKey`, so the test
  cannot silently start passing for an unrelated failure. Confirmed the message is stable —
  it is rendered by `uniqueConstraintMessage` in optimystic's `optimystic-module.ts`.
- **`docs/architecture.md` still described the bug as live.** The "Single-use layering"
  paragraph carried a "Known platform gap" warning stating the single-use guarantee was
  "not currently enforced" and an invite could be replayed. That is now false. Rewritten to
  describe the enforced behavior and to name the test that pins it.
- **Two stale code comments** claimed primary-key uniqueness "is not enforced in bootstrap
  mode", citing the now-closed upstream ticket:
  `strand-membership-writer.ts` (the `registerMemberPeer` doc comment) and
  `strand-membership-peer-rotation.spec.ts:170`. Both reworded. The insert-if-absent design
  they explain is still correct — a restart-safe re-register should succeed quietly rather
  than throw — only the stated reason was wrong.
  - Note: the peer-rotation spec is also touched by the sibling ticket
    `flip-strand-membership-rotation-known-gap`, still in `implement/`. That ticket concerns
    a *different* platform gap (deferred checks not evaluated on `DELETE`) in a different
    test; this edit is a two-line comment fix well away from it.

### Major findings

None. No new tickets filed. The change under review is a test-behavior flip that is correct,
green, and now honestly documented.

### Tripwire recorded (not a ticket)

The end-to-end integration test for closed-strand membership asserts only that a rejected
write throws, without checking that state rolled back. Part of the original justification
for that looseness was the duplicate-primary-key bug, which is now fixed — but only verified
against the local (bootstrap-mode) transactor, not the networked one that the integration
test uses. Parked as a qualifying sentence in `docs/architecture.md` in the closed-strand
end-to-end paragraph: if someone re-verifies the networked path, that assertion can be
tightened. Not worth a ticket now — that integration test is already blocked on
`control-db-convergence-optimystic-p2p`.

### Test coverage assessment

The file's 25 tests cover issuance (manager-only, invite-key proof, closed-strand gating,
expiration canonicalization), consumption (happy path, wrong key, no matching invite,
expired past/future/exact-boundary/null-expiry, and now double-consume), manager-direct
admit, the `isAuthorizedToJoin` pre-flight's expiry filtering, and the `EnrollmentService`
end-to-end paths. No gap worth a ticket. The double-consume test now checks all four things
that matter: it rejects, the rejection reason is right, no second member is admitted, and
the surviving row still points at the first consumer.

## Validation

- `yarn lint` — clean, exit 0.
- `yarn workspace @serfab/cadre-core test` — 52 files, 721 passed, 1 skipped. The skip is a
  Windows-only platform guard on a file-permission test (`key-store.spec.ts`), not a
  disabled failure.
- No pre-existing failures surfaced in this scope.
