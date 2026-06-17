description: Let a strand admin issue a single-use invitation and let an invited party redeem it to become a member of a private strand — the per-strand join handshake, enforced by signatures.
prereq: strand-membership-founder-bootstrap
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/enrollment.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, schemas/strand.qsql
difficulty: hard
----

## Context

Builds on `strand-membership-founder-bootstrap`, which landed the founder's `Header` +
founding `Member`/`Authority` and the shared `signStrandPayload` / `strandMemberKeyPair`
primitives in `strand-membership-writer.ts`. This ticket adds the **invite issuance +
consumption** path so a non-founding party can become a `Member` of a closed strand, and wires
the pre-existing-but-unimplemented `EnrollmentService` (`enrollment.ts`) Member Registration API
to a concrete strand-DB backing (the layer-2 reconciliation from ticket 1 — implement the
registry, do not duplicate the API).

## Constraints being satisfied (from `schemas/strand.qsql`)

- **`Invite.InviteValid` (`check on insert`)** — payload `new.Key || '|' || coalesce(new.Expiration,'')`:
  - issuer must be an `Authority`: `verify(digest(payload,'sha256','utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')` for some `A.MemberKey = context.AuthorityKey`, AND
  - proof the issuer holds the invite private key: `verify(digest(payload,...), context.InviteSignature, new.Key, 'ed25519')`.
  - Context: `AuthorityKey`, `AuthoritySignature`, `InviteSignature`.
- **`ConsumedInvite.ValidUsage` (`check on insert`)** — payload `new.InviteKey || '|' || new.MemberKey`:
  `verify(digest(payload,'sha256','utf8'), context.InviteSignature, new.InviteKey, 'ed25519')`
  (the consumer proves possession of the invite private key). Plus deferred `InviteExists`
  (`Invite` row present) and `MemberExists`/`MemberValid` (`Member` row present). Context: `InviteSignature`.
- **`Member.Authorized` (`check on insert`)** — admitted via the invite branch
  `exists (select 1 from ConsumedInvite CI where CI.MemberKey = new.Key)`. (No member signature
  is needed on the `Member` insert itself when a matching `ConsumedInvite` exists.)

## The circular dependency (settled — single transaction)

`Member.Authorized` (invite branch) needs a `ConsumedInvite` row, while
`ConsumedInvite.MemberExists`/`MemberValid` need a `Member` row. Both are **deferred**
(subquery-bearing) checks that evaluate at **commit**, not per-statement. Resolve by inserting
`Member` and `ConsumedInvite` in **one transaction** and committing once — at commit both rows
exist and both deferred checks pass. This mirrors `ControlDatabase.redeemInvitation`
(`control-database.ts:702`-`761`), which wraps a `Strand` insert + `FormationUsage` insert in
`beginTransaction()/commit()` with the same deferred-check-at-commit reasoning. Use that
try/commit/catch-rollback shape verbatim (note the comment at `control-database.ts:752`: a
failed `commit()` already tears down the txn, so the `rollback()` in `catch` must swallow its
own "no transaction active").

## Encodings

- `Invite.Key` is an **invite public key** in base64url (so the crypto plugin's `verify`
  consumes it directly). Generate a fresh invite ed25519 keypair per invite. The natural source
  is `generatePrivateKey('ed25519','base64url')` + `getPublicKey(...,'base64url','base64url')`
  from `@optimystic/quereus-plugin-crypto` (the same surface `rbac-signed-write` uses for member
  keys). The invite **private** key is handed out-of-band to the invitee (and, in production,
  delivered via the formation/seed channel — out of scope here).
- A joining member's `Member.Key` is that member's ed25519 **public** key (base64url); the
  member proves possession only indirectly here (via the invite signature) — direct member
  self-proof on writes is the `MemberPeer`/sApp path (ticket 3 / done).

## Expiration handling (edge — get this right)

`Invite.Expiration` is `datetime null`. When set, the signed payload segment must byte-match
what the deferred CHECK sees **after datetime coercion** — the engine-canonical `PlainDateTime`
string, NOT a hand-rolled ISO string. `ControlDatabase` already solves this with
`canonicalDatetime` (a `select datetime(?)` round-trip, `control-database.ts:678`); reuse that
approach (extract a tiny shared helper rather than duplicating). When `Expiration` is null, the
payload segment is `''` (`coalesce(new.Expiration,'')`). The first cut may issue null-expiration
invites, but if expiration is supported it MUST use the canonical-datetime round-trip or the
signature will not verify.

## API shape (in `strand-membership-writer.ts`)

- `issueInvite(db, { authorityKeyPair, expiration? }): Promise<{ inviteKey: string;
  invitePrivateKey: string }>` — generate invite keypair, build payload, sign with BOTH the
  authority key (→ `AuthoritySignature`) and the invite private key (→ `InviteSignature`), insert
  `Invite` with `with context AuthorityKey=?, AuthoritySignature=?, InviteSignature=?`.
