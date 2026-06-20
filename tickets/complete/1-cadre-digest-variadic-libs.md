description: A shared crypto hashing helper changed how it must be called; the cadre control-plane and strand libraries were updated to the new form on both the TypeScript and SQL sides so signing and verification still produce identical results.
prereq: none
files:
  - C:/projects/sereus/packages/cadre-core/src/control-database.ts
  - C:/projects/sereus/packages/cadre-core/src/control-schema.ts
  - C:/projects/sereus/schemas/control.qsql
  - C:/projects/sereus/packages/cadre-core/src/peer-record.ts
  - C:/projects/sereus/packages/cadre-core/src/peer-authorization.ts
  - C:/projects/sereus/packages/cadre-core/src/device-token.ts
  - C:/projects/sereus/packages/cadre-core/src/seed-bootstrap.ts
  - C:/projects/sereus/packages/cadre-core/src/strand-membership-writer.ts
  - C:/projects/sereus/packages/quereus-plugin-sereus/src/strand-schema.ts
  - C:/projects/sereus/schemas/strand.qsql
  - C:/projects/sereus/packages/cadre-core/test/digest-variadic-parity.spec.ts (new)
  - C:/projects/sereus/docs/architecture.md (review: stale digest idiom fixed)
difficulty: medium
---

## What landed

Migrated every remaining caller of `@optimystic/quereus-plugin-crypto`'s `digest`
in **cadre-core** and **quereus-plugin-sereus** from the old positional API
(`digest(data, algorithm, inputEncoding, outputEncoding)`) to the new framed-tuple
API (`digest(fields[], algorithm='sha256', encoding='base64url')`), and the matching
SQL `digest(...)` calls from the literal-bearing 4-arg/3-arg form to the variadic
`digest(f1, …, fN)` form.

Two shapes, applied uniformly:

- **Multi-field control messages** (`buildAuthorizationMessage`): TS returns
  `digest([...fields], 'sha256', 'bytes')` (one framed digest over the tuple); SQL
  collapsed the per-field `digest(f,'…','hex') || …` concatenation + `verify(...,'hex')`
  into one `verify(digest(f1, …, fN), …, 'ed25519')`.
- **Single concatenated-TEXT payloads** (peer-record, device-token, peer-auth,
  seed-bootstrap, the whole strand layer): TS keeps the joined string as ONE field
  (`digest([joined], …)`); SQL drops the trailing literal so it is no longer hashed as
  a spurious extra field.

The two schema copies were edited byte-identically in each pair
(`control-schema.ts`⇔`control.qsql`, `strand-schema.ts`⇔`strand.qsql`).

## Review findings

Adversarial pass over commit `6f928f2`. Disposition: one minor finding fixed inline,
one minor coverage gap documented (owned by the integration follow-up), no majors.

### Checked — TS↔SQL byte parity (the dominant failure mode)
Read the crypto plugin source (`../optimystic/packages/quereus-plugin-crypto/src/{crypto,plugin}.ts`)
to confirm the framing contract, not just the call-site shapes:
- SQL `digest(f1,…,fN)` is `numArgs: -1` → `digestFields(args, …)`, applying a per-field
  type tag derived from the **JS value type** each SQL value maps to. Every migrated
  SQL field is TEXT (a column, a `cast(... as text)`, or a `coalesce(...,'')`) → arrives
  as a JS string → `TAG_TEXT`, matching the TS side which passes `string[]`. Tags agree.
- **Field order** verified at every `buildAuthorizationMessage` call site
  (`control-database.ts:528` StrandMember 4-field, `:566` Key/Stamp 2-field, `:645`
  FormationInvite 7-field) against the corresponding SQL `verify(digest(...))` columns.
- **NULL vs '' parity**: every nullable bound field is `coalesce(...,'')` on the SQL side
  and `?? ''` on the TS side — both yield a `TAG_TEXT` empty payload, never a bare
  `TAG_NULL`. No raw-NULL-vs-`''` skew on any signed path.
