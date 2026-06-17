description: Review the new single-use invitation flow that lets a strand admin invite someone and lets the invited person join a private strand, plus the member-registration service now wired to write real membership records.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/canonical-datetime.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/enrollment.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, schemas/strand.qsql, docs/architecture.md, tickets/backlog/optimystic-insert-pk-uniqueness-not-enforced.md
difficulty: hard
----

# Review: strand membership invite → join handshake + EnrollmentService backing

Implements `2-strand-membership-invite-join` (was `tickets/implement/`). Builds on the
landed `strand-membership-founder-bootstrap` (founder `Header`+`Member`+`Authority` and the
`signStrandPayload`/`strandMemberKeyPair` primitives).

## What shipped

**Invite writer API** (`strand-membership-writer.ts`, added to the existing founder-bootstrap module):
- `issueInvite(db, { authorityKeyPair, expiration? }) → { inviteKey, invitePrivateKey }` —
  mints a fresh ed25519 invite keypair, signs `Key || '|' || coalesce(Expiration,'')` with BOTH
  the authority key (→ `AuthoritySignature`) and the invite private key (→ `InviteSignature`),
  inserts `Strand.Invite`. Returns the out-of-band invite private seed (never persisted).
- `consumeInvite(db, { inviteKey, invitePrivateKey, memberKey })` — inserts `Member` then
  `ConsumedInvite` **in one explicit transaction** (`beginTransaction`/`commit`, mirroring
  `ControlDatabase.redeemInvitation`) so the mutually-circular deferred checks pass at commit;
  catch → rollback (swallowing the "no transaction active" after a failed commit).
- `addMemberByAuthority(db, { authorityKeyPair, memberKey })` — the direct authority-admit branch
  (signs `digest(new.Key)`).
- `verifyStrandPayload(payload, signature, pubkey)` — the off-engine verifier counterpart to
  `signStrandPayload`.

**Shared canonical-datetime helper** (`canonical-datetime.ts`): extracted `canonicalDatetime(db, epochMs)`
(a `select datetime(?)` round-trip) out of `ControlDatabase` (which now delegates to it) so the
signed `Invite.Expiration` segment byte-matches the `datetime`-coerced column the deferred CHECK
sees. DRY — one helper, two consumers.

**EnrollmentService backing** (`strand-member-registry.ts`):
- `StrandMemberVerifier(db)` — `verifyMember` checks the self-proof over
  `memberRegistrationPayload` (`strandId || '|' || memberKey`); `isAuthorizedToJoin` is a
  "door is open" check (a `ConsumedInvite` for the key, or any outstanding `Invite`).
- `StrandMemberRegistry(db, admission)` — `admission` is `{mode:'invite', inviteKey, invitePrivateKey}`
  → `consumeInvite`, or `{mode:'authority', authorityKeyPair}` → `addMemberByAuthority`.
  `isMemberRegistered` = `select count(1) from Strand.Member where Key=?`.
- Wired so `EnrollmentService.registerMember` writes real `Strand.*` rows.

`index.ts` re-exports all of the above.

