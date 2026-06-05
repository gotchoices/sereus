----
description: Review the FormationInvite curve fix + the now-live FormationInvite/FormationUsage consent path (ControlDatabase insert/redeem methods, DB-backed recorder, harness wiring). Scrutinize the THREE schema edits (one was the ticketed curve fix; two more latent FormationUsage bugs were discovered+fixed to make the consent path actually work) and the residual bare-stamp weakness on FormationInvite.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/harness/test-network.ts
----

The implement stage fixed the FormationInvite ed25519 curve bug and made the
FormationInvite/FormationUsage consent path live end-to-end in `ControlDatabase`.
The consent-based `Strand.Authorized` branch (authority-signature-FREE strand
creation, authorized by a redeemed invitation) is now exercised and green.

## What landed

### Phase 1 — curve fix (the ticketed defect), both schema copies byte-identical
`FormationInvite.AuthorizedAddOrRemove` now verifies the authority signature with
the canonical shape `verify(digest(context.StampId, 'sha256', 'utf8'),
context.Signature, A.Key, 'ed25519')` — adding the missing `'sha256','utf8'`
digest args and the critical `'ed25519'` curve arg. Applied identically to
`schemas/control.qsql` and the embedded `CONTROL_SCHEMA` in `control-schema.ts`;
the `control-schema-drift.spec.ts` guard passes (byte-identical).

### TWO additional schema fixes — discovered by actually running the consent path
The `FormationUsage` constraints had never been exercised (no code inserted the
table before). Wiring + testing the redemption surfaced two latent, path-blocking
bugs, both fixed in lockstep in BOTH schema copies. **These are the highest-value
review targets** — they are security/authorization-adjacent and were NOT in the
original ticket's "Defect 1":

1. **`Monotonic` self-reference under deferral.** As written,
   `new.UseNumber = coalesce((select max(UseNumber) from FormationUsage U where
   U.Token = new.Token), 0) + 1` auto-defers to commit (it has a subquery) — by
   which point the row being inserted is LIVE, so `max(...)` counted the new row
   itself and `1 = 1+1` was unsatisfiable. The first redemption could NEVER
   succeed. Fixed to read the pre-transaction snapshot:
   `... from committed.FormationUsage U ...`. `committed.*` is Quereus's
   pseudo-schema for pre-transaction state (resolves the real table via the
   default search path; proven by quereus `43-transition-constraints.sqllogic`).
   Cross-transaction this yields sequential 1,2,3…; concurrent redemptions of the
   same token now collide on the `(Token, UseNumber)` PK (acceptable — no
   double-spend). **Reviewer: confirm `committed.*` is the intended semantics and
   that the PK-collision-on-concurrency behavior is acceptable.**

2. **`FormationUsage.Authorized` malformed `digest(new.Token, new.Disclosure)`.**
   This passed `new.Disclosure` as the *algorithm* arg and decoded `new.Token` as
   base64url (the default input encoding), so it THREW ("Unexpected end of data")
   on a normal token string — even when `ValidationUrl is null` and the branch
   should be inert (the engine evaluated the digest before the OR short-circuit
   could save it). Corrected to
   `verify(digest(new.Token || new.Disclosure, 'sha256', 'utf8'),
   context.ValidationSignature, context.ValidationKey, 'ed25519')` — utf8 input
   (never throws on arbitrary strings), token‖disclosure bound together, and an
   explicit `'ed25519'` curve (the same missing-curve class of bug as Defect 1).
   **Reviewer: this changes the ValidationUrl/disclosure verification semantics.
   The no-ValidationUrl path is fully tested; the ValidationUrl path itself is NOT
   exercised here (see Gaps). Sanity-check the chosen message shape against what a
   validation authority would actually sign — the related
   `strand-formation-disclosure-not-transmitted` ticket owns that transport.**

### Phase 2 — `ControlDatabase` insert/redeem methods
- `insertFormationInvite(token, sAppId, authorityKey, signMessage, {expiresAtMs?,
  totalUses?, validationUrl?})` — authority-signed invite insert, modeled on
  `insertStrand`. Signs `digest(stampId,'sha256','utf8')` bytes with the authority
  ed25519 key; passes `with context AuthorityKey/StampId/Signature`.
- `redeemInvitation({token, strandId, type?, memberPrivateKey?, disclosure?,
  peerId?, peerSignature?, nowMs?, validationKey?, validationSignature?})` —
  inserts the `Strand` + `FormationUsage` rows in ONE explicit transaction
  (`db.beginTransaction()` → two parameterized `exec`s → `db.commit()`), so the
  mutually-circular deferred CHECKs (`Strand.Authorized` consent branch ↔
  `FormationUsage.StrandExists`) both see both rows at commit. The strand carries
  NO authority signature (consent branch) but a fresh unique `StampId` column.
  **Confirmed empirically** that the optimystic transactor honors the explicit
  transaction and the deferred CHECKs see same-transaction rows.
- `recordFormationUsage({...})` — usage-only insert (autocommit) for when the
  strand PRE-EXISTS (e.g. authority-signed separately); `StrandExists` is
  satisfied by the committed strand row.
