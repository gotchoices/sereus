---
description: Web Tier 2 e2e still fails the 3 data-convergence distributed specs (13/16) with a ~26% protocol-client dial:fail rate. Re-confirmed 2026-05-27 as the gate for the circuit-relay-long-lived ticket. The circuit-relay discovery race is NOT the cause — browsers DO obtain /p2p-circuit reservations (connectToBootstrap's reservation gate passes for every spec; mode-flip ×2 + bootstrap-persistence are green). The failures are downstream cross-peer data replication / cluster-coordinator convergence, the same layer flagged by the now-complete web-e2e-tier2-data-convergence chain. Reproduce, capture the real dial:fail code=/msg= fields (currently lost — see harness gap below), and root-cause why writes on tab A never reach tab B.
prereq:
files: packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/src/lib/optimystic.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts
---

## Symptom (re-confirmed 2026-05-27)

`yarn workspace @serfab/reference-app-web test:e2e` (Tier 2, reference-peer mesh
spawned on ws ports 9191 bootstrap + 9192/9193 service) → **13 passed / 3 failed**:

- ✘ `cross-tab-activity.spec.ts` — concurrent writes never converge as a set
  (`every(id => onA.has(id))` predicate times out at 30s).
- ✘ `disconnect-mid-session.spec.ts` — message row written on A never becomes
  visible on B (`toBeVisible` times out at 30s).
- ✘ `two-tab-convergence.spec.ts` — same: A sends, B never sees it (20s timeout).

All 10 solo (Tier 1) specs + `mode-flip` ×2 + `bootstrap-persistence` pass.

This is the **same 13/16 baseline** documented in
`tickets/complete/web-e2e-tier2-data-convergence-relay.md` ("the three
data-convergence specs remain red, but on a different layer — cluster-coordinator
supermajority"). The `web-e2e-tier2-cluster-supermajority`,
`web-e2e-tier2-consensus-broadcast-race`, and `web-e2e-tier2-data-convergence`
follow-ups all landed in `complete/`, yet the three specs are **still red** —
so either those fixes regressed or never fully closed the convergence gap. Treat
this as the live recurrence and reconcile against those completed tickets'
"Review findings" before assuming a fresh root cause.

## dial:fail rate

With `OPTIMYSTIC_E2E_DEBUG=1` (enables `localStorage.debug` browser tracing), the
optimystic `protocol-client` emitted over the whole run:

- `dial` attempts: **1930**
- `dial:ok`:        **1426**
- `dial:fail`:      **504**  → **~26%** fail rate (far above the 1% gate)
- `dial:timeout`:   0

26% dialing failure is consistent with cross-peer replication never completing.

## Harness gap — fix this FIRST

`packages/reference-app-web/e2e/distributed/_helpers.ts` `maybeEnableBrowserDebug()`
logs browser console via `msg.text()`. For `debug`-library lines the browser
does the `%s` substitution lazily in its own console formatter, so `msg.text()`
returns the **raw format string** — every captured `dial:fail` line reads
literally `dial:fail peer=%s protocol=%s ms=%d code=%s msg=%s` with no values.
That means the rich `code=`/`msg=` fields the original ticket wanted are **not
recoverable from the current log**. Before diagnosing, change the console hook to
resolve `msg.args()` (await each `JSHandle.jsonValue()`) so the interpolated
`code=`/`msg=`/`protocol=` land in the test output. Only then is the dial:fail
breakdown (which protocols, which error codes, relay vs. direct) actionable.

## What is NOT the cause

The circuit-relay reservation path works in production. `connectToBootstrap()`
gates on `window.__optimystic.getMultiaddrs()` advertising a
`/p2p-circuit/p2p/<self>` address within 60s, and that gate **passed for all
failing specs** (they fail later, on message-row visibility). So the bare
`/p2p-circuit` discovery race described in
`circuit-relay-long-lived-spec-never-publishes` is **not** reproduced in the
vite-bundled web app. Do not re-open the circuit-relay listener path; focus on
the coordinator/replication layer that the dials are failing against.

## Acceptance

- [ ] `_helpers.ts` debug capture resolves `msg.args()` so `dial:fail code=/msg=` fields appear in test output.
- [ ] dial:fail codes categorized (per-protocol, per-error-code) from a fresh `OPTIMYSTIC_E2E_DEBUG=1` run.
- [ ] Root cause for the 3 data-convergence specs identified and reconciled against the prior complete/web-e2e-tier2-* chain.
- [ ] Tier 2 e2e reaches 16/16 (or the residual gap is re-scoped into a precise follow-up with the real codes attached).
