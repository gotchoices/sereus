----
description: wire svelte-check into a build-health gate and fix the latent error it already surfaces in cadre-host/ui events.ts:67
files: packages/cadre-host/ui/src/lib/events.ts, packages/cadre-host/ui/tsconfig.json, packages/cadre-host/ui/package.json, packages/cadre-host/package.json, packages/reference-app-web/package.json, package.json
difficulty: easy
----

# Add a `svelte-check` gate (and fix the latent error it catches)

Carried forward from the lint-warning-cleanup fix ticket as a separate concern. ESLint's svelte pass lints
style/correctness rules but does **not** run `svelte-check` (svelte's own type/template diagnostics), so a
class of errors goes uncaught by any current script.

## Known latent error

`packages/cadre-host/ui/src/lib/events.ts:67` reports **"'ctor' is possibly 'undefined'"** under
`svelte-check`. No current gate catches it. This should be fixed as part of standing up the gate (and
serves as the proof the gate works).

In `subscribeEvents()`, `ctor` is a `const` narrowed to non-`undefined` by an early-return guard
(`if (!ctor) return …`), but `svelte-check`'s TS does not preserve that narrowing into the nested
`open()` closure where `new ctor(url)` runs. At runtime `ctor` is always defined there, so this is a
type-checker limitation, not a runtime bug. Fix direction (not prescriptive): hoist the constructor
into the closure as a captured non-nullable local, assert it once after the guard, or restructure so
the narrowing is visible at the `new ctor(url)` site — avoid a bare non-null assertion if a cleaner
narrowing is available.

The reason this slips through today: the cadre-host UI is **not type-checked in CI**. The workspace
`typecheck` uses `tsconfig.typecheck.json` (covers `src` only) and the UI builds via `vite build`
(esbuild, no type-check), so `svelte-check` errors in `ui/` accumulate silently — which is exactly
what the gate below closes. (Folded in from the former `cadre-host-ui-svelte-check-ctor-undefined`
ticket during triage.)

## Scope

- Add a `svelte-check` invocation for each svelte UI package (`cadre-host/ui`, `reference-app-web`) — a
  per-package `check` script and a root aggregate, parallel to how `yarn lint` / `yarn typecheck` are
  wired in the root `package.json`.
- Decide whether it runs as part of `yarn typecheck` or as its own `yarn check:svelte` gate.
- Fix `events.ts:67` (and any other errors the first clean run surfaces — report them; a large backlog may
  warrant its own burndown ticket, mirroring the ESLint approach).

This is a build-health enhancement, not a blocker. Promoted from backlog into the active pipeline
during a triage pass — the `events.ts:67` fix and the host-UI type-check blind spot were the deciding
factors.
