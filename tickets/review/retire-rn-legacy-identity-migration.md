----
description: The phone app's one-time upgrade step that moved a device's identity key out of an old unencrypted store into the secure hardware store has been deleted, along with the code and docs that supported it. No device ever needed the step.
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, docs/architecture.md, docs/reference-app-rn.md
difficulty: medium
----

# Review: removal of the React Native legacy-identity migration

Pure deletion plus doc/comment rewrites. No behaviour was added. 242 lines removed,
18 added across 5 files.

## What was deleted

**`packages/reference-app-rn/src/secure-key-store.ts`** — the whole trailing
`── Legacy identity migration ──` section (was lines 317–384): the
`LegacyIdentityMigrationOutcome` union, the `LegacyIdentityMigrationDeps`
interface, and the `migrateLegacyIdentity` function. File went 384 → 316 lines.
Everything above the banner — `SecureStoreApi`, `SecureStoreKeyStoreOptions`,
`secureStoreKeySegment`, `forwardedSecureStoreOptions`, and the whole
`SecureStoreKeyStore` class — is byte-identical to before.

**`packages/reference-app-rn/src/cadre-phone.ts`** —
- the `PEER_IDENTITY_DB_NAME = 'sereus-peer-identity'` constant and its comment
- `readLegacyIdentityBytes()` and `deleteLegacyIdentity()`
- `migrateLegacyIdentity` dropped from the `./secure-key-store` import
- the `await migrateLegacyIdentity({...})` call that was the first statement of
  `startPhoneNode`, plus its 5-line comment block

**`packages/reference-app-rn/test/secure-key-store.spec.ts`** — the
`describe('migrateLegacyIdentity', ...)` block (6 tests) and its banner; imports
collapsed to two lines, dropping `migrateLegacyIdentity` and `type KeyStore`
(the latter was used only by the deleted `denied: KeyStore` fixture). File went
392 → 301 lines.

## What was rewritten (not deleted)

- **`cadre-phone.ts` ordering comment** above `loadOrCreateIdentityKey`: the
  "after `migrateLegacyIdentity`" half is gone; the still-true "before
  `loadIceConfig`, whose manifest request is signed with the node identity" half
  stays.
- **`cadre-phone.ts` LevelDB-helpers banner comment**: was "Each strand (and the
  peer identity) gets its own LevelDB database file" — stale even before this
  ticket, since the identity moved to the enclave. Now names the node-local
  record store instead and says explicitly that the identity is not in LevelDB.
- **`docs/architecture.md`** ~1110 (ordering clause) and the ~1145 paragraph,
  retitled **One-time migration** → **No migration path**. Surrounding paragraphs
  on gating, access-vs-absence, and reinstall behaviour untouched.
- **`docs/reference-app-rn.md`** lines 158 and 160 rewritten as prose about the
  behaviour that now exists.

## What must NOT have changed — the thing to check hardest

The **access-vs-absence** contract in `SecureStoreKeyStore.get` is the security
property this ticket was told to leave alone:

- a *thrown* `getItemAsync` ⇒ `KeyStoreAccessError` (never `undefined`)
- a `null` read on an **ungated** slot ⇒ `undefined`
- a `null` read on a **gated** slot ⇒ disambiguated via the unauthenticated
  `__index` marker (`gatedNullResult`): keyId in the index ⇒ `KeyStoreAccessError`
  (fail closed), keyId absent ⇒ `undefined`
- corrupt (non-base64) stored material ⇒ `KeyStoreAccessError`

The failure mode to hunt for is a path where the enclave now reads `undefined`
and the app regenerates an identity where it should have raised
`KeyStoreAccessError`. `git diff packages/reference-app-rn/src/secure-key-store.ts`
should show **only deletions below the class**, with no hunk inside the class body
— worth confirming directly rather than trusting this summary.

## Validation performed

