----
description: Update Sereus to the crypto library's new hashing function, which changed its arguments — right now signing and verification of cadre records crash or silently break.
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/device-token.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/schema-verification.ts, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-provider/src/server/auth.ts, ../optimystic/packages/quereus-plugin-crypto/src/crypto.ts, ../optimystic/packages/quereus-plugin-crypto/src/plugin.ts
difficulty: hard
----

### Symptom

`cadre-host` integration tests fail at HEAD:

**Command:** `cd packages/cadre-host && yarn test src/auth/__tests__/trust-circle-integration.test.ts`

**Failing tests** (`src/auth/__tests__/trust-circle-integration.test.ts`):
- "issues → redeems → lists against the real control DB (listMembers path)"
- "removes a member from CadrePeer"

**Error:**
```
Error: Unsupported output encoding: utf8
 ❯ resolveOutputEncoder ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:129:9
 ❯ digest ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:324:56
 ❯ generateStampId ../cadre-core/src/control-database.ts:25:28
 ❯ ControlDatabase.insertAuthorityKey ../cadre-core/src/control-database.ts:489:21
 ❯ src/auth/__tests__/trust-circle-integration.test.ts:58:15
```

### Root cause

The linked `@optimystic/quereus-plugin-crypto` underwent a committed breaking
API change (optimystic commits `8cea904` / `f10094c`,
`ticket(implement|review): crypto-digest-variadic-config`). The `digest`
function was redesigned:

- **Old API:** `digest(value, algorithm, inputEncoding, outputEncoding)` — a bare
  hash of a single value with per-call algorithm and input/output encodings
  (`digest(x, 'sha256', 'utf8', 'hex')`).
- **New API (HEAD of optimystic):**
  - JS: `digest(fields: readonly DigestField[], algorithm = 'sha256', encoding = 'base64url')`
    — an *injective, framed* multi-field digest (format-version byte + per-field
    type tags + LEB128 lengths, then hashed). `digest(['hello'])` is **not**
    `sha256("hello")`.
  - SQL: registered as **variadic over data fields only** —
    `digest(f1, f2, ..., fN)`. Algorithm and output encoding are resolved
    **once at plugin registration** from load config
    (`crypto.ts:319`, `plugin.ts:120-134`); they are no longer per-call args.

Sereus's `cadre-core` was never migrated. Both the JS callers and the SQL schema
still pass the old positional algorithm/encoding arguments:

- `control-database.ts:25` (`generateStampId`): `digest(peerId, 'sha256', 'utf8', 'bytes')`
  → `'utf8'` is read as the (now-3rd) `encoding` arg → `resolveOutputEncoder('utf8')`
  throws. This is the immediate crash the tests hit.
- `control-database.ts:72` (`buildAuthorizationMessage`): same broken
  `digest(field, 'sha256', 'utf8', 'bytes')`.
- `control-schema.ts` lines 23, 26, 36, 49, 73, 86, 90, 109, 121, 125, 144-150, 184:
  every signed-write constraint calls `digest(value, 'sha256', 'utf8', 'hex')`
  or `digest(value, 'sha256', 'utf8')`. Under the new variadic SQL function these
  string literals become **additional hashed fields** rather than algorithm/encoding
  selectors — so the digests silently change value (no crash, wrong bytes).

### Scope / blast radius

`digest(` appears in ~31 files under `packages/` (signers, schemas, and tests).
The security-critical surface is the signer/verifier pair that must stay
**byte-identical**:

- JS signers produce the message bytes: `buildAuthorizationMessage`
  (`control-database.ts`), plus `peer-authorization.ts`, `device-token.ts`,
  `peer-record.ts`, `seed-bootstrap.ts`, `strand-membership-writer.ts`,
  `schema-verification.ts`, `cadre-provider/src/server/auth.ts`.
- SQL `verify(...)` constraints in `control-schema.ts` and
  `quereus-plugin-sereus/src/strand-schema.ts` re-derive and check those bytes.

Any migration must keep both sides computing the same bytes, or `verify` rejects
every signed row (replay/privilege-escalation protections documented at
`control-database.ts:54-69` depend on this).

### Why this is not a tightly-scoped triage fix

1. **Security-critical byte-parity.** The new digest is *framed* (type tags +
   lengths), so the concatenated-per-field-digest message contract between JS
   signers and SQL `verify` has to be re-established carefully across both
   languages. A subtle mismatch fails closed (all writes rejected) or, worse,
   changes the signed payload silently.
2. **Registration-time encoding.** The schema currently mixes `'hex'` (the
   concatenated authorization messages, decoded by `verify`'s `'hex'` input
   encoding) and the default base64url (bare `digest(x,'sha256','utf8')` in
   PeerAddress/DeviceToken/strand constraints). The new API fixes one output
   encoding per plugin registration, so the migration must decide a single
   encoding (and update how Sereus registers the crypto plugin) and rework the
   `verify` input-encoding arguments to match.
3. **Cross-package + cross-repo.** Touches `cadre-core`, `quereus-plugin-sereus`,
   `cadre-provider`, and the test suites in all of them; the authoritative API
   lives in linked `../optimystic/packages/quereus-plugin-crypto`.

This is a multi-subsystem migration with a single dominant failure mode
(signature byte-parity) and should be planned as its own ticket, not folded into
an unrelated change.

### Ruled out

- **Not** an EventSource/SSE issue and unrelated to the `svelte-check-gate`
  ticket whose work surfaced it (that diff only touched `events.ts` and
  package.json scripts).
- **Not** a flaky/environmental failure: reproduces deterministically at HEAD
  (`6d79439`); 370 other cadre-host tests pass — only the two integration tests
  that exercise `insertAuthorityKey` → `generateStampId` fail.
- A one-line patch of `control-database.ts:25` would unblock the crash but leave
  `buildAuthorizationMessage` and the entire SQL schema computing wrong/legacy
  digests — i.e. it would convert a hard crash into silent signature corruption.
  Rejected; the whole call surface must migrate together.

### Suggested approach (for the implementer)

1. Pin down the new contract in `quereus-plugin-crypto` (`crypto.ts`,
   `plugin.ts`): confirm the framed encoding, the registration config keys for
   algorithm/encoding, and `verify`'s input-encoding handling.
2. Choose one canonical output encoding for the Sereus control/strand plugins
   and set it at plugin registration.
3. Migrate JS signers and SQL constraints in lockstep, asserting byte-parity
   with a focused round-trip test before touching the broader schema.
4. Run `packages/cadre-core` and `packages/cadre-host` suites plus the
   `integration-tests` RBAC signed-write scenarios.
