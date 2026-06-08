----
description: burn down the small/mechanical ESLint warning rules and promote each from `warn` to `error` (everything except no-explicit-any and the svelte rules)
prereq:
files: eslint.config.mjs, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/reference-app-ns/nativescript.config.ts
----

# Lint cleanup, part 1: mechanical rules → error

First of three burndown tickets carved from the `build-health-lint-warning-cleanup` fix ticket. This one
clears the small, mostly-mechanical rule families and flips each from `warn` to `error` in
`eslint.config.mjs`. The big `no-explicit-any` burndown (lint-cleanup-no-explicit-any) and the svelte
reactivity rules (lint-cleanup-svelte) are separate downstream tickets so each PR stays reviewable.

**Tooling decision (resolved):** stay on ESLint. The ticket floated "maybe use biome?" — biome does not
support `.svelte`/`.svelte.ts` and has no type-aware rules, but this config relies on type-aware
`@typescript-eslint/no-floating-promises` and the `eslint-plugin-svelte` pass. Biome cannot replace it, so
no migration.

## Current state (measured via `yarn lint` at fix-stage handoff — 2026-06-08)

`yarn lint` exits 0 with **111 warnings, 0 errors**. The handoff estimate was stale (it predicted
`prefer-const ~23`; the real count is 1 — other tickets fixed the rest). Always re-run `yarn lint` to get
live line numbers; the line:col values below drift as you edit.

Rules in scope for THIS ticket (counts as measured):

| rule | count | sites |
|---|---|---|
| `@typescript-eslint/no-unused-vars` | 21 | spread across cadre-core (test+src), cadre-host (src+tests), integration-tests, cadre-provider |
| `preserve-caught-error` | 6 | cadre-host installer/orchestrator, cadre-core/src/control-database.ts, integration-tests |
| `no-empty` | 4 | packages/cadre-core/test/strand-solicitation.spec.ts (empty `catch {}` in `afterEach`) |
| `no-useless-assignment` | 3 | cadre-host: state.svelte.ts, host-process-orchestrator.ts, trust-circle.ts |
| `prefer-const` | 1 | packages/cadre-core/test/hibernation-manager.spec.ts:380 |
| `no-control-regex` | 1 | packages/cadre-host/src/update/apply.ts:173 |
| `@typescript-eslint/consistent-type-imports` | 1 | packages/reference-app-ns/nativescript.config.ts (auto-fixable) |

## Per-rule guidance

**`consistent-type-imports`** (1) — auto-fixable. Run `yarn lint:fix`; it converts the type-only import in
`nativescript.config.ts`. Verify the diff, nothing else should change.

**`no-unused-vars`** (21) — config already honors the `_`-prefix and `caughtErrors`/`ignoreRestSiblings`
conventions, so these are genuinely unused. Delete dead imports/locals. If an argument must stay for
signature/positional reasons, prefix it with `_`. Do NOT prefix-and-keep something that can simply be
deleted.

**`preserve-caught-error`** (6) — sites rethrow inside a `catch (error)` as `throw new Error(...)` without
forwarding the cause. Add `{ cause: error }` (e.g. `throw new Error('Failed to load schema from …', {
cause: error })`). `control-database.ts` already inlines `${error instanceof Error ? error.message : …}`
into the message string — keep the message but also attach `{ cause: error }` so the stack survives.

**`no-empty`** (4) — `packages/cadre-core/test/strand-solicitation.spec.ts` has best-effort teardown
`try { await nodeA?.stop(); } catch {}` in two `afterEach` blocks. `no-empty` treats a catch containing a
*comment* as non-empty, so the minimal correct fix is `catch { /* best-effort teardown */ }`. AGENTS.md
prefers logging over silent swallowing — if there's a test logger in scope, prefer a `void`-logged debug
line; otherwise the explanatory comment is acceptable for teardown.

**`no-useless-assignment`** (3) — a value is assigned then never read before the next write. Inspect each:
usually the assignment is dead and should be removed, but confirm it isn't a not-yet-wired side effect
before deleting.

**`prefer-const`** (1) — `hibernation-manager.spec.ts:380` is `let manager!: HibernationManager;`. Check
where `manager` is assigned: if it's assigned inside a lifecycle hook (`beforeEach`) the definite-assignment
`let` is correct and `const` is impossible — this is the documented test-lifecycle false positive; keep
`let` and add `// eslint-disable-next-line prefer-const` with a one-line rationale. If `manager` is in fact
assigned once inline, convert to `const`.

**`no-control-regex`** (1) — `apply.ts:173` `/[\x00\r\n]/` is a deliberate guard rejecting control chars in
npm spawn args (a security check). The `\x00` is intentional. Add
`// eslint-disable-next-line no-control-regex` with a rationale comment rather than reworking the regex.

## Promote rules to error

After the sites above are clean, in `eslint.config.mjs`:
- Move `no-unused-vars` (both the TS block ~line 85 and the JS/CJS block ~line 163) and the JS one from
  `warn` → `error`. (Keep the option objects unchanged.)
- Move `consistent-type-imports` (~line 98) `warn` → `error`.
- Move `no-empty` (~line 103) `warn` → `error`.
- In the "eslint-10 recommended additions" block (~line 175): move `preserve-caught-error`,
  `no-useless-assignment`, `no-control-regex`, `prefer-const` from `warn` → `error`.
- Update the surrounding comments (lines 6-9, 82-103, 171-183) so they no longer describe these as
  backlog/`warn`. Leave `no-explicit-any` and the svelte rules at `warn` — they belong to the downstream
  tickets.

## TODO

- [ ] `yarn lint:fix` to clear the `consistent-type-imports` site; review the diff.
- [ ] Fix the 21 `no-unused-vars` sites (delete or `_`-prefix).
- [ ] Fix the 6 `preserve-caught-error` sites (attach `{ cause }`).
- [ ] Fix the 4 `no-empty` sites in strand-solicitation.spec.ts.
- [ ] Fix the 3 `no-useless-assignment` sites.
- [ ] Resolve the 1 `prefer-const` site (const vs scoped-disable per guidance).
- [ ] Add the scoped disable + rationale for the 1 `no-control-regex` site.
- [ ] Promote the in-scope rules `warn` → `error` in `eslint.config.mjs` and refresh the comments.
- [ ] Confirm `yarn lint` still exits 0 (remaining `no-explicit-any` + svelte warnings are expected — they
      land in the downstream tickets). Run the affected packages' tests
      (`yarn workspaces foreach -A run test` is broad; at minimum run cadre-core and cadre-host tests since
      this ticket edits their test files) and report results in the review handoff.
