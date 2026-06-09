priority: 2
description: expo-secure-store-backed KeyStore in reference-app-rn — phone identity persists in iOS Keychain / Android Keystore instead of plaintext LevelDB, with one-time legacy migration and authority-key surfacing for pairing. Reviewed and accepted.
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-rn/package.json, docs/architecture.md
----

## What landed

The RN reference app's phone node persists its libp2p identity (and the
identity-derived authority key, single-key model) in the **platform secure
enclave** via `expo-secure-store` (iOS Keychain / Android Keystore-encrypted
SharedPreferences), replacing the plaintext LevelDB identity path
(`loadOrCreateRNPeerKey` / `sereus-peer-identity` DB). It consumes the `KeyStore`
seam from `keystore-interface-core` (`CadreNodeConfig.keyStore` + `identityKeyId`,
`CadreNode.getIdentityAuthorityKey()`).

- **`src/secure-key-store.ts`** (new) — `SecureStoreKeyStore implements KeyStore`
  over an injected `SecureStoreApi` (type-only `expo-secure-store` import, so the
  module never loads the native module under Node/vitest). base64 material
  bridge; base64url keyId→SecureStore-key mapping under `sereus.ks.` prefix;
  `list()` via a serialized `sereus.ks.__index` entry; access-vs-absence mapping
  (thrown→`KeyStoreAccessError`, `null`→`undefined`); option forwarding. Also
  exports the pure `migrateLegacyIdentity()` orchestrator.
- **`src/cadre-phone.ts`** — constructs the store
  (`keychainAccessible: AFTER_FIRST_UNLOCK`, no `requireAuthentication`), runs
  `migrateLegacyIdentity` before `node.start()`, sources authority genesis from
  `node.getIdentityAuthorityKey()`, exports `getAuthorityPublicKey()`. Legacy
  LevelDB glue (`readLegacyIdentityBytes` / `deleteLegacyIdentity`).
- **`src/use-cadre.ts`** + **`app/settings.tsx`** + **`src/test-ids.ts`** —
  surface `authorityPublicKey` and render an "Authority Key" `InfoRow` (tap →
  selectable modal) for out-of-band pairing.
- **`package.json`** — `expo-secure-store ~14.2.4` (SDK 53 pin).
- **`docs/architecture.md`** — "Mobile secure backend" subsection.

Full implementation detail is in the implement commit `dd56eef`.

## Review findings

Adversarial pass over implement commit `dd56eef`. Read the full diff (src, UI,
tests, docs) with fresh eyes before the handoff summary, then cross-checked
against the cadre-core seam (`key-store.ts`, `cadre-node.ts` `resolveIdentityKey`/
`getIdentityAuthorityKey`) and the legacy storage format in the linked
`../optimystic/db-p2p-storage-rn` package. Lint + typecheck + tests run green.

### Verified correct (checked, nothing to change)

- **Legacy migration is format-correct (the highest-risk claim).** Traced the
  old `loadOrCreateRNPeerKey`: it stored `privateKeyToProtobuf(key)` bytes in a
  **dedicated** `sereus-peer-identity` LevelDB (only the single identity entry,
  key-tag `TAG_IDENTITY`/`peer-private-key`; strands use separate `sereus-<id>`
  DBs). `readLegacyIdentityBytes` takes the first (only) entry's value verbatim;
  cadre-core deserializes it with `privateKeyFromProtobuf` — same format, so the
  PeerId/authority identity is preserved across the upgrade. The "single blob"
  assumption holds.
