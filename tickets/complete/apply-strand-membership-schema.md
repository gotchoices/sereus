description: Applied the repaired Strand membership/RBAC schema (schemas/strand.qsql) to every strand via the shared composeStrand seam, alongside the sApp DDL. Schema present + constraints active on every strand; population deferred to strand-membership-lifecycle-population. Reviewed and completed.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/cadre-core/test/strand-instance-manager.spec.ts, docs/architecture.md
----

## What shipped

The `Strand` membership/RBAC schema (`Header`, `Invite`, `ConsumedInvite`, `Member`,
`MemberPeer`, `Authority`) is now applied to **every** strand database in the single shared
composition seam (`composeStrand`, step 6), unconditionally, after the catalog hydrate and
before the conditional sApp apply. The schema itself was repaired (it had never been
parsed/executed and carried latent bugs). Runtime copy is the embedded `STRAND_SCHEMA`
constant (byte-equivalent to the body of `schemas/strand.qsql`), mirroring cadre-core's
`CONTROL_SCHEMA` so it works on filesystem-less platforms.

This makes the membership tables present and their `verify()`-gated constraints active on
every strand. It does **not** populate them — founder bootstrap, invite/peer flows, and signed
writes are owned by `strand-membership-lifecycle-population` (backlog).

## Review findings

### Checked and verified correct (no change needed)

- **Embedded-schema drift.** Programmatically diffed the body of `schemas/strand.qsql` (inside
  `declare schema Strand { ... }`) against `STRAND_SCHEMA`: **byte-equivalent** (6081 chars,
  equal). The drift invariant the handoff claims holds today.
- **Crypto idiom.** Re-derived `verify(digest(<payload>, 'sha256', 'utf8'), <sig>, <key>,
  'ed25519')` against the real `@optimystic/quereus-plugin-crypto` source
  (`../optimystic/packages/quereus-plugin-crypto/src/crypto.ts`): `digest()` defaults output to
  base64url; `verify(data, sig, pubkey, curve, inputEncoding=base64url, …)` consumes that
  base64url and **returns a boolean**. So (a) dropping the `= 1` on `ConsumedInvite.ValidUsage`
  is correct (it compared a boolean), (b) the explicit `'ed25519'` curve arg is required (verify
  defaults to secp256k1), and (c) the concatenation shapes (`Key || '|' || coalesce(Expiration,
  '')`, etc.) are deterministic and reproducible by the future signer. Matches `control.qsql`'s
  dominant idiom.
- **`Authority.Authorized` restructure.** The three alternatives (bootstrap `count<=1`,
  former-authority rotation, existing-authority) are now fully-parenthesized `or` branches; no
  clause is swallowed by precedence. Logically equivalent to the intended design.
- **Nullability deviation (`text null` on context vars).** Not an auth bypass: a null
  `context.AuthorityKey` can never satisfy `A.MemberKey = context.AuthorityKey` (SQL null
  comparison), so the only null-context inserts that succeed are the bootstrap (`count<=1`)
  branch or a valid `ConsumedInvite`. Required so founding inserts don't trip a NOT-NULL context
  bind before the bootstrap branch short-circuits; e2e tests confirm. Matches the
  `control.qsql` bootstrap idiom.
- **cadre-core test fix (#4) is legitimate, not a paper-over.** Confirmed `selectStrandMode`
  (`strand-cohort.ts:58`) returns `bootstrap` for a solo node with no other peers, so a real
  solo founder never hits networked-consensus-on-Strand-tables. The test's switch to
  `mode: 'bootstrap'` is faithful to production and still forwards the seed to
  `createLibp2pNode` (composeStrand creates the node regardless of transactor), preserving the
  test's actual assertion. The assertion was already a weak smoke test (never asserted the
  forwarded array — real coverage is in `strand-cohort.spec.ts`); the comment is honest about
  this.
- **Single application site.** Grepped all of `packages/**`: `apply schema Strand` /
  `STRAND_SCHEMA` appear only in `compose-strand.ts`. No double-application risk.

### Found and fixed inline (minor)

- **Duplicate step-"7" comment numbering in `compose-strand.ts`** — the sApp-apply and the
  return block were both labeled step 7. Renumbered the return block to step 8. Comment-only;
  no behavior change.

### Verified by running (the implementer's tests are a floor — extended past it)

- `eslint` on the 4 changed/added TS files → 0 errors (4 pre-existing `any` warnings in
  `applyRegistrations`, untouched).
- `@serfab/quereus-plugin-sereus test` → **45 passed, 1 todo** (6 files; includes the new
  strand-schema e2e).
- `@serfab/cadre-core test` → **292 passed** (21 files).
- **Integration tests the implement handoff did NOT run** (directly exercising the flagged
  networked-mode-cost concern, #3): ran `strand-formation-e2e` (**9 passed** — incl. 2-party
  and 3-party **networked** formation with cross-party data replication), `rbac-signed-write`
  (**1 passed** — accepts authorized signed writes, rejects unauthorized, on a real strand),
  `multi-party-sync` (**3 passed**), `strand-creation` (**5 passed**). The unconditional Strand
  apply **survives real multi-party consensus formation** — the handoff under-claimed here; the
  "worth a sanity pass" concern is now empirically clean.

### Major items — already filed, no new tickets needed

- **Deferred-constraint rejection not rolled back (platform bug).** A deferred (subquery-bearing)
  CHECK fires/throws correctly but the optimystic local transactor leaves the violating row
  committed, so RBAC rejection is non-atomic in bootstrap mode (affects `control.qsql`
  identically). Root cause is the transactor's `rollback()`, not the schema. **Confirmed
  out-of-scope** — agree with the implementer that "throws" is the right floor for the two
  rejection e2e tests. Filed: `optimystic-deferred-constraint-rejection-not-rolled-back`
  (backlog).
- **Population, signed flows, networked-mode membership e2e, cross-node membership sync.** Owned
  by `strand-membership-lifecycle-population` (backlog, exists).
- **Drift guard for `STRAND_SCHEMA` vs `schemas/strand.qsql`.** Should generalize from
  `control-schema-drift-guard` (in `implement/`, exists) once that lands. Tracked there.

### Minor items left as-is (documented, low value to change now)

- **`ConsumedInvite` has redundant `MemberExists` + `MemberValid`** (identical predicate). Kept
  verbatim from source for fidelity; harmless (two identical deferred subquery checks). Collapse
  is safe but would touch both schema copies for no behavioral gain and a small drift risk —
  defer to the lifecycle ticket when it edits the schema anyway.
- **`MemberPeer.MemberExists` rejects deletes** (`new.MemberKey` is null on delete). Pre-existing,
  out of scope; no runtime peer deletes exist yet (lifecycle ticket).

### Disposition

No regressions. No new tickets required (all majors already have owners). The implementation is
correct, the validation suite passes, and the one networked-mode risk the handoff flagged as
untested is now verified working via the integration suite. Complete.
