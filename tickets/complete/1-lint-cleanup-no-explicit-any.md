----
description: COMPLETE — burned down all 68 @typescript-eslint/no-explicit-any sites; rule promoted warn → error. Reviewed, validated, one inline DRY fix applied.
files: eslint.config.mjs, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/test/browser-shape.spec.ts
----

# Complete: kill `no-explicit-any` → error

All 68 `@typescript-eslint/no-explicit-any` sites cleared; the rule is enforced as `error` in
`eslint.config.mjs`. `yarn lint` exits 0 (only the 6 svelte reactivity warnings remain, owned by the
downstream `lint-cleanup-svelte` ticket). The implementation is sound; review applied one inline DRY
fix and re-validated the full toolchain.

## Review findings

### What was checked

- **Read the full implement diff (4bb951c) first, fresh, before the handoff.** All 12 source/test
  files plus `eslint.config.mjs`.
- **Boundary type claims verified against the real Quereus source** (`../quereus`): confirmed
  `VTablePluginInfo` / `FunctionPluginInfo` / `CollationPluginInfo` exist
  (`src/vtab/manifest.ts:26-49`) and that the new cast-free registration loops mirror Quereus's own
  `registerPlugin` helper exactly (`src/util/plugin-helper.ts:83-99` — same
  `registerModule(v.name, v.module, v.auxData)` / `registerFunction(f.schema)` /
  `registerCollation(c.name, c.func, c.normalizer)` shapes). The tightened interfaces are correct, not
  guesses.
- **The three `as unknown as <PluginResult>` construction casts** (`compose-strand.ts:188`,
  `control-database.ts:179`, `connect-browser.ts:35`): justified — the plugins' inferred return types
  carry extra members (`collectionFactory`, `hydrateSchemas`) and variant `VirtualTableModule<TTable>`
  generics that don't structurally match the registration-only interfaces, so an `unknown` bridge is
  required. Runtime shapes are exercised by `plugin.spec.ts` (registers crypto digest, StampId,
  optimystic vtables, default-vtab schema) — all green.
- **`deepMerge` `DeepPartial<T>` rewrite** (`loader.ts`): array leaves are replaced wholesale by the
  type (`extends ReadonlyArray ? T[K]`) *and* at runtime (the `!Array.isArray` guard routes arrays to
  the scalar-overwrite branch) — consistent. Iteration is still over `source` keys, `undefined` still
  skipped. Merge semantics unchanged; the 3 call sites drop their `as any` and pass cleanly.
- **Fastify `declare module 'fastify'` augmentation** (`routes.ts`): grepped every `.customer`
  read/write in `cadre-provider/src`. The only two assignments (`auth.ts:60`, `auth.ts:138`) both
  write a `CustomerIdentity`-shaped value; no conflicting shape, no collision. Global-to-compilation
  scope is acceptable for a domain-specific optional field.
- **Event-map `Set<EventHandler<never>>`** (`cadre-node.ts`): correct typed-emitter idiom — handler
  contravariance makes `on`/`off` add/remove cast-free and `emit` does the single documented
  re-narrowing cast.
- **Test-internals helpers** (`serviceInternals`/`cadreNodeInternals`, `BrowserPluginModule`,
  `IndexedDBLike`, `Libp2p`/`IRepo` mock casts): the `unknown`-typed injected fields are deliberate
  (partial mocks); the helpers remove `any` and give `queryPeers()`/the timer real types. Sound.
- **Residual-`any` sweep** across all non-ignored `packages/**/*.ts`: zero real occurrences — the only
  hits are the word "any" in comments (`reference-app-web`) and the ignored deprecated `strand-proto`
  package. No `eslint-disable .* no-explicit-any` anywhere.

### Findings & disposition

- **MINOR (fixed inline): in-package duplication of `Libp2pNodeWithRepo`.** The implement step added a
  2nd identical copy of the interface inside `cadre-core` (`cadre-node.ts` alongside the pre-existing
  `strand-instance-manager.ts` copy) — the handoff flagged this as out-of-scope. Consolidated both into
  a single exported `Libp2pNodeWithRepo` in `cadre-core/src/types.ts`; both consumers now import it,
  and their now-unused `IRepo` / `Libp2p` imports were removed. Purely additive to the package's public
  types (non-breaking). Re-validated: `cadre-core` typecheck + targeted eslint + 344 tests all green,
  and all downstream consumers still typecheck.
- **NOT FIXED (intentional): cross-package copies remain.** `quereus-plugin-sereus/src/types.ts` and
  `integration-tests/src/harness` each keep their own `Libp2pNodeWithRepo`. Hoisting across package
  boundaries would force a shared dependency for a 2-line structural interface — not worth it. Left
  as-is.
- **NO bugs, no type-safety regressions, no security findings.** The change is type-level only; no
  runtime behavior changed (confirmed by unchanged-passing test suites). Empty categories: **no major
  findings** (nothing warranted a new fix/plan ticket) and **no pre-existing failures** (every suite
  and typecheck was already green at HEAD on the touched subsystems).

### Validation run during review (all green)

- `yarn lint` → **0 errors**, 6 svelte warnings (exit 0); confirmed **0** `no-explicit-any`.
- Typecheck: `cadre-core`, `cadre-provider`, `quereus-plugin-sereus`, **and** downstream
  `cadre-cli`, `cadre-host`, `integration-tests` — all exit 0 (re-run after the inline fix).
- Tests: `cadre-core` **344 passed**; `quereus-plugin-sereus` **60 passed + 1 todo**;
  `cadre-provider` **80 passed**.
- No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.

## Net result

`@typescript-eslint/no-explicit-any` is now an enforced `error` gate with a clean tree. The only `warn`
rules left in `eslint.config.mjs` are the two svelte reactivity rules, tracked by `lint-cleanup-svelte`.
