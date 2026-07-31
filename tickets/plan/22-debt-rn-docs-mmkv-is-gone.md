description: The phone app's documentation still says it stores data with MMKV, but MMKV was replaced by LevelDB some time ago and is no longer a dependency at all, so several docs describe storage the app doesn't use.
files: docs/reference-app-rn.md, docs/architecture.md, packages/reference-app-rn/package.json
difficulty: easy
---

# Phone-app docs still describe MMKV storage

`react-native-mmkv` is gone from `packages/reference-app-rn`. The app's on-device
storage is now LevelDB (`rn-leveldb`, via `LevelDBRawStorage` /
`LevelDBKVStore` from `@optimystic/db-p2p-storage-rn`), and the identity key
lives in the platform secure enclave rather than in any general-purpose store.
The docs were never swept after that change, so a newcomer reading them is told
about a dependency the app does not have.

Known stale sites (there may be more — sweep, don't just patch these):

- `docs/reference-app-rn.md` — the architecture diagram box
  (`db-p2p-storage-rn (MMKV)`), the node-topology table's storage column, the
  key-dependencies table (`MMKV-backed IRawStorage`, and the
  `react-native-mmkv` row), and the build-workflow steps that say the dev client
  is cloud-compiled "with MMKV native module" and needs a rebuild when
  `react-native-mmkv` changes (it is `rn-leveldb` that forces that now).
- `docs/architecture.md` — the `rawStorageFactory` paragraph naming "MMKV on
  React Native" as the persistent backend.

## Expected outcome

Every doc statement about where the phone app puts bytes matches what the code
does: LevelDB for strand data and node-local dial hints, the secure enclave for
the identity key and the trusted-owner anchor. Native-rebuild guidance names the
dependency that actually triggers a rebuild.

One historical mention is correct and should stay: `docs/reference-app-rn.md`
notes that an *earlier* version kept the identity key in plaintext MMKV, which
is why a one-time legacy migration exists.

`docs/reference-app-ns.md` was checked and has no MMKV claim — the NativeScript
app is not part of this.
