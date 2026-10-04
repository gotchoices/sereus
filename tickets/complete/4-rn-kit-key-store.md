description: The shared React Native kit now provides the secure key store and the durable record slots a phone node needs, so phone apps other than the reference app can keep their node identity in the platform secure store instead of rewriting (or skipping) that code.
architecture: docs/reference-app-rn.md#node-local-persistence
files: packages/cadre-rn/src/key-store.ts, packages/cadre-rn/src/node-local.ts, packages/cadre-rn/test/key-store.spec.ts, packages/cadre-rn/test/node-local.spec.ts, packages/cadre-rn/test/fake-secure-store.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-names.ts, packages/reference-app-rn/package.json, yarn.lock, docs/reference-app-rn.md, docs/architecture.md
----
# Key store and node-local slots (`@serfab/cadre-rn/key-store`, `/node-local`)

First half of `feat-rn-kit-secure-key-store`. The ticket deferred the move until a second app
wanted the code. Three phone apps now build a cadre node outside the reference app: sereus-chat,
health and taleus. The first two each carry their own copy of the bring-up (health's is forked from
chat's). Measured against cadre-core's host contract, both copies:

- keep the identity as `privateKey` in the plaintext control LevelDB instead of a `keyStore`;
- leave some node-local stores in memory. Chat omits trusted owners, bootstrap peers and enrolled
  machines (`types.ts` notes a node without durable bootstrap peers "is stranded permanently if it
  restarts before connecting"). Health omits the strand network state.

Their own comments give the reason: the secure-store pieces lived only in the Expo reference app,
and both apps are bare React Native. Taleus is waiting on this rather than making a fourth copy.

## What landed

- `src/secure-key-store.ts` moved to `packages/cadre-rn/src/key-store.ts`, exported as
  `@serfab/cadre-rn/key-store`. The behaviour is unchanged. One change: `SecureStoreOptions` (the
  two fields forwarded to every call) is declared in the module rather than imported from
  `expo-secure-store`, so the kit has no Expo dependency. `expo-secure-store` remains structurally
  assignable to `SecureStoreApi`. A bare React Native app passes an adapter over its own secure
  store that keeps the same contract: `null` for an absent key, a throw for a denied read. The
  module header says so.
- `src/node-local-slots.ts` moved to `packages/cadre-rn/src/node-local.ts`, exported as
  `@serfab/cadre-rn/node-local`. It contains `secureStoreSlot`, `kvStoreSlot`, `KvStoreApi`, and the
  record keys (`anchorSlotKey`, `bootstrapPeersKvKey`, `enrolledMachinesKvKey`,
  `strandNetworkKvKey`). These are persistence contracts and are unchanged, so an upgraded
  reference app reads its existing records.
- The app-owned names stayed in the app, now constants in `reference-app-rn/src/cadre-phone.ts`:
  - `NODE_LOCAL_DB_NAME`
  - `NODE_LOCAL_KV_PREFIX`
  - `START_OPTIONS_KV_KEY`, with the reinstall NOTE that belongs to it
  These are the "storage names and key prefixes" the original ticket said tied the code to one app.
- The tests (`secure-key-store.spec.ts`, `node-local-slots.spec.ts`, `fake-secure-store.ts`) moved
  to `packages/cadre-rn/test/` as `key-store.spec.ts` and `node-local.spec.ts`. The fake now types
  against the kit's `SecureStoreOptions`. The one assertion on the app's database name and prefix
  was dropped, since those values are no longer the kit's.
- `package.json` changes:
  - two exports;
  - `uint8arrays` as a dependency;
  - `@serfab/cadre-core` as an optional peer (only these subpaths use it; `KeyStoreAccessError` is
    a runtime import) and as a devDependency.
  - The reference app drops `uint8arrays`, which only the moved key store used.
- Docs:
  - the kit README has the two table rows and a "Key store and node-local records" section, with
    an Expo example and the bare-RN adapter contract;
  - `docs/reference-app-rn.md` and `docs/architecture.md` point at the kit subpaths.

Not moved: the phone-node construction (`cadre-phone.ts`, `phone-node-config.ts`) and the
lifecycle (`background-runner.ts`). They need an API design, not a move. They are
`tickets/backlog/feat-rn-kit-phone-node.md`.

## Verification

On master at v1.11.0, with optimystic v1.9.0 and quereus v4.20.0 as the linked siblings, freshly built:
- `cadre-rn`: `typecheck` clean; `test` 103 passed (7 files), including the moved specs.
- `reference-app-rn`: `typecheck` clean; `test` 192 passed (19 files).
- Repo-wide:
  - `yarn lint` exit 0;
  - `check:dep-ranges`, `check:vitest-typecheck-coverage` and `check:test-file-typecheck-coverage`
    pass;
  - `knip` reports nothing for the moved code or the dependencies it changed.

**Not run:** an Expo build of the reference app on a device. The imports are type-compatible and
the runtime modules are the same code at new paths.

## For the reviewer

- **The peer range:** `@serfab/cadre-core` as `workspace:^`, which publishing rewrites. No other
  package declares a stack peer, so there was no house convention to follow.
- **The bare-RN contract:** is "adapt to `SecureStoreApi`" the right seam, or should the kit also
  ship a `react-native-keychain` adapter? No in-repo consumer could test one, so none was added.
- **Kept on purpose:** the `sereus.ks.` and `sereus.anchor.` prefixes. Each app's secure store is
  sandboxed per app, so a fixed prefix cannot collide between apps.

## Review findings

Reviewed the implement commit `feat(cadre-rn): share the secure key store and node-local slots` (PR #29) against the tree as it stands now, which also carries `refactor(reference-app-rn): pin the node-local record names again` and the phone-node and lifecycle PRs (#30, #31) built on top of it. Those two later moves have their own review tickets (`rn-kit-phone-node`, `rn-kit-lifecycle`); this pass covered only the key store, the node-local slots, their specs and the docs that describe them.

**Correctness.** Checked by reading: the key store and both slots are byte-for-byte the reference app's logic. The secure-store key prefixes (`sereus.ks.`, `sereus.anchor.`), the base64url encoding and the LevelDB record keys are unchanged, so an upgraded phone reads its existing records. `SecureStoreOptions` declared in the kit matches Expo's two fields, and `expo-secure-store` and the kit's `LevelDBKVStore` still satisfy `SecureStoreApi` / `KvStoreApi` (the reference app and `phone-node` typecheck against them). The access-versus-absence handling, the gated-slot guard and the index write ordering were not changed by the move, and their existing specs still pass. No defects found.

**Persistence contracts the move left unpinned (fixed).**
- The implement pass dropped the test that pinned the app's node-local database name and prefix. It was already restored by `refactor(reference-app-rn): pin the node-local record names again` (`node-local-names.ts` with its own spec), so nothing to do here beyond listing that file in the reference app's source tree in `docs/reference-app-rn.md`.
- The identity slot's secure-store key was only checked for shape and for being the same across instances. If that key changes, every installed phone reads its identity slot as empty and cadre-core generates a new peer id. The "deterministic across instances" test in `key-store.spec.ts` now pins the exact key, `sereus.ks.Y2FkcmUvaWRlbnRpdHk`.
- `anchorSlotKey` was only checked for its prefix, not its encoding. The key-shape tests in `node-local.spec.ts` are now one test pinning all four record keys exactly, plus the charset check. The two "distinct keys" tests were cut, since the pinned values already show the keys are distinct.

**Tests cut.** `node-local.spec.ts`'s header says cadre-core owns the store policy and the file does not restate it, but the file did restate it. Removed: the four `kvStoreSlot` pass-through tests (the composition tests already cover its read and write failures), the junk-text, foreign-party-id, raw-envelope and failed-persist tests (cadre-core's `node-local-snapshot.spec.ts` and `enrolled-machine-store.spec.ts` cover them), and the enrolled-machine composition block (`kvStoreSlot` passes its key straight through, so the bootstrap-peer composition stands for all three LevelDB records; a comment says so). The section headings now say what each section covers. What remains in the file is the slots' own contract: a failed read throws rather than returning `undefined`, options are forwarded, a gated anchor slot is refused, the anchor and the key store share one secure store without touching each other, and the record keys are pinned. Kit tests: 139 passed (13 files).

**Docs (fixed).**
- `docs/architecture.md`'s cadre-core summary still said `SecureStoreKeyStore` "ships in `reference-app-rn`". It now names `@serfab/cadre-rn/key-store`.
- The kit README called the reference app's `cadre-phone.ts` the worked example, and said only these two subpaths need `@serfab/cadre-core`. Both stopped being true after #30 and #31. The README now says `createPhoneNode` wires the key store and slots for an app that uses it, and that `/phone-node` and `/lifecycle` need cadre-core too.
- `node-local.ts`'s header pointed at the reference app as the place the stores are opened. It now points at `createPhoneNode`.
- `docs/reference-app-rn.md#node-local-persistence` was read and is current.

**Source hygiene (fixed).** The key store's log tag was still `[secure-key-store]`, the old file name. It is now `[cadre-rn/key-store]`, matching the kit's `[cadre-rn/phone-node]`. Both source files are within size (~330 and ~175 lines). Their comments are long but explain constraints (native key charset, gated-null ambiguity, write ordering) rather than narrating statements.

**Reviewer questions from the handoff.**
- *Peer range `workspace:^`.* Correct. `yarn pub` runs `yarn npm publish`, which rewrites `workspace:` ranges in `peerDependencies` the same as in `dependencies`, and cadre-core is published before cadre-rn in the `pub` chain. Keeping it optional is still right: `/noise-crypto`, `/polyfills` and `/metro` do not use cadre-core.
- *Adapt to `SecureStoreApi`, or ship a `react-native-keychain` adapter.* Keep the seam as it is. No in-repo consumer could test an adapter, and its value would be guessed. The three-method contract (null for absent, throw for denied) is documented in the module header and the README.
- *Fixed `sereus.ks.` / `sereus.anchor.` prefixes.* Fine today, because each app's secure store is its own. Tripwire: an app that shares a Keychain access group with another Sereus app would collide on the index and the identity slot. Recorded as a `NOTE:` at `KEY_PREFIX` in `packages/cadre-rn/src/key-store.ts`, together with the fact that Expo's `keychainService` is not forwarded.

**Considered and left alone.**
- `SecureStoreOptions` (the shape passed to the native call) and `SecureStoreKeyStoreOptions` (the app-facing options) have the same two fields. They stay separate: each is documented for its own role, and `phone-node` uses the second as public API, so merging them would change the API for no behavioural gain.
- Resource cleanup: neither module holds a resource. The key store's index promise chain swallows only for the chain and still rejects to the caller.
- Performance: one secure-store read per index mutation. The index is tiny and touched only on set and delete.

**Validation.** `yarn lint` exit 0. `@serfab/cadre-rn` typecheck clean, test 139/139, rebuilt so the reference app's stale-build guard passes. `@serfab/reference-app-rn` typecheck clean, test 168/168 (17 files). Not run: an Expo device build, same as the handoff. The runtime code is unchanged, so no new risk there.

