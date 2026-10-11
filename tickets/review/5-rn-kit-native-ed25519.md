description: Review PR #33 (merged locally): phone apps built on the shared kit can now sign and check signatures natively instead of in slow JavaScript, by adding one import at startup.
prereq: rn-kit-native-digest
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/src/native-ed25519.ts, packages/cadre-rn/polyfills/native-crypto.js, packages/cadre-rn/polyfills/audit.js, packages/cadre-rn/test/native-ed25519.spec.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, docs/reference-app-rn.md
----
# Native Ed25519 behind `crypto.subtle` (PR #33, kjeib)

External PR, merged locally as `Merge PR #33: cadre-rn native Ed25519 behind crypto.subtle from boot`. The PR filed this ticket straight into `complete/`; it was moved to `review/` at merge so it gets a review pass. Conflict only in `.release-notes.pending.md`: PR #32's digest note had already shipped in v1.14.0, so only the Ed25519 section was kept. Read its commit (`feat(cadre-rn): native Ed25519 behind crypto.subtle from boot`) first.

Follows `7-rn-kit-native-digest`, which made block hashing native. The other half of
sereus-chat's native-crypto polyfill is Ed25519. @libp2p/crypto signs and verifies through WebCrypto
when a probe (`subtle.generateKey({ name: 'Ed25519' })`) succeeds, and otherwise through pure-JS
`@noble/curves`. Hermes has no WebCrypto beyond the boot polyfill's digest, so every libp2p
signature on a phone runs in JavaScript: sereus-chat measured 169 ms per verify on a Galaxy S7,
against 0.72 ms native.

## What landed

- **`src/native-ed25519.ts`** (`@serfab/cadre-rn/native-ed25519`): `installNativeEd25519(native,
  subtle?)` fills `generateKey`, `importKey`, `exportKey`, `sign` and `verify` from a native
  `SubtleCrypto`, only where the global one lacks them. All or nothing (a probe never sees half a
  WebCrypto); a complete WebCrypto is left alone; idempotent; imports nothing native.
- **`polyfills/native-crypto.js`**: side-effect subpath calling it with react-native-quick-crypto's
  `subtle`, and installing the native digest at the same time.
- The audit's `crypto.subtle.importKey` entry names the import that fills it.
- README section and subpath rows; `docs/reference-app-rn.md` note; release note.

## Why a boot polyfill, not `noise-crypto`

@libp2p/crypto runs its probe once, when `keys/ed25519/index.browser.js` is evaluated
(`webCryptoEd25519SupportedPromise`), and keeps the answer. `noise-crypto` imports
`@optimystic/db-p2p`, which loads libp2p before `noise-crypto`'s body runs, so an install there is
always too late for Ed25519. The digest is looked up on every call, so #7's install-on-load works
for it.

## Verification

- `cadre-rn`: typecheck clean; 156 tests pass, 7 new (Node's WebCrypto stands in for
  quick-crypto's, including a real sign and verify through the filled methods); eslint clean on
  changed files; knip reports nothing new.
- Device: the same logic, carried as an app polyfill in sereus-chat and taleus, runs on a Galaxy S7
  (Android 8). A taleus CPU profile there showed no libp2p Ed25519 in JS. Not yet run through this
  kit subpath on a device.

## Not covered

`@optimystic/quereus-plugin-crypto` calls `@noble/curves` directly for its SQL `verify`, so it
stays in JS whatever `crypto.subtle` offers. On the S7 that was 408 ms of a 29 s taleus invite.
Needs a seam in Optimystic (gotchoices/optimystic#30).

## Review focus

- **Scope of the fill.** `installNativeEd25519` installs quick-crypto's `generateKey`, `importKey`, `exportKey`, `sign` and `verify` for every algorithm, not only Ed25519. libp2p's ECDSA/RSA `importKey`/`exportKey` calls (previously a `TypeError`, per `docs/reference-app-rn.md`'s "`crypto.subtle` provides `digest` and nothing else") now reach quick-crypto. That paragraph and the audit's known-gap entries for `crypto.subtle.*` should say so, or the fill should be limited.
- **Verification surface.** Signature checks on the phone now run in quick-crypto. Confirm libp2p's WebCrypto Ed25519 path (`keys/ed25519/index.browser.js`) handles every key format quick-crypto returns (raw, JWK, PKCS#8), and that a `verify` throw is treated as invalid, not as valid.
- **Boot order.** The polyfill must load after `/polyfills` and before any libp2p import. `reference-app-rn`'s `index.js` does not import it yet; decide whether the reference app should (it already depends on quick-crypto for native Noise), and whether `boot-check` should warn when libp2p loaded first.
- **Device check.** Not yet run through this kit subpath on a device (the same logic runs as an app polyfill in sereus-chat and taleus).
- **Tests**: `native-ed25519.spec.ts`; cut any that restate the implementation.

## Verification at merge

`yarn build`, `yarn lint`, `yarn workspace @serfab/cadre-rn test` (156 pass).
