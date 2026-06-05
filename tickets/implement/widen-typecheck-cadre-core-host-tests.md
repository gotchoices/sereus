description: Fix pre-existing type drift in cadre-core and cadre-host test files, then widen each package's `typecheck` to cover test files (per-package `tsconfig.typecheck.json`). These two packages were left at shippable-source scope by `build-health-typecheck-all-packages` because their tests had latent type errors invisible to vitest's esbuild transpile.
prereq: build-health-typecheck-all-packages
files: packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/types.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/package.json, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/server/__tests__/error-handler.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/server/__tests__/publishers.test.ts, packages/cadre-host/src/server/__tests__/status-route.test.ts, packages/cadre-host/package.json, packages/cadre-host/tsconfig.json
----

## Background

`build-health-typecheck-all-packages` made `yarn typecheck` fan out to every workspace and, where
green, widened each package's `typecheck` to cover test files (via a per-package
`tsconfig.typecheck.json`). Two packages had **pre-existing** type errors in their test files that
were invisible because vitest transpiles via esbuild without type-checking and `tsconfig.build.json`
excludes test files. Those two were left at **shippable-source-only** scope (their `typecheck` still
points at `tsconfig.build.json`). This ticket fixes the drift and widens them.

These are genuine drift, not test bugs introduced by the typecheck work — the tests simply have not
been type-validated for a while. All errors below were **reproduced** against the current tree (see
"Reproduction" at the bottom) so line numbers are accurate as of this writing.

## cadre-core — 10 errors (the original ticket enumerated 3; the `hibernation-manager.spec.ts`
batch was missed and is included here)

Reproduce with a typecheck config that includes `test/` (see config section below), then
`yarn workspace @serfab/cadre-core exec tsc -p tsconfig.typecheck.json --noEmit`.

- **`test/cadre-node.spec.ts:71`** — `storage: { type: 'memory' }`: `StorageConfig` (`src/types.ts:99`)
  has no `type` field; its shape is `{ provider: RawStorageProvider; quotaBytes?: number }`. Replace
  with `storage: { provider: () => new MemoryRawStorage() }` and add
  `import { MemoryRawStorage } from '@optimystic/db-p2p';` (mirrors `test/types.spec.ts:2,38`).

- **`test/strand-solicitation.spec.ts:26`** — `createLibp2p({ peerId: ... })`: newer libp2p takes
  `privateKey`, not `peerId`. The helper `createLibp2pNodeWithKeys` (lines 22-33) currently does the
  `@libp2p/peer-id-factory` round-trip (`createEd25519PeerId` → `exportToProtobuf` →
  `createFromProtobuf`). Replace it with a `PrivateKey`: `const privateKey = await generateKeyPair('Ed25519');`
  then `createLibp2p({ privateKey, ... })`. Import `generateKeyPair` from `@libp2p/crypto/keys` and drop
  the now-unused `@libp2p/peer-id-factory` import. This mirrors production
  (`src/enrollment.ts:2,80`, `src/strand-solicitation.ts:3,235`) and the existing
  `test/cadre-node.spec.ts:3,579` usage.

- **`test/types.spec.ts:30`** — `privateKey: new Uint8Array([1, 2, 3])`: `CadreNodeConfig.privateKey`
  is a libp2p `PrivateKey` (`src/types.ts:1,202`), not `Uint8Array`. Make the `it('should allow full
  configuration', ...)` callback `async`, build a real key (`const privateKey = await
  generateKeyPair('Ed25519');`, import from `@libp2p/crypto/keys`), set `privateKey` in the config, and
  update the assertion at **line 53** (`expect(config.privateKey).toEqual(new Uint8Array([1,2,3]))`) to
  assert against the constructed key (e.g. `expect(config.privateKey).toBe(privateKey)`).

