----
description: Fix FormationInvite's ed25519 curve bug in both schema copies, and wire the consent flow to actually insert FormationInvite (authority-signed) and FormationUsage (atomic with the Strand) so the Strand.Authorized FormationUsage branch is exercised.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/integration-tests/src/harness/test-network.ts, packages/cadre-core/test/control-database-genesis.spec.ts
----

The `CadreControl` schema defines an invitation/consent model for strand formation: a
party's authority publishes a `FormationInvite` (an open invitation token), and an
invited cadre peer records a `FormationUsage` against that token to authorize a `Strand`
*without* an authority signature (the second branch of `Strand.Authorized`). Today that
model is both wrong at the crypto layer and unreachable at runtime. This ticket fixes the
curve bug and wires the inserts so the consent path is live end-to-end.

## Defect 1 — wrong signature curve on FormationInvite (mechanical)

Every other `CadreControl` authorization constraint verifies an authority signature with
the same shape: `verify(digest(<value>, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519')`
(see `AuthorityKey`/`ValidationKey`/`Strand`/`CadrePeer`).

`FormationInvite.AuthorizedAddOrRemove` diverges — it calls
`verify(digest(context.StampId), context.Signature, A.Key)`:

- it omits the `'sha256', 'utf8'` digest input-encoding args, and
- critically, it omits the `'ed25519'` curve arg.

The crypto plugin's `verify` defaults `curve = 'secp256k1'`
(`../optimystic/packages/quereus-plugin-crypto/src/plugin.ts:55`) and **swallows the
curve-mismatch error, returning `false`** (`.../src/crypto.ts:259-261`). Authority keys are
ed25519, so the constraint can never validate a real authority signature — a correctly
signed `FormationInvite` insert/delete is always rejected. The bug exists **identically** in
`schemas/control.qsql:69` and the embedded `CONTROL_SCHEMA` copy in
`packages/cadre-core/src/control-database.ts:87`; both must be edited in lockstep. (A
separate plan ticket, `control-schema-duplicated-no-drift-guard`, will add a drift guard —
do not solve that here, just keep the two copies byte-identical.)

The correct form (matching `CadrePeer.AuthorizedInsert` at control.qsql:50):

```sql
exists (select 1 from AuthorityKey A
    where A.Key = context.AuthorityKey
        and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
```

## Defect 2 — FormationInvite / FormationUsage are never written

