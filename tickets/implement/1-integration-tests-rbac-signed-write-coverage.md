----
description: Add integration coverage for sApp signed-write RBAC (authorized write accepted, unauthorized rejected) on a real strand, and repair/consume the verify()-gated fixture (resolves the dead fixture surface).
prereq:
files: packages/integration-tests/src/fixtures/index.ts, packages/integration-tests/fixtures/simple-sapp.qsql, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/cadre-core/src/strand-database.ts
----

Sereus's central promise is consent-based, role-aware shared databases, but no integration
scenario drives a `verify()`-gated signed write through a **real** strand and asserts that an
authorized write is accepted while an unauthorized one is rejected. The only fixture that
encodes such constraints — `SIMPLE_SAPP_LOGIC` (`fixtures/index.ts:24-43`) and its file twin
`fixtures/simple-sapp.qsql` — is consumed solely by the stubbed happy-path scenario, and is
itself malformed for real use. This ticket adds the missing RBAC coverage on a live strand and
repairs the fixture so it actually verifies signatures, which also retires the dead fixture
surface called out in the source ticket.

## Scope boundary (read first)

This ticket covers **sApp-level RBAC** — the `verify()`-gated CHECK constraints declared inside
the application schema (`with context (MemberKey, Signature)`), which already execute today
because `StrandDatabase.executeSchema` applies the sApp DDL under `declare schema App`
(`packages/cadre-core/src/strand-database.ts:184-200`). It is therefore **independent** of the
Strand-level membership schema work in the plan ticket `strand-membership-rbac-schema-not-applied`
(that one is about applying `schemas/strand.qsql`'s `Member`/`Invite`/`Authority` tables — a
different layer). Do **not** wait on that ticket and do **not** assert against `Strand.*` tables
here; assert against the sApp's own `App.Items` constraints. State this distinction in the
scenario header comment so a reviewer does not conflate the two.

## The fixture is malformed and must be repaired

`digest(data, algorithm, inputEncoding, outputEncoding)` and `verify(data, signature, publicKey,
curve, ...)` are the real signatures (`../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:93,232`).
Measured against them, the current fixture cannot work:

- `verify(digest(new.Id, new.Name, new.Value), context.Signature, context.MemberKey)` passes
  `new.Name` as the **digest algorithm** and `new.Value` as the **input encoding** — not a
  concatenation of the three fields. It must digest the concatenated authenticated payload, e.g.
  `digest(new.Id || '|' || new.Name || '|' || coalesce(new.Value,''), 'sha256', 'utf8')`.
- `verify(...)` omits the curve arg, so it defaults to **secp256k1**, while every key in the
  suite (`test-party.ts`, `strand-formation-e2e.ts`) is **ed25519**. Either add the explicit
  `'ed25519'` curve arg to the `verify()` calls **or** generate secp256k1 member keys in the
  scenario — pick one and keep the schema and the signer on the same curve.
- `verify(digest(old.Id), context.Signature, context.MemberKey)` in `AuthorizedDelete` digests a
  plaintext key string under the default `base64url` input encoding; it needs the same
  `'sha256','utf8'` shape.

Repair the constraints so the signed payload the scenario computes (member private key signs
`digest(<same concatenation>, 'sha256','utf8','bytes')`, public key = `context.MemberKey`) is the
one the constraint verifies. Keep `fixtures/index.ts`'s `SIMPLE_SAPP_LOGIC` and
`fixtures/simple-sapp.qsql` byte-identical in their app logic (or collapse to one source — see
dead-surface task below).

## Real-strand write path with context

Drive a real strand exactly as `strand-formation-e2e.integration.ts` Phase 2 does: two
`CadreNode`s, `formStrand` over libp2p, `addStrand({ strandRow, sAppConfig })` on each side, then
write via `strand.database!.getDatabase().exec(...)`. The sApp's `with context (MemberKey,
Signature)` parameters are supplied on the DML, mirroring how `ControlDatabase.insertStrand`
passes `with context AuthorityKey=?, Signature=?, StampId=?` (`control-database.ts:394-398`):

```sql
insert into App.Items (Id, Name, Value, CreatedBy)
  with context MemberKey = ?, Signature = ?
  values (?, ?, ?, ?)
