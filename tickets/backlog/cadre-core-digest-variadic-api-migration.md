----
description: An upstream change to the shared crypto library's hashing function changed how it is called, and the cadre control-plane code was never updated to match — so most of its signing and verification tests now crash.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/device-token.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/schema-verification.ts, ../optimystic/packages/quereus-plugin-crypto/src/crypto.ts, ../optimystic/packages/quereus-plugin-crypto/src/plugin.ts
difficulty: hard
----

## Summary

The optimystic `@optimystic/quereus-plugin-crypto` plugin reworked its `digest`
function in commit `crypto-digest-variadic-config` (optimystic `8cea904`,
confirmed an ancestor of optimystic HEAD). Sereus `@serfab/cadre-core` consumes
this plugin via the `resolutions` link and still calls the **old** `digest`
signature everywhere. The two are now incompatible, and nearly every
crypto-dependent cadre-core test suite crashes.

## Reproduction (confirmed at HEAD)

```
yarn workspace @serfab/cadre-core test test/authority-key.spec.ts
```

```
Error: Unsupported output encoding: utf8
 ❯ resolveOutputEncoder ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:129:9
 ❯ digest ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:324:56
 ❯ test/authority-key.spec.ts:22:23
```

`authority-key.spec.ts` fails 2/8 (the two that call `digest`). The full
`yarn workspace @serfab/cadre-core test` run fans this out across
`cadre-node-seed-trust`, `control-formation-invite` (16 skipped — `beforeAll`
crashes in `generateStampId` → `insertAuthorityKey` → `ensureAuthorityKey`),
`peer-record`, `peer-record-resolution`, `peer-authorization`, `publish-strand`,
`publish-formation-invite`, `control-database-genesis`, `device-token`,
`seed-bootstrap`, `strand-membership-*`, and more. `control-schema-drift.spec.ts`
(the only crypto-free spec) passes.

## Root cause: the `digest` API changed out from under cadre-core

**Old API** (what cadre-core was written against — single value + per-call config):

```ts
digest(value, algorithm, inputEncoding, outputEncoding)
//     'hello'  'sha256'   'utf8'         'base64url' | 'hex' | 'bytes'
```

**New API** (`crypto.ts` at HEAD — variadic injective framing, register-time config):

```ts
// TS:  digest(fields[], algorithm, outputEncoding)   — 3 args, ARRAY input, no input-encoding
// SQL: digest(f1, f2, ..., fN)                        — algorithm + encoding bound at plugin registration
```

The new `digest`:
- treats its argument as an **ordered tuple of fields** and produces a *framed,
  injective* digest (`version ‖ tag ‖ varint(len) ‖ payload`) — `digest(['hello'])`
  is deliberately **not** `sha256("hello")`;
- has **no input-encoding parameter** — field bytes are derived from JS/SQL type;
- accepts only `'base64url' | 'base64' | 'hex' | 'bytes'` as output encoding
  (`'utf8'` is rejected — that is the crash);
- in SQL, binds algorithm + output encoding **once at registration** from plugin
  config (`configAlgorithm`/`configEncoding` in `plugin.ts`), with `numArgs: -1`.

### Two distinct breakages

1. **TS callers throw.** Calls like
   `digest('hello cadre', 'sha256', 'utf8', 'base64url')` land `'utf8'` in the
   new `encoding` slot → `resolveOutputEncoder('utf8')` throws
   `Unsupported output encoding: utf8`. Affected:
   - `control-database.ts:25` `generateStampId` → `digest(peerId, 'sha256', 'utf8', 'bytes')`
   - `control-database.ts:72` (multi-field digest helper)
   - `device-token.ts:38`, `peer-record.ts:56`, `peer-authorization.ts:17`
   - `strand-membership-writer.ts:50,71`
   - `seed-bootstrap.ts:430,643`
   - plus the test files mirroring these calls.

2. **SQL constraints silently mis-hash (latent, even once the throw is fixed).**
   `control-schema.ts` and the strand membership constraints call e.g.
   `digest(new.Key, 'sha256', 'utf8', 'hex')`. Under `numArgs: -1` the literals
   `'sha256'`, `'utf8'`, `'hex'` are **no longer config — they become extra fields
   hashed into the digest**. So the SQL digest will not match any correctly-migrated
   TS digest, breaking `verify(...)` in every authority/membership/peer/device/
   formation-invite constraint. This will not surface as a thrown error — it
   surfaces as signatures that no longer validate.

## Why this is a designed migration, not a quick fix

- **Register-time encoding is a single global.** The plugin now binds ONE output
  encoding for the whole DB lifetime. `control-database.ts:170` registers with
  **no config** (defaults `sha256` / `base64url`), but the SQL schema mixes
  per-call `'hex'` (concatenated digests fed to `verify(..., 'hex')`, e.g.
  `control-schema.ts:23-26,36,49,148-154`) **and** base64url-default digests in
  the same schema. The new model cannot express both at once — this needs a
  deliberate decision (standardize the schema on one encoding and pass matching
  plugin config, or split the concatenation scheme).
- **Off-chain TS digests must be bit-identical to SQL digests** for every
  `verify(...)` to pass. Both sides must migrate together and agree on field
  framing, algorithm, and encoding. Getting it wrong silently breaks
  security-critical authority/membership verification rather than failing loudly.
- **Framing semantics changed.** Old call sites pre-joined fields with `'|'` into
  one string then hashed (`new.PeerId || '|' || new.Multiaddr || ...`). The new
  injective framing makes the manual `'|'` joins redundant/wrong if migrated to a
  multi-field `digest(a, b, c)` — each call site must be re-derived intentionally,
  not mechanically.

## Notes / what was ruled out

- Not caused by any local sereus change: the break is entirely the upstream
  optimystic `digest` rework, which is in optimystic HEAD and linked via root
  `package.json` `resolutions`.
- `schema-verification.ts:27` already uses the **new** array form
  `digest([payload], 'sha256', 'base64url')`, so a partial/ad-hoc migration has
  begun — the rest of cadre-core (and the SQL schema) is inconsistent with it.
- No workaround was applied. The triage pass deliberately did not attempt the
  migration inline: a mechanical search-and-replace would fix the TS throw while
  leaving the SQL constraints silently mis-hashing (breakage #2), producing a
  green-looking build that fails authority verification at runtime.

## Suggested approach (for the plan/implement stage)

- Decide the canonical digest config for the control DB (algorithm + single
  output encoding) and pass it to `registerPlugin(db, cryptoPlugin, config)` in
  `control-database.ts`.
- Rework every SQL constraint in `control-schema.ts` and the strand-membership
  constraints to the variadic `digest(f1, ..., fN)` form (dropping the
  `'sha256'/'utf8'/'hex'` literal args and the manual `'|'` joins), choosing
  field tuples that the framing makes injective.
- Migrate every TS caller (`control-database.ts`, `device-token.ts`,
  `peer-record.ts`, `peer-authorization.ts`, `strand-membership-writer.ts`,
  `seed-bootstrap.ts`) to the new TS signature so each off-chain digest matches
  its SQL counterpart byte-for-byte.
- Update the mirroring test helpers, then run the full
  `yarn workspace @serfab/cadre-core test` suite green.
