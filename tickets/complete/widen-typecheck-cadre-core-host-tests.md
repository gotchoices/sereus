description: Fixed 18 latent type errors in cadre-core (10) and cadre-host (8) test files and widened each package's `typecheck` to cover test files via a per-package `tsconfig.typecheck.json`. Reviewed and accepted.
files: packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/types.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/tsconfig.typecheck.json, packages/cadre-core/package.json, packages/cadre-host/src/nat/__tests__/nat-service.test.ts, packages/cadre-host/src/server/__tests__/error-handler.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/server/__tests__/publishers.test.ts, packages/cadre-host/src/server/__tests__/status-route.test.ts, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-host/package.json
----

## Summary

cadre-core and cadre-host were left at shippable-source typecheck scope by
`build-health-typecheck-all-packages`; their test files carried latent type drift invisible to vitest
(esbuild transpiles without type-checking) and to `tsconfig.build.json` (excludes tests). The implement
stage fixed 18 type errors and widened each package's `typecheck` to a new `tsconfig.typecheck.json`
that includes tests. A triage pass (commit da57e87) separately resolved two unrelated smoke-test
timeouts by raising `testTimeout` to 30000ms on the three CLI smoke suites.

## Review findings

### What was checked
- **Implement diff (089fdd0) + triage diff (da57e87) read first, fresh eyes**, before the handoff summary.
- **Type-fix correctness vs. real source types** — every claim verified against `packages/cadre-core/src/types.ts`:
  - `StorageConfig` has `provider` (a factory/instance), no `type` field → `{ provider: () => new MemoryRawStorage() }` is correct (types.ts:99).
  - `CadreNodeConfig.privateKey?: PrivateKey` (libp2p key, types.ts:202), **not** `Uint8Array` — the `new Uint8Array([1,2,3])` literal was genuinely wrong; the `Uint8Array` at types.ts:355 is the unrelated `CreatePeerResult.privateKey`. The `generateKeyPair('Ed25519')` + `toBe(privateKey)` fix is correct (reference-identity assertion is appropriate here).
  - `NodePorts.admin: number` is required (orchestrator/types.ts:34, allocated at host-process-orchestrator.ts:220/270) → adding `admin` to the four fixtures is required, not cosmetic.
  - Base `target: ES2020` confirmed → `Array.prototype.at` (ES2022) genuinely unavailable, so the `.at(-1)` → `[len-1]` swap is the correct fix (behavior-identical) without polluting `lib`.
  - `createLibp2p({ privateKey })` matches production usage; the dropped `@libp2p/peer-id-factory` round-trip is dead in newer libp2p.
- **`createCallbacks()` inference fix** — confirmed the dropped return-type annotation is the cleaner option: the inferred type flows into 20+ `new HibernationManager(...)` call sites that all typecheck (structural assignability proven), and `vi.fn()` Mock methods survive. `HibernationCallbacks` import is still live (separately-annotated object at line 387), so no dead import.
- **tsconfig widening is real, not a no-op** — cadre-core tests live in `test/` (outside `src`), so `rootDir: "."` + `include: ["src","test"]` genuinely extends coverage; cadre-host tests are under `src/**/__tests__`, so dropping `tsconfig.build.json`'s `exclude` of tests genuinely covers them. Both verified to compile test files.
- **Convention consistency / DRY** — the `tsconfig.typecheck.json` pattern is the established monorepo convention (cadre-cli, integration-tests, quereus-plugin-sereus). cadre-core's new file matches cadre-cli's byte-for-byte in shape; cadre-host's matches the simpler under-`src` form. Conforming, not divergent.
- **Lint, typecheck, tests — all re-run green:**
  - `yarn lint` → **0 errors**, 123 pre-existing backlog warnings. The warnings landing in three touched files (hibernation-manager.spec.ts:380, strand-solicitation.spec.ts:16-17/209-216, status-route.test.ts:2) all sit on lines the diff never modified — pre-existing, not introduced.
  - `tsc -p tsconfig.typecheck.json --noEmit` → clean (exit 0) for **both** cadre-core and cadre-host.
  - `yarn workspace @serfab/cadre-core test` → **292/292 pass** (21 files).
  - `yarn workspace @serfab/cadre-host test` → **359 pass, 3 skipped, 0 failed** (46 files). The two smoke-test timeouts the implementer flagged are resolved by the triage commit's `vi.setConfig({ testTimeout: 30000 })`.

### What was found
- **No correctness, type-safety, DRY, or scalability defects.** All 18 fixes are minimal, idiomatic, and align with production code and the real source types. The widening follows the established pattern.
- **No major findings → no new tickets filed.**
- **Minor:** the three touched test files carry pre-existing backlog lint warnings (unused imports, `prefer-const`, empty blocks) on lines unrelated to this diff. Not introduced here and out of scope for a typecheck-widening ticket; left untouched (lint is `warn`-only, 0 errors). Noted for any future test-hygiene sweep.

### What was done
- Validation re-run (lint + both typechecks + both test suites) — all green. No code changes required in this review pass.
- Confirmed the prior triage commit fully addressed the smoke-test timeouts; `tickets/.pre-existing-error.md` was already consumed and removed by that pass.

### Scope notes carried from implement (verified, no action needed)
- cadre-host `tsconfig.typecheck.json` includes all of `src` (server source + tests), so source is now type-checked against base `tsconfig.json` as well as tests — monorepo `yarn typecheck` stayed green, confirming no source regressions. It deliberately excludes `ui/` (Svelte, needs `svelte-check`, tracked separately).
- cadre-provider and strand-proto still typecheck via `tsconfig.build.json` (strand-proto is deprecated; cadre-provider out of scope) — not a regression introduced here.
