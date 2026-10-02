description: Cadre's time limits for connecting to another machine through a relay now count the step of first connecting to the relay itself, and the relay's decision to let the caller in, so such a connection no longer times out on the slowest link sereus supports.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (CIRCUIT_DIAL_ROUND_TRIPS, RELAY_DIAL_ROUND_TRIPS, RELAYED_DIAL_ROUND_TRIPS, DIAL_ADMISSION_DECISIONS, relayedDialBudgetMs; RELAY_RESERVATION_ROUND_TRIPS now derived)
  - packages/cadre-core/test/link-budget.spec.ts (formula pins, listener containment pin)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (fresh-dial step 4, its record and assertion)
  - packages/cadre-core/src/index.ts, peer-dial.ts, peer-join-backfill.ts, seed-bootstrap.ts, strand-addr-protocol.ts, strand-formation-deadlines.ts, cadre-node.ts, control-cohort.ts, push-fanout.ts, types.ts
  - packages/reference-app-rn/src/host-node-request.ts (connectMs 180 000)
  - docs/architecture.md, docs/cadre-consistency.md, docs/reference-app-rn.md, .release-notes.pending.md
----
# Relayed dial budgets count opening the relay connection

## What landed

A relayed dial is now budgeted at five link round trips (`RELAYED_DIAL_ROUND_TRIPS` = `RELAY_DIAL_ROUND_TRIPS` 1 + `CIRCUIT_DIAL_ROUND_TRIPS` 4) plus two admission allowances (`DIAL_ADMISSION_DECISIONS` × `ADMISSION_DECISION_TIMEOUT_MS`: a party-run relay's and the called machine's), because a dialer cannot know beforehand whether it holds a relay connection. Measured: 15 113 ms (and 15 108 ms on a re-run) at 1 500 ms one-way for a dialer holding no relay connection, against 12 072-12 094 ms over a relay connection already held.

At the default 3 500 ms declaration: per-address dial 16 → 21.5 s, control-cohort per-peer dial 64 → 86 s, formation dial 19.5 → 25 s, one-frame request attempt 23 → 28.5 s, wake's two attempts 46 → 57 s, formation session 208 → 213.5 s. The reference app's connect wait went 140 → 180 s so it still covers two whole per-peer dials.

The listener containment pin in `link-budget.spec.ts` now checks Optimystic's `inboundUpgradeTimeoutMs` against the circuit leg plus one decision, since the listener's timer starts when the relay hands it the circuit. The latency instrument's `cadre-core declared` arm asserts the fresh dial completes under `RELAYED_DIAL_ROUND_TRIPS × DECLARED_LINK_ROUND_TRIP_MS` at or below the supported link.

The implement-stage diff is split across `tess: triage pre-existing test failure` (which swept up most working-tree edits mid-ticket) and `ticket(implement): bug-relayed-dial-budget-omits-opening-the-relay-connection`; that triage commit's changes to `control-write-degraded-cohort-member.integration.ts` and `tickets/.pre-existing-known.md` are the triage agent's own, not this ticket's.

## Review findings

**Checked.**
- Every figure recomputed from the code: 5 × 3 500 + 4 000 = 21 500; ×4 = 86 000; +3 500 = 25 000 (formation dial, `6L + 4 000`); +7 000 = 28 500; ×2 = 57 000; session `14 000 + 57L` = 213 500, and at L = 100 dial 4.6 s / session 19.7 s; `cadre-node.ts`'s re-drive NOTE 57 + 18 = 75 s; `DECLARED_LINK_ROUND_TRIP_MS`'s headroom 17 500 − 15 113 ≈ 2.4 s; the instrument's ceilings (21 500 − 4 000)/10 = 1 750 and 21 500/10 = 2 150 ms one-way, and the "four fifths" rule for the other dialer-side rows. All correct.
- The silent-failure window NOTE: listener limit 17 500 ms vs dial budget 21 500 ms; a dial over a held relay connection costs 4r, so the listener gives up first for r between 4 375 and 5 375 ms. Matches the NOTE's "about 4.4 s to 5.4 s".
- Grep for stale figures (`16 000`, `16 s`, `19.5 s`, `23 s`, `46 s`, `64 s`, `140 s`, `six round trips`, `four link round trips`) across `packages/*/src`, `packages/*/test`, `docs`, release notes: the remaining hits are history (measurement records), unrelated numbers, or the reservation drive's genuine four.
- `strand-wake-protocol.ts` (listed in the plan's files) states no figure, only derivations; no edit needed. `strand-formation-deadlines.ts`'s `responderClampReserveMs` uses `dialMs` symbolically, so it moves with the change; `strand-formation-deadlines.spec.ts` ordering passes.
- The instrument's new assertion is gated on `delayMs <= SUPPORTED_ONE_WAY_MS`, so a sweep above the supported link does not fail on it.
- Validation: `yarn lint`, typecheck of cadre-core, integration-tests and reference-app-rn clean; `yarn workspace @serfab/cadre-core test` 149 files, 2 364 passed, 1 skipped; after this pass's edits, `link-budget`, `relay-reservation` and `strand-formation-deadlines` specs re-run (57 passed). The opt-in latency instrument was not re-run in review (the edit there is a comment); the implement stage ran it at 1 500 ms one-way.

**Fixed inline (minor).**
- `RELAY_RESERVATION_ROUND_TRIPS` was a literal 4 whose doc now says "twice" the relay dial plus the reservation request; it is now `2 * (RELAY_DIAL_ROUND_TRIPS + RELAY_RESERVE_REQUEST_ROUND_TRIPS)` (value unchanged), with `RELAY_RESERVE_REQUEST_ROUND_TRIPS` moved above it, so a change to the relay-dial count moves the reservation drive too.
- The instrument's `UNBOUNDED_MS` doc said "eight one-way delays per dial", which step 4's fresh dial (ten) no longer fits; it now says so.

**Tripwires (kept as NOTEs, not tickets).**
- The listener window above the declared link (`link-budget.ts`, the NOTE after the listener paragraph; `docs/architecture.md`'s "Unexpected EOF" NOTE). Agreed with the implementer that this stays a tripwire: it occurs only on a link slower than the one declared, which is unsupported and already has the same failure for Optimystic's request dial; the remedy is declaring the real link. Stating a cadre-specific `inboundUpgradeTimeout` was considered and not done, because it would make the listener hold half-built connections longer on every link to cover an unsupported one.
- The hop-split NOTE (counts measured with the delay split evenly across both hops) in `link-budget.ts`'s module doc, as the plan asked.

**Major findings / tickets filed.** None: no defect found that needs work beyond this pass.

**Tests.** Kept the two updated `link-budget.spec.ts` cases (formula pins and the listener containment pin, which pins a real contract against Optimystic's derivation) and the instrument assertion (pins the measured count at the supported link). No tests added: the inline fixes change no value and are covered by the existing formula pin on `relayReservationBudgetMs`.

**Docs.** `docs/architecture.md`, `docs/cadre-consistency.md`, `docs/reference-app-rn.md`, the release note and the blocked ticket `report-issue-13-address-dial-timeout-rerun` were read and reflect the new figures. No other doc states them.
