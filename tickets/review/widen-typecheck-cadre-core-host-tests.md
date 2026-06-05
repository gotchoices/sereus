description: Review the type-drift fixes + typecheck widening for cadre-core and cadre-host test files. These two packages were left at shippable-source scope by `build-health-typecheck-all-packages`; their tests had latent type errors. All errors are now fixed and each package's `typecheck` covers test files via a per-package `tsconfig.typecheck.json`.
files: packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/types.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/tsconfig.typecheck.json, packages/cadre-core/package.json, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/server/__tests__/error-handler.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/server/__tests__/publishers.test.ts, packages/cadre-host/src/server/__tests__/status-route.test.ts, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-host/package.json
----

## What was done

Fixed 18 pre-existing type errors across cadre-core (10) and cadre-host (8) test files, then widened
each package's `typecheck` script to cover test files via a new `tsconfig.typecheck.json`. These were
genuine drift invisible to vitest (esbuild transpiles without type-checking) and to
`tsconfig.build.json` (which excludes tests). All 18 errors reproduced against the tree before the fix
and are gone after.

### cadre-core test fixes (`test/`, outside `src`)
- **cadre-node.spec.ts** — `storage: { type: 'memory' }` → `storage: { provider: () => new MemoryRawStorage() }`;
  added `import { MemoryRawStorage } from '@optimystic/db-p2p'`. (`StorageConfig` has `provider`, no `type`.)
- **strand-solicitation.spec.ts** — `createLibp2pNodeWithKeys` rewritten to
  `const privateKey = await generateKeyPair('Ed25519')` + `createLibp2p({ privateKey, ... })`; dropped the
  `@libp2p/peer-id-factory` round-trip import (newer libp2p takes `privateKey`, not `peerId`). Mirrors
  production (`src/enrollment.ts`, `src/strand-solicitation.ts`).
- **types.spec.ts** — "full configuration" test made `async`; `privateKey` now a real
  `generateKeyPair('Ed25519')` key (was `new Uint8Array([1,2,3])`, but `CadreNodeConfig.privateKey` is a
  libp2p `PrivateKey`); assertion changed to `expect(config.privateKey).toBe(privateKey)`.
- **hibernation-manager.spec.ts** — removed the explicit `HibernationCallbacks & {...}` return-type
  annotation on `createCallbacks()` so the `vi.fn()` Mock types survive (the annotation widened the mocks
  to plain functions, erasing `.mockImplementation`/`.mockRejectedValueOnce`). TS now infers the type;
  it remains structurally assignable to `HibernationCallbacks` at all `new HibernationManager(...)` sites.
  `HibernationCallbacks` import is still used (line ~382 has a separately-annotated callbacks object).

### cadre-host test fixes (`src/**/__tests__`, already under `src`)
- **nodes-route.test.ts / publishers.test.ts / status-route.test.ts** — added `admin` to each `ports`
  fixture (`NodePorts` now requires `admin: number`, the loopback admin channel). A 4th fixture
  (nodes-route.test.ts:203) already had `admin`.
- **error-handler.test.ts** — annotated the three implicit-`any` `req` params as `FastifyRequest`
  (imported `type FastifyRequest` from `fastify`).
- **nat-service.test.ts:352** — replaced `fired.at(-1)!` with `fired[fired.length - 1]!` (avoids needing
  `lib: ES2022`, the preferred fix) and annotated `(a: string)`.

### Config widening
- New `packages/cadre-core/tsconfig.typecheck.json` (`extends ./tsconfig.json`, `rootDir: "."`,
  `noEmit: true`, `include: ["src","test"]`) — `rootDir` widened because tests live outside `src`.
- New `packages/cadre-host/tsconfig.typecheck.json` (`extends ./tsconfig.json`, `noEmit: true`,
  `include: ["src"]`) — server tests already under `src`; deliberately does **not** include `ui/`
  (Svelte, needs `svelte-check`, tracked separately).
- Both `package.json` `typecheck` scripts now point at `tsc -p tsconfig.typecheck.json --noEmit`.

## Validation performed (all green unless noted)
- `yarn workspace @serfab/cadre-core exec tsc -p tsconfig.typecheck.json --noEmit` → clean (exit 0).
- `yarn workspace @serfab/cadre-host exec tsc -p tsconfig.typecheck.json --noEmit` → clean (exit 0).
- `yarn typecheck` (whole monorepo fan-out) → green (exit 0, ~15s).
- `yarn workspace @serfab/cadre-core test` → 21 files, **292/292 pass**.
- `yarn workspace @serfab/cadre-host test` → 357 pass, 3 skipped, **2 failed** — see gaps below.

## Known gaps / things for the reviewer to probe
- **Two cadre-host smoke-test timeouts (NOT caused by this diff).** `cli.smoke.test.ts > prints help
  with all subcommands` and `cli-nat.smoke.test.ts > GETs /nat/status ...` hit vitest's 5000ms per-test
  timeout in the full 46-file run (which reported `import 86.51s` — heavy parallel contention spawning
  a CLI child + booting a server). **Both pass 11/11 when run in isolation**
  (`vitest run src/__tests__/cli.smoke.test.ts src/__tests__/cli-nat.smoke.test.ts`). Neither imports
  anything this ticket touched. Documented in `tickets/.pre-existing-error.md` for the runner's triage
  pass. A durable fix is raising `testTimeout` for these subprocess-spawn smoke tests — out of scope here.
- **Reviewer check:** confirm the `createCallbacks()` inference change is the cleanest fix. An
  alternative is annotating the return type with the Mock-preserving shape (e.g.
  `HibernationCallbacks & { onHibernate: Mock; ... } & { ...Calls }`), but dropping the annotation is
  simpler and the structural assignability at call sites is already validated by the green typecheck.
- **Scope note:** cadre-host typecheck covers all of `src` (not just tests), so the `tsconfig.build.json`
  → `tsconfig.typecheck.json` swap now type-checks server source against the base `tsconfig.json` too;
  monorepo typecheck stayed green, so no source regressions, but worth a sanity glance.
- The `.at(-1)` → index swap is behavior-identical; the `privateKey` change in types.spec is a real key
  now, asserted by reference (`toBe`) — verify that's the intended assertion semantics.
