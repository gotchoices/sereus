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
  - C:/projects/sereus/packages/cadre-core/test/{authority-key,peer-authorization,peer-record,device-token,seed-bootstrap,cadre-node-seed-trust,strand-membership-writer,control-formation-invite}.spec.ts
  - C:/projects/sereus/packages/quereus-plugin-sereus/test/plugin.spec.ts
difficulty: medium
---

## What landed

Migrated every remaining caller of `@optimystic/quereus-plugin-crypto`'s `digest`
in **cadre-core** and **quereus-plugin-sereus** from the old positional API
(`digest(data, algorithm, inputEncoding, outputEncoding)`) to the new framed-tuple
API (`digest(fields[], algorithm='sha256', encoding='base64url')`), and the matching
SQL `digest(...)` calls from the literal-bearing 4-arg/3-arg form to the variadic
`digest(f1, …, fN)` form. The narrow `schema-verification.ts` case was already done
and was the reference idiom.

Two shapes, applied uniformly:

- **Multi-field control messages** (`buildAuthorizationMessage`): TS now returns
  `digest([...fields], 'sha256', 'bytes')` (a single framed digest over the tuple);
  SQL collapsed `digest(f1,'…','hex') || … || digest(fN,'…','hex')` +
  `verify(..., 'ed25519', 'hex')` to one `verify(digest(f1, …, fN), …, 'ed25519')`.
  All fields are TEXT on both sides, so per-field type tags agree.
- **Single concatenated-TEXT payloads** (peer-record, device-token, peer-auth,
  seed-bootstrap, the whole strand layer): TS keeps the joined string as ONE field
  (`digest([joined], 'sha256', 'base64url')`, or `'bytes'` where raw bytes are
  signed); SQL drops the trailing `'sha256','utf8'`/`'hex'` so the literal is no
  longer hashed as a spurious extra field.

`generateStampId` (local-only ID, never cross-checked) → `digest([peerId], 'sha256',
'bytes')`. Plugin registration is unchanged: both `ControlDatabase` (control-database.ts)
and `connectToStrand` (sereus connect.ts) register the crypto plugin with default config
(sha256 / base64url) — verified, so SQL `digest`/`verify` and the TS helpers agree.

The two schema copies were edited byte-identically in each pair
(`control-schema.ts`⇔`control.qsql`, `strand-schema.ts`⇔`strand.qsql`); the drift
guards pass. Stale doc comments that quoted the old `digest(x,'sha256','utf8')` form
were updated to the new form.

## The core invariant to review: TS↔SQL byte-parity

A field-tag or NULL/`''` mismatch fails CLOSED (verify rejects every signed row)
rather than throwing — invisible to a type-check. The guardrails that this stayed
intact:

- **`digest-variadic-parity.spec.ts`** (new, fast, no DB stack): registers ONLY the
  crypto plugin into a bare Quereus `Database` and asserts a TS-signed value is
  accepted by `select verify(digest(...), …, 'ed25519')` and a one-field tamper is
  rejected — one case per shape (multi-field, peer-record, strand single-string).
- **`control-authorization-binding.spec.ts`** (unchanged): signs via
  `buildAuthorizationMessage` and drives the REAL control schema — happy path +
  transplant/replay/tamper rejection for Strand / ValidationKey / AuthorityKey /
  FormationInvite. Confirm it genuinely exercises `verify` (it does: inserts succeed
  on a correct signature and throw on a tampered one).
- **Drift guards** `control-schema-drift.spec.ts` / `strand-schema-drift.spec.ts`
  (both copies byte-identical).
- Strand happy-path specs (`strand-membership-invite`, `strand-membership-writer`,
  `strand-membership-peer-rotation`, `publish-strand`, formation-consent) exercise
  the cross-package path: cadre-core's `signStrandPayload` ⇔ sereus
  `strand-schema.ts` verify.

## Validation run (what I actually ran)

