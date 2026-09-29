description: On Windows and Mac, two different strands or two different parties can end up sharing one storage folder, because those systems ignore letter case in folder names. Make every storage key lowercase-only so that two different keys always give two different folders.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (`SCOPE_KEY_CHARSET`, `controlStorageScope`, `isValidStrandScopeKey`, `InvalidStrandIdError` message, `assertScopeKeyCharset`, module comment)
  - packages/cadre-core/src/cadre-node.ts (~1736-1741: comment on `assertScopeKeyCharset` says "base64url is inside the charset")
  - packages/cadre-core/test/control-storage-scope.spec.ts (`decodeControlScope`, the path-safe `it.each`)
  - packages/cadre-core/test/strand-scope-key-validation.spec.ts (rejection `it.each`; the `control-ZmFrZQ` rows)
  - docs/architecture.md (*Storage scope keys*, ~line 1545-1557, and the table row for the control key)
  - packages/cadre-core/src/types.ts (`RawStorageProvider` doc, ~line 126-133)
  - packages/cadre-core/README.md (~line 234-244)
  - packages/cadre-cli/src/commands/node-session.ts (`resolveStorageConfig` comment)
  - packages/reference-app-ns/src/ns-storage.ts (`makeLazyNsStorage` comment), packages/reference-app-web/README.md (~line 80)
  - .release-notes.pending.md
repro: verified
----

# Storage scope keys must be distinct as file names, not only as strings

## The defect

cadre-core hands an embedder's storage provider a **scope key** — the strand id for a strand, `control-<encoded party id>` for the party's control database — and promises the key can be used directly as a file, folder or database name. cadre-cli does exactly that (`${storage.path}/${scope}` in `packages/cadre-cli/src/commands/node-session.ts`). Windows (NTFS) and macOS (APFS/HFS+ by default) compare names without regard to case; everything else in the system compares with case. So two keys that differ only in capitalization are two stores in memory and one folder on disk.

Reproduced against the built `cadre-core` (`packages/cadre-core/dist/storage-scope.js`):

```
controlStorageScope('aa@')      -> control-YWFA
controlStorageScope('aaZ')      -> control-YWFa     (same folder on NTFS/APFS)
isValidStrandScopeKey('strand-ABC') -> true
isValidStrandScopeKey('strand-abc') -> true         (same folder on NTFS/APFS)
```

The on-disk half was measured in the fix stage on Windows 11: with folder `strand-abc` present, `mkdir STRAND-ABC` fails `EEXIST`. (Trailing dots and reserved names `CON`/`NUL`/`aux`/`com1`/`lpt1` did not collide and are out of scope.)

## Decision

Maintainer (2026-09-28): the on-disk layout may change, provided `.release-notes.pending.md` says so and tells an upgrader what to do. Chosen design — **every scope key is spelled in `[a-z0-9._-]`**, so distinct-as-a-string and distinct-as-a-name become the same property, for both kinds of key, with no per-node bookkeeping:

- **Control key: `control-` + lowercase hexadecimal of the party id's UTF-8 bytes** (`uint8ArrayToString(bytes, 'base16')` — confirmed lowercase: `'ab'` → `6162`). Hex over base32 because an operator can decode it in a console with no library (`new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)))`), which the doc comment on `controlStorageScope` already promises for the current encoding. Cost: the key is 2× the party id's byte length rather than ~1.33×. A UUID party id gives an 80-character key, far inside the 255-byte path-component limit; leave a `NOTE:` at `controlStorageScope` that a party id over ~120 bytes would overflow one path component, and if long party ids ever appear, hash rather than encode.
- **Strand key: stays the strand id verbatim, but the accepted charset narrows to lowercase** — `isValidStrandScopeKey` rejects any uppercase letter, so a mixed-case strand id is refused with `InvalidStrandIdError` at `publishStrand`, at `StrandInstanceManager.startStrand`, and in `KeyStoreJoinedStrandStore` (all already call this predicate). Every id this repository mints is already lowercase (`strand-id.ts`: lowercase hex and base36; both reference apps' `crypto.randomUUID()`), so no existing strand store moves. Rejected alternative: encoding the strand id as the control id is — it would move every existing strand folder and make them unreadable to an operator, to keep accepting ids nothing here produces. Lowercasing a mixed-case id instead of refusing it is also rejected: that silently merges two distinct strands, which is the bug.

One shared constant: `SCOPE_KEY_CHARSET` becomes `/^[a-z0-9._-]+$/` and both `isValidStrandScopeKey` and `assertScopeKeyCharset` keep using it; `assertScopeKeyCharset`'s message and `InvalidStrandIdError`'s message name the new set and say why (case-insensitive filesystems).

## Documentation to bring in line

Every place that states the guarantee says `[A-Za-z0-9._-]` and/or `base64url`; each must now say `[a-z0-9._-]`, lowercase hex, and state the property actually promised: *two different keys are two different names even on a filesystem that ignores case*. Sites: `storage-scope.ts` module comment (the "WHY IT IS ENCODED" and strand-arm paragraphs) and the `controlStorageScope` doc + decode snippet; `cadre-node.ts` comment at `resolveControlStorage`; `types.ts` `RawStorageProvider`; `cadre-core/README.md`; `docs/architecture.md` *Storage scope keys* (table row and both bullets — add the case-insensitivity reason to the first bullet); `cadre-cli` `resolveStorageConfig` comment; `reference-app-ns` `makeLazyNsStorage` comment; `reference-app-web/README.md`. `grep -rn "base64url\|A-Za-z0-9._-" packages docs --include=*.ts --include=*.md` finds them; leave alone the unrelated base64url uses (`joined-strand-store.ts` slot ids — handled by the sibling ticket `file-store-names-collide-on-case-insensitive-filesystems` at the key-store file-name layer — and the React Native `secureStoreKeySegment`, whose keychain keys are case-sensitive).

## Release note

Add to `.release-notes.pending.md` (currently only its header) an entry under a breaking/upgrade heading, in plain language:

- The control database's storage name changed from `control-<base64url party id>` to `control-<hex party id>`, so a node's existing control store will not be found after upgrading. A party member re-replicates the control database from its peers; a device that is the party's only node loses its control records unless the folder is renamed. For cadre-cli file storage, the rename is: old folder `control-<X>` → `control-<hex>` where `<hex>` is `Buffer.from(X, 'base64url').toString('hex')` (give the one-line `node -e` command). Browser (IndexedDB) and phone (LevelDB) stores cannot be renamed in place — start fresh.
- Strand ids containing uppercase letters are now refused. None minted by Sereus contain them; a strand published by other software with such an id will not start and must be re-created with a lowercase id.

## Tests

No new test file. Tighten the two existing ones so they pin the new property:

- `control-storage-scope.spec.ts`: `decodeControlScope` decodes `base16`; the path-safe `it.each` asserts `/^[a-z0-9._-]+$/` (this is the regression — `'aa@'`/`'aaZ'` fail the old encoding only through case). Optionally add `['letters whose base64url differed only by case', 'aa@']` as a row.
- `strand-scope-key-validation.spec.ts`: add `['an uppercase letter', 'strand-ABC']` to the `rejects %s` table. The `control-ZmFrZQ` rows (two of them) would now be rejected by the charset alone, which stops them testing the `control-` prefix rule — change them to a lowercase control-shaped id such as `control-7061727479`.

## TODO

- Change `SCOPE_KEY_CHARSET` to lowercase, `controlStorageScope` to `base16`, update both error messages, and add the length `NOTE:` at `controlStorageScope`.
- Update the doc comments in `storage-scope.ts` (module comment, `controlStorageScope` decode snippet → hex) and the `cadre-node.ts` `resolveControlStorage` comment.
- Update `types.ts`, `cadre-core/README.md`, `docs/architecture.md` *Storage scope keys*, `node-session.ts`, `ns-storage.ts`, `reference-app-web/README.md`.
- Tighten the two spec files as above.
- Write the release-note entry.
- Run `yarn workspace @serfab/cadre-core test` and `yarn workspace @serfab/cadre-core build`; grep the other packages' tests for a hard-coded `control-<base64url>` literal or a mixed-case strand id (`grep -rnE "control-[A-Za-z0-9_-]*[A-Z]" packages --include=*.ts`) and fix any that surface. Run `yarn lint`.