```

Confirm during implementation that the App-schema context is addressable through
`StrandDatabase.getDatabase()`; if `executeSchema`'s `declare schema App { ... }` wrapping
prevents passing context to `App.*` DML, that is a real production gap — capture it and file a
`tickets/backlog/` ticket rather than forcing a workaround here.

The `sAppConfig.schema` fed to `addStrand` must be the repaired `SIMPLE_SAPP_LOGIC` app logic,
wrapped/signed the same way `createSignedSAppConfig` does in `strand-formation-e2e.ts:76-87`
(`signSchema` + ed25519 author key).

## Expected behavior / key tests

New scenario `packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts`:

- **Authorized insert accepted**: member M inserts an `Items` row with `CreatedBy = M.publicKey`
  and a valid `Signature` over the payload → insert succeeds; assert the row is present locally
  and (optionally) replicates to the second node.
- **Authorized update accepted**: M updates its own row with a fresh valid signature → accepted.
- **Unauthorized write rejected**: at least two negative cases drive a `rejects.toThrow()` —
  (a) a write whose `CreatedBy`/`MemberKey` is M but `Signature` is missing or over the wrong
  payload, and (b) an update of M's row by a different member key N → both rejected by
  `AuthorizedWrite`. Assert the row is unchanged after rejection.
- **(optional) Authorized delete** accepted vs delete by non-creator rejected, exercising
  `AuthorizedDelete`.

## Dead fixture surface

The source ticket flags `wrapSAppSchema`, `loadSimpleSApp`, and `simple-sapp.qsql` as unused
(`fixtures/index.ts:15-17,58-60`). Resolve by either (preferred) having the new scenario import
the fixture through these helpers so they are exercised, or removing whichever remain genuinely
unused after this ticket lands. Do not leave a dead second copy of the app logic — pick
`SIMPLE_SAPP_LOGIC` (inline) or `simple-sapp.qsql` (file via `loadSimpleSApp`) as the single
source and delete/redirect the other.

## Out of scope (owned elsewhere)

- sApp **schema-signature** rejection (unsigned/tampered/wrong-key `SAppConfig`) is owned by the
  plan ticket `sapp-schema-signature-gate-bypassable`, which introduces the enforcing
  `requireSignedSchemas` policy the unsigned case needs. Do not add it here.
- Wiring `createInvitation`/`joinStrand`/`waitForControlSync` is covered by ticket
  `2-integration-tests-real-control-sync-and-scenario-honesty` and the implement ticket
  `formationinvite-fix-curve-and-wire-consent`.

## Key references

- `packages/integration-tests/src/fixtures/index.ts:24-43` — `SIMPLE_SAPP_LOGIC` (malformed verify/digest);
  `:15-17,58-60` — dead `loadSimpleSApp`/`wrapSAppSchema`.
- `packages/integration-tests/fixtures/simple-sapp.qsql` — file twin of the fixture.
- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts:76-110,316-416` —
  template for signed `SAppConfig`, two-node `CadreNode` setup, `addStrand`, and DB writes.
- `packages/cadre-core/src/strand-database.ts:184-200` — `executeSchema` applies sApp DDL under `declare schema App`.
- `packages/cadre-core/src/control-database.ts:394-398` — `with context` DML pattern.
- `../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:93,181,232,280,303` — `digest`/`sign`/`verify`/key signatures and default curves.

## TODO

### Phase 1 — repair the fixture
- Fix `SIMPLE_SAPP_LOGIC` (and `simple-sapp.qsql`) so `AuthorizedWrite`/`AuthorizedDelete` digest
  the concatenated payload with `'sha256','utf8'` and verify on a single explicit curve.
- Decide single source of truth for the fixture; redirect/remove the duplicate.

### Phase 2 — RBAC scenario
- Add `rbac-signed-write.integration.ts` driving a real two-node strand with the repaired
  fixture as the sApp schema (signed `SAppConfig` per `createSignedSAppConfig`).
- Implement a small signer helper: member key (matching the fixture curve) signs
  `digest(<payload>, 'sha256','utf8','bytes')`; pass `with context MemberKey=?, Signature=?`.
- Cover authorized insert/update accepted and ≥2 unauthorized writes rejected (missing/wrong
  signature; wrong member). Assert post-rejection row state.

### Phase 3 — dead surface + validation
- Wire or remove `loadSimpleSApp`/`wrapSAppSchema` per the decision above.
- Run `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/rbac.log` (stream output)
  for the new scenario, plus the package type-check/build. If a write-with-context path turns out
  to be unsupported through `StrandDatabase`, file a backlog ticket and document the deferral in
  the review handoff rather than leaving a green-but-fake assertion.
