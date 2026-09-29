description: When a machine connects to another through a relay it has not yet connected to, it first has to connect to the relay, and the relay may also decide whether to let it in. The connection time limits do not count that first step, so on the slowest link sereus supports such a connection can time out even though it would have succeeded.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (RELAYED_DIAL_ROUND_TRIPS, relayedDialBudgetMs, the module doc's count table and its NOTE on the measured dial)
  - packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts (the instrument: dials the relay before the timed relayed dial, lines ~273-286)
  - node_modules/@libp2p/circuit-relay-v2/dist/src/transport/index.js (~129: a circuit dial opens the relay connection itself when none is open)
  - packages/cadre-core/src/membership-connection-gater.ts (the relay's own inbound gate, when the relay is a party-run control node)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Counting the relay leg lengthens every dial budget by another link round trip (and possibly another decision), so a peer that is truly gone takes longer still to give up on — per-address 16 s would become about 19.5-21.5 s — for a case that needs both the extreme supported link and a dialer with no open connection to the relay.
----
# A relayed dial's budget assumes the relay connection is already open

## What is counted

`link-budget.ts` budgets opening a relayed connection at `RELAYED_DIAL_ROUND_TRIPS` (4) link round trips plus one `ADMISSION_DECISION_TIMEOUT_MS` (2 000 ms) for the called machine's connection gate: 16 000 ms at the default declared round trip of 3 500 ms. The 4 comes from `relayed-dial-cost-by-latency.integration.ts`, which measured 12 094 ms at the supported 3-second round trip.

## What the measurement left out

That instrument connects the dialer to the relay (and times it separately: "dial the relay", 3 037 ms at 1 500 ms one-way) **before** the timed relayed dial. So the 12 094 ms is a relayed dial over a relay connection the dialer already held.

libp2p's circuit transport opens the relay connection on the same dial when none is open (`@libp2p/circuit-relay-v2` `transport/index.js` ~129, `connectionManager.openConnection(relayPeer, options)` with the caller's signal). That costs one more link round trip (the module's own table: "dial the relay itself: 1"). When the relay is a party-run control node, its connection gate (`membership-connection-gater.ts`, `denyInboundEncryptedConnection`, up to 2 000 ms before failing open) also runs on that dial's clock.

## Arithmetic at the supported link

Fresh relayed dial: about 12 094 + 3 037 ≈ 15 130 ms of link time, against a 16 000 ms budget. That leaves about 0.87 s for both the relay's decision (if party-run) and the called machine's decision, where the budget meant to give the called machine 2 s. A slow decision during bring-up (a membership read that consults the cohort) therefore makes a good fresh relayed dial time out as if the peer were absent. Not observed; derived from the measured figures and the libp2p call order.

## Who dials a relay it is not connected to

- A strand node dialing another party's strand node through that party's relay (peer-book circuit addresses). When that relay is party-run, a stranger's hop connection has a separate, tracked problem: `bug-party-run-relay-drops-a-stranger-dialing-through-it`.
- A control node with a public address dialing a relay-only sibling through a party relay it holds no reservation on.

## Expected behaviour

Every relayed dial budget holds by construction for a dial that must first open its relay connection, at every declaration: one more link round trip in the count, and one more admission allowance where the relay may run a gate — or an explicit, documented decision that cadre only budgets the reused-relay-connection case, with the reason.
