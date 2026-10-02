description: When a machine connects to another through a relay it is not yet connected to, it first has to connect to the relay, and the relay may also decide whether to let it in. Cadre's connection time limits do not count that first step, so on the slowest link sereus supports such a connection can time out even though it would have succeeded. Count that step in every relayed connection time limit.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (RELAYED_DIAL_ROUND_TRIPS, DIAL_ADMISSION_DECISIONS, relayedDialBudgetMs and the three budgets built on it; module doc's count table, "The listener's admission decision" section and its NOTE at ~99-104; the inboundUpgradeTimeout paragraph at ~153-164; RELAY_RESERVATION_ROUND_TRIPS doc)
  - packages/cadre-core/test/link-budget.spec.ts (~39-53 formula pins, ~67-76 listener containment)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (step 4 "fresh relayed dial" already added by the fix stage; doc comment needs the record and the cadre arm an assertion)
  - packages/cadre-core/src/peer-dial.ts (~38-68 doc), peer-join-backfill.ts (~178-181), seed-bootstrap.ts (~212, ~1141), strand-addr-protocol.ts (~390, ~437), strand-wake-protocol.ts (~65 doc), strand-formation-deadlines.ts (~120-125 figures), cadre-node.ts (~6336-6338, ~7136), control-cohort.ts (~35), types.ts (~579), index.ts (exports)
  - packages/reference-app-rn/src/host-node-request.ts (~96, ~400: the 64 s per-peer figure)
  - docs/architecture.md (~298, ~906, ~1471, ~1481, ~1483, ~1485, ~1491), docs/cadre-consistency.md (~70, ~77), .release-notes.pending.md
  - tickets/blocked/report-issue-13-address-dial-timeout-rerun.md (line 19 points at this ticket with the old 19.5 s formation figure)
repro: verified
----
# Count opening the relay connection in every relayed dial budget

## What was measured