- `consumeInvite(db, { inviteKey, invitePrivateKey, memberKey }): Promise<void>` — in one
  transaction: insert `Member (Key)` then `ConsumedInvite (InviteKey, MemberKey)` signed with the
  invite private key (`with context InviteSignature=?`), commit. `memberKey` is the joiner's
  ed25519 public key (base64url).
- `addMemberByAuthority(db, { authorityKeyPair, memberKey }): Promise<void>` — the direct
  authority-admit branch of `Member.Authorized` (payload `digest(new.Key)`, signed by an
  authority; `with context AuthorityKey=?, AuthoritySignature=?`). Sibling to the invite path.

## EnrollmentService backing (reconciliation)

Provide concrete `MemberRegistry` + `MemberVerifier` (`enrollment.ts:15`,`:34`) implementations
backed by a strand `Database`:
- `MemberRegistry.registerMember` → `consumeInvite`/`addMemberByAuthority` (writes `Member`,
  and `MemberPeer` rows for the supplied `peerIds` is ticket 3 — for now register the member; if
  `peerIds` are passed, defer peer rows to ticket 3 and document it).
- `MemberRegistry.isMemberRegistered` → `select count(1) from Strand.Member where Key=?`.
- `MemberVerifier.verifyMember` → verify the registration signature with `signStrandPayload`'s
  verifier counterpart; `isAuthorizedToJoin` → an `Invite`/`ConsumedInvite` exists for the key.
This makes `EnrollmentService.registerMember` write real `Strand.*` rows instead of returning
"MemberRegistry not configured". Do not add a second invite model — these tables ARE the model.

## Edge cases & interactions

- **Atomic consumption**: `Member` + `ConsumedInvite` must commit together. Test that a forced
  failure on the second insert leaves NEITHER row (rollback), and a clean run leaves BOTH.
- **Unauthorized issuance**: `issueInvite` signed by a non-authority key (not in `Authority`)
  must be rejected. Test with a member who is not an authority.
- **Invite-key proof**: an `Invite` insert whose `InviteSignature` is over a different key /
  payload must be rejected (the `verify(..., new.Key, ...)` branch).
- **Wrong invite private key on consume**: `consumeInvite` with a private key not matching
  `inviteKey` must be rejected (`ConsumedInvite.ValidUsage`).
- **Consume without a matching Invite**: rejected by deferred `InviteExists`.
- **Double consumption / replay**: `ConsumedInvite` PK is `InviteKey`; a second consume of the
  same invite must be rejected (PK / `InsertOnly`). Document single-use semantics vs. control-layer
  `FormationUsage` single-use (two different layers, both single-use).
- **Open strand**: `Invite`/`ConsumedInvite`/`Member` are `OnlyClosed`; issuing/consuming on an
  open strand must be rejected. Assert.
- **Expiration signature**: a set-expiration invite must verify (canonical datetime); a
  hand-rolled ISO string must fail — cover both so the canonicalization is actually exercised.
- **bootstrap-mode rejection rollback**: per the known optimystic bug
  (`optimystic-deferred-constraint-rejection-not-rolled-back`, backlog), a *rejected* deferred
  write may leave a row committed in bootstrap mode. For the rejection assertions, "throws" is
  the floor (same disposition as `apply-strand-membership-schema`). Do not chase that platform
  bug here; if it surfaces, note it per the pre-existing-error protocol.
- **Founder is already a Member+Authority** (from ticket 1): issuing an invite as the founder
  authority and admitting a *second*, distinct member must take the non-bootstrap branches
  (`count > 1`), i.e. genuinely exercises signature verification, not the `count<=1` shortcut.

## TODO

### Phase 1 — invite issuance
- `issueInvite` + shared canonical-datetime helper. Component test against a real closed strand
  DB (founder bootstrapped): authority issues invite → one `Invite` row; non-authority rejected;
  bad invite-key proof rejected; open-strand issuance rejected.

### Phase 2 — invite consumption (atomic)
- `consumeInvite` (single transaction, `beginTransaction/commit` per `redeemInvitation`) +
  `addMemberByAuthority`. Tests: valid consume admits a second `Member` (+`ConsumedInvite`);
  wrong/missing invite key rejected; double-consume rejected; forced mid-txn failure rolls back
  both rows.

### Phase 3 — EnrollmentService backing
- Strand-DB-backed `MemberRegistry` + `MemberVerifier`; `EnrollmentService.registerMember`
  end-to-end writes a `Member` via a valid invite. Test the happy path + the unauthorized/already
  -registered branches.

### Phase 4 — validate
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-invite.log` (stream). Lint + typecheck changed files.
- Update `docs/architecture.md` membership section with the invite→join handshake and the
  EnrollmentService backing.
