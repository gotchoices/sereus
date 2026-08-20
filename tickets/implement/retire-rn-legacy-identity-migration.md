----
description: The phone app carries a one-time upgrade step that moves a device's identity key out of an old unencrypted store into the secure hardware store. No device has ever needed that upgrade, so the step and everything supporting it should go.
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, docs/architecture.md, docs/reference-app-rn.md
difficulty: medium
----

# Remove the React Native one-time legacy-identity migration

## What exists today

`reference-app-rn` keeps its libp2p identity in the platform secure enclave via
`SecureStoreKeyStore` (`src/secure-key-store.ts`). Bolted onto that module is a **one-time
migration** — `migrateLegacyIdentity` plus its `LegacyIdentityMigrationOutcome` and
`LegacyIdentityMigrationDeps` types — that lifts an identity out of an older, *plaintext* LevelDB
database (`sereus-peer-identity`) into the enclave on first launch after upgrade, then clears the
plaintext copy. `src/cadre-phone.ts` supplies the two halves of that (`readLegacyIdentityBytes`,
`deleteLegacyIdentity`) and calls it as the first statement of `startPhoneNode`.

It only ever mattered for a device upgrading from a build that wrote the plaintext database. No
such device exists, and the current no-live-instances window is the moment to delete it while it
costs nothing.

Removing it also removes a **startup ordering constraint**: today `loadOrCreateIdentityKey` must run
*after* the migration, or it would generate a fresh key into the empty slot and orphan the migrated
identity. With the migration gone that hazard disappears, and the comments asserting it should go
with it — but note the *other* half of that comment (`loadOrCreateIdentityKey` must still run
**before** `loadIceConfig`, because the ICE-manifest request is signed with the node identity) is
unrelated and **stays**.

## What must NOT change

This is a security-sensitive path, and exactly one behaviour must survive untouched: the
**access-vs-absence** contract in `SecureStoreKeyStore.get`. A thrown read becomes
`KeyStoreAccessError`; a `null` read becomes `undefined` for an ungated slot, and for a **gated**
slot is disambiguated through the unauthenticated `__index` marker (`gatedNullResult`) so a
biometric-invalidated entry fails closed instead of being reported empty. None of that is part of
the migration, and none of its tests are part of the migration's tests. The failure mode to avoid
is a device that reads `undefined` from the enclave and regenerates an identity where it should have
raised `KeyStoreAccessError`.

## Scope of the deletion

**`src/secure-key-store.ts`** — the whole trailing `── Legacy identity migration ──` section:
`LegacyIdentityMigrationOutcome`, `LegacyIdentityMigrationDeps`, `migrateLegacyIdentity`. Everything
above that banner stays.

**`src/cadre-phone.ts`** — the `PEER_IDENTITY_DB_NAME` constant and its comment,
`readLegacyIdentityBytes`, `deleteLegacyIdentity`, the `migrateLegacyIdentity` import, the
`await migrateLegacyIdentity({...})` call at the top of `startPhoneNode` and its comment block, and
the "after `migrateLegacyIdentity`" clause of the ordering comment above `loadOrCreateIdentityKey`.

**`test/secure-key-store.spec.ts`** — the `describe('migrateLegacyIdentity', ...)` block and the
now-unused imports it pulls in. The `SecureStoreKeyStore` suites above it stay in full.

**Docs** — `docs/architecture.md` ~1114 (the ordering clause) and the **One-time migration**
paragraph at ~1145; `docs/reference-app-rn.md` lines 158 and 160 (both name `migrateLegacyIdentity`
by hand). Rewrite them as prose describing the behaviour that will actually exist — the app reads
its identity from the enclave and generates one there on first run — rather than deleting the
surrounding paragraphs, which cover the still-live gating and reinstall behaviour.

## Edge cases & interactions

- **`sereus-peer-identity` is also a live database name in a different app.** `reference-app-ns`
  (NativeScript) stores its identity BLOB and both node-local records in a *SQLite* database of the
  same name (`docs/architecture.md:204`, `docs/reference-app-ns.md:64` and `:76`). Those are a
  different app, a different substrate, and a **current** path — do not touch them, and do not let a
  repo-wide search-and-replace on the string reach them.
- **`openLevelDb` must stay imported in `cadre-phone.ts`.** It is still used for `nodeLocalDb` (the
  bootstrap-peer store). Only the two legacy helpers go.
- **The `??=` on `nodeLocalDb` is not migration code.** It guards native-handle leakage across a
  cold-start re-entry of `startPhoneNode`; leave it and its comment alone.
- **After removal, `startPhoneNode`'s first `await` changes.** Confirm nothing between the old call
  site and `loadOrCreateIdentityKey` depended on the migration having already awaited (it did not
  at plan time — but the ordering comment claims a dependency, so verify rather than assume).
- **The RN package has its own type-check program.** A dangling import from the deleted symbols may
  compile in one program and fail in another; run the package's own build/type-check, not just the
  root one.
- **`console.warn` spies.** The deleted migration tests were the only users of the legacy-read
  `console.warn` path; make sure no leftover spy setup remains in the spec's shared scaffolding.

## TODO

- Delete the legacy-identity migration section from `src/secure-key-store.ts`.
- Delete `PEER_IDENTITY_DB_NAME`, `readLegacyIdentityBytes`, `deleteLegacyIdentity`, the import, and
  the `migrateLegacyIdentity` call + comment from `src/cadre-phone.ts`; trim the ordering comment to
  the still-true half (before `loadIceConfig`).
- Delete the `migrateLegacyIdentity` describe block and now-unused imports from
  `test/secure-key-store.spec.ts`; confirm the `SecureStoreKeyStore` access-vs-absence and
  gated-null cases still run and pass.
- Update `docs/architecture.md` (~1114 ordering clause, ~1145 "One-time migration" paragraph) and
  `docs/reference-app-rn.md` (lines 158, 160). Leave every `reference-app-ns` mention of
  `sereus-peer-identity` alone.
- Grep for stragglers: `migrateLegacyIdentity`, `LegacyIdentityMigration`, `readLegacyIdentityBytes`,
  `deleteLegacyIdentity`, and `PEER_IDENTITY_DB_NAME` should have no hits left outside `tickets/`.
- Run `yarn workspace @serfab/reference-app-rn test` and the package's build/type-check.
- Run `yarn lint`.
