description: When someone joins one of a party's networks, the record of that join names who joined, but nobody checks that the named person actually agreed to it. Make the joiner sign its own join, carry that signature over the wire, and refuse the record without it.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/formation-approval.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/api.md
difficulty: hard
----

# The joining peer signs its own formation record

## Today

`CadreControl.FormationUsage` records one redemption of a `FormationInvite`. The row's
`PeerId` column names the joining peer. The insert carries a `context.PeerSignature` value
that **no constraint reads** — it is declared in the table's write context
(`schemas/control.qsql`, `FormationUsage ... with context (PeerSignature text, ...)`) and
dropped.

The node that performs the insert is the *inviting* party's node (the formation
**responder**), not the joiner's. So the joiner's identity on the row is whatever the
responder asserts. When the invite carries a `ValidationUrl`, an outside approver signs a
digest that includes `PeerId`, so one approval cannot be re-filed under a different name —
but nothing proves the named joiner ever took part.

Where the joiner's identity comes from: `StrandSolicitationService.formStrand`
(`strand-solicitation.ts`) mints a **fresh Ed25519 keypair per formation call**, sets
`memberKey = peerIdFromPrivateKey(privateKey).toString()`, and overrides
`disclosure.partyId` with it before handing off to `StrandFormationManager.formStrand`. The
responder writes that string as `FormationUsage.PeerId`. **The joiner holds the private
half** — it just never signs anything with it during formation.

## The change, in one line

The joiner mints the redemption nonce, signs a digest over its own join, ships both in the
formation contact message; the responder writes them onto the row; a new schema constraint
verifies the signature against the joiner's own public key and refuses the row otherwise.

## Design decisions (settled — do not re-open)

### 1. The identity column becomes the public key, not the peer-id string

Rename `FormationUsage.PeerId` → **`PeerKey`**, holding the joiner's base64url Ed25519
**public key** (32 bytes), not a libp2p peer-id string.

Why: the schema's `verify(...)` takes a base64url raw key. A peer-id string is an identity
multihash *wrapping* that key, and SQL has no function to unwrap it. The alternative —
keep `PeerId` and add a separate `PeerKey` column, as `CadrePeer` does — leaves the
key↔peer-id binding unverifiable at write time (`CadrePeer` gets away with it because an
*owner* signs over the peer id; `FormationUsage` has no owner signature at all). Storing
the key **is** the identity removes the binding problem instead of relocating it.

Nothing reads `FormationUsage.PeerId` back today (no `select` of it anywhere in the repo),
so this rename costs no reader. The libp2p peer id stays derivable from the key for display
— an Ed25519 peer id is the identity multihash of exactly these bytes.

Producer side: in `strand-solicitation.ts:formStrand`, use the existing
`ed25519KeyPairFromLibp2p(privateKey)` (`ed25519-key.ts`) to get
`{ privateKeyB64, publicKeyB64 }` from the freshly minted libp2p key. `publicKeyB64` is the
new `PeerKey`; `privateKeyB64` signs. No new key derivation code is needed.

### 2. The joiner mints the redemption nonce — no extra round trip

