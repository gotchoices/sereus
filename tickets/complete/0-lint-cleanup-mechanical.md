description: lint cleanup part 1 — burned down 7 mechanical ESLint rule families (37 warning sites) and promoted each warn→error; bumped cadre-core/cadre-host `lib` to ES2022 for Error `cause`
prereq:
files: eslint.config.mjs, packages/cadre-core/tsconfig.json, packages/cadre-host/tsconfig.json, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/update/apply.ts, packages/cadre-host/src/server/static.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, docs/STATUS.md
----

# Lint cleanup part 1 — mechanical rules → error (COMPLETE)

Implemented `tickets/implement/0-lint-cleanup-mechanical.md` and reviewed here. Cleared 7 mechanical
ESLint rule families (37 warning sites) and promoted each `warn`→`error` in `eslint.config.mjs`:
`no-unused-vars`, `consistent-type-imports`, `no-empty`, `preserve-caught-error`,
`no-useless-assignment`, `no-control-regex`, `prefer-const`. `no-explicit-any` (68) and the two svelte
rules (6) remain `warn`, deferred to `lint-cleanup-no-explicit-any` and `lint-cleanup-svelte`.

The one non-mechanical decision — adding `"lib": ["ES2022", "DOM", "DOM.Iterable"]` to cadre-core and
cadre-host tsconfigs (keeping `target: "ES2020"`) so the type-checker accepts `new Error(msg, { cause })`
— was scrutinized and accepted (see findings).

## Review findings

**Process:** Read the implement diff (commit `e14ad5e`) with fresh eyes before the handoff, then ran the
full gate plus extra coverage the implementer flagged as untested.

### Correctness of the 37 fixes — PASS
- **`no-useless-assignment` (3 sites, the riskiest — removed initializers rely on definite assignment):**
  read all three. `trust-circle.ts` `controlMembers` (both try and catch assign; catch re-throws on
  unexpected errors), `host-process-orchestrator.ts` `size` (catch returns early), and
  `state.svelte.ts` `payload` (catch returns early) — every read is preceded by a definite assignment
  on all reachable paths. Correct.
- **`preserve-caught-error` (6 sites):** each forwards the original error via `{ cause }`. control-database.ts
  keeping `error.message` inline *and* adding `{ cause }` is intentional (readable message + error chain).
- **`consistent-type-imports`:** `nativescript.config.ts` uses `NativeScriptConfig` only in `as`-position —
  `import type` is correct.
- **`no-control-regex`:** the `update/apply.ts` NUL/CR/LF spawn-arg guard is the point of the rule; scoped
  `eslint-disable` + rationale is the right disposition.
- **`prefer-const` (hibernation-manager.spec.ts):** the closure references `manager` before its `const`
  declaration, but only executes after construction (post-timer-advance); no TDZ hazard. Tests pass.
- **Deleted imports/locals (21):** typecheck across all five workspaces is clean, so no removed binding was
  in use.

### Validation — PASS
- `yarn lint` → **0 errors, 74 warnings** (68 `no-explicit-any` + 6 svelte). 0 errors confirms every
  promoted rule has zero live violations across the repo.
- `yarn workspace @serfab/cadre-core typecheck` → clean. `… cadre-host typecheck` → clean.
- `yarn workspace @serfab/cadre-core test` → **344 passed / 28 files**.
- `yarn workspace @serfab/cadre-host test` → **359 passed, 3 skipped / 46 files** (pre-existing DEP0190
  shell-spawn notice prints; unrelated to this diff).

### `lib`-bump decision — ACCEPTED
Decoupling `lib` (ES2022) from `target` (ES2020) is the right call over bumping `target`: cadre-core is a
published library, so keeping emit byte-for-byte identical avoids any consumer/runtime change, and the new
`lib` is a strict superset of the ES2020-target default (only ES2020→ES2022, drops unused ScriptHost). I
verified cadre-provider, cadre-cli, and quereus-plugin-sereus are all still `target: ES2020` with no `lib`
bump — the handoff is accurate that the *next* `preserve-caught-error` cause-forward in those packages will
hit TS2554 until their `lib` is bumped. Leaving them as-is is acceptable: there are no violations today, the
gate is green, and the failure (if it ever occurs) is a clear compile error pointing at the exact site. Not
worth a pre-emptive ticket.

### Docs — FIXED INLINE (minor)
`docs/STATUS.md` → "Lint coverage" was **stale**: it still listed all 7 promoted rules under "Rules at
`warn`". The implement diff did not touch it. Updated the section to move the burned-down families to the
`error` list, note the `lib`-bump rationale, and reduce the `warn` set to `no-explicit-any` + the two svelte
rules with their tracking tickets.

### Extra coverage the implementer flagged — RESOLVED + one new ticket (major, out of scope)
- **cadre-host/ui (`state.svelte.ts`) not in CI typecheck:** ran `npx svelte-check --tsconfig ui/tsconfig.json`.
  `state.svelte.ts` (the only UI file this diff touched) is **clean** — the `payload` definite-assignment
  edit and `catch (err)`→`catch` change typecheck fine under the UI's ES2022/strict config. Gap closed.
- **Pre-existing UI type error discovered:** the same `svelte-check` run reports
  `'ctor' is possibly 'undefined'` in `ui/src/lib/events.ts:67` — a file this diff never touched, so it is
  pre-existing and out of scope. The cadre-host UI is not type-checked in CI (typecheck covers `src` only;
  UI builds via esbuild), so it went unnoticed. Filed `tickets/backlog/cadre-host-ui-svelte-check-ctor-undefined.md`
  (fix the narrowing + decide whether to wire `svelte-check` into the gate).
- **integration-tests, reference-app-ns:** typecheck-only (Docker/NativeScript builds not agent-runnable);
  edits are unused-import removals + one ES2022 `{ cause }` already in-target. Acceptable.

### Not done (deferred by design)
- Full integration-test execution (needs Docker + real network) and a NativeScript build — out of agent scope.

## Downstream
`no-explicit-any` → `lint-cleanup-no-explicit-any`; svelte rules → `lint-cleanup-svelte` (independent, no
prereq chaining). New backlog ticket: `cadre-host-ui-svelte-check-ctor-undefined`.
