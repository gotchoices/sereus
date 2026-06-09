priority: 2
description: Define a pluggable KeyStore interface in @serfab/cadre-core and route CadreNode identity + authority key load/generate through it (with in-memory + file-based reference backends for Node)
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/authority-key.ts, packages/cadre-core/src/enrollment.ts, packages/cadre-core/src/index.ts
----

Mobile cadre nodes hold sensitive key material at rest: the libp2p **peer/node identity** key and the **authority** signing key (which in the single-key reference model is *derived from* the identity key). Today both flow through `CadreNodeConfig.privateKey` (a libp2p `PrivateKey` object) and the React Native app persists that key in plaintext LevelDB. This ticket introduces a backend-agnostic `KeyStore` abstraction in `@serfab/cadre-core` and routes the node-identity load/generate path through it, so a platform-secure backend (iOS Keychain / Android Keystore — landed in the `keystore-rn-secure-store` ticket) can be plugged in without cadre-core taking any platform dependency.

This ticket is **cadre-core only**: it must not depend on Expo, React Native, or any mobile package. The mobile (`expo-secure-store`) backend and app wiring land in the dependent `keystore-rn-secure-store` ticket.

### Background (current state — verified)

- `CadreNodeConfig` is defined in `packages/cadre-core/src/types.ts` (~lines 210–264). Identity today is `privateKey?: PrivateKey` (from `@libp2p/interface`). If present it is spread into `createLibp2pNode()` in `cadre-node.ts` `createControlNode()` (~line 440); if absent, libp2p generates an ephemeral key internally.
- cadre-node reads `config.privateKey` directly in two places: `createControlNode()` (~440) and `getSelfSigningKey()` (~566–581, used by `publishSelfRecord()` and `registerDeviceToken()`).
- Authority key is derived from the identity key via `authorityKeyFromLibp2p(privateKey)` in `authority-key.ts` (~32–52), which extracts the 32-byte Ed25519 seed from libp2p's 64-byte raw key and returns `{ privateKeyB64, publicKeyB64 }` (base64url). The RN app currently calls this in its own `runAuthorityGenesis`.
- libp2p Ed25519 keys serialize via `privateKeyToProtobuf()` / `privateKeyFromProtobuf()` from `@libp2p/crypto/keys`. `peerIdFromPrivateKey()` derives the PeerId. The natural unit of stored key material is **protobuf bytes** (`Uint8Array`).
- No KeyStore/keyring abstraction exists today.

### KeyStore interface

Add a new module `packages/cadre-core/src/key-store.ts` exporting:

```typescript
/** Opaque identifier for a stored key slot (e.g. 'cadre/identity'). */
export type KeyId = string;

/**
 * Backend-agnostic store for raw private key material. Implementations may be
 * file-based, OS-keyring, or platform secure-enclave backed (iOS Keychain /
 * Android Keystore). The interface makes no assumption about the backend and
 * never logs, returns, or throws key material.
 *
 * Key material is raw bytes (e.g. libp2p protobuf-serialized private keys).
 * Text-only backends encode/decode (base64) internally; byte-native backends
 * (LevelDB) store as-is.
 */
export interface KeyStore {
  /** Resolves to the stored material, or undefined if the slot is empty. */
  get(keyId: KeyId): Promise<Uint8Array | undefined>;

  /** Writes/overwrites the slot. */
  set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void>;

  /** Removes the slot. Idempotent — succeeds even if absent. */
  delete(keyId: KeyId): Promise<void>;

  /** Enumerates the keyIds this store knows about. */
  list(): Promise<KeyId[]>;
}

/**
 * Thrown by get() when access was denied or could not be satisfied (e.g. a
 * biometric/device-unlock prompt was cancelled or failed). Distinguishes
 * "access refused" from "slot empty" (which is a plain undefined return).
 * Biometric gating itself is out of scope here, but get() rejecting with this
 * error is the contract a gated backend uses, so callers must not treat it as
 * "no key" (which would trigger key regeneration and silent identity loss).
 */
export class KeyStoreAccessError extends Error {
  readonly keyId: KeyId;
  constructor(keyId: KeyId, message: string, options?: { cause?: unknown });
}
```

Semantics to honor across all backends and call sites:
- `get` returns `undefined` for a missing slot — it does **not** throw. Throwing is reserved for access-denied / backend-failure (`KeyStoreAccessError` or a backend error), so a load-or-create path can distinguish "generate a fresh key" from "do not clobber an existing but currently-unreadable key".
- `set` overwrites silently.
- `delete` is idempotent.
- `list` returns keyIds only — never material. (The RN backend maintains an index for this; Node backends can enumerate natively.)
- All operations are async (secure enclaves are async on RN).

