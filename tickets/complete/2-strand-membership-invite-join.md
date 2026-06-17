description: Completed and reviewed — a strand admin can now invite someone and the invited person can join a private strand, and the member-registration service writes real membership records.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/canonical-datetime.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/enrollment.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, docs/architecture.md
----

# Complete: strand membership invite → join handshake + EnrollmentService backing

Implements and reviews `2-strand-membership-invite-join`. Builds on the landed
`strand-membership-founder-bootstrap`.

## What shipped

- **Invite writer API** (`strand-membership-writer.ts`): `issueInvite` (authority mints a
  single-use ed25519 invite, dual-signed by the authority key + the invite key),
  `consumeInvite` (atomic `Member` + `ConsumedInvite` in one explicit transaction so the
  mutually-circular deferred checks pass at commit), `addMemberByAuthority` (direct
  authority-admit branch), and `verifyStrandPayload` (off-engine verifier counterpart to
  `signStrandPayload`).
- **Shared `canonicalDatetime` helper** (`canonical-datetime.ts`): extracted from
  `ControlDatabase` (which now delegates) so a signed timestamp byte-matches the
  `datetime`-coerced column the deferred CHECK sees. DRY — one helper, two consumers.
- **EnrollmentService backing** (`strand-member-registry.ts`): `StrandMemberVerifier`
  (`verifyMember` self-proof check + `isAuthorizedToJoin` "door is open" pre-flight) and
  `StrandMemberRegistry` (`invite` vs `authority` admission), wired so
  `EnrollmentService.registerMember` writes real `Strand.*` rows. `index.ts` re-exports.

## Review findings

Adversarial pass over the implement-stage diff (commit `2d75971`). Read the diff first,
then the schema, the `EnrollmentService` seam it backs, and the runtime schema copy.

### Validation (all green from a clean tree)

- `yarn workspace @serfab/cadre-core test` → **511 passed (38 files)**, including the new
  `strand-membership-invite.spec.ts` (**17 tests**).
- `yarn workspace @serfab/cadre-core test control-database` → 1 passed (confirms the
  `canonicalDatetime` extraction did not regress its only consumer).
- `yarn workspace @serfab/cadre-core typecheck` → clean.
- `yarn eslint <all changed files>` → clean.

### What was checked

- **Signer/verifier byte-equivalence** (`signStrandPayload` vs `verifyStrandPayload` vs the
  in-engine `verify(digest(...))`): confirmed identical. The signer digests to raw bytes and
  signs with `inputEncoding='bytes'`; the verifier digests to base64url and verifies with
  `inputEncoding='base64url'` — both feed the *same* SHA-256 digest into ed25519. Exercised
  both true (phase-3 happy path) and false (bad-self-proof) directions.
- **Atomicity of `consumeInvite`**: the `beginTransaction`/`commit` + rollback-on-failure
  (swallowing only the post-failed-commit "no transaction active") is correct and mirrors
  `ControlDatabase.redeemInvitation`. The wrong-invite-key test pins that both rows roll back.
- **Constraint coverage**: issuance non-authority rejection, bad invite-key proof,
  open-strand `OnlyClosed`, canonical-vs-hand-rolled-ISO expiry, consume `InviteExists`,
  authority-admit non-authority rejection — all present and passing.
- **DRY / refactor**: `canonicalDatetime` extraction is clean delegation; no duplicated
  logic left in `ControlDatabase`. `index.ts` re-exports are complete and consistent.
- **Docs**: `docs/architecture.md` was updated with the invite→join handshake and
  EnrollmentService-backing sections and accurately reflects the shipped code, including the
  single-use platform-gap caveat. Verified against the actual diff — no drift.
- **Error handling / type safety**: no `any`, no swallowed exceptions beyond the documented
  rollback no-op, unused interface args correctly `_`-prefixed.

### Findings & disposition

- **MAJOR → new ticket filed** (`tickets/fix/strand-invite-expiration-not-enforced.md`):
  `Invite.Expiration` is canonicalised, signed, and stored, but **no constraint or code path
  ever compares it to the current time**. `ConsumedInvite.ValidUsage` checks only the invite
  signature (no `NotExpired`), and `isAuthorizedToJoin` counts invites with no expiry filter.
  An expired invite is fully consumable — the expiry field is currently decorative. The
  implement-stage tests cover *issuing* a set-expiry invite (which gives a false impression
  expiry works) but cannot cover *rejecting* an expired one because nothing enforces it. This
  spans the schema (both copies), the writer, the verifier, and needs research into how a
  deferred CHECK references a deterministic "now". Filed rather than fixed inline because it
  is a schema-design change with an open determinism question, not a one-line fix.

- **ACCEPTED / documented — single-use not enforced** (platform gap): the writer issues a
  correct ordinary insert; the optimystic bootstrap-mode vtab silently overwrites on
  duplicate PK, so `ConsumedInvite`'s single-use guarantee does not currently hold. I agree
  with the implementer's document-not-chase disposition — this is a platform-layer sibling of
  the fixed deferred-constraint-rollback bug, already filed as
  `optimystic-insert-pk-uniqueness-not-enforced` (backlog) with a sound recommendation to
  audit the control-layer single-use PKs too. The `KNOWN GAP` sentinel test correctly pins
  the buggy behavior so it fails loudly once the platform enforces uniqueness.

- **ACCEPTED / documented — `isAuthorizedToJoin` is mode-blind**: in `authority` admission
  the "door is open" pre-flight still requires at least one *outstanding* `Invite` to exist
  (the authority-mode happy-path test issues one purely to open the door), because the
  verifier and registry are separate objects with no shared admission-mode knowledge. This is
  the "loose reconciliation" the implementer flagged (gap #2): `MemberRegistration` carries no
  invite credentials, so the cryptographic gate lives in the deferred `Strand.*` constraints
  and the pre-flight is necessarily coarse. Left as-is — it is tied to the EnrollmentService
  API shape, which is expected to evolve when the credential-carrying / `MemberPeer` path
  (ticket 3) lands. Revisit the API shape there rather than patching the pre-flight now.

- **ACCEPTED / documented — `MemberPeer`/`peerIds` deferred to ticket 3**: a non-empty
  `peerIds` is logged and ignored; the member is still seated. Consistent with the plan.

- **ACCEPTED — bootstrap-mode only**: like the prior membership tickets, everything is
  tested on the solo-founder bootstrap path. Networked-mode membership writes and cross-node
  sync are out of scope here.

### No pre-existing test failures

No `tickets/.pre-existing-error.md` written — the full suite passes from a clean state. The
single-use gap is a non-failing, documented platform limitation (green-but-pinned sentinel),
not a failing test.
