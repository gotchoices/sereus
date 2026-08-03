description: The self-hosted manager's dashboard now has a page listing the shared networks a party takes part in, with a Leave button and an extra type-the-name confirmation for the case that cannot be undone.
files: packages/cadre-host/ui/src/routes/Strands.svelte, packages/cadre-host/ui/src/lib/strand-removal.ts, packages/cadre-host/ui/src/lib/typed-confirm.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/lib/router.ts, packages/cadre-host/ui/src/App.svelte, packages/cadre-host/ui/src/components/ConfirmDialog.svelte, packages/cadre-host/ui/__tests__/strand-removal.test.ts, packages/cadre-host/ui/__tests__/typed-confirm.test.ts, packages/cadre-host/ui/__tests__/router.test.ts, docs/cadre-host.md
----

# What shipped

A **Strands** page in the cadre-host SPA — nav item after Settings, hash route
`#/strands` — over the `/api/strands` routes from `feat-cadre-host-strand-api`.
Before this, leaving a shared network meant `cadre strand remove` in a terminal.

- **`ui/src/lib/router.ts` / `App.svelte`** — the `strands` route, nav entry, render branch.
- **`ui/src/lib/state.svelte.ts`** — `StrandSummary` / `StrandRemovalResult` mirror types,
  the `strands` slice (`list`, `controlConnections`, `loaded`, `error`), `refreshStrands()`,
  and a `strands-changed` case in `applyEvent`.
- **`ui/src/lib/typed-confirm.ts`** — `typedConfirmationMatches(expected, typed)`: trim both
  sides, then exact. Paste passes; a case difference, a substring, a superstring and a blank
  `expected` all fail.
- **`ui/src/lib/strand-removal.ts`** — `requiresTypedConfirmation(type)` and
  `removalFeedback(result)`.
- **`ui/src/components/ConfirmDialog.svelte`** — optional `requireText` and `note`; the
  confirm button stays disabled until the typed text matches, and Enter in the field obeys
  the same gate.
- **`ui/src/routes/Strands.svelte`** — the page.
- **`docs/cadre-host.md`** — Strands in the SPA page list, a paragraph on the type-the-id
  confirmation and the two advisory surfaces, bundle figure ≈ 45 KB gzipped (re-measured
  this pass: 41.23 kB JS + 3.41 kB CSS gzip).

## Behaviour

The confirmation has two strengths, both keyed off `requiresTypedConfirmation(strand.type)`,
so the dialog shown and the query flag sent can never disagree:

| Strand type | Dialog | `DELETE` sent |
|---|---|---|
| `'o'` open | plain confirm, one click | `/api/strands/:id` |
| `'c'` closed | confirm + must type the id exactly | `/api/strands/:id?confirm=1` |

Exactly one piece of feedback per removal (`removalFeedback`): `published: false` → info
toast `<id> was already removed`; `removed && alone` → dismissable inline banner and no
toast; otherwise success toast `Left <id>`. A 428 surfaces the node's own wording verbatim;
any other error becomes `Leave failed: <msg> (<code>)`.

The `controlConnections === 0` advisory appears in the dialog *before* a removal; the
`alone` banner appears *after*. Both are read-time snapshots and are worded as advisory.

## Review findings

**Checked:** the full implement diff read before the handoff summary; the API contract it
consumes (`src/strands/types.ts`, `src/server/routes/strands.ts`, its route tests) against
what the page sends and expects; the CSS tokens and shared classes the new markup uses;
`docs/cadre-host.md` end to end for the strand surface, the route table, the SSE event list
and the bundle figure; the two existing `ConfirmDialog` callers in `TrustCircle.svelte`;
and the ticket board for tickets already claiming these files.

**Fixed in this pass (minor):**

- *Untestable branchy logic in the template.* `reportRemoval` — the four-way choice between
  three toasts and the banner — lived in `Strands.svelte`, where this package cannot execute
  it. Moved out as the pure `removalFeedback(result)` returning a
  `{ kind: 'toast' | 'banner' }` union, with tests covering every
  `published × removed × alone` combination, that `alone` alone never raises the banner, and
  that the feedback quotes the id the node acted on.
