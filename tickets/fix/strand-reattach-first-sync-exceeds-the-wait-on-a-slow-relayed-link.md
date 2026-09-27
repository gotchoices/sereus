description: When a phone re-opens a shared strand after being away, over a slow relayed link, its data takes about 150 seconds to arrive, but Sereus gives up at 120 seconds and reports the strand as not ready. The wait was sized from fresh joins, which are faster than re-attaches.
files:
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS = 120 000)
  - packages/cadre-core/src/link-budget.ts (the measurement notes near line 84)
  - packages/integration-tests/src/scenarios/ (the relay-only latency scenarios added for optimystic #22)
----

# Re-attach over a slow relayed link outlasts the first-sync wait

## Report

On optimystic #22 (kjeib, 2026-09-27 01:56Z; sereus 1.5.0, optimystic 1.6.0, Quereus 4.20.0, one copy of each):
- **Shape:** two relay-only parties. B runs `stopStrand`, A writes while B is away, the one-way delay is raised to 900 ms, then B runs `addStrand` and reads.
- **Result:** `sereus:cadre:strand-first-sync` shows the gate opening at about **150 s**, after `addStrand` has already rejected at its 120 s budget. It is the same at `cohortQueryTimeoutMs` 5000 and 15000, so this is not the consult deadline.
- **Real devices:** a fresh join from a Galaxy S7 over relay.sereus.org took 178 s, with Hermes crypto costs on top.

The 120 s default (`complete/1-first-sync-wait-too-tight-on-a-slow-relayed-link`) was sized from **fresh joins**: 23–46 s at 900 ms one-way. A re-attach was never measured.

## Do

1. Reproduce the re-attach shape in an opt-in integration scenario, reusing the relay-only latency setup from the #22 tickets. Record how long it takes the gate to open at 900 ms one-way.
2. **Find where the time goes.** A re-attach already holds most of the strand locally. If it is slower than a fresh join, that points at something the re-attach path does extra: a catch-up per missed revision, repeated consults, redials. Fix that if it is sereus's. If it is optimystic's, write it up for optimystic (don't edit `../optimystic`).
3. Only then size `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` against the measured re-attach, with margin. Record the measurement where the fresh-join one is. A longer default also delays how soon a truly stuck join reports failure; say so at the constant.
4. Check that `StrandAwaitingFirstSyncError`'s message still points callers at `whenStrandWritable`, which is what the reporter now uses.
