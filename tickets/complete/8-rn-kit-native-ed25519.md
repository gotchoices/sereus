description: Phone apps built on the shared kit can now sign and check signatures natively instead of in slow JavaScript, by adding one import at startup.
prereq: 7-rn-kit-native-digest
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/src/native-ed25519.ts, packages/cadre-rn/polyfills/native-crypto.js, packages/cadre-rn/polyfills/audit.js, packages/cadre-rn/test/native-ed25519.spec.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, docs/reference-app-rn.md
----
# Native Ed25519 behind `crypto.subtle`

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
Needs a seam in Optimystic.