- *Layering.* The generic `ConfirmDialog` imported from a strand-named module. Split into
  `lib/typed-confirm.ts` (the match rule, which is the dialog's own concern) and
  `lib/strand-removal.ts` (strand policy); `strand-confirm.ts` is gone and its test split to
  match. One case added: a percent-escape is matched literally, not decoded.
- *Dead prop.* `ConfirmDialog`'s `requireTextLabel` had exactly one caller passing a string
  identical to the component's own default — and passing it even when the gate was off,
  producing a `Type  to confirm:` label nothing rendered. Prop removed; the label now shows
  the expected value in a `<code>` so leading or trailing spaces in an id are visible.
- *A failed refresh discarded a good list.* The card's `{#if error}` came first in the chain,
  so a refresh that failed *after* a successful load replaced the whole list with an error
  line. The error line now sits above the list, and the three list states come from one
  `listView` derivation (`loading` / `empty` / `list` / `none`) rather than a nested chain.

**Filed (major):** `tickets/backlog/debt-cadre-host-ui-component-tests` — the package has no
way to mount a Svelte component in a test (`vitest.config.ts` is `node`-only with no Svelte
plugin), so the typed-confirmation gate that guards the one irreversible action in this
dashboard is enforced solely by unexecuted markup. After the extraction above the rules are
tested; the wiring (button really disabled, Enter gated, field reset between openings) is
not, and cannot be here. The ticket notes it shares a config file with
`debt-build-guard-wiring-unasserted`.

**Tripwires (recorded as `NOTE:` comments, not tickets):**

- `ui/src/lib/state.svelte.ts`, at `refreshStrands` — overlapping refreshes are
  last-response-wins, so a slow earlier fetch could land after a newer one and briefly
  re-show a removed row. Today the only overlap is a removal's own refresh racing its SSE
  echo and both are post-delete; if these calls ever get slow, sequence them behind a token.
- `ui/src/lib/state.svelte.ts`, at the `strands-changed` case (from the implement pass) — the
  removing tab fetches twice, its own refresh plus the SSE echo.

**Checked and deliberately left alone:**

- *Donor-only installs.* The nav item shows and the page reports a load error. Same shape as
  Trust Circle and Connectivity, one problem with one fix, already tracked in
  `tickets/backlog/feat-cadre-host-donor-aware-ui`, which carries a Strands arm. No
  second page-local gate invented here.
- *A failed refresh both toasts (`reportError`) and shows the inline line.* Duplicated but
  consistent with every other refresh helper in the file; changing it is a whole-file
  decision, not a Strands one.
- *The banner is not cleared by a later successful removal.* It names a specific strand and
  stays true; it is dismissable.
- *`ConfirmDialog` never moves focus into itself,* so Escape only fires once something inside
  is focused. Pre-existing, unchanged by this diff, and equally true of the two trust-circle
  callers.
- *Nav order* (Strands after Settings) — as specified by the plan ticket.

**Still not covered, and honestly so:** everything that only exists as markup — the dialog
copy, the disabled-until-typed button, the field reset, Enter/Escape handling, the banner,
the row rendering, and the whole of `Strands.svelte`. No founder-mode host was run against
this build. That is the entirety of the filed ticket's subject; the manual checklist in the
implement handoff (commit `80a411a`) is still the list to walk when a live host is available.

## Verification

| Command | Result |
|---|---|
| `yarn lint` | pass |
| `yarn dep-check` | pass (no cadre-host entries; pre-existing reference-app-web noise only) |
| `yarn --cwd packages/cadre-host typecheck` | pass |
| `yarn --cwd packages/cadre-host check:svelte` | 284 files, 0 errors, 0 warnings |
| `yarn --cwd packages/cadre-host test` | 65 files, 584 passed / 4 skipped |
| `yarn --cwd packages/cadre-host build` | pass |

The transient `@quereus/quereus` resolution failure the implement pass saw in a full
`yarn build` did not recur.
