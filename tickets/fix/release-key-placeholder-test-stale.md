description: Two `isPlaceholderReleaseKey` unit tests fail at HEAD because they assert the pre-release invariant "the shipped default PROD_KEY_BASE64 is the all-zeros placeholder", but the real Ed25519 release public key was intentionally committed (fb79894) per the publish guard's own documented workflow. Product code is correct and load-bearing; the tests are stale and must be re-expressed to test the function contract via explicit inputs.
prereq:
files:
  - packages/cadre-host/src/update/__tests__/release-key.test.ts (the two stale assertions)
  - packages/cadre-host/src/update/release-key.ts (PROD_KEY_BASE64 — real key, do NOT revert)
  - scripts/publish-package.js (placeholder guard; documents "Commit the new PROD_KEY_BASE64")
  - packages/cadre-host/scripts/release-keygen.mjs (--write-source workflow)
  - docs/cadre-host.md (release signing & key management runbook)
difficulty: easy
---

# Fix: stale placeholder-era assertions in release-key.test.ts

## Failing test

```
# from packages/cadre-host
yarn test --run release-key
```

`packages/cadre-host/src/update/__tests__/release-key.test.ts`:

- `isPlaceholderReleaseKey > is true for the default all-zeros placeholder (no override)` — line 17, expected `true`, got `false`.
- `isPlaceholderReleaseKey > honors an explicit env argument over process.env` — line 27, `isPlaceholderReleaseKey({})` expected `true`, got `false`.

Error excerpt:

```
AssertionError: expected false to be true // Object.is equality
 ❯ src/update/__tests__/release-key.test.ts:17:39
```

Reproduces at HEAD against freshly-built deps (2 failed | 1 passed).

## Root cause (confirmed, not hypothesis)

`release-key.test.ts` predates the release-key embed. It hard-codes the pre-release
assumption that the **shipped default** `PROD_KEY_BASE64` decodes to 32 zero bytes:

- line 17: `expect(isPlaceholderReleaseKey()).toBe(true)` — no override, so falls to the embedded default.
- line 27: `expect(isPlaceholderReleaseKey({})).toBe(true)` — empty env, same fall-through.

Commit `fb79894` ("feat(cadre-host): embed production release-signing public key")
deliberately replaced the all-zeros placeholder with the real key:

```
-const PROD_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
+const PROD_KEY_BASE64 = 'XyRVnOY9DVgU6xdMgJIguOsc9B2L1o2KoU9626Nk+OE=';
```

This is the **intended, documented terminal state**, not a defect:

- The publish guard (`scripts/publish-package.js:39-52`) refuses to ship the placeholder and
  its own message instructs: *"Generate a real keypair offline … Commit the new
  PROD_KEY_BASE64, re-sign latest.json, then publish."* Committing the real key is the
  prescribed workflow.
- The embedded key is **load-bearing**: cadre-host verifies its signed `latest.json`
  (committed in `b48b027`) against it. Reverting `PROD_KEY_BASE64` to all-zeros would make the
  shipped binary reject every authentic manifest as `signature_invalid` and break updates.
- A **public** key in source is intended (`release-key.ts:1-9`: "only the public half ever
  ships in the binary"). No secret is exposed.

`fb79894` updated the source + docs + `.gitignore` but did **not** update
`release-key.test.ts`, which still encodes the now-obsolete placeholder-ships assumption.
`isPlaceholderReleaseKey()` itself is correct — it returns `true` iff the effective key decodes
to 32 zero bytes; the test just feeds it the wrong input (the mutable embedded constant instead
of an explicit placeholder).

## Fix

Re-express the two stale assertions to test the **function contract** with explicit inputs,
decoupling coverage from the mutable embedded constant:

- Placeholder-detection (true branch): feed an explicit all-zeros key rather than relying on the
  embedded default —
  `expect(isPlaceholderReleaseKey({ CADRE_HOST_UPDATE_DEV_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })).toBe(true)`.
- Real-key (false branch): the existing override test (line 21-22) already covers this; the
  `{}` case at line 27 should assert the *effective embedded default* is a real key, mirroring
  the publish guard's post-release invariant — `expect(isPlaceholderReleaseKey({})).toBe(false)`
  and `expect(isPlaceholderReleaseKey()).toBe(false)`. Frame these as "the shipped default is a
  real (non-placeholder) key", not as an inversion trick — that is the actual invariant the
  publish guard enforces.

Net: both branches of `isPlaceholderReleaseKey` stay covered; the placeholder-detection path is
tested with a real all-zeros input rather than a coincidence of the current embedded byte
string.

## Design constraints

- **Do NOT revert `PROD_KEY_BASE64`** to all-zeros — it is load-bearing (signs `latest.json`)
  and the guard mandates committing the real key.
- Enforcing "a *release build* must not ship the placeholder" is the job of the publish guard
  (`scripts/publish-package.js`), not this unit test. Don't try to recreate that invariant here.
- Keep coverage of both true/false branches of `isPlaceholderReleaseKey`. Don't merely delete
  the failing assertions.
- Public key in committed source is intended — no security finding; don't gitignore/relocate it.

## Cross-cutting obligations

None. No determinism edition bump, byte-format vector, golden fixture, or migration — this is a
test-only correction; the signing key, manifest format, and verification path are unchanged.

## TODO

- [ ] Rewrite `release-key.test.ts` lines 15-18 and 25-28 per "Fix" above.
- [ ] `cd packages/cadre-host && yarn test --run release-key` → green (3+ tests).
- [ ] `yarn lint` on cadre-host clean.
- [ ] Remove this signature's entry from `tickets/.pre-existing-known.md` once landed.
