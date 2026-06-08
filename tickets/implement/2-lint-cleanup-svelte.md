----
description: resolve the svelte ESLint warnings (prefer-svelte-reactivity ~5, no-at-html-tags 1) and promote the rules to error, achieving a fully clean `yarn lint`
prereq: lint-cleanup-no-explicit-any
files: eslint.config.mjs, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/components/QrCode.svelte
----

# Lint cleanup, part 3: svelte rules → error (final, fully clean gate)

Last of three burndown tickets from `build-health-lint-warning-cleanup`. Clears the svelte warnings and
promotes the rules to `error`. After this lands, `yarn lint` should exit 0 with **0 warnings, 0 errors**.

## Current state (measured via `yarn lint`, 2026-06-08)

| rule | count | sites |
|---|---|---|
| `svelte/prefer-svelte-reactivity` | 5 | reference-app-web/src/lib/diagnostics.svelte.ts (3), reference-app-web/src/lib/messages.svelte.ts (1), cadre-host/ui/src/lib/state.svelte.ts (1) |
| `svelte/no-at-html-tags` | 1 | cadre-host/ui/src/components/QrCode.svelte:46 |

## Guidance

**`svelte/prefer-svelte-reactivity`** (5) — flags a plain `Set`/`Date`/`Map` held in a `.svelte.ts` rune
module, where mutations don't trigger svelte 5 reactivity. The fix is to swap to `SvelteSet`/`SvelteDate`/
`SvelteMap` from `svelte/reactivity`. **But verify each is a real reactivity bug first** (per the fix
ticket): the rule only matters if the collection/date is part of reactive state that the UI reads and the
code *mutates in place* (`.add()`, `.setTime()`, etc.) expecting a re-render. If a value is only ever
*replaced* (reassigned) rather than mutated, reactivity already works and the swap is unnecessary noise —
in that case keep the plain type and add `// eslint-disable-next-line svelte/prefer-svelte-reactivity`
with a one-line rationale. Convert the genuine cases; document the rest.

**`svelte/no-at-html-tags`** (1) — `QrCode.svelte:46` does `{@html svg}` to render a locally-generated QR
code SVG string (not user-supplied content), so the XSS warning is a false positive here. Add
`<!-- eslint-disable-next-line svelte/no-at-html-tags -->` with a rationale noting the SVG is locally
generated. (Confirm `svg` is not derived from untrusted/network input before disabling; if it ever could
be, sanitize instead.)

## Promote rules to error

In `eslint.config.mjs` (~lines 148-151) move both `svelte/no-at-html-tags` and
`svelte/prefer-svelte-reactivity` from `warn` → `error`, and update the comments above them and the
top-of-file header (lines 6-9) so nothing is described as a remaining `warn` backlog. At this point every
rule the cleanup ticket enumerated is at `error`.

## TODO

- [ ] Triage the 5 `prefer-svelte-reactivity` sites: convert genuine in-place-mutation cases to
      `SvelteSet`/`SvelteDate`/`SvelteMap`; scoped-disable + rationale for replace-only false positives.
- [ ] Add the scoped disable + rationale for `QrCode.svelte:46` (after confirming `svg` is locally
      generated).
- [ ] Promote both svelte rules `warn` → `error` and refresh comments.
- [ ] **Final verification:** `yarn lint` exits 0 with **0 warnings, 0 errors**. Build/typecheck the two
      svelte UIs (reference-app-web, cadre-host/ui) since `.svelte.ts` edits can affect reactivity at
      runtime; report results in the handoff.
- [ ] Note in the review handoff that the cleanup epic is complete and the gate is now fully enforced.