`relayed-dial-cost-by-latency.integration.ts` now has a step 4: a third node that has never connected to the relay dials the listener's circuit address, so libp2p's circuit transport opens the relay connection on that same dial (`@libp2p/circuit-relay-v2` `dist/src/transport/index.js` ~127-136: `connectionManager.openConnection(relayPeer, options)`, with the caller's signal). The fix stage added that step and ran it once:

`RELAY_DIAL_COST=1 RELAY_DIAL_COST_DELAYS=1500 yarn workspace @serfab/integration-tests exec vitest run relayed-dial-cost-by-latency`, 2026-10-01, same Windows machine as the earlier records, libp2p 3.3.11, `@optimystic/*` 1.9.0. `cadre-core declared` arm:

| operation | ms |
| --- | --- |
| dial the relay (dialer) | 3 029 |
| relayed dial, relay connection already open | 12 072 (12 086 and 12 094 in the two re-dials) |
| **relayed dial, no relay connection open yet** | **15 113** |

15 113 ≈ 12 072 + 3 029 + 12: exactly ten one-way delays, which is five link round trips (one to the relay, four through it). The `db-p2p fallback` arm's fresh dial stopped at libp2p's 6 000 ms per-address limit, as every other dial in that arm does. Log: `tickets/.logs/relayed-dial-budget-omits-opening-the-relay-connection.fix.measure.log`.

So at the default declaration the 16 000 ms budget (`relayedDialBudgetMs`: 4 × 3 500 + 2 000) leaves 887 ms for admission decisions on such a dial, where it is meant to leave 2 000 ms for the called machine's alone, and nothing for a party-run relay's. A decision slower than about 0.9 s (a control node's membership read that still consults the cohort during bring-up) turns a working dial into a timeout that looks like an absent peer. The gate-decision part is inferred from the code (`membership-connection-gater.ts` runs `denyInboundEncryptedConnection` on the relay's inbound connection from the dialer, up to `ADMISSION_DECISION_TIMEOUT_MS`), not observed: the instrument is bare libp2p and runs no gate.

## Who dials a relay it holds no connection to

Common, not exotic: a joiner dialing an inviter's machine through the inviter's party relay (strand formation, `formationDeadlines().dialMs`); a strand node dialing another party's strand node through that party's relay; a control node with a public address dialing a relay-only sibling through a relay it holds no reservation on; a new machine applying a seed and dialing its owners' circuit addresses. `peer-dial.ts`'s doc already says the per-address limit covers "connect to the relay ... when no relay connection is open yet"; today the count does not.

## Decision: count it (not "document reused-connection only")

Every cadre budget that opens a possibly relayed connection must hold for the dial that opens its relay connection first, because cadre cannot know beforehand whether one is open, and a budget that is too short fails as silently as an absent peer. Optimystic's own dial derivation (10 round trips) and cadre's `optimysticDialLimits` (plus `DIAL_ADMISSION_DECISIONS` = 2) already budget this case; cadre's own budgets are the only ones that do not.

### The counts

In `link-budget.ts`:

- `CIRCUIT_DIAL_ROUND_TRIPS = 4` — opening a relayed connection over a relay connection the dialer already holds (the measured 12 072-12 094 ms). This is today's `RELAYED_DIAL_ROUND_TRIPS` renamed.
- `RELAY_DIAL_ROUND_TRIPS = 1` — the dialer opening its own connection to the relay (the measured 3 029-3 037 ms; the table's "dial the relay itself" row).
- `RELAYED_DIAL_ROUND_TRIPS = RELAY_DIAL_ROUND_TRIPS + CIRCUIT_DIAL_ROUND_TRIPS` = 5 — what a relayed dial is budgeted for (the measured 15 113 ms).
- `relayedDialBudgetMs(r) = RELAYED_DIAL_ROUND_TRIPS * r + DIAL_ADMISSION_DECISIONS * ADMISSION_DECISION_TIMEOUT_MS`. Move `DIAL_ADMISSION_DECISIONS` above it; its doc already names exactly these two gates (a party-run relay's on the dialer's connection to it, then the called machine's). One allowance per gate keeps the budget valid at every declaration, matching how `relayReservationBudgetMs` counts two.

`RELAYED_REQUEST_ROUND_TRIPS` becomes 7 by construction. `RELAY_RESERVATION_ROUND_TRIPS` stays 4 but its doc must stop calling 4 "the relayed-dial count"; its reason (rediscovery repeats both 1-round-trip legs) stands on its own.

### What moves, at the default 3 500 ms declaration

| budget | now | after |
| --- | --- | --- |
| `relayedDialBudgetMs` — control-cohort per-address dial, peer-join push dial | 16 000 | 21 500 |
| control-cohort per-peer dial (4 addresses) | 64 000 | 86 000 |
| `relayedStreamOpenBudgetMs` — strand formation dial | 19 500 | 25 000 |
| `relayedRequestBudgetMs` — wake, strand-address, seed delivery attempts | 23 000 | 28 500 |
| wake's two attempts | 46 000 | 57 000 |
| formation session (`formationDeadlines().sessionMs`) | 208 000 | 213 500 |

Recompute each figure from the code rather than trusting this table; the formation ordering (`strand-formation-deadlines.spec.ts`) holds at every declaration because the dial only adds to the initiator's side, but run it.

Cost: a peer that is truly gone takes 5.5 s longer per address to give up on. That is the ticket's stated tradeoff, accepted here because the alternative is a budget that fails good dials at the supported link.

### The listener containment pin changes meaning

`link-budget.spec.ts` ~67-76 pins Optimystic's `inboundUpgradeTimeoutMs` (5 round trips, floor 10 000) ≥ `relayedDialBudgetMs` at every declaration. After the change that pin fails (5 r ≥ 5 r + 4 000 is false), and it should change rather than the budget: the listener's timer starts when the relay hands it the inbound circuit, so it never covers the dialer's relay leg or the relay's decision. The pin becomes `inboundUpgradeTimeoutMs ≥ CIRCUIT_DIAL_ROUND_TRIPS * r + ADMISSION_DECISION_TIMEOUT_MS` (inline in the spec; no exported function just for it). Update the module doc's paragraph (~153-164), `docs/architecture.md` ~1485 and ~1491 ("at four round trips plus one decision"), and `docs/cadre-consistency.md` ~77 to say the listener contains the part of the dial its clock covers, not the whole budget.

## Out of scope, park as a tripwire

The counts were measured with the delay split evenly across both hops (the instrument delays each node's own dialed socket by the same one-way figure). On a link whose whole round trip sits on one machine's hop to the relay (a phone on a congested mobile link, the case `RELAY_RESERVE_REQUEST_ROUND_TRIPS`'s doc already takes), exchanges that cross only that hop — the relay dial, the hop-stream negotiation and CONNECT — cost up to twice their share. Not measured. Add a `NOTE:` at the counts saying so, with the revisit condition (relayed dials seen failing near the budget on such a link: measure that split before raising anything).

## TODO

- In `link-budget.ts`, add `CIRCUIT_DIAL_ROUND_TRIPS` (4) and `RELAY_DIAL_ROUND_TRIPS` (1), define `RELAYED_DIAL_ROUND_TRIPS` as their sum, move `DIAL_ADMISSION_DECISIONS` above `relayedDialBudgetMs` and use it there. Update every doc in the module that states the old figures: the count table (add the 5-round-trip row; keep "dial the relay itself"), "The listener's admission decision" section (one allowance per gate, now two), the `DECLARED_LINK_ROUND_TRIP_MS` doc's "1.9 s over that dial" headroom (recompute against 15 113: 17 500 − 15 113 ≈ 2.4 s), `relayedDialBudgetMs`'s cost paragraph, `relayedStreamOpenBudgetMs` / `relayedRequestBudgetMs` figures, the inboundUpgradeTimeout paragraph, and `RELAY_RESERVATION_ROUND_TRIPS`'s doc. Delete the NOTE at ~99-104 (this ticket resolves it). Add the hop-split `NOTE:` described above.
- Export the new constants from `packages/cadre-core/src/index.ts` next to `RELAYED_DIAL_ROUND_TRIPS`.
- `link-budget.spec.ts`: update the formula pins to the new expressions (`DIAL_ADMISSION_DECISIONS`), and change the listener containment pin to the circuit leg plus one decision, with its test name and comment saying why.
- Latency instrument: add the 2026-10-01 fresh-dial record above to its doc comment (the measurement table gains a column or a sentence; the "budgets in force" table's first row changes to five round trips plus two decisions, 21.5 s, and its "impossible above" figure: (21 500 − 4 000) / 10 = 1 750 ms one-way through two gates, 2 150 ms through none). In the `cadre-core declared` arm's assertion block, assert the fresh dial completes (`typeof measured[FRESH_RELAYED_DIAL] === 'number'`) and stays under `RELAYED_DIAL_ROUND_TRIPS * DECLARED_LINK_ROUND_TRIP_MS` (import from `@serfab/cadre-core`), so a libp2p change that moves the count fails here.
- Update every stale figure listed in `files:` (16 000 / 16 s, 19.5 s, 23 000 / 23 s, 46 s, 64 000 / 64 s, "four link round trips", "six round trips") to the recomputed values. Grep again after editing: `grep -rn "16 000\|16_000\|19 500\|19\.5 s\|23 000\|23 s\b\|46 s\|64 000\|64 s\b\|six round trips\|four link round trips" packages/*/src docs .release-notes.pending.md`.
- Add a `.release-notes.pending.md` entry: relayed connection limits now include connecting to the relay and the relay's admission decision; a machine that is gone takes about 5.5 s longer per address to give up on (figures at the default declaration).
- Update `tickets/blocked/report-issue-13-address-dial-timeout-rerun.md` line 19: the formation dial is now 25 s and already covers a joiner opening its relay connection, so drop the pointer to this ticket.
- Run `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn lint`, `yarn workspace @serfab/cadre-core test`, and the instrument at `RELAY_DIAL_COST_DELAYS=1500` (about 2 minutes).