- **`test/hibernation-manager.spec.ts:210,293,339,348,441,469,475`** (7 errors) — calls like
  `callbacks.onHibernate.mockRejectedValueOnce(...)` / `.mockImplementation(...)` fail with
  `Property 'mock...' does not exist on type '(strandId: string) => Promise<void>'`. **Root cause:**
  `createCallbacks()` (lines 28-45) annotates its return type as `HibernationCallbacks & { idleCalls:
  string[]; ... }`. Because `HibernationCallbacks` types `onIdle`/`onHibernate`/`onWake`/`onCheckIn`
  as plain `(strandId: string) => Promise<void>`, the explicit annotation **widens** the `vi.fn()`
  mocks down to plain functions, erasing the Mock methods. **Fix:** drop the explicit return-type
  annotation on `createCallbacks` (let TS infer it) so the `vi.fn()` Mock types survive. The inferred
  object is still structurally assignable to `HibernationCallbacks` at the `new HibernationManager(...)`
  call sites (extra `*Calls` array properties are fine when passing a variable, not an object literal).
  Verify those call sites still typecheck after the change.

## cadre-host — 8 errors (matches the original enumeration)

Server tests live under `src/**/__tests__`, so the base `tsconfig.json` `include: ["src"]` already
pulls them in; `tsconfig.build.json` excludes them. Reproduce with
`yarn workspace @serfab/cadre-host exec tsc -p tsconfig.json --noEmit` (or the new
`tsconfig.typecheck.json`).