All from repo root, all green:

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/reference-app-rn typecheck` | exit 0 (`tsc --noEmit`, the package's own program) |
| `yarn workspace @serfab/reference-app-rn test` | 10 files, **184 tests passed** |
| `yarn workspace @serfab/reference-app-rn vitest run test/secure-key-store.spec.ts --reporter=verbose` | **26 tests passed** |
| `yarn lint` | exit 0 |

The verbose run was done specifically to confirm the protected suites still
execute by name — they do: `SecureStoreKeyStore — access vs absence` (3 tests),
`SecureStoreKeyStore — gated null discriminator` (7 tests),
`SecureStoreKeyStore — index consistency` (4 tests), plus the KeyStore-contract,
base64-bridge, and keyId-mapping suites. No pre-existing failures surfaced;
`tickets/.pre-existing-error.md` was not written.

## Straggler sweep

`migrateLegacyIdentity`, `LegacyIdentityMigration`, `readLegacyIdentityBytes`,
`deleteLegacyIdentity`, and `PEER_IDENTITY_DB_NAME` have **no hits left** outside
`tickets/`, except four in `packages/reference-app-ns/` — the NativeScript app,
which is a different app on a different substrate (SQLite) and a currently-live
path. Those were deliberately left alone, per the ticket. `reference-app-rn`'s
own markdown was also swept for the words "legacy"/"migration" — no matches.

## Edge cases from the plan, and how they resolved

- **`openLevelDb` stayed imported/used** — `nodeLocalDb` (the bootstrap-peer
  store) still calls it, and `createStorage` calls it per strand.
- **The `??=` on `nodeLocalDb`** and its native-handle-leak comment are untouched.
- **`startPhoneNode`'s first `await` changed** (it is now
  `PersistentTrustedOwnerStore.open`). Verified nothing between the old call site
  and `loadOrCreateIdentityKey` depended on the migration having awaited: the
  intervening code opens `NODE_LOCAL_DB_NAME` (a *different* LevelDB database),
  and reads the `sereus.anchor.<partyId>` SecureStore key (a *different* slot from
  the `sereus.ks.`-prefixed identity slot). Neither touched the identity slot nor
  the legacy database. The old ordering comment's claim of a dependency was about
  `loadOrCreateIdentityKey` only, and that dependency is now moot.
- **`console.warn` spies** — one `vi.spyOn(console, 'warn')` remains in the spec,
  inside the *index-consistency* suite's corrupt-JSON test. That is
  `parseIndex`'s warn path, not the deleted legacy-read path, so it correctly
  stays. The migration block's own spy went with the block; no shared scaffolding
  was left behind.
- **The `vi` import is still used** (by that same spy), so it was kept.

## Known gaps / what this pass did not do

- **No device or emulator run.** Everything here is type-check + unit test +
  lint. `startPhoneNode` itself has no unit test in this package — the RN package
  has no test that exercises the function end-to-end, so "the app still starts and
  resolves its identity" is verified by types and by reading, not by execution.
  Confirming it on a device is out of scope for an agent run.
- **`yarn workspace @serfab/reference-app-rn test:bundle`** (`expo export`) was
  not run. It routinely exceeds the ten-minute agent budget. A reviewer with time
  may want it, since it is the only check that would catch a bundler-visible
  breakage the TypeScript program misses — though this diff adds no imports and
  removes only unreferenced symbols, so the risk is low.
- **The stale `openLevelDb` banner comment was rewritten opportunistically.** It
  was wrong before this ticket too. If a reviewer prefers ticket-scoped diffs,
  that hunk is the one to object to.
- **Doc wording is a judgement call.** `docs/architecture.md`'s new
  "No migration path" paragraph and `docs/reference-app-rn.md`'s new sentence both
  keep a one-clause mention that earlier development builds used plaintext MMKV
  and then plaintext LevelDB, and state plainly that no upgrade path exists from
  either. The alternative — deleting the history entirely — would leave a reader
  wondering why the plaintext LevelDB is mentioned two paragraphs earlier. Worth a
  second opinion on whether that history is worth the two sentences it costs.
- **The `sereus-peer-identity` LevelDB database is now orphaned on RN.** Nothing
  in `reference-app-rn` opens it any more. If a dev-build device out there has
  one, it is simply never read; the app generates a fresh identity into the
  enclave. That is the intended consequence of the ticket, not an oversight — but
  it is the one user-visible behaviour change, so it is called out here rather
  than buried.
