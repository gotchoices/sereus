----
description: Re-establish live two-party cross-cohort convergence as a runnable e2e tier for the browser reference — two parties form a closed strand via the consent/invitation flow, then a chat message written by one replicates to the other through the strand cohort.
prereq: formationinvite-fix-curve-and-wire-consent
files: packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/fixtures/state.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/relay-config.ts, ops/
----

# Live formation → convergence e2e for the browser reference

Phase 2 (`reference-app-web-strand-formation-consent-rbac`) shipped the browser
**formation machinery + UI + RBAC observability** and a solo e2e tier
(`e2e/solo/formation-rbac.spec.ts`) covering everything one tab can prove
(formation panel, dialability guard, invalid-invitation guard, authority-gate
rejection, authorization surface). What it deliberately deferred is the **live
two-party path**: two cadres forming a shared **closed** strand via
`createOpenInvitation` → `formStrand`, then a chat message written in one
converging to the other through the strand cohort.

`e2e/global-setup.ts` currently writes the Tier-2 fixture as unavailable
(`TIER2_CONVERGENCE_DEFERRED = true`) so the legacy `e2e/distributed/*` specs
skip. This ticket re-establishes convergence on the cadre path.

## Why it was deferred (the blockers to clear)

1. **Dialability / relay infra.** A browser tab can't listen; formation needs a
   circuit-relay-v2 reservation so both tabs advertise a `/p2p-circuit` address.
   `relay-config.ts` already resolves a relay multiaddr from `VITE_RELAY_ADDR` /
   `localStorage["relay-addr"]` and `cadre-web.ts` dials + waits for the
   reservation — but the e2e harness spawns **no relay**. A service-peer relay
   fixture (like the removed Tier-2 setup) is needed.
2. **Consent DB wiring.** The responder must persist a `FormationInvite` and, on
   redemption, a `FormationUsage` row atomically with the `Strand` insert so the
   consent-based `Strand.Authorized` branch is exercised. That lands in
   `formationinvite-fix-curve-and-wire-consent` (cadre-core). Design against the
   shipped cadre-core API once it lands.
3. **A dialable second cadre.** Either a second relayed browser tab, or a headless
   cadre **responder fixture**. Note `cadre-cli` has **no** formation/invite
   command today — a responder fixture would need either a new `cadre-cli`
   subcommand (create-invitation / stay-alive-as-responder) or a small Node
   harness that boots a `CadreNode`, genesis-seeds an authority, calls
   `createOpenInvitation`, prints the encoded invite, and serves the formation
   protocol.

## Expected behavior (the test to write)

- **Happy path:** responder creates invitation → initiator `formStrand` with the
  token → both reach an `active` closed strand with the same `strandId` → a chat
  message written by one replicates to the other within a bounded wait. Assert a
  `FormationUsage` row on the responder, both `StrandInstance.status === 'active'`,
  and the replicated `App.Message` row.
- **Invalid/expired token:** `formStrand` against a bad/expired token fails; no
  `FormationUsage` row; no strand provisioned; no identity disclosed (disclosure
  timing).
- **Closed-strand membership:** the formed strand requires the minted member key
  to read; without it, reads are unauthorized. (Note: the schema's
  "member key only if closed" constraint is currently a TODO — see
  `control-database.ts` `Strand` table — so this may need the constraint added
  first, or asserting at the cohort/read layer rather than the control insert.)

## Topology options (implementer's call)

- **Two browser tabs + relay** (browser-native): both tabs relayed; invitation
  copy/pasted in-test via the `__cadre` debug hook
  (`createInvitation` / `joinViaInvitation` are already exposed).
- **Browser ↔ node** (more deterministic): a headless cadre responder fixture
  holds the invite; the browser tab forms against it. Reuses the
  `reference-peer.ts` spawn pattern but needs the responder command noted above.

Flip `TIER2_CONVERGENCE_DEFERRED` to `false`, wire the fixture in `global-setup.ts`,
and rewrite the obsolete `e2e/distributed/*` specs (which assert membership-free
Optimystic convergence) onto the cadre formation model.
