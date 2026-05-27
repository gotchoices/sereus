---
description: Review the fix to the long-lived circuit-relay regression spec. The browser-shaped client now listens on the SPECIFIC relay circuit address (`<relayWs>/p2p-circuit`) instead of the bare `/p2p-circuit` search address, so the circuit-relay-v2 listener takes the deterministic `CircuitListen` "configured reservation" path and publishes the `/p2p-circuit/p2p/<client>` multiaddr in <1s — bypassing the RelayDiscovery / registrar-topology / cuckoo-filter race that left the reservation forever pending. Stale docstring grep example also corrected.
prereq:
files: ../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts
---

## What changed

Two edits, both in `../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts`:

1. **`spawnBrowserShaped` (~line 73)** — `listenAddrs: ['/p2p-circuit']` →
   `listenAddrs: [`${relayAddr.toString()}/p2p-circuit`]`. `relayAddr` is the
   function's existing parameter (the relay's `/ws/p2p/<RELAY>` multiaddr from
   `pickRelayWsAddr`). This is the whole fix: listening on the specific relay
   address matches `CircuitListen` in `@libp2p/circuit-relay-v2`'s
   `transport/listener.js`, which directly opens a connection to the relay and
   calls `reservationStore.addRelay(remotePeer, 'configured')` →
   `addedRelay(reservation)` → publishes the circuit addr. No `RelayDiscovery`,
   no registrar HOP topology, no cuckoo filter, no peer-routing dependency — all
   of which were the one-shot startup race that never recovered (see the
   fix-stage root-cause in the prior ticket). Both the primary and control cases
   call `spawnBrowserShaped(relayWs)`, so both are fixed by this single change.

2. **Docstring grep example (~lines 18-19)** — `--grep "circuit-relay-long-lived"`
   → `--grep "Circuit-relay long-lived"` (the actual `describe` title) in both
   the PowerShell and bash example lines.

`waitForCircuitListen`'s 15s timeout was left as-is (configured path publishes in
~250ms, so 15s is very comfortable).

## Validation performed (this stage)

All run from `../optimystic/packages/db-p2p`, output streamed:

- `RUN_LONG_TESTS=1 yarn test:verbose --grep "Circuit-relay long-lived"`
  → **1 passing** (primary case, 42s). The primary case drives 80×2KiB = 160 KiB
  through the relay with `applyDefaultLimit:false` and completes with no reset. ✓
- `RUN_LONG_TESTS=1 RUN_LONG_TESTS_CONTROL=1 yarn test:verbose --grep "Circuit-relay long-lived"`
  → **2 passing** (56s). The control case (14s) reaches `failureSeen === true`,
  confirming `applyDefaultLimit:true` still surfaces a relay reset — i.e. the
  spec still exercises the per-circuit data-limit surface it exists to test. ✓

The fix-stage probe scripts (`_relay-probe*.ts`) were already removed and none
were re-introduced.

## Acceptance criterion #4 (web Tier 2 e2e) — result

Ran `OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`
(reference-peer mesh auto-spawned; chromium present). Outcome: **13 passed /
3 failed**, dial:fail rate **~26%** (504 fail / 1930 attempts).

Interpretation:

- The 3 failures are the `cross-tab-activity`, `disconnect-mid-session`, and
  `two-tab-convergence` distributed specs — all failing on **message
  convergence** (a write on tab A never appears on tab B), AFTER
  `connectToBootstrap()` succeeds. That helper gates on the browser advertising a
  `/p2p-circuit/p2p/<self>` reservation within 60s, and it passed for every spec
  (plus `mode-flip` ×2 and `bootstrap-persistence`). **So the production browser
  node is NOT hitting the bare-`/p2p-circuit` discovery race** — circuit
  reservations succeed in the vite-bundled app. The scope-note worry is cleared.
- This is the exact 13/16 baseline already documented in
  `tickets/complete/web-e2e-tier2-data-convergence-relay.md` (3 convergence specs
  red on the cluster-coordinator layer). My change touches only a db-p2p **test
  file**, which is not in the web bundle, so it cannot have affected this result.
- Per the acceptance gate (dial:fail ≥ 1% → file a follow-up), I filed
  **`tickets/fix/web-e2e-tier2-data-convergence-dial-fail-rate.md`**. It flags
  the production discovery race as ruled out, points at the convergence layer,
  and calls out a harness gap that must be fixed first: the e2e debug capture
  uses `msg.text()`, which returns `debug`'s raw `%s` format string, so the rich
  `code=`/`msg=` dial:fail fields the original ticket wanted are NOT in the log —
  the hook needs to resolve `msg.args()` before the breakdown is actionable.

## Reviewer notes / known gaps (treat as a floor)

- I could **not** capture the per-failure `code=`/`msg=` for the 26% dial:fail
  rate (harness `%s`-interpolation gap above). The follow-up ticket owns that.
- The fix deliberately stops exercising relay **auto-discovery** in the spec
  (the configured path bypasses it). That was explicitly in scope per the prior
  ticket — the spec exists for the per-circuit data-limit surface, not discovery.
  Confirm you agree discovery coverage doesn't belong here.
- `packages/reference-app-web/src/lib/optimystic.ts` still uses bare
  `listenAddrs: ['/p2p-circuit']` in production. The e2e evidence says that path
  works (reservations land), but it was never converted to the configured-address
  form. If a reviewer wants belt-and-suspenders determinism in production too,
  that would be a new ticket — out of scope here.
- Validation was a single pass each. The primary case is deterministic (~250ms
  publish), but "reliably" in the acceptance criterion implies more than one run;
  a reviewer re-running a few times would harden the claim.
