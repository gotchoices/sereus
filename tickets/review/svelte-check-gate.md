----
description: Review the svelte-check gate wiring and events.ts closure-narrowing fix.
files: packages/cadre-host/ui/src/lib/events.ts, packages/cadre-host/package.json, packages/reference-app-web/package.json, package.json
----

# Review: svelte-check gate

## What was done

### Fix: `events.ts:67` — `'ctor' is possibly 'undefined'`

`subscribeEvents()` narrowed `ctor` to `typeof EventSource` via an early-return guard, but
svelte-check's TypeScript didn't preserve that narrowing into the nested `open()` closure. Fixed
by capturing the already-narrowed `const ctor` into a new `const Ctor` immediately after the guard:

```typescript
if (!ctor) { return { close() { /* noop */ } }; }
const Ctor = ctor; // svelte-check doesn't preserve const narrowing into closures
```

`open()` now calls `new Ctor(url)`. No non-null assertion used.

### New scripts

| Package | Script | Command |
|---|---|---|
| `@serfab/cadre-host` | `check:svelte` | `svelte-check --tsconfig tsconfig.json --workspace ui` |
| `@serfab/reference-app-web` | `check:svelte` | `svelte-check` |
| root | `check:svelte` | `yarn workspaces foreach -A run check:svelte` |

The `--tsconfig` path in cadre-host is resolved relative to `--workspace` by svelte-check v4, so
`tsconfig.json` refers to `ui/tsconfig.json` (the workspace root), not `packages/cadre-host/tsconfig.typecheck.json`.

The root aggregate uses `-A` without `--include`; yarn 4 automatically skips workspaces that don't
define the script (confirmed via dry-run), mirroring the existing `yarn typecheck` pattern.

## Verification

- `yarn workspace @serfab/cadre-host run check:svelte` → **0 errors, 0 warnings** (279 files)
- `yarn workspace @serfab/cadre-host run typecheck` → clean
- `yarn workspace @serfab/cadre-host run test` → 370/372 pass (2 pre-existing failures in trust-circle integration tests — see `.pre-existing-error.md`)

## Known gaps / pre-existing failures

- **`reference-app-web` svelte-check: 2 errors** in `src/lib/cadre-web.ts` from a `@libp2p/interface`
  version mismatch between sereus and the linked optimystic package. Pre-existing, unrelated to this
  ticket. Documented in `tickets/.pre-existing-error.md`. A follow-up ticket should align the
  dependency versions.

- **`cadre-host` trust-circle integration tests: 2 failures** — `Unsupported output encoding: utf8`
  deep inside `quereus-plugin-crypto`. Pre-existing, documented in `.pre-existing-error.md`.

## Testing use cases for reviewer

1. Run `yarn workspace @serfab/cadre-host run check:svelte` — should exit 0.
2. Run `yarn check:svelte` from root — cadre-host should pass; reference-app-web will fail with
   the 2 pre-existing libp2p errors.
3. Introduce a svelte-type error in any `ui/src/**/*.svelte` file and confirm `check:svelte` catches it.
4. Verify `new Ctor(url)` in `open()` is runtime-equivalent to the old `new ctor(url)` — the fix is
   purely cosmetic for TypeScript; both reference the same `EventSource` constructor.
