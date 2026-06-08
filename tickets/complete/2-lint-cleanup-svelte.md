description: COMPLETE — svelte lint cleanup (part 3/3 of the lint-warning-cleanup epic). 5 `svelte/prefer-svelte-reactivity` + 1 `svelte/no-at-html-tags` warnings triaged as false positives, scoped-disabled with rationale, both rules promoted warn→error. `yarn lint` is now a fully-enforced error gate with zero warn backlog. Reviewed: triage re-verified per-site, gate confirmed clean (0/0, no unused directives), typechecks + builds green.
files: eslint.config.mjs, AGENTS.md, docs/STATUS.md, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/messages.svelte.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/components/QrCode.svelte
----

# Complete: lint cleanup part 3 (svelte rules → error) — final gate

Last of three burndown tickets from `build-health-lint-warning-cleanup`. With this landed, **the entire
lint-cleanup epic is complete**: `lint-cleanup-mechanical` → `lint-cleanup-no-explicit-any` →
`lint-cleanup-svelte`. `yarn lint` is a fully-enforced `error` gate with **no remaining `warn` backlog**.

## What changed

All 6 warnings (5 `svelte/prefer-svelte-reactivity` + 1 `svelte/no-at-html-tags`) were triaged as **false
positives** and suppressed with scoped `eslint-disable-next-line` + one-line rationale. **Zero collections
were converted to `SvelteSet`/`SvelteDate`/`SvelteMap`** — none of the flagged sites are genuine
in-place-mutation reactive state. Both rules were then promoted `warn` → `error`.

### `svelte/prefer-svelte-reactivity` (5 sites — all false positives, all disabled)

| file:line | construct | why it's a false positive |
|---|---|---|
| diagnostics.svelte.ts:533 | `new Set<string>()` in `streamProtocols` | local dedup set, `Array.from(seen).sort()` returned, Set discarded — never held in `$state` |
| diagnostics.svelte.ts:643 | `new Set<number>()` in `collectKnownRings` | same: local dedup set, converted to sorted array, discarded |
| diagnostics.svelte.ts:808 | `new Date(ms).toLocaleString()` in `formatTimestamp` | transient Date, immediately stringified and discarded |
| messages.svelte.ts:144 | `new Date().toISOString()…` | transient Date, immediately stringified into a SQL datetime literal |
| state.svelte.ts:331 | `new Date().toISOString()` | transient Date, immediately stringified into the `publishedAt` string field |

The fix only matters when a collection/date is held in `$state` and **mutated in place** (`.add()`,
`.setTime()`) expecting a re-render. None of these are: the two Sets are pure-function locals returned as
arrays; the three Dates are transient and serialized to strings on the same expression. The real `$state`
objects in these modules (`snapshot`, `state`) are plain object/array literals reassigned wholesale, which
reactivity already handles; no Set/Date/Map is held in any of them.

### `svelte/no-at-html-tags` (1 site — false positive, disabled)

`QrCode.svelte:47` renders `{@html svg}` where `svg` is `$state` set from `QRCode.toString(value, {type:
'svg'})` (the `qrcode` npm library). The library encodes `value` into QR modules (`<rect>`s) — it does
**not** interpolate `value` as raw HTML — so the output is library-controlled markup with no XSS surface
even if `value` were attacker-influenced. In practice `value` is a locally-generated trust-circle pairing
URL/invite token. Disabled with rationale.

### Rule promotion + doc sync

- `eslint.config.mjs`: both svelte rules `warn` → `error`; top-of-file header rewritten to state the
  cleanup epic is complete and there is no remaining `warn` backlog.
- `docs/STATUS.md` "Lint coverage": `no-explicit-any` + the two svelte rules moved into the `error` list;
  the "Rules at `warn`" bullet now reads "none".
- `AGENTS.md` intro: dropped the "Backlogged rules currently run as `warn`" clause; describes the gate as
  fully `error`-enforced.

## Review findings

Adversarial pass over the implement diff (`9334eb1`), read with fresh eyes before the handoff summary.