- **Encoder parity**: plugin is registered with **default** config (sha256 / base64url) in
  `ControlDatabase` (`control-database.ts:169`), `connect.ts:21`, `connect-browser.ts:35`,
  and the new parity spec — so SQL `digest` returns the same base64url string that
  `verify`'s default base64url input decodes back to the raw bytes TS signs.

### Checked — completeness sweep (independent of the implementer's)
Grepped `digest(` across `packages/`. The ONLY remaining old-form callers are in the
**integration-tests** package (`rbac-signed-write.integration.ts`,
`strand-membership-closed-strand-e2e.integration.ts`) — explicitly out of scope and
covered by the prereq-chained follow-up `cadre-digest-variadic-integration`, which I
confirmed exists in `implement/` and lists exactly those files. `cadre-provider/.../auth.ts`
and `reference-app-ns/.../node-crypto.ts` use Node's `createHash().digest()`, unrelated.

### Found + FIXED inline (minor) — stale docs
The implementer's handoff claimed stale doc references were updated, but only *code
comments* were touched. `docs/architecture.md` still quoted the old positional form in
two places:
- L304: `digest(canonicalJson({partyId, peers}), 'sha256')` → `digest([canonicalJson(...)], 'sha256')`.
- L499: `verify(digest(payload,'sha256','utf8'), …)` → `verify(digest(payload), …)`, and
  "multi-field … concatenation" → "multi-field … digest" (it is now one framed digest,
  not a concatenation of per-field digests).
Swept the rest of `docs/` for old-form digest literals and stale "concatenation"/"per-field
digest" prose — none remaining.

### Found + documented (minor, NOT blocking) — one untested branch
The control schema's `FormationUsage` validation branch
(`verify(digest(new.Token || new.Disclosure), context.ValidationSignature, …)`) was
migrated correctly but has **no** end-to-end test: no existing spec sets a `ValidationUrl`
+ a real validation signature, so the branch never executes. The change is the
single-concatenated-string shape, which IS covered structurally by parity cases (b) and
(c) in `digest-variadic-parity.spec.ts`; adding a FormationUsage-specific case would
exercise nothing new at the digest layer. End-to-end coverage is owned by
`cadre-digest-variadic-integration`. Left as-is; no new ticket.

### Checked — tests cover edge/error/regression paths
- New `digest-variadic-parity.spec.ts` pins all three call shapes with both an accept
  (happy path) and a one-field-tamper reject (error path) — the exact fail-closed mode
  this migration could regress.
- `control-authorization-binding.spec.ts` drives the REAL control schema with
  transplant/replay/tamper rejection across Strand/ValidationKey/AuthorityKey/FormationInvite.
- Drift guards (`control-schema-drift`, `strand-schema-drift`) confirm the two copies of
  each schema stayed byte-identical; both pass.

### Validation run (this review)
- `yarn workspace @serfab/cadre-core typecheck` — 0 errors.
- `yarn workspace @serfab/quereus-plugin-sereus typecheck` — 0 errors.
- `yarn lint` — clean (exit 0).
- Rebuilt sereus `dist/` first (cadre-core's strand specs resolve sereus from `dist/`, not
  src), then: `yarn workspace @serfab/quereus-plugin-sereus test` — **60 passed | 1 todo**;
  `yarn workspace @serfab/cadre-core test` — **556 passed | 1 skipped**.

### Note on the two formerly-failing tests
The implementer reported 2 failures (`strand-membership-invite` double-consume,
`strand-membership-peer-rotation` non-authority removal) as pre-existing platform-gap
time-bombs and filed `.pre-existing-error.md`. The runner's triage pass (commit
`92f03b3`) already flipped those assertions to expect the now-enforced platform behavior
and removed `.pre-existing-error.md`; both pass here. Neither involves the digest/verify
expressions this ticket changed. No action needed.

## Re-signing note

The framed digest differs from the old bare hash, so any persisted signatures are
invalidated. Per AGENTS.md this is acceptable (no backwards-compat yet); sign/verify stay
internally consistent.
