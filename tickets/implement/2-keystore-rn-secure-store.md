priority: 2
prereq: keystore-interface-core
description: Implement an expo-secure-store-backed KeyStore in reference-app-rn (iOS Keychain / Android Keystore) and wire the phone node identity through it, replacing plaintext LevelDB key persistence
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/package.json, packages/reference-app-rn/app.json
----

The React Native reference app currently persists its libp2p peer/identity key in **plaintext LevelDB** via `loadOrCreateRNPeerKey` (`@optimystic/db-p2p-storage-rn`), with an explicit in-code note that this is not secure storage. This ticket implements a `KeyStore` (interface from the `keystore-interface-core` ticket) backed by **`expo-secure-store`** — iOS Keychain and Android Keystore (encrypted SharedPreferences) — and wires the phone node to load/generate its identity through it. The authority key is derived from the identity (single-key model), so moving the identity into the enclave protects both.

### Backend decision: expo-secure-store (resolves the plan's open question)

The app is **Expo managed** (`expo ~53`, `expo-dev-client`, `expo-router`, `expo-notifications`; no bare-workflow native config today). Chosen: **`expo-secure-store`** over `react-native-keychain`.

Rationale (verified against current Expo docs, June 2026):
- First-party Expo, no config-plugin/native scaffolding beyond an `NSFaceIDUsageDescription` string; `react-native-keychain` needs a config plugin and shines only for advanced features (biometric-only access, shared keychain groups) we don't need now.
- iOS → Keychain (`kSecClassGenericPassword`); Android → SharedPreferences encrypted with an Android Keystore key. Matches the ticket's enclave requirement on both platforms.
- Stored material is tiny: Ed25519 identity = ~68-byte protobuf, well under the ~2048-byte soft size limit that some iOS releases historically enforced. Document the limit so larger future material (don't store it here) is handled.
- Biometric gating is available but optional via `requireAuthentication: true` (prompt fires automatically on read) + `SecureStore.canUseBiometricAuthentication()`. This satisfies "interface must not preclude biometric" without making it mandatory. Default: **no** `requireAuthentication` for the identity slot (the node must come up in background/headless contexts — see edge cases); expose it as an app-controlled option so the dev can align with UX.

### SecureStoreKeyStore implementation

Add `packages/reference-app-rn/src/secure-key-store.ts` implementing the cadre-core `KeyStore` interface over `expo-secure-store`.

Mapping and constraints:
- **Byte ↔ text bridge.** `expo-secure-store` stores **strings**; `KeyStore` material is `Uint8Array`. Encode with base64 (`uint8arrays` `toString/fromString`, already a dep) on `set`, decode on `get`.
- **KeyId → SecureStore key.** SecureStore keys must match `[A-Za-z0-9._-]` (no `/`). Map `KeyId` → a safe key (e.g. base64url or percent-encode the keyId, with a stable prefix like `sereus.ks.`). The default identity slot `'cadre/identity'` must map deterministically and round-trip.
- **`list()` via index.** Neither iOS Keychain nor Android Keystore (through expo-secure-store) can enumerate keys. Maintain an index: a reserved SecureStore entry (e.g. `sereus.ks.__index`) holding a JSON array of logical keyIds. `set` adds (dedup), `delete` removes, `list` reads it. Keep index writes consistent with material writes: write material first, then index (so a crash leaves an orphaned-but-readable slot, never an index entry pointing at nothing). `get` does not depend on the index.
- **`get` returns `undefined`** when `getItemAsync` yields `null`. Surface a thrown/cancelled biometric prompt (only relevant if `requireAuthentication` is enabled) as cadre-core's `KeyStoreAccessError`, NOT as `undefined` — returning undefined would let cadre-core regenerate and orphan the real identity.
- Construction options: `{ requireAuthentication?: boolean; keychainAccessible?: SecureStore.KeychainAccessibilityConstant }` forwarded to `setItemAsync`/`getItemAsync` so the app dev controls gating and accessibility (e.g. `AFTER_FIRST_UNLOCK` for background use). Default accessibility chosen to permit background/headless node bring-up.

### Wiring the phone node

In `packages/reference-app-rn/src/cadre-phone.ts`:
- Construct a `SecureStoreKeyStore` and pass it (plus default `identityKeyId`) into `CadreNodeConfig` instead of pre-loading a `privateKey`. Remove the `loadOrCreatePhoneKey()` / `loadOrCreateRNPeerKey` LevelDB identity path and the associated `PEER_IDENTITY_DB_NAME` LevelDB (peer identity only — leave the per-strand `sereus-${strandId}` data LevelDBs alone).
- Update `runAuthorityGenesis` to source the authority pair from the node's new `getIdentityAuthorityKey()` accessor (added in the core ticket) instead of `authorityKeyFromLibp2p(privateKey)` on a key it loaded itself.
- One-time migration: if a key exists in the old LevelDB identity store and the secure-store identity slot is empty, read it, write it into the KeyStore, and (optionally) delete the LevelDB copy so the device keeps its PeerId/authority identity across the upgrade. If reading the legacy store fails, fall through to fresh generation (logged, no key material in the log). Gate this so it runs at most once.

### Public-key display for pairing

The settings screen (`app/settings.tsx`) already shows the connected node's `peerId`. Per the first-launch use case ("displays public key for pairing"), ensure the **authority public key** (base64url, from `getIdentityAuthorityKey().publicKeyB64`) is also surfaced in the Node section so it can be shared for enrollment/pairing — add an `InfoRow` (copy-to-clipboard if trivial). Keep it read-only; never display or log any private material.

### Platform reinstall behavior (document + recovery)

Document in `docs/architecture.md` (enrollment/secure-storage section) and a concise in-app note where appropriate:
- **iOS** — Keychain items persist across app uninstall/reinstall by default, so identity/authority survive a reinstall.
- **Android** — uninstall wipes the app's SharedPreferences, so the Keystore-encrypted entries are lost; the node loses its identity on reinstall.
- **Biometric caveat** — entries written with `requireAuthentication: true` are invalidated when the device's biometric set changes (new fingerprint / re-enrolled Face ID); reading then fails with `KeyStoreAccessError`. Another reason the identity slot defaults to no biometric gating.
- **Recovery** — a node that has lost its enclave entries (Android reinstall, biometric invalidation, or device loss) recovers by **re-enrolling from another cadre node** (seed + authority pinning via the existing invite/seed flow), receiving a fresh identity; it does not recover the old key. Cross-reference the existing seed-bootstrap / `applySeed` recovery path.

### Dependencies / config

- Add `expo-secure-store` (SDK-53-compatible version) to `package.json` dependencies.
- Add `NSFaceIDUsageDescription` to `app.json` iOS `infoPlist` only if `requireAuthentication` will be exercised; otherwise note that it's required before enabling biometric gating.

### Edge cases & interactions

- **First launch (empty slot)** → cadre-core generates + persists identity through the store; PeerId is stable on next launch. Verify the round-trip (base64 encode/decode is lossless for protobuf bytes).
- **Legacy LevelDB key present** → migrated once into secure store; PeerId/authority unchanged across upgrade. Test the migration branch and the "legacy read fails → fresh generate" fallback.
- **Background / headless bring-up** (`expo-task-manager` / push-wake paths already in the app) → identity must load without a foreground UI; this is why biometric gating is off by default and accessibility allows after-first-unlock. Confirm the node can start from the background runner.
- **Biometric prompt cancelled** (only if gating enabled) → `get` raises `KeyStoreAccessError`; node start fails loudly; NO regeneration / identity orphaning.
- **Android reinstall** → slot empty → node generates a NEW identity (expected, documented); ensure the app surfaces this as "re-enroll" rather than silently acting as a new party. (At minimum: the new authority public key is shown for re-pairing.)
- **iOS reinstall** → identity persists; node resumes with the same PeerId/authority.
- **Index/material desync** → orphaned material (in store, not in index) is tolerable and never returns key bytes via `list`; an index entry with missing material must not crash `get` of *other* slots. Test a forced-inconsistent index.
- **SecureStore unavailable / Expo Go** → `requireAuthentication` is unsupported in Expo Go; guard so dev runs degrade clearly rather than throwing opaque native errors.
- **Concurrent set to the index** (two slots written close together) → index updates must not lose entries; serialize index read-modify-write.
- **Size guard** → if a future caller stores material > ~2048 bytes, surface the native error rather than silently truncating (don't store large material here, but fail loudly).

### Tests (vitest — the app already uses vitest)

Mock `expo-secure-store` (in-memory map standing in for `getItemAsync`/`setItemAsync`/`deleteItemAsync`) and run:
- The cadre-core KeyStore contract suite against `SecureStoreKeyStore` (reuse/import the parametrized contract from the core ticket if exported; otherwise mirror it): set/get round-trip, get-missing→undefined, delete idempotency, `list` reflects writes/deletes, awkward keyId mapping (`'cadre/identity'`).
- base64 byte round-trip fidelity for representative protobuf bytes.
- KeyId→SecureStore-key mapping round-trips and rejects/escapes disallowed chars.
- `get` raising on a simulated biometric-cancel → `KeyStoreAccessError` (not `undefined`).
- Index consistency: forced orphan in index does not break `get`; `delete` prunes the index.
- Migration: legacy-LevelDB-present path writes into the store once; fresh-generate fallback when legacy read throws.

### Validation

- `yarn lint` (think cross-platform: this file is RN/Expo — no Node-only imports leaking in).
- `yarn workspace <reference-app-rn pkg name> test` (vitest) and typecheck — stream with `2>&1 | tee`.
- Device/simulator verification (Keychain persistence across reinstall, Android loss on reinstall, background bring-up) is **manual / out-of-band** — not agent-runnable; document the manual steps in the review handoff rather than attempting them in-ticket.

## TODO

- [ ] Add `expo-secure-store` to `package.json`; (conditionally) add `NSFaceIDUsageDescription` to `app.json`.
- [ ] Implement `src/secure-key-store.ts` (`SecureStoreKeyStore`): byte↔base64 bridge, keyId↔SecureStore-key mapping, index-backed `list`, `KeyStoreAccessError` on access-denied, construction options for gating/accessibility.
- [ ] Rewire `cadre-phone.ts` to pass `keyStore` (+ `identityKeyId`) into `CadreNodeConfig`; remove LevelDB peer-identity path; keep per-strand storage.
- [ ] Update `runAuthorityGenesis` to use `node.getIdentityAuthorityKey()`.
- [ ] Add one-time LevelDB→SecureStore identity migration with safe fallback.
- [ ] Surface the authority public key for pairing in `app/settings.tsx`.
- [ ] Document reinstall behavior (iOS vs Android), biometric invalidation, and re-enrollment recovery in `docs/architecture.md` (+ brief in-app note).
- [ ] Write the vitest suites above with a mocked `expo-secure-store`; run lint + test green.
- [ ] In the review handoff, list the manual device verification steps (iOS reinstall persistence, Android reinstall loss, background bring-up).
