description: cadre-core and cadre-host test files have pre-existing type drift that hid because tests were never type-checked. The build-health typecheck ticket widened typecheck to test files for other packages but left these two at shippable-source scope. Fix the test-file type errors, then widen their `typecheck` to include tests.
prereq: build-health-typecheck-all-packages
files: packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/types.spec.ts, packages/cadre-core/package.json, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/server/__tests__/error-handler.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/server/__tests__/publishers.test.ts, packages/cadre-host/src/server/__tests__/status-route.test.ts, packages/cadre-host/package.json, packages/cadre-host/tsconfig.json
----

## Background

`build-health-typecheck-all-packages` made `yarn typecheck` fan out to every workspace and, where
green, widened each package's `typecheck` to cover test files (via a per-package
`tsconfig.typecheck.json`). Two packages had **pre-existing** type errors in their test files that
were invisible because vitest transpiles via esbuild without type-checking and the `tsconfig.build.json`
excludes test files. To keep the primary deliverable (all packages green) intact, those two were left
at **shippable-source-only** scope. This ticket fixes the drift and widens them.

These are genuine drift, not test bugs introduced by the typecheck work — the tests have simply not
been type-validated for a while.

## cadre-core (3 errors) — run `yarn workspace @serfab/cadre-core exec tsc -p tsconfig.typecheck.json --noEmit` after recreating the config

- `test/cadre-node.spec.ts:68` — `storage: { type: 'memory' }`: `StorageConfig` no longer has a
  `type` field. The current shape is `{ provider: () => RawStorage, quotaBytes?: number }` (see
  `test/types.spec.ts:37-39` which uses `provider: () => new MemoryRawStorage()`). Update the fixture
  to match.
- `test/strand-solicitation.spec.ts:26` — `createLibp2p({ peerId: ... })`: newer libp2p takes
  `privateKey`, not `peerId`. The helper generates a peer-id; switch to generating/passing a
  `PrivateKey` (the `@libp2p/crypto` `generateKeyPair`/`privateKeyFromProtobuf` path) consistent with
  how production code constructs libp2p elsewhere in cadre-core.
- `test/types.spec.ts:30` — `privateKey: new Uint8Array([1,2,3])`: `CadreNodeConfig.privateKey` is now
  a libp2p `PrivateKey`, not `Uint8Array`. Construct a real `PrivateKey` (or adjust the type if the
  intent was raw bytes — verify against `src/types.ts`).

## cadre-host (8 errors) — server tests under `src/**/__tests__` (the base `tsconfig.json` `include: ["src"]` already pulls these in; `tsconfig.build.json` excludes them)

- `src/server/__tests__/nodes-route.test.ts:88`, `publishers.test.ts:134`, `status-route.test.ts:67` —
  `NodePorts` now requires an `admin` port; the test fixtures build
  `{ health, metrics, p2p }` without it. Add `admin` to each fixture.
- `src/server/__tests__/error-handler.test.ts:15,19,23` and `src/nat/__tests__/nat-service.test.ts:352` —
  implicit-`any` params (`req`, `a`). Annotate them.
- `src/nat/__tests__/nat-service.test.ts:352` — `Array.prototype.at` needs `lib` ES2022; cadre-host's
  base `tsconfig.json` targets ES2020. Either avoid `.at()` in the test or bump `lib`/`target` for the
  typecheck scope (don't change production emit target casually — prefer fixing the test or adding a
  `lib` override in the test-scoped tsconfig).

## Then widen the configs

For each package, recreate a `tsconfig.typecheck.json` (the implement ticket deleted the unused ones)
extending the base, `noEmit: true`, `include` source + tests:

- cadre-core: `include: ["src", "test"]`, `compilerOptions: { "rootDir": ".", "noEmit": true }`
  (tests live in `test/`, outside `src`, so `rootDir` must widen).
- cadre-host: `include: ["src"]`, `compilerOptions: { "noEmit": true }` (server tests are under `src`;
  do NOT add `ui/` — that's Svelte and needs `svelte-check`, tracked separately).

Then point each `package.json` `typecheck` at `tsconfig.typecheck.json --noEmit` and confirm
`yarn typecheck` is still green across the monorepo.
