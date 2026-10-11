description: Phone apps built on the shared kit can now sign and check signatures natively instead of in slow JavaScript, by adding one import at startup; the reference app now does so.
prereq: rn-kit-native-digest
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/src/native-ed25519.ts, packages/cadre-rn/polyfills/native-crypto.js, packages/cadre-rn/polyfills/audit.js, packages/cadre-rn/test/native-ed25519.spec.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/index.js, docs/reference-app-rn.md, docs/architecture.md
----
# Native Ed25519 behind `crypto.subtle` (PR #33, kjeib)

External PR, merged locally as `Merge PR #33: cadre-rn native Ed25519 behind crypto.subtle from boot` (feature commit `feat(cadre-rn): native Ed25519 behind crypto.subtle from boot`). Follows `rn-kit-native-digest`, which made block hashing native.

@libp2p/crypto signs and verifies Ed25519 through WebCrypto when a probe (`subtle.generateKey({ name: 'Ed25519' })`) succeeds, and otherwise in pure-JS `@noble/curves`. Hermes has no WebCrypto beyond the boot polyfill's digest, so every libp2p signature on a phone ran in JavaScript: sereus-chat measured 169 ms per verify on a Galaxy S7, against 0.72 ms native.

## What landed

- **`src/native-ed25519.ts`** (`@serfab/cadre-rn/native-ed25519`): `installNativeEd25519(native, subtle?)` installs `generateKey`, `importKey`, `exportKey`, `sign` and `verify` from a native `SubtleCrypto` when the global one lacks any of them. The five go in as a set (a `CryptoKey` is unusable outside the implementation that made it); all or nothing on the native side; a complete WebCrypto is left alone; idempotent; imports nothing native.
- **`polyfills/native-crypto.js`** (`@serfab/cadre-rn/polyfills/native-crypto`): side-effect subpath calling it with react-native-quick-crypto's `subtle`, and installing the native digest at the same time. It must load after `/polyfills` and before any libp2p import, because @libp2p/crypto probes once, when `keys/ed25519/index.browser.js` evaluates.
- The reference app's `index.js` imports it (added in review).
- Audit entry for `crypto.subtle.importKey`, README section and subpath rows, `docs/reference-app-rn.md`, `docs/architecture.md`, release note.

## Not covered

- `@optimystic/quereus-plugin-crypto` calls `@noble/curves` directly for its SQL `verify`, so it stays in JS whatever `crypto.subtle` offers (408 ms of a 29 s taleus invite on the S7). Needs a seam in Optimystic (gotchoices/optimystic#30).
- **Device check.** Not yet run through this kit subpath on a device. The same logic ran as an app polyfill in sereus-chat and taleus on a Galaxy S7. Now that the reference app imports it, its next device run exercises it; a boot that logs `[cadre-rn] native Ed25519 unavailable` or a `crypto.subtle.importKey` row reading `gap` in the audit table means it did not take.

## Review findings

Read the feature commit's diff first, then libp2p's `keys/ed25519/index.browser.js` and `ed25519.js`/`utils.js` (@libp2p/crypto 5.1.23) and quick-crypto 1.1.7's `src/subtle.ts` and `src/index.ts`.

**Fixed in this pass**

- **Mixed implementations (defect).** The install filled only the methods the global `subtle` lacked. A global with some of the five (say an app polyfill's `importKey`) would get native `generateKey`/`sign`/`verify` beside a foreign `importKey`: libp2p's probe passes, then every signature fails because native `sign` cannot use the foreign `CryptoKey`. Now the five are installed as one set whenever any is missing. New test `replaces a partial set whole…` pins it (fails against the old code: the foreign `importKey` survived) and also runs libp2p's verify sequence (raw public key → `importKey` → `verify`).
- **Scope of the fill — docs.** The five methods serve every algorithm quick-crypto supports, so libp2p's ECDSA/RSA `importKey`/`exportKey` now reach quick-crypto instead of throwing. Kept the fill unrestricted (quick-crypto implements those, and limiting by algorithm would be a wrapper for no current caller) and corrected the docs instead: `docs/reference-app-rn.md`'s "`crypto.subtle` provides `digest` and nothing else" paragraph is now "`crypto.subtle` has no AES-GCM surface", with the without-native-crypto case as its own paragraph; the `crypto.subtle.digest()` table row names `/polyfills/native-crypto`; the "Other global polyfills" table and directory listing gained `native-crypto.js`; the reference app's `dependency-globals.spec.ts` allowlist reason for `crypto.subtle` no longer says "digest only… pure noble".
- **Boot order — reference app.** Decided the reference app should import `/polyfills/native-crypto`: it already depends on quick-crypto for native Noise, so it costs nothing new. Added it after `/polyfills`, before `/polyfills/webrtc`, and updated every place that lists the entry imports (`docs/reference-app-rn.md` snippet and order rationale, `docs/architecture.md`, kit README snippet and audit note, `polyfills/index.js` and `boot-check.js` comments, reference app README).
- **Audit placement.** The `crypto.subtle.importKey` probe sat under "Known gaps"; moved it beside `RTCPeerConnection`, the other optional-install probe, with a comment that it stands for all five methods.
- **Duplicate warning.** `native-crypto.js` warned on `check-failed` after `installNativeDigest` had already warned; removed the second one.
- **Tests cut.** `keeps the digest it found` (folded into the first test as one assertion), `reports a missing native WebCrypto as unavailable` (a one-line guard), `defaults to the global crypto.subtle…` (tests a default parameter). Five remain.

**Checked, no change**

- **Key formats.** libp2p never imports a key quick-crypto exported: signing imports a JWK (`kty: 'OKP'`, `crv: 'Ed25519'`, `x`, `d`) and verifying imports `'raw'` from `publicKey.buffer`. quick-crypto's `edImportKey` handles both. `publicKey.buffer` is exactly 32 bytes because `ensureEd25519Key` copies with `Uint8Array.from`. `exportKey` and PKCS#8 are never called on this path.
- **A throwing `verify`.** `hashAndVerifyWebCrypto` returns the native `verify`'s promise; a throw rejects `Ed25519PublicKey.verify`, which callers see as an error, never as `true`.
- **Import shape.** quick-crypto exposes `subtle` only on its default export (`...subtle` spread of the module, which carries `export const subtle = new Subtle()`); `qc = quickCrypto.default ?? quickCrypto` handles it. Methods are bound to the native instance.
- **Boot-check warning when libp2p loaded first.** Declined: nothing global marks that @libp2p/crypto has evaluated, and the existing audit row (`gap` vs `polyfilled`) already shows whether the install happened. Order is documented at every entry listing.
- **Resource cleanup, performance, type safety.** Nothing to clean up (a one-time install); no `any`; the casts in `installNativeEd25519` are confined to the write-back.

**Validation:** `yarn workspace @serfab/cadre-rn build` and `typecheck` clean; `@serfab/cadre-rn` tests 154 pass; `@serfab/reference-app-rn` tests 151 pass; `yarn lint` clean. Not run: `yarn test:bundle` (Android export) and a device boot.

No tickets filed: the one defect was fixed inline, and the device check is recorded above rather than as a ticket since the reference app's next device run covers it.