- Read helpers: `queryFormationInvite` (parses the stored `datetime` back to epoch
  ms, anchoring the bare-UTC string to `Z` so JS `Date` doesn't read it as local),
  `countFormationUsage`, private `nextUseNumber`.

### Phase 3 — DB-backed recorder + harness wiring
- `ControlFormationUsageRecorder implements FormationUsageRecorder`
  (`control-formation-recorder.ts`, exported): `isTokenValid` (matching, unexpired
  invite), `isTokenUsed` (uses vs `TotalUses`; null = unlimited), `recordUsage`
  (→ `redeemInvitation`). Replaces the in-memory stubs.
- Harness `test-network.ts`: `createInvitation` now persists an authority-signed
  `FormationInvite` on the inviting party's control DB (unlimited `TotalUses`);
  `joinStrand` now records a `FormationUsage` against the existing strand on the
  inviter's control DB. The TODOs are gone.

## Use cases / how to validate

Gating command (green): `yarn workspace @serfab/cadre-core test` →
**24 files, 311 tests pass**, including the new `control-formation-invite.spec.ts`
(8 tests) and the drift guard. Run just the new spec:
`yarn workspace @serfab/cadre-core exec vitest run test/control-formation-invite.spec.ts`.

The new spec covers:
- **Curve-fix pin** — an authority-signed invite inserts. This insert FAILS
  against the pre-Phase-1 schema (ed25519 sig rejected by the secp256k1 default)
  and PASSES after, pinning the bug. (The pin is encoded by the test, not run
  against the old schema in CI.)
- Non-authority-key signature → invite rejected.
- **Atomic redemption** — `Strand`+`FormationUsage` inserted in one txn; strand
  exists purely via the FormationUsage branch (no authority sig); `UseNumber=1`.
- Redemption against a non-existent token → rejected, nothing lands.
- Redemption against an expired invite → rejected, nothing lands.
- `recordFormationUsage` against a pre-existing authority-signed strand →
  monotonic `UseNumber` 1,2.
- `ControlFormationUsageRecorder` — `isTokenValid` (known/unknown/expired),
  `isTokenUsed` (single-use vs unlimited `TotalUses`), `recordUsage` redeems.

Adversarial angles worth a reviewer's attention: replay/transplant of a
FormationInvite signature (see Gap 1 — currently NOT prevented); concurrent
redemption of one token (PK collision is the guard); datetime edge cases at
sub-second expiry windows (see Gap 4).

## Known gaps / honest flags (reviewer: treat as the starting point)

1. **FormationInvite signature is still a BARE STAMP — not row-bound, not
   single-use.** Unlike `Strand`/`AuthorityKey`/`ValidationKey` (which the prior
   `control-key-constraints-bind-row-and-single-use-stamp` work hardened to
   row-bound + unique-StampId-column), `FormationInvite` signs only
   `digest(StampId)` and `StampId` is a context value, not a unique column. So a
   captured `(StampId, Signature)` pair CAN be transplanted onto a different
   invite row and CAN be replayed. This matches the ticket's prescribed minimal
   fix (it explicitly modeled the fix on `CadrePeer` and scoped binding out), but
   it is a real residual weakness. **Recommend a follow-up ticket** to bind the
   FormationInvite signature to the row (Token/sAppId/…) and add a single-use
   StampId column, mirroring the other privileged tables. Not done here to stay in
   scope and avoid a schema redesign.

2. **Integration network suite NOT run by me (not agent-runnable).** The harness
   wiring typechecks and `@serfab/cadre-core` builds, and the integration-tests
   package typechecks against the built dist — but the multi-node libp2p scenarios
   (`happy-path`, `multi-party-sync`, `strand-creation` integration) were not
   executed (they need real networks; out-of-band CI/human validation). The DB
   writes the wiring performs are LOCAL to the inviter's control DB (deterministic,
   same pattern as the already-working `createStrand`→`insertStrand`), so the risk
   is contained, but it is unverified. **Reviewer/CI: run
   `yarn workspace @serfab/integration-tests test`.**

3. **Cross-party vs intra-cadre semantic nuance in `joinStrand`.** The consent
   tables are INTRA-cadre (the invite lives in the inviting party's
   `control-<partyId>` network; its cadre peers redeem it). The harness models
   CROSS-party joining of an existing strand, which doesn't map 1:1. The wiring
   records the `FormationUsage` on the INVITER's control DB (where the invite +
   strand live) — the closest correct mapping — rather than the `:166-169` TODO's
   "joiner's control network" (the joiner's separate network has no copy of the
   invite). Reviewer should confirm this modeling choice is acceptable for the
   harness, or redesign the scenario to genuinely create the strand by consent.

4. **`cadre-node.createOpenInvitation` does NOT auto-persist a FormationInvite.**
   Deliberately scoped out: that method is used by the e2e tests whose nodes never
   genesis an `AuthorityKey`, so auto-persisting (which requires an enrolled
   authority) would break the existing mock-recorder e2e flows. Persistence is
   wired at the harness + recorder layer instead. If a node/host layer should own
   this, it needs the authority key + a genesis'd control DB — a separate change.

5. **datetime comparison robustness.** `context.Now` is passed as an ISO string
   (`toISOString()`); Quereus does NOT coerce context values, so a number would
   mismatch storage classes against the canonicalized `datetime` `ExpiresAt`. The
   stored canonical form is a bare-UTC `PlainDateTime` (no `Z`); lexicographic
   ordering vs the `Z`-suffixed Now is correct for any realistic (≥ ~1s) expiry
   window but not at sub-second equality. Fine in practice; flagged for awareness.
   The DB-backed recorder also re-checks expiry in JS as a backstop.

6. **Docs not updated.** `docs/strands.md` / `docs/cadre-consistency.md` describe
   the consent model conceptually; neither was updated to note the now-live
   FormationInvite/FormationUsage insert path or the two FormationUsage schema
   corrections. Minor follow-up.

## Related tickets (do NOT fold in)
- `strand-formation-disclosure-not-transmitted` — owns the token/disclosure
  transport over libp2p (the ValidationUrl/disclosure flow this ticket's schema
  fix #2 touched at the crypto layer but did not wire end-to-end).
- `reference-app-rn-join-and-consent-not-exercised` — RN reference exercising
  consent.
- A new follow-up for Gap 1 (row-bind + single-use the FormationInvite signature)
  is recommended.
