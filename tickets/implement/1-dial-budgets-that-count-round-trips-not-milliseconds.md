description: Reaching another machine through a relay takes a fixed number of back-and-forth exchanges, so on a slow connection it takes proportionally longer — but the limits our code gives it are fixed numbers of seconds, chosen for a fast local network. The most important of them is short enough that copying a workspace's data to a machine that just rejoined has never once worked over a relay. Derive those limits from one stated assumption about connection speed instead.
architecture: docs/architecture.md#relay-integration
files:
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (the committed opt-in measurement, and the single home of its numbers — read its doc comment first)
  - packages/cadre-core/src/peer-join-backfill.ts (DEFAULT_PEER_JOIN_BACKFILL.dialTimeoutMs 3000, responseTimeoutMs 10_000)
  - packages/cadre-core/src/relay-reservation.ts (DEFAULT_RELAY_RESERVE_TIMEOUT_MS 10_000, bounding dial + reserve + wait together)
  - packages/cadre-core/src/types.ts (NetworkConfig — where the declared link assumption goes, beside cohortQueryTimeoutMs; strandBackfill / controlBackfill)
  - packages/cadre-core/src/cadre-node.ts (the control PeerJoinBackfill construction, ~line 1506; reserveRelays / the control relay drive)
  - packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime — the strand PeerJoinBackfill, ~line 848, and the per-relay supervisors)
  - packages/cadre-core/src/peer-dial.ts (DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS 30_000 / DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS 8_000 — read and decide, may need no change)
  - docs/testing.md ("Where measurements live" — already points at the instrument)
  - docs/architecture.md#relay-integration
difficulty: medium
----

# Cadre's own dial budgets should be derived from a declared link round trip

## The measurement this rests on

`packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts` is committed and opt-in (`RELAY_DIAL_COST=1`). Its doc comment holds the numbers and is their only home; read it before changing anything here. The one sentence that matters:

**Opening a connection to another machine through a relay costs a fixed number of exchanges — measured at 8 one-way link delays — so any budget expressed in milliseconds has a link speed above which it can never open one.** Measured: 26 ms at no delay, 7.3 s at 900 ms one-way, 12.1 s at 1500 ms one-way, on one Windows machine over the loopback dedicated relay. A direct dial to the relay costs 2 one-way delays, a reservation request on an already-open relay connection 2, and a protocol negotiation over an established circuit 2.

## What is wrong, in cadre's own code

| cadre-owned budget | value | what it bounds | relayed work becomes impossible above |
| --- | --- | --- | --- |
| `DEFAULT_PEER_JOIN_BACKFILL.dialTimeoutMs` | 3 000 ms | the block catch-up's dial to one peer | **375 ms one-way (0.75 s round trip)** |
| `DEFAULT_RELAY_RESERVE_TIMEOUT_MS` | 10 000 ms | one whole reservation drive: dial the relay (2 delays) + request (2) + poll | 2 500 ms one-way (5 s round trip) |

The first is a live defect, not a future one. The peer-join block catch-up exists so that a machine which joined (or rejoined) after blocks were committed physically ends up holding them; through a relay it has **never** been able to, at any link slow enough to matter, because its dial cannot finish. The 2026-09-26 reproduction logs show exactly this at 1500 ms one-way (`dial timeout: peer=… after 3000ms`), and the measurement says the same thing would happen at any one-way delay above 375 ms — well inside the band sereus already treats as supported (the first-sync budget and the cohort read deadline were both sized against 900 ms one-way).

The second is not broken today but is the next thing to break, and it is bounded by the same arithmetic, so it belongs in the same change rather than in a ticket filed after someone hits it.

## What this ticket does NOT fix, and why it still stands alone

Two 10 000 ms budgets inside libp2p bound the same relayed dial and **cannot be reached from sereus at all**: `connectionManager.dialTimeout` (libp2p's own default, which `@optimystic/db-p2p`'s `libp2p-node-base.ts` neither sets nor exposes) and `connectionManager.inboundUpgradeTimeout` (which it sets to 10 000). Above roughly 1250 ms one-way — a 2.5 s round trip — no relayed connection can be established by this stack whatever cadre declares, and the listener's budget is what makes that failure look like nothing at all rather than like a timeout. That half needs an upstream change and a decision about how slow a link sereus intends to carry; it is `blocked/how-slow-a-relayed-link-does-sereus-carry`.

So the honest scope here is **the band from 375 ms up to about 1250 ms one-way**: links that sereus already claims to support and where the catch-up silently does not work. Say that in the code, not just here — a reader who raises these numbers and still sees a relayed dial fail at 1500 ms must be able to find out why without re-deriving it.

## Shape

One declared assumption, several derived budgets — the shape `COHORT_READ_DEADLINE_MS` and `NetworkConfig.cohortQueryTimeoutMs` already established for the cohort read deadline (`complete/declare-cohort-read-deadline-for-relayed-phones`). Reuse it rather than inventing a second idiom:

- A single declared link round trip on `NetworkConfig` — a host that knows its deployment is slower moves every budget below at once, and the default states the link sereus assumes. Name it for what it is (a link round trip), not for what it bounds.
- Each budget derived from it by the **round-trip count the measurement gives for that operation**, with the count written down next to the arithmetic. A budget's comment should say "8 round trips, because that is what a relayed dial costs — see the instrument" rather than a bare number. That is the part that stops this class coming back: the next person to widen a budget changes one declaration, and the next person to add a dial writes down its round-trip count.
- `resumeStrand` already retains `network`, so a value reaches a hibernation wake with no new plumbing. Check that claim rather than trusting this sentence.
- Keep the existing per-field overrides working (`strandBackfill` / `controlBackfill` still win over the derived value) — an integration scenario that pins its own budget must keep pinning it.

`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` (30 s total, 8 s per address) is already generous enough for the band above and may need no change; read it, decide deliberately, and record the decision where a reader meets it rather than leaving it unmentioned.

## Open question to settle while implementing, not before

The 2026-09-26 logs show the founder's strand node receiving a fresh `connection:open` for the rejoining machine's strand node roughly every 14.5 seconds for the whole 200-second run, each time re-running a catch-up that cannot succeed. `PeerJoinBackfill` only schedules from `connection:open` and from `scheduleConnectedPeers()`, and it memoizes only clean runs, so the retry is unbounded by construction. The dial that keeps succeeding is almost certainly Optimystic's block-transfer pull path, whose budget is `transferTimeoutMs ?? 30000` (`../optimystic/packages/db-p2p/src/cluster/block-transfer.ts:457`) — the only budget in the stack above the measured 12 s setup cost. Confirm that with `DEBUG='sereus:cadre*,optimystic:db-p2p:*'` before relying on it. Two things follow, and both are in scope:

- Whether a failing catch-up should back off rather than re-arm on every `connection:open`. The module's own doc comment already carries a `NOTE:` proposing a backoff re-arm for a related case; this is the case that makes it concrete.
- Whether the failure is reported well enough. Today a rejoining machine on too slow a link produces no statement that anything is wrong — the connection simply never appears, and only a `DEBUG` log names a dial timeout. Whatever this ticket cannot fix (the band above 1250 ms one-way) it should at least make legible.

## TODO

- Read `relayed-dial-cost-by-latency.integration.ts`'s doc comment, then re-run it (`RELAY_DIAL_COST=1 … vitest run relayed-dial-cost-by-latency`) so the numbers you build on are ones you have seen on this machine.
- Confirm which dial path produces the repeating `connection:open` on the founder's side, with `DEBUG='sereus:cadre*,optimystic:db-p2p:*'`. Record the answer in the ticket handoff — the review pass should not have to re-derive it.
- Add the declared link round trip to `NetworkConfig`, beside `cohortQueryTimeoutMs`, with its default stating the link sereus assumes and its doc comment naming the instrument.
- Derive `DEFAULT_PEER_JOIN_BACKFILL.dialTimeoutMs` (and weigh `responseTimeoutMs`, which bounds a data transfer rather than a dial and so has a different round-trip count) from it, keeping `strandBackfill` / `controlBackfill` overrides authoritative.
- Derive `DEFAULT_RELAY_RESERVE_TIMEOUT_MS` from it, with its 4-round-trip count written down. Check the two `NOTE:`s in `strand-instance-manager.ts` that quote "10 s" as this drive's cost (the N-strands-during-a-relay-outage one, and the strand-addr announce hook's "~30 s") and correct them if the number moves.
- Read `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` / `DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS` and either derive them too or record why they stay fixed.
- State the ceiling this change does NOT lift, at the site where the derived budgets live, pointing at `blocked/how-slow-a-relayed-link-does-sereus-carry`. A reader who widens these numbers and still cannot connect at 1500 ms one-way must land on that explanation.
- Decide on the unbounded catch-up retry: back off on a non-clean run, or state why re-arming on every connection is right. Either way the decision goes in the code, not only in the handoff.
- Tests: no new unit test for the wiring (a passthrough is what `types.spec.ts`-style tests already cover for this shape, and the existing `strand-instance-manager` / `cadre-node` option specs pin one call site each — follow whatever those two files already do for `cohortQueryTimeoutMs` and do not add a second copy). The derivation itself — round-trip count times declared round trip, and a host override winning — is arithmetic with a real branch and is worth one test at the layer that owns it.
- Run `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/cadre-core build` and `test`. Then the relayed scenario most exposed to these budgets: `blind-relay-phone-to-phone-e2e` at its committed 10 ms arm, which must not get slower for a fast link.
- Check no scenario depended on the old 3 000 ms catch-up failing fast. A catch-up that now actually pushes blocks through a relay changes what a relayed scenario observes.