`FormationUsage.UsageStampId` is today minted by the *responder*
(`ControlFormationUsageRecorder.obtainApproval` → `ControlDatabase.mintUsageStampId`, or
`recordFormationUsage`'s `generateStampId` fallback). Move the mint to the **joiner**, sent
in `FormationContactMessage`.

Why: for the joiner's signature to be single-use it must cover the nonce, and the joiner
must sign *before* it sends. With a responder-minted nonce the joiner would have to sign a
value it learns only in a second round trip. Joiner-minted keeps the protocol at its
current 2 messages and leaves the whole timeout ladder
(`strand-formation-protocol.ts`: approval hook 10 s < responder provisioning 12 s <
initiator await-response 15 s < session 30 s), the settle-grace semantics, and the
cadre-disclosure timing rule untouched.

Safety of moving the mint: the nonce's only job is single-use-ness, enforced by the
column's `unique`. A joiner that supplies a colliding or reused nonce fails its own insert
— self-harm, no cross-party effect. The responder must use the joiner's value verbatim for
**both** the approval request and the insert; signing one nonce and inserting another
already fails `FormationUsage.Authorized`.

### 3. What the joiner signs — and what it deliberately does not

    digest('CadreControl.FormationUsage', 'consent',
           new.Token, new.UsageStampId, new.PeerKey, new.Disclosure)

Distinct **action tag** `'consent'` vs the approver's `'vouch'`, so the two signatures are
never interchangeable — the same discipline `CadrePeer` applies between `'vouch'` and
`'remove'`. This matters more than usual here because, like `CadrePeer.VouchSig`, the
joiner's signature is **stored and replicated**, so it must be inert against every other
rule in the schema.

`'consent'` is a new member of the `ControlAction` union in `control-authorization.ts`;
extend the union and its doc comment.

**`StrandId` is deliberately NOT in the joiner's digest.** The joiner does not know the
strand id when it sends contact: a bound invite's host strand id reaches it only in the
result frame, and an unbound redemption's strand is minted by the responder
(`ControlFormationUsageRecorder.provisionAndRecord`). Binding it would force a
challenge/response round trip.

The tradeoff this accepts: the joiner's consent says *"I, holder of this key, consented to
redeem token T with disclosure D, once"* — not *"…against strand X"*. That is adequate
because the responder cannot freely choose the strand anyway:

- **bound invite** — `FormationUsage.Authorized` already pins it (`FI.StrandId is null or
  FI.StrandId = new.StrandId`);
- **unbound invite** — the responder mints a fresh strand; there is no victim strand to
  substitute.

The signature is still strictly single-use: one nonce, one row, `unique` on the column.
Record this reasoning as a `NOTE:` comment beside the constraint so a future reader does
not read the missing `StrandId` as an oversight.

### 4. The signature is stored on the row, not passed in context

Add a **`PeerSig`** column (base64url ed25519). `context.PeerSignature` is **removed** from
the table's context declaration entirely.

Why stored: the ticket's audit requirement — a reader must be able to re-check the record
after the fact, exactly as `CadrePeer.VouchOwner`/`VouchSig` allow. `FormationUsage` is
append-only (`InsertOnly check on update, delete (false)`), so a stored signature can never
be tampered with after the fact — a stronger position than `CadrePeer`, whose row is
updatable.

New constraint, alongside the existing `Authorized`:

```sql
-- The JOINING peer proves it consented to this redemption: PeerKey is its own ed25519
-- public key and PeerSig is its signature over the 'consent'-tagged digest below.
-- Unlike the approver's sign-off (context.ValidationSignature, checked against a STORED
-- ValidationKey row), the identity here IS the key, so there is no enrolled row to look
-- up and nothing for a writer to substitute: a forged joiner would need that joiner's
-- private key. Stored rather than passed in context so any later reader can re-check it;
-- the 'consent' action tag keeps this replicated signature useless against every other
-- rule in this schema (notably the approver's 'vouch' digest over the same table).
constraint PeerConsented check on insert (
    verify(digest('CadreControl.FormationUsage', 'consent',
                  new.Token, new.UsageStampId, new.PeerKey, new.Disclosure),
           new.PeerSig, new.PeerKey, 'ed25519')
),
```

Both columns are `not null` — every redemption path must now carry consent. There is no
"unsigned join" mode.

### 5. Disclosure bytes must be canonical on both sides

The joiner signs the disclosure **text**; the responder writes it and the approver signs
it. Today `StrandFormationManager.provisionAsResponder` produces that text with
`JSON.stringify(disclosure)` on the *parsed* wire object, while the joiner would produce it
from its own object — key order can diverge and the signature silently fails.

Fix: both sides derive the disclosure text through the repo's existing
`canonical-json.ts:canonicalJson`, and that canonical string is what is signed *and* what
is written to `FormationUsage.Disclosure`. Keep the "serialized ONCE" comment in
`provisionAsResponder` and update it to say *canonically* serialized on both sides. The
`MAX_DISCLOSURE_BYTES` (8 KiB) cap still applies to the canonical bytes, still before any
DB read or hook contact.

### 6. Hook wire contract renames `peerId` → `peerKey`

`FormationApprovalRequest` / `FormationVouchFields` (`formation-approval.ts`) and
`formationVouchMessage` (`control-database.ts`) carry `peerId`; the approver's digest binds
it. That field becomes `peerKey` and carries the public key. `docs/api.md` documents the
POST body (`{ token, usageStampId, strandId, peerId, disclosure }`) — update it, and note
that the value is now the joiner's Ed25519 public key, with the libp2p peer id derivable
from it. Per AGENTS.md there is no backwards-compat obligation.

## Wire format

`FormationContactMessage` (`strand-formation-protocol.ts`) gains three fields:

```ts
export interface FormationContactMessage {
  token: string;
  /** Initiator's member key (peer id). */
  partyId: string;
  /** Initiator's base64url ed25519 PUBLIC key — the key behind `partyId`, written to `FormationUsage.PeerKey`. */
  peerKey: string;
  /** Single-use nonce the JOINER minted for this redemption; written to `UsageStampId`. */
  usageStampId: string;
  /** Joiner's signature over the 'consent' digest (see `formationConsentMessage`). */
  peerSignature: string;
  disclosure: StrandFormationDisclosure;
  cadrePeerAddrs: string[];
}
```

`partyId` stays — it is the human-facing identity in logs and in `FormStrandResult.memberKey`.

Responder-side validation, in `FormationListener.runSession`, **before** provisioning and
before any disclosure of responder identity: reject with `approved: false, reason:
'Invalid joiner consent'` when `peerKey` is not a well-formed base64url 32-byte key
(reuse `requireEd25519PublicKeyB64` from `ed25519-key.ts`, catching its throw), when
`peerKey` does not match the key embedded in `partyId`
(`ed25519PublicKeyB64FromPeerId(partyId)` from `seed-bootstrap.ts`), or when the signature
does not verify locally. The database constraint remains the authority — this is the
legibility pre-check, exactly as `verifyFormationApproval` is for the approver's sign-off.

The `partyId`↔`peerKey` agreement check is what keeps `partyId` honest; it lives only here
(SQL cannot unwrap a multihash), which is fine because `partyId` is not stored.

## New helpers

In `control-database.ts`, beside `formationVouchMessage`:

```ts
/** Bytes the JOINING peer signs to consent to ONE redemption. */
export function formationConsentMessage(fields: {
  token: string; usageStampId: string; peerKey: string; disclosure: string;
}): Uint8Array;
```

In `peer-authorization.ts` (the import-free lightweight verifier module), the read-side
mirror, matching the `verifyCadrePeerVoucher` shape and its never-throws contract:

```ts
/** Re-check a stored FormationUsage consent signature. Returns false, never throws. */
export function verifyFormationConsent(row: {
  token: string; usageStampId: string; peerKey: string; disclosure: string; peerSig: string;
}): boolean;
```

Export both from `index.ts`.

## Edge cases & interactions

- **Nonce reuse by the joiner.** Two formation attempts reusing one `usageStampId`: the
  second insert fails `unique`. Must surface as a clean `approved: false` rejection, not a
  dropped result frame — `provisionAsResponder`'s catch already maps unknown write failures
  to `'Formation conflict, retry'`; confirm it covers this and that the invite is unspent.
- **Approval + consent both required.** A `ValidationUrl` invite now needs the approver's
  `'vouch'` signature *and* the joiner's `'consent'` signature. Both cover
  `(Token, UsageStampId, Disclosure)`; both must be over the *same* canonical disclosure
  bytes and the *same* nonce. A test must assert that a mismatch in either fails.
- **Cross-signature substitution.** Assert explicitly that the joiner's `'consent'`
  signature does not satisfy the approver's `'vouch'` check and vice versa, and that a
  `'consent'` signature cannot satisfy any other table's rule (the reason for the action
  tag).
