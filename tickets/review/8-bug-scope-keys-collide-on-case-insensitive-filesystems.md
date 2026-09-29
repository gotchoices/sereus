description: On Windows and Mac, two different strands or two different parties could end up sharing one storage folder, because those systems ignore letter case in folder names. Every storage key is now lowercase-only, so two different keys always give two different folders; review the change and its upgrade note.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (`SCOPE_KEY_CHARSET`, `controlStorageScope`, `isValidStrandScopeKey`, `InvalidStrandIdError`, `assertScopeKeyCharset`, module comment)
  - packages/cadre-core/test/control-storage-scope.spec.ts
  - packages/cadre-core/test/strand-scope-key-validation.spec.ts
  - .release-notes.pending.md
  - docs/architecture.md (*Storage scope keys*)
  - comment/doc-only: packages/cadre-core/src/cadre-node.ts (`resolveControlStorage`), packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/README.md, packages/cadre-cli/src/commands/node-session.ts, packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/README.md, docs/reference-app-ns.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/strand-storage.ts
repro: verified
----

# Storage scope keys are lowercase-only

## What changed

cadre-core names each store it asks an embedder's storage provider for with a **scope key**: the strand id for a strand, `control-<encoded party id>` for the party's control database. Embedders use the key directly as a folder, file or database name. On NTFS and APFS/HFS+ two keys differing only in case were two stores in memory and one folder on disk (`controlStorageScope('aa@')` = `control-YWFA`, `controlStorageScope('aaZ')` = `control-YWFa`; strand ids `strand-ABC` / `strand-abc`).

- `SCOPE_KEY_CHARSET` is now `/^[a-z0-9._-]+$/`, shared by `isValidStrandScopeKey` (strand keys) and `assertScopeKeyCharset` (control key, asserted in `CadreNode.resolveControlStorage`).
- `controlStorageScope` encodes the party id's UTF-8 bytes as lowercase hex (`uint8arrays` `'base16'`) instead of base64url. A UUID party id gives an 80-character key. A `NOTE:` at the function records the tripwire: a party id over ~120 bytes would overflow one 255-byte path component; hash instead of encoding if long party ids ever appear.
- A strand id with an uppercase letter is now refused with `InvalidStrandIdError` (at `publishStrand`, `StrandInstanceManager.startStrand` and `KeyStoreJoinedStrandStore`, which all already call the predicate). Refused, not lowercased — lowercasing would merge two distinct strands.
- Both error messages name `[a-z0-9._-]` and say why (case-insensitive file names).
- The console decode snippet in the `controlStorageScope` doc comment and in `docs/architecture.md` is now hex; I ran it on `sereus-control-7061727479` (→ `party`), `control-` (→ empty) and the non-ASCII test party id — all decode correctly. It now slices from `indexOf('control-')`, so it works on the prefixed file name the example shows (the old snippet sliced a fixed 8 characters, which was wrong for `sereus-control-…`).
- `.release-notes.pending.md` has an upgrade entry: the control store's name changed; parties with other machines re-replicate; a sole node must rename `control-<X>` → `control-<hex>` before starting the upgraded build (one-line `node -e` command given, tested in a scratch directory against a UUID party's folder and matched against `controlStorageScope`'s output); browser and phone stores start fresh; uppercase strand ids are refused.

## Tests

No new test file. Existing ones tightened:

- `control-storage-scope.spec.ts` — `decodeControlScope` decodes `base16`; the path-safe `it.each` asserts `/^[a-z0-9._-]+$/`. This is the regression: every row except the empty string fails under the old base64url encoding purely through uppercase letters. (The ticket's optional `'aa@'` row was not added: it tests nothing the tightened regex does not already catch.)
- `strand-scope-key-validation.spec.ts` — `['an uppercase letter', 'strand-ABC']` added to `rejects %s`; the two `control-ZmFrZQ` rows became `control-7061727479`, so they still exercise the `control-` prefix rule rather than being rejected by the charset alone.

## Validation run

- `yarn workspace @serfab/cadre-core build` — clean. `yarn workspace @serfab/cadre-core test` — 144 files, 2344 passed, 1 skipped (pre-existing skip).
- `yarn workspace @serfab/cadre-cli test` — 16 files / 236 passed. `packages/integration-tests`: `yarn vitest run test/` (unit specs only) — 4 files / 48 passed. Reference apps `vitest run`: web 66, rn 294, ns 110 — all passed.
- Rebuilt `@serfab/cadre-cli` (comment edit) and `@serfab/cadre-host` (dist was already stale from earlier commits) so the stale-build guard would let the integration unit specs run.
- `yarn lint` — clean.
- **Not run:** the real-network integration scenarios (`src/**/*.integration.ts`), which exceed the agent time limit. Every scenario strand id I found is built from lowercase literals, `Date.now()`, base36 or `randomUUID()`, and every consumer of the control key calls `controlStorageScope` rather than hard-coding a literal, so none should be affected — a reviewer or CI run of the full suite would confirm.

## For the reviewer

- Check the grep for `base64url` / `A-Za-z0-9._-` left nothing stating the old guarantee about scope keys. Remaining hits are deliberately untouched: `joined-strand-store.ts` slot ids (`cadre/joined-strand/<base64url party id>/…`, owned by the sibling ticket `file-store-names-collide-on-case-insensitive-filesystems`) and the React Native SecureStore key segments (keychain keys are case-sensitive).
- The release note says an upgraded sole node that already started must have its new `control-<hex>` folder deleted before the rename; that folder then holds only post-upgrade writes (for a sole node, owner genesis re-runs on start). Confirm that wording is right for cadre-host-managed nodes.
- `MAX_STRAND_SCOPE_KEY_LENGTH` (128) applies only to strand keys; the control key has no length check, only the `NOTE:` tripwire above.