### Reference backends (Node-only, in cadre-core)

Ship two concrete backends in cadre-core for non-mobile nodes and tests. These have **no** mobile deps:

- `InMemoryKeyStore` (`key-store.ts` or `key-store-memory.ts`) — a `Map<KeyId, Uint8Array>`. For tests and ephemeral nodes. `list()` returns the map keys.
- `FileKeyStore` (`key-store-file.ts`) — one file per slot under a configured directory (e.g. `<dir>/<urlencoded keyId>.key`, raw bytes). `list()` enumerates the directory and reverses the keyId encoding. Use `node:fs/promises`; restrict file permissions where the platform supports it (best-effort `0o600` on posix). Must remain importable in a Node context without pulling browser/RN-incompatible code into the package's default entry — if `node:fs` would break bundlers, export it from a subpath (e.g. `@serfab/cadre-core/key-store-file`) rather than the package root. Confirm against how the package already segregates Node-only code (check `index.ts` exports and `package.json` `exports`).

### CadreNodeConfig integration (additive, mutually-exclusive)

Extend `CadreNodeConfig` (`types.ts`):

```typescript
  /** If provided, use this keypair for the node identity (direct injection). */
  privateKey?: PrivateKey;

  /**
   * Pluggable secure store for node key material. When set, the node loads its
   * identity from `keyStore` under `identityKeyId`, generating + persisting a
   * fresh Ed25519 key on first run. Mutually exclusive with `privateKey` —
   * supplying both is a configuration error (fail closed). Absent ⇒ legacy
   * behavior (use `privateKey`, else libp2p generates an ephemeral key).
   */
  keyStore?: KeyStore;

  /** Slot id for the node identity in `keyStore`. Default: 'cadre/identity'. */
  identityKeyId?: KeyId;
```

Resolution order, performed once early in `start()` into a private resolved field (e.g. `this.identityKey: PrivateKey`):
1. If both `keyStore` and `privateKey` are set → throw a clear configuration error before any libp2p/network bring-up.
2. If `keyStore` is set: `const bytes = await keyStore.get(identityKeyId ?? DEFAULT_IDENTITY_KEY_ID)`.
   - If `bytes` → `privateKeyFromProtobuf(bytes)`.
   - If `undefined` → `generateKeyPair('Ed25519')`, persist `privateKeyToProtobuf(key)` via `keyStore.set(...)`, then use it.
   - If `get` rejects → propagate (do **not** generate a new key — that would silently orphan the real identity).
3. Else if `privateKey` → use it (current behavior).
4. Else → leave undefined; libp2p generates ephemeral (current behavior).

Then **replace every `this.config.privateKey` read** in cadre-node with the resolved `this.identityKey`:
- `createControlNode()` (~440): spread `this.identityKey` instead of `config.privateKey`.
- `getSelfSigningKey()` (~566–581): derive from `this.identityKey`.

Reuse the existing `enrollment.ts` `createCadrePeer()` generation/serialization helpers (`generateKeyPair('Ed25519')`, `privateKeyToProtobuf`) rather than re-implementing — factor a shared helper if cleaner. Keep the protobuf-bytes representation as the canonical stored form so the RN backend and `FileKeyStore` agree.

### Exposing the resolved authority key (app-controlled genesis)

The RN app's `runAuthorityGenesis` currently derives the authority key from the privateKey it loaded itself. Once identity resolution moves inside cadre-node, the app no longer holds that key. Per the ticket requirement that the app dev retains control of these points (to align with UX), expose the resolved authority material **without** auto-running genesis:

- Add a public accessor on `CadreNode`, available after `start()`, e.g. `getIdentityAuthorityKey(): AuthorityKeyPair` that returns `authorityKeyFromLibp2p(this.identityKey)`. (Promote/reuse the logic behind the private `getSelfSigningKey()`; do not duplicate the seed-extraction.)
- The app then keeps calling `ensureAuthorityKey(pub)` + `initializeSeedBootstrap(priv)` itself, sourcing the key pair from this accessor. cadre-core does not silently perform authority genesis.

Document (TSDoc on the accessor and the config fields) that in this single-key model the authority key is derived from the node identity, so protecting the identity in the enclave protects the authority key too; a future separate-authority-slot (`authorityKeyId`) extension is anticipated but not built here.

