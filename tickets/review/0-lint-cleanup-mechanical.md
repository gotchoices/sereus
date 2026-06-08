description: review the mechanical ESLint warn→error burndown — verify the 37 fixed sites are correct, the rule promotions are complete, and the cadre-core/cadre-host `lib` bump (needed for Error `cause`) is sound
prereq:
files: eslint.config.mjs, packages/cadre-core/tsconfig.json, packages/cadre-host/tsconfig.json, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/service-host/launchd.ts, packages/cadre-host/src/installer/service-host/systemd.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/server/static.ts, packages/cadre-host/src/nat/__tests__/port-mapper.test.ts, packages/cadre-host/src/server/__tests__/status-route.test.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-provider/src/service/billing-service.ts, packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/scenarios/basic-connectivity.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts, packages/reference-app-ns/nativescript.config.ts
----

# Review: lint cleanup part 1 — mechanical rules → error

Implements `tickets/implement/0-lint-cleanup-mechanical.md`. Cleared the 7 small/mechanical ESLint
rule families (37 warning sites) and promoted each from `warn` → `error` in `eslint.config.mjs`.
`no-explicit-any` (68 warnings) and the svelte rules (6 warnings) are intentionally left at `warn` —
they belong to the downstream `lint-cleanup-no-explicit-any` and `lint-cleanup-svelte` tickets.

## What changed

**Rules promoted to `error`** (eslint.config.mjs): `@typescript-eslint/no-unused-vars` (both the TS
block ~L89 and the JS/CJS block ~L167), `@typescript-eslint/consistent-type-imports` (~L102),
`no-empty` (~L107), and in the eslint-10 recommended block (~L181) `preserve-caught-error`,
`no-useless-assignment`, `no-control-regex`, `prefer-const`. Header/inline comments (L1-9, L12-18,
L88, L101-102, L171-189) refreshed so they no longer call these a `warn` backlog.

**37 sites fixed**, by rule:
- `no-unused-vars` (21): deleted dead imports/locals across cadre-core (src+test), cadre-host
  (src+tests), cadre-provider, integration-tests. Two genuinely-unused mock args in
  strand-solicitation.spec.ts were **deleted** (not `_`-prefixed) since trailing params are optional
  on the typed callback. `static.ts` lost both the dead `const log` and its now-orphaned
  `import debug from 'debug'`.
- `preserve-caught-error` (6): attached `{ cause: <err> }` as the 2nd `Error` arg in
  control-database.ts, installer/config.ts, service-host/{launchd,systemd}.ts,
  host-process-orchestrator.ts, and cadre-host-authority-node.integration.ts. control-database.ts
  keeps its inlined `error.message` in the string *and* now forwards `{ cause }`.
- `no-empty` (4): the two `afterEach` best-effort teardown blocks in strand-solicitation.spec.ts →
  `catch { /* best-effort teardown */ }` (no test logger in scope).
- `no-useless-assignment` (3): trust-circle.ts `controlMembers`, host-process-orchestrator.ts `size`,
  state.svelte.ts `payload` — each had a dead initializer overwritten before any read; removed the
  initializer and rely on definite-assignment (try assigns / catch returns-or-throws).
- `prefer-const` (1): hibernation-manager.spec.ts:380 was a genuine single-assignment — converted
  `let manager!` → inline `const manager = new HibernationManager(...)` and removed the forward decl.
- `no-control-regex` (1): apply.ts npm spawn-arg guard `/[\x00\r\n]/` — added scoped
  `// eslint-disable-next-line no-control-regex` + rationale (the NUL/CR/LF rejection is the point).
- `consistent-type-imports` (1): nativescript.config.ts → `import type`.

## ⚠️ Non-mechanical decision the reviewer MUST scrutinize: the `lib` bump

`preserve-caught-error`'s fix forwards the original error via `new Error(msg, { cause })`. That 2-arg
overload is **ES2022**, but `packages/cadre-core` and `packages/cadre-host` compile with
`target: "ES2020"` and no explicit `lib` — so attaching `{ cause }` first produced **TS2554
"Expected 0-1 arguments, but got 2"** in both packages' typecheck.

