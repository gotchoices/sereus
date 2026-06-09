priority: 2
prereq:
description: Review the expo-secure-store-backed KeyStore in reference-app-rn — phone identity now persists in iOS Keychain / Android Keystore instead of plaintext LevelDB, with a one-time migration and authority-key surfacing for pairing.
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, packages/reference-app-rn/package.json, docs/architecture.md
----

## What landed

The RN reference app's phone node now persists its libp2p identity (and the
authority key derived from it, single-key model) in the **platform secure enclave**
via `expo-secure-store` (iOS Keychain / Android Keystore-encrypted SharedPreferences),
replacing the plaintext LevelDB identity path (`loadOrCreateRNPeerKey` /
`sereus-peer-identity` DB). It consumes the `KeyStore` seam from the already-landed
`keystore-interface-core` work (`CadreNodeConfig.keyStore` + `identityKeyId`,
`CadreNode.getIdentityAuthorityKey()`).

### Files & responsibilities

- **`src/secure-key-store.ts`** (new) — `SecureStoreKeyStore implements KeyStore`
  over an injected `SecureStoreApi` (the 3 async methods of expo-secure-store).
  The expo-secure-store import is **type-only**, so importing this module never
  loads the native module (keeps Node/vitest clean). Also exports the pure
  `migrateLegacyIdentity()` orchestrator.
  - **Bytes↔text:** base64 on set / decode on get (`uint8arrays`).
  - **KeyId→SecureStore key:** base64url of the keyId under a `sereus.ks.` prefix
    (SecureStore keys may only be `[A-Za-z0-9._-]`; base64url emits `[A-Za-z0-9-_]`
    — no `/`, deterministic, collision-free). `cadre/identity` round-trips.
  - **`list()` via index:** reserved `sereus.ks.__index` entry holds a JSON array
    of logical keyIds. Material written before index; index read-modify-write is
    **serialized** via a promise chain (`mutateIndex`). Index reads/writes drop
    `requireAuthentication` (keyIds aren't material → never prompt).
  - **Access vs absence:** thrown `getItemAsync` → `KeyStoreAccessError`; `null` →
    `undefined`. Only `undefined` lets cadre-core regenerate, so a denied prompt
    never orphans the real identity.
  - Construction opts `{ requireAuthentication?, keychainAccessible? }` forwarded to
    every material call.
- **`src/cadre-phone.ts`** — constructs the store
  (`keychainAccessible: AFTER_FIRST_UNLOCK`, **no** `requireAuthentication`),
  passes `keyStore` + `identityKeyId` into config (removed the pre-loaded
  `privateKey`), runs `migrateLegacyIdentity` **before** `node.start()`, sources
  authority genesis from `node.getIdentityAuthorityKey()`, and exports
  `getAuthorityPublicKey()`. Legacy LevelDB glue (`readLegacyIdentityBytes` /
  `deleteLegacyIdentity`) iterates the dedicated `sereus-peer-identity` DB (which
  only ever held one blob).
- **`src/use-cadre.ts`** + **`app/settings.tsx`** + **`src/test-ids.ts`** — surface
  `authorityPublicKey` and render an "Authority Key" `InfoRow` (tap → selectable
  modal) in the Node section for out-of-band pairing.
- **`package.json`** — adds `expo-secure-store ~14.2.4` (SDK 53 pin). `yarn install` ran.
- **`docs/architecture.md`** — new "Mobile secure backend" subsection: bridging,
  gating, migration, reinstall table (iOS persists / Android wipes), biometric
  invalidation, re-enrollment recovery.

## Validation done (all green)

- `yarn workspace @serfab/reference-app-rn test` → **75 passed** (23 new in
  `test/secure-key-store.spec.ts`).
- `yarn workspace @serfab/reference-app-rn typecheck` → clean.
- `yarn lint` (repo-wide) → clean.

The new spec uses an **in-memory `SecureStoreApi` fake** (no native module, no
`vi.mock`) and covers: the KeyStore contract (set/get round-trip, missing→undefined,
overwrite, caller-buffer isolation, delete idempotency, list reflects writes/deletes,
awkward keyIds incl. `cadre/identity`); full 0..255 base64 fidelity; keyId→key
mapping (allowed-charset, no-collision, deterministic default slot); cancelled-prompt
→ `KeyStoreAccessError` (not undefined); option forwarding (material gets
`requireAuthentication`, index does not); index consistency (forced orphan doesn't
break `get`, corrupt index reads empty, delete prunes, **serialized concurrent
sets**); and all `migrateLegacyIdentity` branches (migrate-once + legacy-delete,
already-present skips legacy, no-legacy, read-failed fallthrough, access-error
propagation).

## Use cases to validate (reviewer focus)

- **First launch (empty slot):** node generates + persists identity via the store;
  PeerId stable on next launch. (base64 round-trip verified lossless in tests.)
- **Upgrade with legacy key:** identity lifted from LevelDB into the enclave once;
  PeerId/authority unchanged; legacy plaintext cleared.
- **Authority key for pairing:** Settings → Node → "Authority Key" shows base64url
  pubkey; tap reveals full selectable value. Matches `getIdentityAuthorityKey().publicKeyB64`.
- **Access-denied path:** if biometric gating is ever enabled, a cancelled prompt
  must fail node start loudly (no regeneration). Default config never prompts.

## Known gaps / honest flags (treat tests as a floor)

1. **Device verification is out-of-band (NOT done — manual).** Run on real
   devices/simulators:
   - *iOS reinstall persistence:* connect → note PeerId + Authority Key →
     uninstall → reinstall → connect → **same** PeerId/Authority Key (Keychain
     survives).
   - *Android reinstall loss:* same flow → after reinstall expect a **new**
     identity (SharedPreferences wiped) → confirm the new Authority Key is shown
     for re-pairing.
   - *Background / headless bring-up:* trigger a push-wake / background-runner
     cold start while the device is locked (after first unlock) and confirm the
     node resolves its identity without a foreground prompt (validates
     `AFTER_FIRST_UNLOCK` + no `requireAuthentication`).
   - *Legacy migration on a real device:* install the pre-secure-store build,
     create an identity, upgrade to this build, confirm PeerId is preserved and
     the `sereus-peer-identity` plaintext is gone.
2. **Biometric-invalidation semantics differ from the ticket's wording.** The
   ticket said an invalidated `requireAuthentication` entry "fails with
   `KeyStoreAccessError`." Per the current Expo API, `getItemAsync` on a
   biometric-invalidated entry resolves **`null`** (indistinguishable from empty)
   → our code maps that to `undefined` → cadre-core would **regenerate**. Only a
   *cancelled/denied* prompt rejects (→ `KeyStoreAccessError`). Documented in
   `architecture.md`; it's another reason the identity slot is not gated by
   default. Reviewer: decide whether gated slots need a separate
   "was-present-but-now-null" heuristic (none exists today).
3. **`NSFaceIDUsageDescription` intentionally NOT added to `app.json`** (biometric
   gating is off by default). It is required *before* enabling
   `requireAuthentication`; noted in code + docs. `app.json` is otherwise untouched.
4. **Native LevelDB migration glue is unit-tested only via injected callbacks.**
   `migrateLegacyIdentity` (the decision logic) is fully covered, but
   `readLegacyIdentityBytes` / `deleteLegacyIdentity` (the rn-leveldb iterate/delete)
   run only on-device — see gap #1. They assume the dedicated `sereus-peer-identity`
   DB holds exactly one entry (historically true).
5. **Fresh first-launch creates an empty `sereus-peer-identity` LevelDB dir**
   (the migration probe opens with createIfMissing default). Harmless (no key
   written; no worse than the prior code, which created the same DB) but could be
   skipped with a one-time "migration done" marker if desired.
6. **Corrupt-base64 `get` branch is defensive, not unit-tested** (hard to force a
   value the impl itself wrote). It throws `KeyStoreAccessError` rather than
   returning truncated bytes.
7. **Expo Go:** `requireAuthentication` is unsupported there; since it's off by
   default the app degrades fine, but an app dev opting in needs a dev/release
   build — documented, not guarded in code.