- **`src/server/__tests__/nodes-route.test.ts:88`, `publishers.test.ts:134`, `status-route.test.ts:67`**
  — `NodePorts` (`src/orchestrator/types.ts:29`) now requires `admin: number` (loopback admin channel).
  Each fixture builds `ports: { health, metrics, p2p }`. Add an `admin` port to each (any distinct
  number consistent with the fixture's other ports).

- **`src/server/__tests__/error-handler.test.ts:15,19,23`** — `app.get('/x/:code', async (req) => ...)`
  callbacks have implicit-`any` `req`. Annotate `req` (e.g. `req: FastifyRequest`, importing the type
  from `fastify`) — the handler only reads `req.params`, so a `FastifyRequest` annotation suffices.

- **`src/nat/__tests__/nat-service.test.ts:352`** — two errors on one line:
  `expect(fired.at(-1)!.every((a) => ...))`.
  - `a` is implicit-`any`: annotate it (`(a: string) => ...`).
  - `Array.prototype.at` needs `lib` ES2022; the base `tsconfig.json` targets ES2020 with no explicit
    `lib`. **Preferred fix:** avoid `.at(-1)` in the test — use `fired[fired.length - 1]!` (zero config
    risk, one-line change). Alternative (documented, not preferred): add `"lib": ["ES2022"]` to the
    test-scoped `tsconfig.typecheck.json` only — do **not** change the production `target`/emit. Since
    the cadre-host typecheck scope is all of `src`, a `lib` bump would apply to production typechecking
    too; that is harmless (Node 18+ has ES2022) but broader than necessary, so prefer the test edit.

## Then widen the configs

For each package, create a `tsconfig.typecheck.json` extending the base, `noEmit: true`, including
source + tests:

- **cadre-core** (`packages/cadre-core/tsconfig.typecheck.json`): tests live in `test/`, outside `src`,
  so `rootDir` must widen.
  ```jsonc
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "rootDir": ".", "noEmit": true },
    "include": ["src", "test"]
  }
  ```
- **cadre-host** (`packages/cadre-host/tsconfig.typecheck.json`): server tests are already under `src`.
  Do **NOT** add `ui/` — that's Svelte and needs `svelte-check`, tracked separately.
  ```jsonc
  {
    "extends": "./tsconfig.json",
    "compilerOptions": { "noEmit": true },
    "include": ["src"]
  }
  ```
  (If using the `lib` alternative for `.at()`, add `"lib": ["ES2022"]` under `compilerOptions` here.)

Then point each `package.json` `typecheck` script at the new config:
`"typecheck": "tsc -p tsconfig.typecheck.json --noEmit"`.

## Reproduction (current tree, before fixes)

cadre-core (temporary `tsconfig.typecheck.json` as above):
```
test/cadre-node.spec.ts(71,20): error TS2353: 'type' does not exist in type 'StorageConfig'.
test/hibernation-manager.spec.ts(210,29): error TS2339: Property 'mockRejectedValueOnce' does not exist ...
test/hibernation-manager.spec.ts(293,29): error TS2339: Property 'mockImplementation' does not exist ...
test/hibernation-manager.spec.ts(339,29): error TS2339: Property 'mockImplementation' does not exist ...
test/hibernation-manager.spec.ts(348,27): error TS2339: Property 'mockImplementation' does not exist ...
test/hibernation-manager.spec.ts(441,24): error TS2339: Property 'mockImplementation' does not exist ...
test/hibernation-manager.spec.ts(469,29): error TS2339: Property 'mockImplementation' does not exist ...
test/hibernation-manager.spec.ts(475,10): error TS2339: Property 'mockRejectedValueOnce' does not exist ...
test/strand-solicitation.spec.ts(26,5): error TS2353: 'peerId' does not exist in type 'Libp2pOptions<ServiceMap>'.
test/types.spec.ts(30,9): error TS2322: Type 'Uint8Array<ArrayBuffer>' is not assignable to type 'PrivateKey | undefined'.
```

cadre-host (`tsc -p tsconfig.json --noEmit`):
```
src/nat/__tests__/nat-service.test.ts(352,18): error TS2550: Property 'at' does not exist on type 'string[][]'. ...
src/nat/__tests__/nat-service.test.ts(352,33): error TS7006: Parameter 'a' implicitly has an 'any' type.
src/server/__tests__/error-handler.test.ts(15,36): error TS7006: Parameter 'req' implicitly has an 'any' type.
src/server/__tests__/error-handler.test.ts(19,34): error TS7006: Parameter 'req' implicitly has an 'any' type.
src/server/__tests__/error-handler.test.ts(23,37): error TS7006: Parameter 'req' implicitly has an 'any' type.
src/server/__tests__/nodes-route.test.ts(88,3): error TS2741: Property 'admin' is missing ... 'NodePorts'.
src/server/__tests__/publishers.test.ts(134,7): error TS2741: Property 'admin' is missing ... 'NodePorts'.
src/server/__tests__/status-route.test.ts(67,11): error TS2741: Property 'admin' is missing ... 'NodePorts'.
```

## TODO

### Phase 1 — cadre-core test fixes
- [ ] `test/cadre-node.spec.ts`: replace `storage: { type: 'memory' }` (line ~71) with
      `storage: { provider: () => new MemoryRawStorage() }`; add `MemoryRawStorage` import from
      `@optimystic/db-p2p`.
- [ ] `test/strand-solicitation.spec.ts`: rewrite `createLibp2pNodeWithKeys` to use
      `generateKeyPair('Ed25519')` from `@libp2p/crypto/keys` and pass `privateKey` (not `peerId`);
      remove the unused `@libp2p/peer-id-factory` import.
- [ ] `test/types.spec.ts`: make the "full configuration" test `async`, build `privateKey` via
      `generateKeyPair('Ed25519')`, set it on the config, and fix the line ~53 assertion.
- [ ] `test/hibernation-manager.spec.ts`: remove the explicit return-type annotation on
      `createCallbacks()` so `vi.fn()` Mock types survive; confirm `new HibernationManager(...)` sites
      still typecheck.

### Phase 2 — cadre-host test fixes
- [ ] `nodes-route.test.ts`, `publishers.test.ts`, `status-route.test.ts`: add `admin` to each
      `ports` fixture.
- [ ] `error-handler.test.ts`: annotate the three `req` params (`FastifyRequest`).
- [ ] `nat-service.test.ts:352`: annotate `a: string`; replace `fired.at(-1)!` with
      `fired[fired.length - 1]!`.

### Phase 3 — widen typecheck scope
- [ ] Create `packages/cadre-core/tsconfig.typecheck.json` (`include: ["src","test"]`,
      `rootDir: "."`, `noEmit: true`).
- [ ] Create `packages/cadre-host/tsconfig.typecheck.json` (`include: ["src"]`, `noEmit: true`).
- [ ] Point both `package.json` `typecheck` scripts at `tsc -p tsconfig.typecheck.json --noEmit`.

### Phase 4 — validate
- [ ] `yarn workspace @serfab/cadre-core exec tsc -p tsconfig.typecheck.json --noEmit` → clean.
- [ ] `yarn workspace @serfab/cadre-host exec tsc -p tsconfig.typecheck.json --noEmit` → clean.
- [ ] `yarn typecheck` (whole monorepo) → green; stream output with `tee` (it fans out across
      workspaces).
- [ ] `yarn workspace @serfab/cadre-core test` and `yarn workspace @serfab/cadre-host test` → still
      pass (the fixture changes must not alter runtime behavior).
