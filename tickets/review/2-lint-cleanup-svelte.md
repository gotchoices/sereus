description: review the svelte lint cleanup — 5 prefer-svelte-reactivity + 1 no-at-html-tags warnings scoped-disabled with rationale, both rules promoted warn→error; verify the false-positive triage and that the gate is fully clean (0 warnings, 0 errors)
files: eslint.config.mjs, AGENTS.md, docs/STATUS.md, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/components/QrCode.svelte
----

# Review: lint cleanup part 3 (svelte rules → error) — final gate

Last of three burndown tickets from `build-health-lint-warning-cleanup`. With this landed, **the entire
lint-cleanup epic is complete**: `lint-cleanup-mechanical` → `lint-cleanup-no-explicit-any` →
`lint-cleanup-svelte`. `yarn lint` is now a fully-enforced `error` gate with **no remaining `warn`
backlog**.

## What changed

All 6 warnings (5 `svelte/prefer-svelte-reactivity` + 1 `svelte/no-at-html-tags`) were triaged as
**false positives** and suppressed with scoped `eslint-disable-next-line` + one-line rationale. **Zero
collections were converted to `SvelteSet`/`SvelteDate`/`SvelteMap`** — none of the flagged sites are
genuine in-place-mutation reactive state. Both rules were then promoted `warn` → `error`.

### `svelte/prefer-svelte-reactivity` (5 sites — all false positives, all disabled)

| file:line | construct | why it's a false positive |
|---|---|---|
| diagnostics.svelte.ts:533 | `new Set<string>()` in `streamProtocols` | local dedup set, `Array.from(seen).sort()` returned, Set discarded — never held in `$state` |
| diagnostics.svelte.ts:643 | `new Set<number>()` in `collectKnownRings` | same: local dedup set, converted to sorted array, discarded |
| diagnostics.svelte.ts:808 | `new Date(ms).toLocaleString()` in `formatTimestamp` | transient Date, immediately stringified and discarded |
| messages.svelte.ts:144 | `new Date().toISOString()…` | transient Date, immediately stringified into a SQL datetime literal |
| state.svelte.ts:331 | `new Date().toISOString()` | transient Date, immediately stringified into the `publishedAt` string field |

The rule fires on *any* `new Set`/`new Date`/`new Map` inside a `.svelte`/`.svelte.ts` file regardless of
whether the instance is actually reactive state. The fix only matters when a collection/date is held in
`$state` and **mutated in place** (`.add()`, `.setTime()`) expecting a re-render. None of these are: the
two Sets are pure-function locals returned as arrays; the three Dates are transient and serialized to
strings on the same expression. (Note: the real `$state` objects in these modules — `snapshot`, `state` —
are plain object/array literals reassigned wholesale, which reactivity already handles; no Set/Date/Map is
held in any of them.)

### `svelte/no-at-html-tags` (1 site — false positive, disabled)

`QrCode.svelte:46` renders `{@html svg}` where `svg` is markup produced by `QRCode.toString(value)` (the
`qrcode` npm library). The library encodes `value` into QR modules (`<rect>`s) — it does **not**
interpolate `value` as raw HTML — so the output is library-controlled markup with no XSS surface, even if
`value` were attacker-influenced. In practice `value` is a locally-generated trust-circle pairing
URL/invite token. Disabled with rationale.

### Rule promotion + doc sync

- `eslint.config.mjs`: both svelte rules `warn` → `error` (~lines 150-162); top-of-file header (lines
  6-13) rewritten to state the cleanup epic is complete and there is no remaining `warn` backlog.
- `docs/STATUS.md` "Lint coverage": moved `no-explicit-any` (stale from the prior ticket) and the two
  svelte rules into the `error` list; the "Rules at `warn`" bullet now reads "none".
- `AGENTS.md` intro: dropped the "Backlogged rules currently run as `warn`" clause; now describes the gate
  as fully `error`-enforced.

## Verification performed

- **`yarn lint`** → exit 0, **empty output (0 warnings, 0 errors)**. Run *after* the warn→error promotion,
  so this confirms both that every disable correctly suppresses a real violation (no unused-directive
  reports) and that no other rule regressed.
- **reference-app-web** `yarn workspace @serfab/reference-app-web build` (`tsc --noEmit && vite build`) →
  exit 0. (The dynamic-import / >500kB-chunk warnings are pre-existing libp2p/optimystic dep + bundle
  noise, unrelated to these comment-only edits.)
- **cadre-host** `yarn workspace @serfab/cadre-host typecheck` → exit 0; `build:ui` (vite) → exit 0.

## What the reviewer should scrutinize (honest gaps)

- **The triage is the crux.** Every edit is comment-only, so there is no runtime/type risk — the entire
  value of this ticket rests on the claim that all 5 reactivity sites are false positives. Re-verify each:
  confirm the Set/Date instance is never assigned into a `$state` object nor read by the UI between
  construction and disposal. I'm confident (locals in pure functions / immediately-stringified transients),
  but this is exactly the judgment a second pass should re-check, not take on faith.
- **`.svelte` files are not type-checked by the build.** `vite build` compiles svelte components but does
  not run `svelte-check`, so the `<script lang="ts">` in `QrCode.svelte` (and any other `.svelte`) is not
  type-verified by the commands above. Harmless here (comment-only edit), but worth knowing the gate has no
  svelte-check step — a future ticket could add one.
- **`.svelte.ts` edits "can affect reactivity at runtime."** They can't here — the edits add only comment
  lines — but I did not run the apps and click through `/diag` (reference-app-web) or the cadre-host UI to
  observe reactivity live. If the reviewer wants belt-and-suspenders, a manual smoke of those two surfaces
  would confirm nothing shifted; I judged it unnecessary for comment-only changes.

## Epic status

The `build-health-lint-warning-cleanup` epic is **done**. `yarn lint` is a fully-enforced gate; there is
no `warn` backlog left in `eslint.config.mjs`. The only AGENTS.md rules not machine-enforced remain
human-review-only by nature (lowercase SQL reserved words in template literals; runtime inline `import()`).