- `yarn workspace @serfab/cadre-core typecheck` — 0 errors (the prior `TS2554`s gone).
- `yarn workspace @serfab/quereus-plugin-sereus typecheck` — 0 errors.
- `yarn workspace @serfab/quereus-plugin-sereus test` — **60 passed | 1 todo** (incl.
  `strand-schema-drift`, the migrated `plugin.spec` `select digest('hello')` assertion).
- `yarn workspace @serfab/cadre-core test` — **554 passed | 2 failed | 1 skipped**.
- Leftover sweep (old-form TS `digest(<non-[>, …)` and any SQL `digest(` carrying
  `'sha256'/'utf8'/'hex'/'base64url'`) across both packages + `schemas/` — none.

### The 2 failures are pre-existing (documented in `tickets/.pre-existing-error.md`)

Both are self-described **"KNOWN GAP"** time-bomb tests that assert an
optimystic/quereus *platform* limitation still exists and are designed to fail the
moment the platform closes the gap:

1. `strand-membership-invite.spec.ts > … double consume … (PK uniqueness not enforced)`
   — now `UNIQUE constraint failed: ConsumedInvite.InviteKey`. Involves **no
   digest/verify at all**, so definitively not this ticket.
2. `strand-membership-peer-rotation.spec.ts > … non-authority removal … (deferred
   CHECK not enforced on delete)` — the deferred `Authority.Authorized` CHECK now
   runs on delete and correctly rejects a non-authority's invalid signature. I only
   changed the `verify(digest(...))` expression, never the `check on … delete` clause
   that governs whether it runs; the bad signature fails under old OR new digest form.

The linked `../../../quereus`/optimystic checkout has closed both gaps
(`optimystic-insert-pk-uniqueness-not-enforced`,
`optimystic-deferred-check-not-enforced-on-delete`). Per the tests' own comments the
fix is to flip the assertions to `rejects.toThrow()` + unchanged counts — platform
follow-up work, left untouched here.

## Reviewer: things to scrutinise (known gaps / non-obvious)

- **Cross-package build order.** cadre-core resolves `@serfab/quereus-plugin-sereus`
  from its **built `dist/`**, NOT src. I rebuilt the sereus dist (`yarn workspace
  @serfab/quereus-plugin-sereus build`) so the cadre-core strand specs run against the
  migrated `strand-schema.js`. Re-running the cadre-core suite WITHOUT first
  rebuilding sereus would silently test the OLD strand schema. Confirm CI builds
  sereus before cadre-core's strand tests (or rebuild before re-validating).
- **FormationUsage validation branch is unverified end-to-end.** The SQL
  `verify(digest(new.Token || new.Disclosure), context.ValidationSignature,
  context.ValidationKey, 'ed25519')` was migrated, but NO existing test sets a
  `ValidationUrl` + a real validation signature (the formation-invite spec passes a
  disclosure but null ValidationUrl, so this branch never runs). The migration is
  mechanical (single-string field, mirrors the other single-string cases) but the
  parity test does NOT cover it. If you want belt-and-suspenders, add a case that
  signs `digest([token + disclosure])` in TS and inserts a FormationUsage against an
  invite carrying a ValidationUrl. (Integration coverage is owned by the prereq-chained
  follow-up `cadre-digest-variadic-integration`.)
- **`schemas/chat.qsql`** already uses the new variadic form (`digest(Key, OneTime,
  CanInvite)`); it is an sApp fixture, out of scope, and was left as-is — flagged only
  so a reviewer's grep for `digest(` in `schemas/` doesn't read as a miss.
- **Re-signing.** The framed digest differs from the old bare hash, so any persisted
  signatures are invalidated. Per AGENTS.md this is acceptable (no backwards-compat
  yet); sign/verify stay internally consistent.

## Out of scope (do not do here)

Integration-test surfaces (`cadre-digest-variadic-integration`, sequence 2). Fixing
the two pre-existing platform-gap tests (the runner's triage pass handles
`.pre-existing-error.md`).
