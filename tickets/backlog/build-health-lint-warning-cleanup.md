----
description: burn down the ESLint warning backlog surfaced by the new `yarn lint` gate and promote the corresponding rules from `warn` to `error`
prereq: build-health-eslint
files: eslint.config.mjs, packages/*/src/**, packages/*/test/**, packages/reference-app-web/src/**, packages/cadre-host/ui/src/**
----

# Burn down the ESLint warning backlog and tighten the gate

`build-health-eslint` stood up a working `yarn lint` gate (`eslint.config.mjs`) that exits 0 on a clean
checkout. To keep the gate green without hand-fixing hundreds of pre-existing sites in that ticket, several
AGENTS.md-derived rules (and some eslint-10 recommended additions) were left at `warn`. As of that ticket
the gate reports **0 errors, ~118 warnings**.

This ticket is the cleanup pass: fix the warnings and promote each rule from `warn` to `error` so the
style guarantees are actually enforced going forward.

## Warning backlog (counts approximate, from `yarn lint` at handoff)

AGENTS.md rules currently at `warn`:
- `@typescript-eslint/no-explicit-any` (~67) — "Don't be type lazy — avoid `any`". The bulk of the
  backlog. Many are in test files and at libp2p/Quereus boundary shims; some need real types, some can be
  narrowed to `unknown` + guards.
- `@typescript-eslint/no-unused-vars` (~30) — already honors the `_`-prefix convention; remaining are
  genuinely-unused imports/vars to delete or prefix.
- `@typescript-eslint/consistent-type-imports` — auto-fixable (`yarn lint:fix`); the implement ticket
  already applied the safe fixes, residual cases may need manual attention.
- `no-empty` (empty `catch`, ~4) — "don't eat exceptions"; add logging or a comment per site.

eslint-10 recommended additions (not AGENTS.md rules, but worth keeping) currently at `warn`:
- `prefer-const` (~23) — note the test-lifecycle false positives (`let x; beforeEach(() => x = …)`);
  those should stay `let` and may warrant a scoped `// eslint-disable` rather than a rule downgrade.
- `preserve-caught-error` (~6) — attach `{ cause }` when rethrowing.
- `no-useless-assignment` (~3), `no-control-regex` (~1).
- `svelte/no-at-html-tags` (1), `svelte/prefer-svelte-reactivity` (~5) — the latter wants
  `SvelteSet`/`SvelteDate` in `.svelte.ts` rune modules for correct reactivity; verify each is a real
  reactivity bug before converting.

## Out of scope / not enforceable

Do **not** try to machine-enforce these (documented in `eslint.config.mjs` and `docs/STATUS.md`):
- lowercase SQL reserved words (SQL lives in template literals — no clean ESLint rule),
- "no runtime inline `import()`",
- tab indentation (left to `.editorconfig`).

## Expected outcome

`yarn lint` exits 0 with **0 warnings**, and the rules above are promoted to `error` in
`eslint.config.mjs` (except any rule a maintainer decides should stay advisory, documented inline).
Consider also wiring `svelte-check` into a gate as a separate concern — there is a pre-existing latent
`svelte-check` error in `packages/cadre-host/ui/src/lib/events.ts:67` ("'ctor' is possibly 'undefined'")
that no current script catches.
