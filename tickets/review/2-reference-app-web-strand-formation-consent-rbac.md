----
description: REVIEW — browser reference now drives the consent/invitation strand-formation flow (responder + initiator), closed-strand membership, and `CadreControl` authorization-gate ("RBAC") observability. Live two-party convergence deferred to a backlog fixture ticket. typecheck + build + full e2e green.
prereq: formationinvite-fix-curve-and-wire-consent
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/relay-config.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/e2e/solo/formation-rbac.spec.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/README.md, docs/architecture.md
----

# Review: browser consent/invitation formation + closed strands + RBAC observability

The browser reference moved beyond the Phase-1 solo open strand. It now drives the
cadre-core **strand-formation API** end-to-end (responder + initiator), launches a
**closed** strand from the formation result, and makes the `CadreControl`
authorization gates ("RBAC") observable on Diagnostics. This is genuinely new
reference surface — it's the first reference to call
`createOpenInvitation`/`formStrand` from a UI.

**Treat this as a starting point.** The single-tab paths (UI, dialability guard,
authority gate, observability) are automated and green. The *live two-party*
formation→convergence path is wired in code but **not** exercised by an automated
test — it needs relay infra + a dialable second cadre + the cadre-core consent DB
wiring. That's the headline gap (see "Known gaps").

## What shipped

### Formation machinery (`src/lib/cadre-web.ts`)
- `createInvitation(expirationMs?)` — responder: `initializeStrandSolicitation` →
  `createOpenInvitation(CHAT_SAPP_ID, exp)` → `encodeInvitation`. Guards on relay
  dialability and throws a clear "not dialable" error when no reservation exists.
- `joinViaInvitation(encoded, disclosure?)` — initiator: `decodeInvitation` →
  `formStrand(invitation, { partyId })` → pre-open the formed strand's IndexedDB
  store → `addStrand({ strandRow: { Id, MemberPrivateKey, Type: 'c' }, sAppConfig })`.
- **Relay reservation** for dialability: `reserveRelay` dials the configured
  relay(s) and polls `getMultiaddrs()` for a `/p2p-circuit` address (10s budget),
  fail-soft. `listenAddrs` is `['/p2p-circuit','/webrtc']` only when a relay is
  configured, else `[]` (Phase-1 solo posture preserved).
- **RBAC**: `attemptUnauthorizedStrandWrite()` (the authority-gate probe) and
  `readControlAuthorizationState()` (read-only SQL over the control DB's Quereus
  handle — authority/validation key counts, FormationInvite/FormationUsage rows,
  per-strand type + member-key presence).
- New state/getters: `getRelayState`, `getFormedStrands`. `__cadre` debug hook
  extended with the formation + RBAC entry points for e2e.

### Relay config (`src/lib/relay-config.ts`, new)
Runtime relay-multiaddr resolution (`VITE_RELAY_ADDR` / `localStorage["relay-addr"]`),
mirroring `ice-config.ts`: framework-free, guarded, never throws.

### UI
- **Home** (`Home.svelte` + `network.svelte.ts`): the disabled Phase-1 seed panel
  is replaced by a **Strand formation** panel — create-invitation (responder,
  copyable encoded blob) and join-via-invitation (initiator, paste → form), plus a
  "Relay" status row. Shows resulting strand id + membership type.
- **Diagnostics** (`Diagnostics.svelte` + `diagnostics.svelte.ts`): new "Control
  authorization (RBAC)" card — authority/validation key counts, relay posture,
  FormationInvite/FormationUsage rows, per-strand membership, and a "Verify
  authority gate" button surfacing the rejected/accepted result. (Renamed the
  component's local `state` → `diag` to use the `$state` rune without a
  store-conflict.)

### Docs
`README.md` (formation flow, relay/dialability, RBAC, e2e tiers, out-of-scope) and
`docs/architecture.md` (reference-apps table + web-reference paragraph) updated;
Phase-1 "forthcoming" caveats for formation/RBAC removed.