- **Lifting consent onto another row.** Same key, same token, *different* nonce → verify
  fails. Same nonce → `unique` refuses. Different disclosure text → verify fails. Cover all
  three.
- **`redeemInvitation` (unbound) vs `recordFormationUsage` (bound).** Both write paths must
  thread `peerKey` / `peerSignature` / joiner-supplied `usageStampId`. `redeemInvitation`
  writes `Strand` + `FormationUsage` in one transaction with deferred CHECKs — confirm the
  new `PeerConsented` constraint (no subquery, so **not** deferred) still evaluates
  correctly there.
- **`obtainApproval` no longer mints.** It must take the nonce from its caller. The
  `validationUrl === null` early return currently skips minting entirely and lets the DB
  mint — that fallback disappears; the joiner's nonce is used in both cases.
- **Non-Ed25519 / malformed `partyId`.** `ed25519PublicKeyB64FromPeerId` returns `null`;
  reject before provisioning. No path should reach the insert with a null key.
- **Concurrent redemptions of one multi-use invite.** Two joiners, two nonces, two keys,
  `(Token, UseNumber)` PK race unchanged. The loser's rejection must still leave its
  consent signature re-presentable under a new use number (the free-nonce property the
  schema comment describes) — do not accidentally bar it.
- **Abort/settle-grace paths.** `FormationAbortedError` handling in
  `provisionAsResponder` and `settleWithinGrace` must be unaffected; a consent-check
  rejection is an ordinary `approved: false`, not an abort.
- **Direct-manager tests.** Integration tests that call `CadreNode.formStrand` with a
  hand-written `partyId` (e.g. `partyId: 'party-b-excl-…'` in
  `multi-party-workflows.integration.ts`, `strand-formation-e2e.integration.ts`) are safe —
  `StrandSolicitationService.formStrand` overrides `partyId` with the minted `memberKey`.
  Any test that drives `StrandFormationManager` directly must be updated to supply real
  key material.
