description: Cadre's time limits for connecting to another machine through a relay now count the step of first connecting to the relay itself, and the relay's decision to let the caller in, so such a connection no longer times out on the slowest link sereus supports. Review the new figures, the changed listener check, and two consequences that go past the ticket's literal scope.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (CIRCUIT_DIAL_ROUND_TRIPS, RELAY_DIAL_ROUND_TRIPS, RELAYED_DIAL_ROUND_TRIPS, DIAL_ADMISSION_DECISIONS moved above relayedDialBudgetMs; module doc's count table, "Admission decisions" section, listener paragraph and two new NOTEs)
  - packages/cadre-core/test/link-budget.spec.ts (formula pins, listener containment pin)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (fresh-dial record, budgets table, cadre arm assertions)
  - packages/cadre-core/src/index.ts (exports)
  - packages/cadre-core/src/peer-dial.ts, peer-join-backfill.ts, seed-bootstrap.ts, strand-addr-protocol.ts, strand-formation-deadlines.ts, cadre-node.ts, control-cohort.ts, push-fanout.ts, types.ts (doc figures only)
  - packages/reference-app-rn/src/host-node-request.ts (connectMs 140_000 → 180_000, and its doc)
  - docs/architecture.md, docs/cadre-consistency.md, docs/reference-app-rn.md, .release-notes.pending.md
  - tickets/blocked/report-issue-13-address-dial-timeout-rerun.md (line 19)
----
# Review: relayed dial budgets count opening the relay connection

## What changed

`link-budget.ts` now splits the relayed dial into its two measured legs and budgets both, plus both gates:

- `CIRCUIT_DIAL_ROUND_TRIPS = 4`: the connection through a relay connection the dialer already holds (measured 12 072-12 104 ms at 1 500 ms one-way).
- `RELAY_DIAL_ROUND_TRIPS = 1`: the dialer's own connection to the relay (measured 3 022-3 037 ms).
- `RELAYED_DIAL_ROUND_TRIPS = RELAY_DIAL_ROUND_TRIPS + CIRCUIT_DIAL_ROUND_TRIPS` = 5 (measured 15 113 ms, and 15 108 ms in this stage's re-run).
- `relayedDialBudgetMs(r) = 5r + DIAL_ADMISSION_DECISIONS (2) × ADMISSION_DECISION_TIMEOUT_MS (2 000)`. `RELAYED_REQUEST_ROUND_TRIPS` becomes 7 by construction. `RELAY_RESERVATION_ROUND_TRIPS` stays 4; its doc no longer calls 4 "the relayed-dial count".

Figures at the default 3 500 ms declaration, recomputed from the code (formation via a node one-liner over `formationDeadlines`' formulas):

| budget | before | after |
| --- | --- | --- |
| `relayedDialBudgetMs` (control-cohort per-address dial, peer-join push dial) | 16 000 | 21 500 |
| control-cohort per-peer dial (4 addresses) | 64 000 | 86 000 |
| `relayedStreamOpenBudgetMs` (formation dial) | 19 500 | 25 000 |
| `relayedRequestBudgetMs` (wake, strand-address, seed delivery attempt) | 23 000 | 28 500 |
| wake's two attempts | 46 000 | 57 000 |
| formation session | 208 000 | 213 500 |

Formation formulas in `strand-formation-deadlines.ts`'s doc: dial `6L + 4 000` (was `5L + 2 000`), session `14 000 + 57L` (was `12 000 + 56L`). At L = 100 the dial is 4.6 s and the session 19.7 s. `strand-formation-deadlines.spec.ts`'s ordering still passes at every declaration it tries.

The listener containment pin in `link-budget.spec.ts` changed meaning, as the ticket decided: it now checks Optimystic's `inboundUpgradeTimeoutMs ≥ CIRCUIT_DIAL_ROUND_TRIPS × r + ADMISSION_DECISION_TIMEOUT_MS` (inline in the spec), because the listener's timer starts when the relay hands it the circuit and never covers the dialer's relay leg or the relay's decision. The module doc, `docs/architecture.md` and `docs/cadre-consistency.md` say the listener contains the part of the dial its clock covers, not the whole budget.

Two `NOTE:`s added to the module doc: the hop-split tripwire the ticket asked for (counts measured with the delay split evenly across both hops; a link whose delay sits on one machine's hop to the relay is not measured), and the listener window described under "Gaps" below. The NOTE that pointed at this ticket is deleted.

## Tests

- `link-budget.spec.ts` "multiplies each operation's round-trip count…": the dial, request and stream-open pins now use `DIAL_ADMISSION_DECISIONS × ADMISSION_DECISION_TIMEOUT_MS`. Updated, not new.
- `link-budget.spec.ts` "gets a listener limit from Optimystic that outlasts the part of a relayed dial its clock covers…": the containment pin, changed to the circuit leg plus one decision. Updated, not new.
- `relayed-dial-cost-by-latency.integration.ts` (opt-in, `RELAY_DIAL_COST=1`), `cadre-core declared` arm: now asserts the fresh relayed dial (step 4, a node holding no relay connection) completes and stays under `RELAYED_DIAL_ROUND_TRIPS × DECLARED_LINK_ROUND_TRIP_MS` (17 500 ms), so a libp2p change that adds a round trip fails at the supported link. Ran at `RELAY_DIAL_COST_DELAYS=1500`: passed, fresh dial 15 108 ms, both arms green (115 s). Log: `tickets/.logs/relayed-dial-budget-omits-opening-the-relay-connection.implement.measure.log`.

No new test files.

## Validation run

- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/reference-app-rn typecheck`: clean.
- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core test`: 149 files, 2 364 passed, 1 skipped.
- `yarn workspace @serfab/reference-app-rn exec vitest run host-node-request`: 34 passed.
- `yarn workspace @serfab/cadre-core build` (so the instrument runs against the new counts), then the instrument above.
- The instrument was not run at 0 or 900 ms one-way.

## Gaps and judgment calls for the reviewer

- **A new silent-failure window above the declared link.** The ticket kept Optimystic's listener limit (5 round trips, 17 500 ms at the default) and grew the dial budget (21 500 ms). At or below the declared link the listener still contains its part of every dial. On a link slower than declared, a dial over a relay connection the dialer already holds now outlasts the listener's limit before its own budget runs out: at the default, between about a 4.4 s and a 5.4 s round trip, computed from the counts, not measured. That dial resolves and its streams die with `Unexpected EOF`, rather than timing out. Before this change cadre's budget (16 000) ran out first there. I recorded it as a `NOTE:` in `link-budget.ts` beside the listener paragraph and widened the NOTE in `docs/architecture.md` (the "Unexpected EOF" one below "Dial budgets are counted in round trips"), rewriting that section's claim that cadre's budgets "run out first" above the ceiling. Decide whether this stays a tripwire (links slower than declared are unsupported, and the remedy is declaring the real link) or needs cadre to state its own `inboundUpgradeTimeout`.
- **Reference app connect wait raised, 140 s → 180 s** (`host-node-request.ts` `DEFAULT_BUDGETS.connectMs`, `docs/reference-app-rn.md`'s troubleshooting entry). Its doc sizes it as two whole per-peer dials, which went 64 s → 86 s; leaving 140 s would make that doc false. The cost is a person waiting 40 s longer before the "could not reach it" message. The file must import nothing at runtime, so it cannot derive the value from cadre-core.
- **Removed a historical parenthetical** from `DECLARED_LINK_ROUND_TRIP_MS`'s doc ("the previous 2 000 … with about 720 ms to spare"): it measured headroom against the 4-round-trip dial, which is no longer what "that dial" means there.
- **Release note** added to `.release-notes.pending.md` ("Relayed connection limits include connecting to the relay"), listing the moved figures and the `RELAYED_DIAL_ROUND_TRIPS` 4 → 5 change for embedders.
- **The relay's admission decision is inferred, not observed:** the instrument is bare libp2p and runs no gate. The budget counts it from the code (`membership-connection-gater.ts` gates the relay's inbound connection from the dialer).
- **Commit history:** a concurrent runner commit (`67420946`, "tess: triage pre-existing test failure") picked up most of this ticket's working-tree edits while I was mid-ticket. The diff for this ticket is therefore split between that commit and the runner's commit for this stage; review both together (`git diff cc8768e1..` over the files above).
