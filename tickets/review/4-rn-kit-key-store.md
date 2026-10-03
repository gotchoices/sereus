description: The shared React Native kit now provides the secure key store and the durable record slots a phone node needs, so phone apps other than the reference app can keep their node identity in the platform secure store instead of rewriting (or skipping) that code.
architecture: docs/reference-app-rn.md#node-local-persistence
files: packages/cadre-rn/src/key-store.ts, packages/cadre-rn/src/node-local.ts, packages/cadre-rn/test/key-store.spec.ts, packages/cadre-rn/test/node-local.spec.ts, packages/cadre-rn/test/fake-secure-store.ts, packages/cadre-rn/package.json, packages/cadre-rn/README.md, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/start-options.ts, packages/reference-app-rn/package.json, yarn.lock, docs/reference-app-rn.md, docs/architecture.md, tickets/backlog/feat-rn-kit-phone-node.md, tickets/backlog/debt-rn-cadre-phone-lifecycle-untested.md
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