- **`StrandProvisioner` / no-recorder fallbacks.** `provisionUnbound`'s provisioner and
  structural-placeholder branches write no `FormationUsage` row, so they need no consent —
  but the listener's pre-check runs regardless, so their tests must still send a
  well-formed contact message.

## Key tests (TDD — write these first)

Schema-level (`packages/cadre-core/test/control-formation-invite.spec.ts`, which already
issues the raw `insert … with context PeerSignature = ?` and must be rewritten):

- insert with a valid `(PeerKey, PeerSig)` pair → accepted.
- insert with `PeerSig` signed by a *different* key → `CHECK constraint failed: PeerConsented`.
- insert with a signature valid over a *different* `(Token | UsageStampId | Disclosure)` →
  rejected.
- insert reusing a spent `UsageStampId` → rejected by `unique`, not by `PeerConsented`.
- the approver's `'vouch'` signature presented as `PeerSig` → rejected (tag disjointness).
- `verifyFormationConsent` returns `true` for a row read back out of the table, `false`
  after mutating any signed field, and `false` (never throws) on garbage input.

Protocol/manager-level:

- responder rejects `approved: false` with `'Invalid joiner consent'` when `peerKey`
  disagrees with `partyId`, when the signature is bad, and when `peerKey` is malformed —
  and **discloses no responder identity or cadre addrs** in that reply.
- rejection happens before `provisionStrand` is called (assert the hook is never invoked)
  and leaves the invite unspent (`countFormationUsage` unchanged).

End-to-end (`strand-formation-e2e.integration.ts`): a real two-party formation writes a row
whose stored `PeerSig` re-verifies via `verifyFormationConsent` against the `PeerKey` the
joiner actually used, and whose `PeerKey` matches the joiner's returned `memberKey`.

## TODO

Phase 1 — digests and schema

- Add `'consent'` to `ControlAction` in `control-authorization.ts`; update its doc comment.
- Add `formationConsentMessage` to `control-database.ts` beside `formationVouchMessage`.
- Add `verifyFormationConsent` to `peer-authorization.ts`; export both from `index.ts`.
- In `schemas/control.qsql` `FormationUsage`: rename `PeerId` → `PeerKey`, add `PeerSig text
  not null`, add the `PeerConsented` constraint, drop `PeerSignature` from the `with
  context` list, and rewrite the stale comments on `PeerId` and the context declaration that
  point at this ticket.
- Update the `FormationUsage.Authorized` `'vouch'` digest to name `new.PeerKey`.
- Mirror the whole schema change into `packages/cadre-core/src/control-schema.ts`.

Phase 2 — write paths

- `control-database.ts`: `execFormationUsageInsert`, `recordFormationUsage`,
  `redeemInvitation` take `peerKey` + `peerSignature` and a **required** `usageStampId`;
  drop the `generateStampId` fallback and the `PeerSignature` context binding.
- `formation-approval.ts`: rename `peerId` → `peerKey` through
  `FormationApprovalRequest` / `FormationVouchFields` / `signFormationApproval` /
  `verifyFormationApproval`.
- `control-formation-recorder.ts`: `recordUsage` / `provisionAndRecord` accept
  `peerKey`, `peerSignature`, `usageStampId`; `obtainApproval` stops minting and takes the
  nonce from its caller.

Phase 3 — protocol and initiator

- `strand-formation-protocol.ts`: extend `FormationContactMessage`; add the consent
  pre-check in `runSession` before `provision`, rejecting without disclosure.
- `strand-formation-manager.ts`: thread the new contact fields into `recordUsage` /
  `provisionAndRecord`; switch disclosure serialization to `canonicalJson`.
- `strand-solicitation.ts:formStrand`: derive the keypair via `ed25519KeyPairFromLibp2p`,
  mint the nonce, canonicalize the disclosure, sign `formationConsentMessage`, and put
  `peerKey` / `usageStampId` / `peerSignature` on the contact message.

Phase 4 — tests and docs

- Write the schema-level, protocol-level, and end-to-end tests above.
- Update `docs/api.md`'s approval-hook wire contract (`peerId` → `peerKey`, meaning, and
  the joiner-minted nonce).
- Update `docs/strands.md` / `docs/architecture.md` where formation is described, if they
  state that the joiner contributes no signature.
- Run `yarn build`, `yarn lint`, the `cadre-core` unit suite, and the formation
  integration scenarios; stream output with `tee`.
