description: The shared kit now switches block hashing to the phone's native SHA-256 once react-native-quick-crypto has loaded, instead of leaving it in pure JavaScript, which in one app took close to half the time the app's code ran.
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/src/native-digest.ts, packages/cadre-rn/src/noise-crypto.ts, packages/cadre-rn/polyfills/hermes.js, packages/cadre-rn/package.json, packages/cadre-rn/test/native-digest.spec.ts, packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts, packages/cadre-rn/README.md, docs/reference-app-rn.md
----
# Native SHA-256/512 behind `crypto.subtle.digest`

`polyfills/hermes.js` defines `crypto.subtle.digest` with `@noble/hashes`. multiformats' browser
`sha256` goes through it, and Optimystic hashes every block (`canonicalBlockHash`) with it. A Hermes
CPU profile of sereus-chat put **47% of all JS time** in that digest. The JS thread was blocked for
up to 43 s at a stretch, and two-phone messages took minutes, against about 1 s in Node.

sereus-chat now routes SHA-256/512 through react-native-quick-crypto's synchronous `createHash`. It
checks the result against the "abc" test vector first, keeps noble as the fallback, and warns when
the fallback is used. On a Galaxy S7, `reserveRelays` went from 18 s to 6.6 s. The loop's blocked
share fell from about 13% to 4–9%. Chat's version is the last block of
`apps/mobile/polyfills/hermes.js`.

## Expectation

The kit's polyfill uses quick-crypto when the app has it installed and noble otherwise.
quick-crypto is an optional peer, so the polyfill must not require it. Metro resolves `require` at
bundle time, so this needs Metro's optional-dependency support (`allowOptionalDependencies`, set by
`withCadreMetro`) or an equivalent, tested in both directions.

## What landed

No Metro change. The premise above was that the polyfill would `require` quick-crypto as an
optional dependency; `withCadreMetro` does not set `allowOptionalDependencies`, and the polyfill
runs before quick-crypto can load anyway (quick-crypto's own modules read globals the polyfills
supply). Instead the boot fallback is replaced once quick-crypto is already loaded:

- `polyfills/hermes.js` tags its `@noble/hashes` digest with
  `Symbol.for('@serfab/cadre-rn/js-digest')`. Nothing else about it changes.
- New `@serfab/cadre-rn/native-digest` (`src/native-digest.ts`): `installNativeDigest(createHash,
  subtle?)` replaces only a tagged digest, after a known-vector check (SHA-256 of "abc"), for
  SHA-256 and SHA-512, leaving other algorithms with the fallback. It is idempotent. It returns
  `'installed' | 'already' | 'not-polyfilled' | 'check-failed'` and warns on a failed check.
  `nativeDigestActive()` reports the state. It imports no native module.
- `noise-crypto.ts` calls it at module load with the `createHash` it already imports, so any app
  that passes native Noise crypto gets native hashing with no further change.
- multiformats reads `crypto.subtle.digest` on every call, so a replacement made after boot applies
  from the next hash. Hashing before the `noise-crypto` import still uses the fallback.

Tests: `test/native-digest.spec.ts` (`node:crypto` as the native hash; replacement, byte views,
other algorithms, untagged digests, idempotence, failed check, a throw mid-call), and a case in the
polyfill spec that the boot digest carries the tag. Kit typecheck, build, tests (149) and lint pass.

Not yet seen on a device through the kit; sereus-chat ran the same replacement in its own
polyfills (S7: `reserveRelays` 18 s → 6.6 s; SHA-256 gone from the CPU profile).
