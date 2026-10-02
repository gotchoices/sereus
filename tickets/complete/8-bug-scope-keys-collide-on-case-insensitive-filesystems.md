description: On Windows and Mac, two different strands or two different parties could end up sharing one storage folder, because those systems ignore letter case in folder names. Every storage key is now lowercase-only, so two different keys always give two different folders.
architecture: docs/architecture.md#storage-scope-keys
files:
  - packages/cadre-core/src/storage-scope.ts (`SCOPE_KEY_CHARSET`, `controlStorageScope`, `isValidStrandScopeKey`, `InvalidStrandIdError`, `assertScopeKeyCharset`, module comment)
  - packages/cadre-core/test/control-storage-scope.spec.ts
  - packages/cadre-core/test/strand-scope-key-validation.spec.ts
  - .release-notes.pending.md
  - docs/architecture.md (*Storage scope keys*)
  - comment/doc-only: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/README.md, packages/cadre-cli/src/commands/node-session.ts, packages/reference-app-ns/src/ns-storage.ts, packages/reference-app-ns/README.md, docs/reference-app-ns.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/strand-storage.ts
repro: verified
----

# Storage scope keys are lowercase-only

## Summary

cadre-core gives each store it asks an embedder's storage provider for a name, called a **scope key**: the strand id for a strand, and `control-<encoded party id>` for the party's control database. Embedders use the key directly as a folder, file or database name. NTFS (Windows) and APFS/HFS+ (macOS) ignore case in file names, so two keys that differed only in case were two stores in memory but one folder on disk. For example, under the old base64url encoding party ids `aa@` and `aaZ` became `control-YWFA` and `control-YWFa`; strand ids `strand-ABC` and `strand-abc` had the same problem.

Landed in `ticket(implement): bug-scope-keys-collide-on-case-insensitive-filesystems`:

- `SCOPE_KEY_CHARSET` is `/^[a-z0-9._-]+$/`. `isValidStrandScopeKey` uses it for strand keys, and `assertScopeKeyCharset` uses it for the control key.
- `controlStorageScope` now encodes the party id's UTF-8 bytes as lowercase hex (`uint8arrays` `'base16'`). A UUID party id gives an 80-character key. A `NOTE:` tripwire at the function covers the 255-byte path-component limit for long party ids.
- A strand id containing an uppercase letter is refused with `InvalidStrandIdError` at `publishStrand`, `startStrand`, `handleStrandAdded` and the joined-strand store. It is refused rather than lowercased, because lowercasing would merge two distinct strands.
- `.release-notes.pending.md` has an upgrade note. The control store's name changed, and a node that is its party's only node must rename its folder before starting the upgraded build. Browser and phone stores start fresh, and uppercase strand ids are now refused.

## Review findings

**Diff read first.** I read the full implement commit before the handoff. All changes are consistent with each other, the docs included.

**Correctness, checked and found sound:**
- Every code path that hands a strand id to storage goes through `isValidStrandScopeKey` / `assertStrandScopeKey`, so the tightened regex covers all of them: `cadre-node.ts` `handleStrandAdded`, `publishStrand` and `addStrand`, `strand-instance-manager.ts` `startStrand`, and `joined-strand-store.ts`. Both minters in `strand-id.ts` produce only lowercase (hex from `randomBytes`, and `Date.now()` plus base36), and they assert the predicate on their output.
- A strand id sent by a formation responder is checked only for being non-empty (`strand-formation-protocol.ts` around line 372). A mixed-case id from a nonconforming responder is still refused when the joined-strand store saves it, the same way any other invalid id already was. Nothing new here.
- The other places that build strand ids (the integration harness, `test-network.ts`, `formation-mocks.ts`, `convergence-stress`) all use lowercase literals, `Date.now()` or base36.
- Every code outside `storage-scope.ts` that uses the control key calls `controlStorageScope` / `isControlStorageScope`, including web `cadre-web.ts`, the integration probe and tests. None hard-codes or parses the key, so none depended on the base64url form. The cache wrapper keyed by scope (`wrapStorageWithCache`) is in memory only.
- `isControlStorageScope` is a prefix test, so it does not depend on the encoding. Strand keys still cannot begin with `control-`.

**Release note:**
- I ran the `node -e` rename command in a scratch directory on a UUID party's base64url folder. It produced `control-3131…3535`, which is the lowercase hex of the party id's UTF-8 bytes, matching `controlStorageScope`.
- The path `<workdir>/storage` for cadre-host nodes is correct for the `storage` profile (`host-process-orchestrator.ts:578` and `:1026`). The instruction for an already-started sole node (stop it, delete the new `control-<hex>` folder, then rename) is correct: that folder holds only what the node wrote after the upgrade, and the note says so.

**Docs:**
- The remaining `[A-Za-z0-9._-]` hits are the React Native SecureStore key-segment rules (`secure-key-store.ts`, `node-local-slots.ts`, `docs/architecture.md:1411`). Keychain keys are case-sensitive, so those are correct as written.
- `cadre/joined-strand/<base64url party id>/…` (`docs/architecture.md:1348`, `joined-strand-store.ts`) is left for the open sibling ticket `file-store-names-collide-on-case-insensitive-filesystems` (in `review/`).
- `control-<partyId>` in `docs/architecture.md:377/796/1057` and in the RN/NS docs names libp2p networks, not storage, so it is unaffected.

**Tests:** I kept the two tightened specs. The charset assertion in `control-storage-scope.spec.ts` is the regression test: it fails under base64url because of uppercase alone. The `strand-ABC` row pins the new refusal. The `control-7061727479` rows still exercise the prefix rule rather than the charset. No test added and none cut: nothing else was left unverified.

**Tripwires:** The only one is the `NOTE:` on `controlStorageScope` about long party ids, added by the implementer. The strand key's 128-character cap does not apply to the control key; that is covered by the same note. No new tripwires.

**Source hygiene, types, error handling, performance:** The change is a regex and an encoding name plus comments, so there is nothing to find in these categories. The error messages name the charset and give the reason.

**Not re-run:** The real-network integration scenarios, which take longer than an agent run is allowed. Every strand id and control key they use is lowercase or comes from `controlStorageScope`, so I expect them to pass. CI would confirm.

**Validation run in review:** `yarn workspace @serfab/cadre-core build` passed. `yarn workspace @serfab/cadre-core test`: 144 files, 2344 passed, 1 skipped (a skip that was already there). `yarn lint`: clean.

**Changes made in review:** none.
