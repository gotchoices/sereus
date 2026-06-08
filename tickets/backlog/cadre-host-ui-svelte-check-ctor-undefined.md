description: cadre-host UI `svelte-check` reports a type error (`'ctor' is possibly 'undefined'`) in ui/src/lib/events.ts; the UI is not type-checked in CI so this latent error goes unnoticed
prereq:
files: packages/cadre-host/ui/src/lib/events.ts, packages/cadre-host/ui/tsconfig.json, packages/cadre-host/package.json
----

# cadre-host UI: svelte-check type error in events.ts

## Problem

`npx svelte-check --tsconfig ui/tsconfig.json` (run from `packages/cadre-host`) reports:

```
ERROR "ui/src/lib/events.ts" 67:16 "'ctor' is possibly 'undefined'."
```

This is **pre-existing** — it was not introduced by `lint-cleanup-mechanical` (that diff touched
only `ui/src/lib/state.svelte.ts`, which `svelte-check` reports clean). It surfaced because the
review pass ran `svelte-check` to verify the UI edits, which the normal pipeline does not do.

In `subscribeEvents()` (events.ts), `ctor` is a `const` narrowed to non-`undefined` by an early-return
guard:

```ts
const ctor = opts.eventSourceCtor ?? (typeof EventSource !== 'undefined' ? EventSource : undefined);
if (!ctor) {
  return { close() { /* noop */ } };
}
// ...
function open(): void {
  source = new ctor(url);   // <-- svelte-check: 'ctor' is possibly 'undefined'
```

The guard narrows `ctor` in the outer scope, but `svelte-check`'s TS does not preserve that narrowing
into the nested `open()` closure. At runtime `ctor` is always defined here (the early return guarantees
it), so this is a type-checker limitation, not a runtime bug.

## Why it matters

The cadre-host UI is **not type-checked in CI**: `yarn workspace @serfab/cadre-host typecheck` uses
`tsconfig.typecheck.json` which covers `src` only, and the UI builds via `vite build` (esbuild, no
type-check). So `svelte-check` errors in `ui/` accumulate silently. This ticket is about (a) fixing the
narrowing complaint and (b) deciding whether to wire `svelte-check` into the host's `typecheck` (or a
`typecheck:ui` script) so future UI type regressions are caught.

## Expected behavior

- `svelte-check` on the UI tsconfig exits 0.
- Consider adding a `typecheck:ui` (svelte-check) script and/or folding it into the workspace gate so
  the UI is no longer a type-checking blind spot.

## Suggested fix direction (not prescriptive)

Either hoist the constructor into the closure as a captured non-nullable local, assert it once after the
guard, or restructure so the narrowing is visible at the `new ctor(url)` site. Avoid a bare
non-null assertion if a cleaner narrowing is available.