## How to validate

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-invite.log` — **511 passed (38 files)**,
  including the new `test/strand-membership-invite.spec.ts` (**17 tests**).
- `yarn workspace @serfab/cadre-core typecheck` — clean (src + test).
- `yarn eslint <changed files>` — clean.
- All membership tests run a **real closed strand DB in bootstrap mode** (libp2p node +
  `MemoryRawStorage` + the optimystic local transactor) via `connectToStrand` — the same path
  `StrandDatabase` uses — so the real apply/DML/deferred-constraint path is exercised, not a fake.

## Test coverage (the floor — extend past it)

Phase 1 (issuance): authority issues 1 invite (Key === returned pubkey); non-authority rejected;
bad invite-key proof rejected; open-strand issuance rejected (OnlyClosed); set-expiration invite
verifies via canonical datetime; **hand-rolled ISO string fails** (proves canonicalization matters).
Phase 2 (consumption): valid consume admits a 2nd Member + ConsumedInvite; wrong invite private
key rejected **and rolls back both rows** (atomicity, relying on the now-fixed deferred-constraint
rollback); consume with no matching Invite rejected; `addMemberByAuthority` admits a 2nd member
(non-bootstrap branch, count>1) / non-authority rejected.
Phase 3 (enrollment): happy path writes a Member via a valid invite; bad self-proof rejected;
no-invite → "not authorized"; already-registered rejected; authority-mode admit (no ConsumedInvite).

## Gaps & things to scrutinize (treat my work as a starting point)

1. **⚠️ Single-use is NOT actually enforced — platform gap.** The schema relies on
   `ConsumedInvite`'s PK (`InviteKey`) to make invites single-use, but the optimystic
   bootstrap-mode vtab transactor **does not enforce PK uniqueness on INSERT** — a duplicate-PK
   insert silently **overwrites** (verified: `optimystic-module.ts` `case 'insert'` stages
   `[insertKey, …]` with no existence check; classified as `'insert'` so `InsertOnly` never
   fires). Net effect: an invite can be **replayed** (second consume overwrites the
   `ConsumedInvite` row and admits a second member). Confirmed empirically (members 2→3,
   ConsumedInvite overwritten B→C). This is a platform-layer issue (sibling of the fixed
   `optimystic-deferred-constraint-rejection-not-rolled-back`), NOT in this diff. Filed
   `tickets/backlog/optimystic-insert-pk-uniqueness-not-enforced.md`; **likely also affects
   control-layer single-use (`FormationInvite.Token`, `Strand.Id`, `FormationUsage`) — audit
   recommended.** The double-consume test pins the **actual (buggy)** behavior as a sentinel
   (`it('KNOWN GAP: a double consume currently overwrites …')`) so it fails loudly once the
   platform enforces uniqueness, prompting the assertions to flip to `rejects.toThrow()`.
   Reviewer: confirm you agree with documenting-not-chasing here.

2. **EnrollmentService reconciliation is necessarily loose.** `MemberRegistration` (`{strandId,
   key, peerIds}`) carries no invite credentials, so the invite material is supplied to the
   **registry at construction** via `StrandAdmission`, not per-call. `isAuthorizedToJoin` is a
   "door is open" pre-flight (strand invites are anonymous — `Invite.Key` is an invite pubkey,
   not bound to a member key), with the real cryptographic gate enforced by the deferred
   `Strand.*` constraints at write time. Scrutinize whether this is the right shape or whether
   the API should grow to carry invite credentials.

3. **`memberRegistrationPayload` = `strandId || '|' || memberKey`** — I chose this binding;
   `peerIds` are intentionally NOT in the payload (peer rows are ticket 3). Confirm the binding is
   sufficient (it prevents cross-strand replay of a registration signature).

4. **`MemberPeer` rows deferred to ticket 3.** A non-empty `peerIds` is logged and ignored; the
   member is still seated. `MemberVerifier`/`MemberRegistry` JSDoc and the registry log say so.

5. **Bootstrap-mode only.** Like the prior membership tickets, everything is tested on the solo-
   founder bootstrap path (`selectStrandMode` returns `bootstrap` for a solo node). Networked-mode
   membership writes + cross-node membership sync are not exercised here.

6. **`expiration` is epoch-ms** (matching `ControlDatabase`'s `canonicalDatetime` contract).
   First cut supports both null-expiry and set-expiry invites (both covered).

## No pre-existing test failures

No `tickets/.pre-existing-error.md` written — the full suite passes from a clean state. The
single-use gap is a non-failing **known platform limitation** (the writer issues a correct
insert; the platform should reject the duplicate), filed as a backlog ticket rather than via the
pre-existing-error protocol (that protocol is for *failing* tests; this is green-but-documented).