**Scope of the change.** Every edit is comment-only: 6 `eslint-disable-next-line` directives + 2 rule
severity bumps + doc prose. There is no runtime or type surface, so the entire value of the ticket rests on
(a) the triage being correct and (b) the gate actually being clean after promotion. Both were re-checked
from scratch.

### Triage re-verification (the crux) — ✅ all 6 sound

Each `prefer-svelte-reactivity` site was re-read in context, confirming the instance is never assigned into
a `$state` object nor read by the UI between construction and disposal:

- **diagnostics.svelte.ts:533 / :643** — `seen`/`rings` are locals in pure helper functions
  (`streamProtocols`, `collectKnownRings`), `Array.from(...).sort()` returned, Set discarded. Confirmed.
- **diagnostics.svelte.ts:808** — `new Date(ms).toLocaleString()` returned inline; never bound. Confirmed.
- **messages.svelte.ts:144 / state.svelte.ts:331** — transient `new Date()` immediately serialized to a
  string (SQL datetime literal / `publishedAt` string field). Confirmed.

`no-at-html-tags` (QrCode.svelte): read the full component. `svg` is `$state('')` populated solely from
`QRCode.toString(v, {type:'svg', …})`; `value` is encoded into QR modules, never echoed as markup. No XSS
surface. Triage sound.

### Gate cleanliness — ✅ verified independently

- `yarn lint` (`eslint .`) → **exit 0, empty output** (0 warnings, 0 errors), run *after* the warn→error
  promotion.
- `eslint . --report-unused-disable-directives` → **exit 0, no reports** — proves every one of the 6
  disables suppresses a *real* violation (none spurious / stale), and that nothing else regressed.

### Build / typecheck — ✅ no regressions

- `@serfab/cadre-host typecheck` → exit 0; `build:ui` (vite) → exit 0 (194 modules; confirms QrCode.svelte
  still compiles with the new HTML comment).
- `@serfab/reference-app-web build` (`tsc --noEmit && vite build`) → exit 0. The dynamic-import /
  >500kB-chunk warnings are pre-existing libp2p/optimystic dep + bundle noise, unrelated to comment edits.

### Docs — ✅ consistent

AGENTS.md intro, `docs/STATUS.md` "Lint coverage" (error list + "Rules at `warn`: none"), and the
`eslint.config.mjs` header all agree the epic is complete with zero `warn` backlog. Remaining `warn`
references in `.md` files are historical archives under `tickets/complete/` — correctly left untouched.

### Adversarial probes that found nothing actionable

- **False negatives in the gate?** Several `new Date()` calls in `.svelte` files (Activity, Diagnostics,
  Messages, InviteModal, LogTail) are *not* flagged by the rule. Checked the only one assigned to `$state`
  — `LogTail.svelte:25 lastFetchedAt = new Date()` — it is a wholesale **reassignment** of `$state<Date |
  null>`, never an in-place mutation, so reactivity is correct and the rule rightly stays silent. No missed
  bug. (`tess/ui/.../Pipeline.svelte`'s `new Set` is in the ignored `tess/**` tree.)
- **Minor (no fix):** the ticket prose / config comment say the rule "fires on any `new Set`/`Date`/`Map`
  … regardless." Empirically it fires on the `.svelte.ts` rune-module sites but not on `.svelte`
  template/reassignment sites — a slight over-generalization. It does not affect correctness (every
  per-site disable rationale is precise and accurate), so left as-is in the archived ticket.

### Disposition

- **Minor findings fixed inline:** none required — the implementation is correct and complete as shipped.
- **Major findings → new tickets:** none.
- One genuinely-deferrable gap noted by the implementer and confirmed by review: `vite build` does not run
  `svelte-check`, so `<script lang="ts">` inside `.svelte` files is not type-verified by the gate. Harmless
  here (comment-only edit) and out of scope for this ticket; a future ticket could add a `svelte-check`
  step. Not filed — it is a pre-existing gate gap, not a regression introduced here.

## Epic status

The `build-health-lint-warning-cleanup` epic is **done**. `yarn lint` is a fully-enforced gate; there is
no `warn` backlog left in `eslint.config.mjs`. The only AGENTS.md rules not machine-enforced remain
human-review-only by nature (lowercase SQL reserved words in template literals; runtime inline `import()`).
