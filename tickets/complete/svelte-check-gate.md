----
description: Wired svelte-check into a build-health gate across the two Svelte UI packages and fixed the latent type-narrowing error it surfaced in cadre-host's events client.
files: packages/cadre-host/ui/src/lib/events.ts, packages/cadre-host/package.json, packages/reference-app-web/package.json, package.json
----

# Complete: svelte-check gate

## Summary

Stood up a `svelte-check` gate (svelte's own template/type diagnostics, which ESLint's svelte
pass does not run) and fixed the one latent error it surfaced in `cadre-host/ui`.

### Changes

| Location | Change |
|---|---|
| `packages/cadre-host/ui/src/lib/events.ts` | Capture narrowed `const Ctor = ctor` after the guard; `open()` uses `new Ctor(url)` |
| `packages/cadre-host/package.json` | `check:svelte` → `svelte-check --tsconfig tsconfig.json --workspace ui` |
| `packages/reference-app-web/package.json` | `check:svelte` → `svelte-check` |
| root `package.json` | `check:svelte` → `yarn workspaces foreach -A run check:svelte` |

The `events.ts` fix is a pure TypeScript-narrowing workaround: svelte-check's TS does not preserve
the early-return `const` narrowing into the nested `open()` closure. `new Ctor(url)` is runtime-
identical to the old `new ctor(url)` (same `EventSource` reference); no non-null assertion was used.

## Review findings

### What was checked

- **Implement diff** (`6d79439`) read first, fresh — 4 source/config changes plus the
  `.pre-existing-error.md` (since consumed by the triage pass).
- **The fix** (`events.ts`): narrowing-capture correctness, no non-null assertion, runtime
  equivalence, SPP/maintainability of the one-line change.
- **Gate wiring**: all three `check:svelte` scripts; `svelte-check ^4.0.0` present as a devDep in
  both Svelte packages; `ui/tsconfig.json` resolution under `--tsconfig tsconfig.json --workspace ui`.
- **Coverage**: which packages actually use Svelte vs. which define the script; whether the root
  aggregate skips non-participating workspaces cleanly.
- **Tests**: existing `events.test.ts` (happy path, backoff schedule, attempt reset, close).
- **Gates run**: `lint`, `cadre-host check:svelte`, `cadre-host` events tests, `reference-app-web
  check:svelte`, root `check:svelte`.
- **Pre-existing-failure honesty**: confirmed both documented failures are outside this diff and
  already have follow-up tickets.

### What was found and done

- **Fix correctness — OK.** `const Ctor = ctor` is the cleanest available narrowing capture; the
  comment explains the why. Behavior is unchanged. No action.
- **Gate wiring — OK.** Verified directly:
  - `cadre-host check:svelte` → **0 errors / 0 warnings** (279 files).
  - Root `yarn check:svelte` runs both Svelte packages and **silently skips** every workspace that
    lacks the script (no "command not found"), matching the established `yarn typecheck` pattern.
  - Exactly two packages use Svelte (`cadre-host/ui`, `reference-app-web`); **both** define
    `check:svelte`. No Svelte package was missed.
- **Lint — PASS** (exit 0, no output).
- **Tests — PASS.** `events.test.ts`: 4/4. The fix is indirectly but fully exercised — all four
  tests drive `new Ctor(url)`.
- **Root gate is RED on introduction — known, already ticketed (not a new finding).**
  `reference-app-web check:svelte` fails with 2 errors in `src/lib/cadre-web.ts` from a duplicated
  `@libp2p/interface` (sereus `node_modules` vs. the linked optimystic copy) — a type-identity
  mismatch, not anything in this diff (which only *adds* the script there). A gate that cannot pass
  cannot catch regressions, so this matters — but the triage pass (`dfba772`) already filed
  `tickets/backlog/reference-app-web-libp2p-interface-dedup.md` for it. No new ticket needed.
- **`cadre-host` integration tests (2 failures) — pre-existing, already ticketed.** `Unsupported
  output encoding: utf8` inside `quereus-plugin-crypto` via `control-database.insertAuthorityKey`;
  unrelated to events/SSE. Covered by `tickets/backlog/migrate-cadre-to-variadic-digest-api.md`
  (also from the triage pass). Not re-run here (outside this diff).

### Categories with nothing to report

- **Major findings → new tickets: none.** The only failing-gate concern was already decomposed into
  two backlog tickets by the triage pass before review; filing more would duplicate them.
- **Minor findings fixed inline: none.** The diff is a one-line narrowing capture plus three script
  entries; nothing required correction.
- **Docs:** no doc touches the svelte-check gate or the `events.ts` ctor narrowing, so none is now
  out of date. The change is build-tooling/internal and introduces no user- or protocol-facing
  surface. Nothing to update.
- **Test-gap note (non-blocking):** the `if (!ctor) return` SSR/no-`EventSource` branch in
  `subscribeEvents()` has no direct test. This is a pre-existing gap untouched by this ticket and
  orthogonal to the narrowing fix; not worth expanding scope here.

## Verification (re-run during review)

- `yarn lint` → exit 0
- `yarn workspace @serfab/cadre-host run check:svelte` → 0 errors, 0 warnings (279 files)
- `cadre-host` `events.test.ts` → 4/4 pass
- `yarn check:svelte` (root) → cadre-host passes; reference-app-web fails with the 2 pre-existing,
  already-ticketed libp2p errors; other workspaces skipped
