priority: 2
description: Specify secure storage of authority keys and peer private keys in platform secure enclaves (iOS Keychain / Android Keystore)
files: packages/cadre-core/src/enrollment, packages/reference-app-rn/app
----
Mobile cadre nodes hold sensitive key material: authority keys (which authorize control network changes) and per-node libp2p peer private keys. These must be stored in the platform's secure enclave — iOS Keychain on iOS, Android Keystore on Android — rather than in plain app storage (AsyncStorage, files). This protects keys at rest against device compromise, app backups, and forensic extraction.

### Scope

- **Authority keys**: Ed25519 signing keys used to authorize `CadrePeer` inserts, create seeds, and sign formation disclosures. Loss or exposure compromises the party's entire cadre.
- **Peer private keys**: Per-node libp2p identity keys. Less catastrophic if exposed (attacker can impersonate one node) but still should never appear in plain storage.
- **Strand member keys**: Keys used to prove membership in closed strands (see `StrandInstance.memberPrivateKey` in `docs/architecture.md`). Same protection requirements as peer private keys.

### Requirements

- Pluggable `KeyStore` interface in `@serfab/cadre-core` with at least `get(keyId)`, `set(keyId, keyMaterial)`, `delete(keyId)`, `list()` operations. The interface must not assume any particular backend — Node.js nodes may use file-based or OS keyring; mobile nodes use secure enclave.
- Mobile implementation wraps either `expo-secure-store` or `react-native-keychain` (decision pending — see TODO). Must work on both iOS and Android.
- `CadreNode` identity flow accepts a `KeyStore` rather than raw `privateKey` bytes in `CadreNodeConfig`. If a `KeyStore` is configured, the node loads/generates identity via the store instead of `privateKey` in config.
- Keys generated on first run are written to the enclave; subsequent runs load from the enclave. No code path writes key material to plain app storage, logs, or error messages.
- Biometric/device-unlock gating on authority key access is out of scope for this ticket but the interface should not preclude it (e.g., `get()` may reject or prompt).
- Be sure that the app dev has control over these points so they can properly align with the UX

### Use cases

- First-launch: app generates authority keypair, stores in enclave, displays public key for pairing.
- Reinstall: enclave entries survive reinstall on iOS (Keychain) but not Android (Keystore) — document the difference; recovery is via re-enrollment from another cadre node.
- Multi-user device: enclave items are per-app, so different Sereus app installs have separate key stores automatically.

## TODO
- [ ] Compare `expo-secure-store` vs `react-native-keychain`: API ergonomics, biometric support, size limits, iOS/Android parity, maintenance status
- [ ] Specify `KeyStore` interface (method signatures, error cases, async semantics)
- [ ] Specify how `CadreNodeConfig` integrates `KeyStore` (replace `privateKey`? additive?)
- [ ] Document reinstall behavior per platform and recovery flow
- [ ] Identify which existing cadre-core call sites read/write key material and must be routed through `KeyStore`