- **Legacy LevelDB glue API usage is correct** (gap #4, on-device-only) —
  checked against the real `LevelDBLike` driver surface: `iterator()` →
  `next(): Promise<[k,v]|undefined>` + `close()`, `iterator({keys:true})`,
  `db.delete(key)`, `db.close()` all match. `deleteLegacyIdentity` collects keys
  first then deletes (no iterate-while-mutate). try/finally closes iterators+DBs
  (no leaks).
- **keyId→SecureStore-key mapping is safe and collision-free.** base64url of the
  UTF-8 keyId under `sereus.ks.` emits only `[A-Za-z0-9-_]` (+ the prefix `.`) —
  the allowed charset. **No material key can collide with `__index`**: valid
  UTF-8 never has a byte ≥ 0xFC, so base64url output can never begin with `_`,
  so it can never equal `__index`. Re-derived independently; verified by the
  allowed-charset and no-collision tests.
- **Access vs absence** routes correctly: thrown `getItemAsync` →
  `KeyStoreAccessError` (caller never regenerates over an unreadable slot); `null`
  → `undefined` (the only path that lets cadre-core regenerate); corrupt base64 →
  `KeyStoreAccessError`. `get` reads material directly (never the index), so the
  critical identity load at start has minimal failure surface.
- **Index crash-consistency + serialization** — `set` writes material before
  index, `delete` removes index before material (invariant: an index entry never
  points at missing material; orphaned material is tolerable and never returned
  via `list`). `mutateIndex` serializes read-modify-write on a promise chain with
  failed-link recovery; index reads/writes drop `requireAuthentication` so
  `list`/`set`/`delete` never prompt. Verified by the serialized-concurrent-sets,
  orphan, corrupt-index, and option-forwarding tests.
- **`migrateLegacyIdentity` decision logic** — gated on the secure slot being
  empty (copies + clears legacy at most once); propagates `KeyStoreAccessError`
  from the slot (never migrates over an unreadable key); swallows a legacy-read
  failure to fall through to fresh generation; best-effort legacy delete is
  non-fatal. Runs before `node.start()` so cadre-core's generate path can't
  pre-empt it. Fully covered.
- **cadre-phone / cadre-core wiring** — `identityKeyId` matches
  (`DEFAULT_IDENTITY_KEY_ID`) between migration and `CadreNodeConfig`; `privateKey`
  removed (mutually exclusive with `keyStore`); authority genesis now sources from
  `getIdentityAuthorityKey()`. `getAuthorityPublicKey()` returns base64url
  (confirmed: `AuthorityKeyPair.publicKeyB64` is base64url — docs accurate).
- **UI** — `getAuthorityPublicKey` plumbed through `use-cadre` and reset on
  start/connect/disconnect; "Authority Key" row taps into a genuinely `selectable`
  modal (`showAlert`/`Modal`); `Pressable` imported; test-id added.
- **No lingering legacy references** in reference-app-rn (the
  `loadOrCreateRNPeerKey`/`authorityKeyFromLibp2p` imports are gone). The web
  reference app still uses its own IndexedDB identity path — correctly **out of
  scope** for this RN ticket.
- **Docs** — `docs/architecture.md` "Mobile secure backend" matches the code:
  bridging, gating (`AFTER_FIRST_UNLOCK`, no auth), migration, the iOS-persists /
  Android-wipes reinstall table, and biometric-invalidation semantics.

### Found + fixed in this pass (minor)

- **Untested reachable error path: corrupt stored material.** Confirmed
  `uint8arrays` base64 decode genuinely *throws* on non-base64 input (not dead
  code, not silent-garbage), so the `get` → `KeyStoreAccessError` branch (impl
  gap #6) was a real, reachable, untested path. Added a test that corrupts the
  stored value and asserts `KeyStoreAccessError` (keyId preserved).
- **Untested branch: zero-length legacy blob.** `migrateLegacyIdentity` treats
  `byteLength === 0` as no-legacy (so it never `set`s an empty slot), but only the
  `undefined` case was tested. Added a `new Uint8Array(0)` → `'no-legacy'` test.

Tests now **77 passed** (was 75); lint + typecheck re-run clean.

### Found → filed as new ticket (major)

- **Biometric-invalidation → silent identity regeneration** (impl gap #2). A
  gated slot (`requireAuthentication: true`) invalidated by a biometric-set change
  reads as `null` per the Expo API — indistinguishable from empty — so our mapping
  yields `undefined` and cadre-core would **regenerate**, orphaning the real
  identity. **Latent, not active**: the identity slot ships with gating *off*, so
  no current code path can hit it; it becomes a live silent-identity-loss bug the
  instant anyone enables `requireAuthentication`. Filed
  `backlog/secure-store-gated-slot-regeneration-guard.md` to add a
  "was-present-but-now-null" discriminator (+ the `NSFaceIDUsageDescription`
  prerequisite, impl gap #3) before gating is enabled. Not fixed here because it
  has no effect on shipped behaviour and the right fix needs a design choice.

### Deferred to manual / human (cannot be agent-validated)

- **On-device verification (impl gap #1) remains outstanding.** The KeyStore
  contract, byte/keyId bridges, index, access-vs-absence, and migration *decision
  logic* are unit-covered against an in-memory fake, but the native enclave and
  the rn-leveldb iterate/delete glue run only on a real device/simulator. Before
  relying on this in anger, a human/CI must still run: iOS reinstall **persists**
  PeerId/authority; Android reinstall yields a **new** identity (and the new
  Authority Key shows for re-pairing); locked-after-first-unlock background
  bring-up resolves identity without a prompt; and a real pre-secure-store →
  this-build upgrade preserves PeerId and clears the `sereus-peer-identity`
  plaintext. Flagged here so it is not mistaken for done.

### Empty categories

- **No security issues** — no key material is logged, returned in errors, or left
  in plaintext after migration; `KeyStoreAccessError` carries only the keyId.
- **No DRY / type-safety / resource-leak findings** — no `any`; injected
  `SecureStoreApi` keeps the native module out of the test graph; all DB/iterator
  handles closed in `finally`.
- **No pre-existing test failures** surfaced (`.pre-existing-error.md` not
  written).

## Validation

- `yarn workspace @serfab/reference-app-rn test` → **77 passed** (25 in
  `test/secure-key-store.spec.ts`, incl. the 2 added this pass).
- `yarn workspace @serfab/reference-app-rn typecheck` → clean.
- `yarn lint` (repo-wide) → clean; `eslint` on the edited spec → clean.