No code anywhere inserts `FormationInvite` or `FormationUsage`. `ControlDatabase`
(`packages/cadre-core/src/control-database.ts`) has `insertAuthorityKey` and `insertStrand`
but nothing for either invitation table. `StrandSolicitationService.createOpenInvitation`
(`strand-solicitation.ts:284-301`) mints a token in memory only; `recordFormationComplete`
(`strand-solicitation.ts:307-316`) delegates to a `FormationUsageRecorder` for which no
DB-backed implementation exists. The integration harness has the gap marked with TODOs:
`packages/integration-tests/src/harness/test-network.ts:139` ("Insert into FormationInvite
table via ControlDatabase") and `:166-169` ("Insert FormationUsage record / Insert Strand
row"). As a result the `FormationUsage` branch of `Strand.Authorized` is dead and the
consent-based authorization path is never taken.

## Critical design finding — the consent insert is a single atomic transaction

The two consent-path constraints are mutually circular:

- `Strand.Authorized` (control.qsql:33-39) is satisfied (without an authority signature) only
  by `exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)` — the
  `FormationUsage` row must exist.
- `FormationUsage.StrandExists` (control.qsql:93) requires
  `exists (select 1 from Strand S where S.Id = new.StrandId)` — the `Strand` row must exist.

Neither row can be inserted before the other under immediate evaluation. This resolves
because **both CHECK constraints contain subqueries, and Quereus auto-defers
subquery/committed-ref CHECKs to transaction commit**:
`needsDeferred = containsSubquery(expression) || containsCommittedRef(expression)`
(`../quereus/packages/quereus/src/planner/building/constraint-builder.ts:167`), evaluated by
`DeferredConstraintQueue.runDeferredRows()` at commit
(`../quereus/packages/quereus/src/runtime/deferred-constraint-queue.ts`).

**Implication:** redeeming an invitation must insert the `Strand` row and its
`FormationUsage` row **in one transaction** so both deferred CHECKs see both rows at commit.
If each `db.exec` runs in its own implicit transaction, the dual insert will fail — so the
redemption path needs an explicit `begin … commit` (or a single multi-statement exec that
shares one transaction). Confirm Quereus/optimystic transaction boundaries during
implementation and structure the redemption accordingly. Note also that `StampId()` is drawn
from the optimystic transaction (see `insertStrand`), so a shared transaction is consistent
with how stamp-id authorization already works.

## Roles & signing recap (who can write what)

- `FormationInvite` insert/delete → **authority-signed** (curve-fixed Defect 1). Model the
  insert on `ControlDatabase.insertStrand` (control-database.ts:376-401): generate a stampId,
  sign `digest(stampId,'sha256','utf8')` with the authority's ed25519 key, pass
  `with context AuthorityKey = ?, Signature = ?, StampId = ?`. The harness's `signData`
  (`test-network.ts:27-31`, sha256 of utf8 bytes then ed25519 sign) is the matching signer.
- `FormationUsage` insert → authorized purely by an existing matching `FormationInvite`
  (`Authorized` constraint, control.qsql:83-92) plus its `Monotonic`/`StrandExists` checks;
  context is `(PeerId, PeerSignature, Now, ValidationKey?, ValidationSignature?)` — **no
  authority key needed**. `Now` gates `ExpiresAt`; `ValidationKey/ValidationSignature` are
  only consulted when the invite has a `ValidationUrl`.
- The `FormationInvite` becomes visible to a redeeming cadre peer because cadre peers share
  the same `control-<partyId>` optimystic network; the authority inserts the invite, peers
  read and redeem it.

## Expected behavior

- `FormationInvite.AuthorizedAddOrRemove` verifies authority signatures with the canonical
  shape (`utf8` `sha256` digest + explicit `'ed25519'`), in **both** `schemas/control.qsql`
  and the embedded `CONTROL_SCHEMA`, so a real authority signature validates.
- The invitation flow actually persists `FormationInvite` (authority-signed, when a party
  offers an invitation) and `FormationUsage` (when an invited peer redeems it, atomically
  with the `Strand` insert), so the consent-based `Strand.Authorized` branch is exercised and
  an authority-signature-free strand creation works end to end.
- A DB-backed `FormationUsageRecorder` (or equivalent) makes `isTokenValid` / `isTokenUsed` /
  `recordUsage` read and write the real tables rather than relying on stubs.

## Key references

- `schemas/control.qsql:67-70` — `FormationInvite.AuthorizedAddOrRemove` (wrong curve);
  `:50` — `CadrePeer.AuthorizedInsert` (correct shape to copy); `:33-39` — `Strand.Authorized`
  (consent branch); `:73-94` — `FormationUsage` (constraints + context).
- `packages/cadre-core/src/control-database.ts:85-89` — embedded copy of the curve bug;
  `:376-401` — `insertStrand` (template for the new insert methods); `:351-364` —
  `insertAuthorityKey`; `:123-138` — `generateStampId`.
- `packages/cadre-core/src/strand-solicitation.ts:35-50` — `FormationUsageRecorder` interface;
  `:284-301` — `createOpenInvitation`; `:307-316` — `recordFormationComplete`.
- `packages/cadre-core/src/strand-formation-manager.ts:180-201` — `validateToken` hook that
  should consult the DB-backed recorder.
- `packages/integration-tests/src/harness/test-network.ts:130-173` — `createInvitation` /
  `joinStrand` TODOs to wire; `:27-31` — `signData` signer; `:96-125` — `createStrand`
  (existing authority-signed insert call site).
- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` — formation
  E2E scenario that should drive the real inserts.
- `../quereus/.../constraint-builder.ts:167` and `.../deferred-constraint-queue.ts` — the
  auto-deferral behavior the atomic redemption relies on.
- Related (do NOT fold in): `strand-formation-disclosure-not-transmitted` (transport carrying
  token/disclosure over libp2p — separate from the DB inserts here);
  `control-schema-duplicated-no-drift-guard` (schema drift guard);
  `reference-app-rn-join-and-consent-not-exercised` (RN reference exercising consent).

## TODO

### Phase 1 — curve fix (mechanical, independently testable)
- In `schemas/control.qsql:69`, change `FormationInvite.AuthorizedAddOrRemove`'s verify to
  `verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519')`.
- Apply the identical change to the embedded `CONTROL_SCHEMA` in
  `packages/cadre-core/src/control-database.ts:87`. Keep both copies byte-identical.

### Phase 2 — ControlDatabase insert methods
- Add `insertFormationInvite(...)` to `ControlDatabase`, modeled on `insertStrand`: take the
  invite fields (`token`, `sAppId`, optional `expiresAt`, `totalUses`, `validationUrl`), the
  authority public key, and a `signStampId` callback; generate a stampId, sign it, and insert
  with `with context AuthorityKey/Signature/StampId`.
- Add `insertFormationUsage(...)` (and/or a combined `redeemInvitation(...)`) that inserts the
  `Strand` row and the `FormationUsage` row **in a single transaction** (explicit
  `begin … commit` if `db.exec` does not already share one), populating `FormationUsage`'s
  `(PeerId, PeerSignature, Now, ValidationKey?, ValidationSignature?)` context. Compute
  `UseNumber` per the `Monotonic` constraint (max+1 for the token).
- Confirm the optimystic/Quereus transaction boundary actually keeps both inserts in one
  transaction so the deferred CHECKs see both rows at commit; document what you find.

### Phase 3 — wire the service/recorder
- Provide a DB-backed `FormationUsageRecorder` implementation: `isTokenValid` (matching,
  unexpired `FormationInvite`), `isTokenUsed` (uses vs `TotalUses`), `recordUsage` (the
  redemption insert from Phase 2).
- Have `StrandSolicitationService.createOpenInvitation` (or the cadre-node/host layer that
  owns the authority key + control DB) persist a `FormationInvite` via `insertFormationInvite`
  instead of only minting an in-memory token.
- Replace the harness TODOs at `test-network.ts:139` and `:166-169` with real
  `insertFormationInvite` / redemption calls.

### Phase 4 — tests
- Add a ControlDatabase test (model on `packages/cadre-core/test/control-database-genesis.spec.ts`:
  boot a `CadreNode` with empty bootstrap + `transaction` profile, genesis an authority key)
  that: (a) inserts an authority-signed `FormationInvite` — this insert must **fail before the
  Phase 1 curve fix and pass after**, pinning the bug; (b) redeems it by inserting
  `Strand` + `FormationUsage` atomically and asserts the `Strand` row exists via the
  `FormationUsage` branch (no authority signature on the strand insert); (c) asserts a
  redemption against a non-existent/expired token is rejected.
- Run `yarn workspace @serfab/cadre-core test` (stream with `2>&1 | tee`) and the package
  build/type-check; ensure green before handoff.