## Validation re-run (all green)
- `yarn workspace @serfab/reference-app-web typecheck` → exit 0.
- `npx svelte-check` → 0 errors, 0 warnings.
- `yarn workspace @serfab/reference-app-web build` → exit 0 (only the pre-existing
  ~3 MB chunk-size + db-p2p dynamic-import warnings; nothing new).
- `yarn test:e2e --project=chromium` (full suite) → **25 passed, 8 skipped, 0
  failed**. The 4 new `formation-rbac.spec.ts` tests pass; the 8 legacy
  `e2e/distributed/*` specs skip cleanly via the fixture gate.

## Use cases for the reviewer to exercise / verify

1. **Authority gate (RBAC) — the load-bearing claim.** `formation-rbac.spec.ts`
   asserts the probe is *rejected*. Confirm independently that
   `attemptUnauthorizedStrandWrite` really exercises the `Strand.Authorized`
   constraint (non-enrolled key + bogus sig, no `FormationUsage`) and that the
   rejection is the *constraint* firing at commit — not an unrelated error (e.g. a
   context-type error on the null/bogus values). It passed in-browser, but verify
   the failure path is the intended one.
2. **Dialability guard.** With no relay, *Create invitation* must surface "not
   dialable". Spot-check that `createOpenInvitation`'s own
   "No multiaddrs available" throw and the relay-status guard don't mask each
   other.
3. **Formation happy path (manual).** Configure a relay (`VITE_RELAY_ADDR`), open
   two tabs, create → copy → paste → form. Verify both reach a closed strand with
   the same `strandId` and that Diagnostics shows the FormationUsage/strand rows.
   This is the path with **no automated coverage** — see gap #1.
4. **Observability accuracy.** Confirm the Diagnostics authorization card counts
   match the control DB (genesis → 1 authority key; solo → 0 formation rows; 0
   control-DB strands because `addStrand` launches the instance but inserts no
   control `Strand` row on a solo node — verify this is correct, not a bug).
5. **No regression to Phase-1 solo posture.** Boot/messages/reload/diagnostics
   specs still green with no relay configured.

## Known gaps (honest)

1. **Live two-party convergence is NOT automated** — the biggest gap. The
   `createInvitation`/`joinViaInvitation`/`formStrand` code paths are typechecked
   and reachable but have **not** been run against a real second party in CI. They
   need (a) a circuit-relay reservation, (b) the cadre-core consent DB wiring from
   `formationinvite-fix-curve-and-wire-consent` (still in `implement/`,
   unlanded — current `createOpenInvitation` mints an in-memory token and wires no
   DB-backed `FormationUsageRecorder`), and (c) a dialable second cadre. Filed as
   `tickets/backlog/reference-app-web-formation-convergence-e2e.md`.
2. **Closed-strand-membership negative test deferred.** The ticket wanted "join a
   `Type:'c'` strand without the member key fails." The schema's "member key only
   if closed" constraint is a TODO (`control-database.ts` `Strand` table) and
   `addStrand` doesn't gate on it, so a clean solo negative assertion isn't
   meaningful yet — the real enforcement is at the cohort/read layer. Folded into
   the backlog convergence ticket.
3. **cadre-core unchanged by design.** `@serfab/cadre-core` resolves to `dist/`
   (`main: dist/index.js`), so touching its source would require rebuilding it for
   the web app. The reference reads control tables via the already-exported
   `ControlDatabase.getDatabase()` Quereus handle instead — no cadre-core diff, no
   rebuild dependency. If the reviewer prefers typed `queryFormationInvites` etc.
   on `ControlDatabase`, that's a cadre-core change + rebuild (a deliberate
   trade-off I avoided).
4. **Topology shipped = two-tab + relay** (relay-configurable). Browser↔node was
   the ticket's recommended-first path but `cadre-cli` has no formation command,
   so a headless responder fixture doesn't exist — noted in the backlog ticket.
5. **`relay-config.ts` is untested in isolation** (no unit test); it mirrors the
   tested-by-use `ice-config.ts` shape but only its "no relay → []" branch is
   exercised by the solo e2e.

## Pre-existing failures
None surfaced. `tickets/.pre-existing-error.md` not written. The full e2e suite
was green; cadre-core source was not modified.