Resolution chosen: add `"lib": ["ES2022", "DOM", "DOM.Iterable"]` to each package's `tsconfig.json`
while **keeping `target: "ES2020"`**. Rationale:
- Emit is unchanged (target still ES2020 → identical downleveling). cadre-core is a **published**
  RN/node library, so leaving emit byte-for-byte identical avoids any consumer/runtime change.
- The new `lib` set is a **superset** of the ES2020-target default (`DOM`, `DOM.Iterable`, `ES2020`,
  `ScriptHost`), only swapping `ES2020`→`ES2022` and dropping the unused `ScriptHost`, so it cannot
  remove any previously-available type.
- The repo already mixes targets — `integration-tests`, `reference-app-web`, and `cadre-host/ui`
  are ES2022 already (that's why the cause-attach in those trees typechecked without this change).
- Runtimes are fine: cadre-host requires Node ≥18 (full ES2022); modern RN Hermes supports
  `Error.cause`; and even where unsupported, `{ cause }` degrades to an ignored property (no crash).

**Reviewer judgment calls:** (a) Is decoupling `lib` (ES2022) from `target` (ES2020) preferred over
just bumping `target` to ES2022 to match the other packages? Bumping target would also work and be
more uniform, but changes emit for the published cadre-core. (b) The other ES2020 packages
(`quereus-plugin-sereus`, `cadre-provider`, `cadre-cli`) were **not** bumped — they have no current
`preserve-caught-error` violations, but since the rule is now a global `error`, the *next* cause-
forward in those packages will hit the same TS2554 until their `lib` is bumped too. Decide whether
to pre-emptively bump them or leave as-is (current choice: leave; no violations today).

## Validation performed (this is a floor, not a ceiling)

- `yarn lint` → **0 errors, 74 warnings** (was 111 warnings/0 errors). All 74 remaining are the
  deferred rules: `no-explicit-any` (68) + `svelte/prefer-svelte-reactivity` (5) +
  `svelte/no-at-html-tags` (1). 0 errors proves every promoted rule has zero live violations.
- `yarn workspace @serfab/cadre-core typecheck` → clean (exit 0).
- `yarn workspace @serfab/cadre-host typecheck` → clean (exit 0).
- `yarn workspace @serfab/cadre-provider typecheck` → clean.
- `yarn workspace @serfab/integration-tests typecheck` → clean.
- `yarn workspace @serfab/reference-app-ns typecheck` → clean.
- `yarn workspace @serfab/cadre-core test` → **344 passed / 28 files**.
- `yarn workspace @serfab/cadre-host test` → **359 passed, 3 skipped / 46 files** (pre-existing
  Node DEP0190 shell-spawn deprecation notice prints, unrelated to this diff).

## Known gaps / things to check harder

- **cadre-host/ui (`state.svelte.ts`) is not covered by `cadre-host typecheck`** — that script's
  tsconfig includes `src` only; the UI compiles via `vite build` (esbuild, no type-check) and has its
  own ES2022 tsconfig. The `payload` definite-assignment edit + the `catch (err)`→`catch` binding
  removal were verified indirectly: lint parsed the file clean, the cadre-host vitest run imports the
  module, and the identical definite-assignment pattern typechecks in the ES2020 src cases. A
  `svelte-check`/`vite build` of the UI would close this fully — not run here.
- **integration-tests were typechecked but NOT executed** — the `.integration.ts` scenarios need
  Docker + real network and aren't agent-runnable. The edits there are unused-import removals plus one
  `{ cause }` (ES2022, already this package's target), all covered by typecheck.
- **reference-app-ns** got a `typecheck` only; no full NativeScript build was run (the change is a
  trivial `import`→`import type`).
- **hibernation-manager.spec.ts const conversion**: the `onCheckIn` mock closure references `manager`
  *before* the `const manager = …` line, relying on the closure not executing until after timers
  advance (post-construction). Tests pass, but confirm you're comfortable with the
  reference-before-declaration-in-closure pattern vs. keeping a forward `let` + scoped disable.
- **`prefer-const` now `error`**: a future `let x!; beforeEach(() => x = …)` test-lifecycle var would
  be a false positive needing a scoped disable. None exist today; comment in the config notes this.

## Downstream (not part of this ticket)

`no-explicit-any` and the svelte reactivity rules remain `warn` for `lint-cleanup-no-explicit-any`
and `lint-cleanup-svelte`. No `prereq` chaining needed — those tickets are independent of this one.