### No-leak guarantee

- No code path writes resolved key material, protobuf bytes, seeds, or base64 key strings to logs, `console`, error messages, or thrown error `.message`/`.stack`. Audit the touched functions and the existing debug `log(...)` calls in `cadre-node.ts` / `seed-bootstrap.ts` along the identity path. `KeyStoreAccessError` carries only the `keyId`, never material.
- The push-credential `privateKey` fields already documented as never-logged are out of scope here but follow the same rule — don't regress them.

### Edge cases & interactions

- **Both `privateKey` and `keyStore` set** → config error thrown before network bring-up; test it.
- **First run (empty slot)** → generates, persists, and the SAME key is returned on the next `start()` with the same store (round-trip via protobuf). Test generate→persist→reload identity stability (PeerId equal across two nodes sharing one InMemory/File store).
- **`get` rejects with `KeyStoreAccessError`** → `start()` fails loudly; node is NOT brought up with a freshly generated key. Test that a throwing stub does not cause regeneration.
- **Corrupt/garbage bytes in slot** → `privateKeyFromProtobuf` throws; surface a clear error (do not silently regenerate, which would orphan the real identity). Test with junk bytes.
- **`list()` on each backend** reflects exactly the slots written (and removed via `delete`). Test set/list/delete sequencing, including delete-of-absent (idempotent).
- **FileKeyStore keyId encoding** — keyIds containing `/`, spaces, or unicode round-trip through the filename encoding without collision. Test `'cadre/identity'` and a couple of awkward ids.
- **Concurrent `start()`/double-resolve** — identity resolves once; a second resolve must not regenerate or double-persist. (CadreNode lifecycle is single-start, but guard the resolved field.)
- **Ephemeral path unchanged** — no `keyStore`, no `privateKey` ⇒ identical behavior to today (libp2p ephemeral key). Existing cadre-core tests must still pass.
- **Authority accessor before start()** — calling `getIdentityAuthorityKey()` before identity is resolved must throw a clear "node not started" error, not return a key derived from `undefined`.

### Tests (write up front, TDD)

In `packages/cadre-core/test` (match existing test layout/runner — check whether the package uses vitest like the RN app):
- KeyStore contract suite run against both `InMemoryKeyStore` and `FileKeyStore` (parametrized): set/get/round-trip, get-missing→undefined, delete idempotency, list reflects writes/deletes, awkward keyIds.
- Identity resolution: generate-on-first-run + persist; reload yields identical PeerId; throwing `get` does not regenerate; corrupt bytes surface an error; both-keys config error.
- No-leak: spy/capture the debug logger over a full resolve+start path and assert no stored byte sequence / base64 seed appears.
- `getIdentityAuthorityKey()` returns the same pair as `authorityKeyFromLibp2p(identityKey)`; throws before start.

### Validation

- `yarn lint` (flat ESLint gate — every rule is an error; mind: tabs for code, no inline `import()`, prefix unused args with `_`, no `any`, `void` unused promises, ES modules).
- `yarn workspace @serfab/cadre-core build` (or the package's typecheck) and the package test suite. Stream long output with `2>&1 | tee` — never silent-redirect.

## TODO

- [ ] Add `key-store.ts` with `KeyId`, `KeyStore`, `KeyStoreAccessError`, and a `DEFAULT_IDENTITY_KEY_ID = 'cadre/identity'` constant.
- [ ] Add `InMemoryKeyStore`; export from package root.
- [ ] Add `FileKeyStore` (Node-only) and wire it through the correct (possibly subpath) export so bundlers don't pull `node:fs` into the default entry.
- [ ] Extend `CadreNodeConfig` with `keyStore?` + `identityKeyId?`; document mutual exclusivity with `privateKey`.
- [ ] Resolve identity once in `CadreNode.start()` into `this.identityKey`; implement the 4-step resolution order.
- [ ] Replace `config.privateKey` reads in `createControlNode()` and `getSelfSigningKey()` with `this.identityKey`.
- [ ] Add public `getIdentityAuthorityKey(): AuthorityKeyPair` accessor (throws before start); reuse existing seed-extraction.
- [ ] Audit identity-path logging for key-material leaks; fix any.
- [ ] Export new public types/impls from `index.ts`.
- [ ] Write the test suites above; run lint + build + tests green.
- [ ] Update `docs/architecture.md` (authority/peer key + enrollment sections) to describe the `KeyStore` seam and the identity-resolution order.
