description: A deployment on a slow connection can now state how slow it is in one setting, and most of cadre's "give up reaching that machine after N seconds" limits adjust themselves to it. Three of them do not, so stating a slower connection fixes some ways of reaching another machine and leaves others failing exactly as before.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/link-budget.ts (the derivation these three should read from)
  - packages/cadre-core/src/strand-wake-protocol.ts (DEFAULT_WAKE_TIMEOUT_MS 10_000, DEFAULT_WAKE_DIAL_BUDGET_MS 20_000)
  - packages/cadre-core/src/strand-addr-protocol.ts (DEFAULT_ADDR_TIMEOUT_MS 10_000)
  - packages/cadre-core/src/seed-bootstrap.ts (DEFAULT_SEED_DELIVER_TIMEOUT_MS 10_000, and the owner-dial ack NOTE that already outgrew it)
  - docs/architecture.md (Relay Integration -> "Dial budgets are counted in round trips, not milliseconds" — the claim this ticket makes true)
severity: edge-case
likelihood: unusual
tradeoffs: Nothing is broken at the shipped default, and each of these three deadlines wraps a best-effort path that logs and carries on, so a maintainer may reasonably wait until a real slow-link deployment reports one of them firing rather than converting three more sites now — the counting exercise is judgement per site, not a mechanical substitution.

# Three more dial deadlines still ignore the declared link

## What is true today

`dial-budgets-that-count-round-trips-not-milliseconds` established one declared assumption about how long a message takes to reach another machine and come back (`NetworkConfig.linkRoundTripMs`, default 2000 ms), and made four deadlines derive themselves from it by multiplying it by the number of exchanges that operation was measured to cost. Those four are the peer-join block catch-up's dial and response deadlines, the relay reservation drive's deadline, and the control-cohort per-address and per-peer dial budgets. `packages/cadre-core/src/link-budget.ts` holds the counts.

Three other cadre-owned deadlines bound a dial and a reply over the same link and are still typed as fixed milliseconds:

| deadline | value | what it bounds |
| --- | --- | --- |
| `DEFAULT_WAKE_TIMEOUT_MS` | 10 000 ms | one attempt at waking a sleeping machine — dial plus ack. Candidates are dialed serially with the relay/signaling address FIRST, so the first attempt is precisely a relayed dial. |
| `DEFAULT_WAKE_DIAL_BUDGET_MS` | 20 000 ms | the whole wake call — deliberately two of the above |
| `DEFAULT_ADDR_TIMEOUT_MS` | 10 000 ms | asking another machine for a workspace's network addresses — dial plus response |
| `DEFAULT_SEED_DELIVER_TIMEOUT_MS` | 10 000 ms | handing another machine a seed — dial plus ack |

(The `*_READ_TIMEOUT_MS` constants beside them are receiver-side caps on how long an inbound frame may take to arrive. They are a different question and are deliberately not in scope here.)

## Why it matters

The whole point of the declaration is that one number moves every deadline that bounds reaching another machine. Right now it moves some of them. A deployment that declares `linkRoundTripMs: 3000` because its machines really are that far apart gets a catch-up, a reservation drive and a cohort dial that all widen to 12 000 ms, while waking a machine, asking for its addresses and delivering a seed keep a fixed 10 000 ms — which at four exchanges per relayed connection cannot open one above about 1 250 ms of one-way delay. So the very deployment the setting exists for gets a partial fix, and the paths that still fail do so the way a relayed dial always fails: the peer looks absent rather than slow.

Nothing is wrong at the shipped default of 2000 ms, which is why this is not filed as a bug. It becomes wrong the first time someone uses the setting for its stated purpose.

There is a second, smaller arm at the seed site that is already true at the default. `seed-bootstrap.ts` notes that an unreachable owner can hold the receiver's ack for the whole owner-dial budget — which this change made derived, so it is 32 000 ms at the default and grows with any declaration — while the sender abandons the delivery at a fixed 10 000 ms. That mismatch predates the change; what is new is that one side of it now moves and the other does not, so the gap widens with every declaration. Either the deliver deadline is counted from the same declaration, or the receiver acks before dialing (which that NOTE already proposes).

## What a fix looks like

The root of it is not any one of these three numbers — it is that `link-budget.ts` states a rule ("this module is the only place a new dial's budget should be written") that nothing enforces and that three pre-existing sites do not follow. Two things, in order of value:

- Give each of the three a round-trip count and derive it, the way the four converted sites were: name what the operation actually costs in exchanges, put the count in `link-budget.ts` beside the others, and thread the host's declaration to the call site. The wake budget is already expressed as "two attempts", so it should stay two of whatever one attempt derives to rather than becoming an independent number.
- Then make the rule checkable, so the next dial added does not reintroduce the class. The cheapest shape is a check that no constant in `packages/cadre-core/src` whose name says it bounds a dial is assigned a numeric literal — the four converted sites are already assignments from a `link-budget.ts` function, so the idiom to match exists. Without something like that, this ticket is the second instance of a class that will get a third.

No repro to run: the values are read off the named constants, and the four-exchange cost of a relayed connection is the measurement in `packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts` (opt-in, `RELAY_DIAL_COST=1`), not a new one.

## Related, but not this

`debt-cadre-deadlines-sized-against-old-optimystic-bounds` also names `seed-bootstrap.ts`, and both tickets are about deadlines that were chosen without reference to something underneath them. They do not resolve at the same site. That one is about cadre's READ and COMMIT deadlines against Optimystic's per-peer and per-round bounds, and its fix is a written-down ladder plus a per-site decision about intent. This one is about DIAL deadlines against the declared link, and its fix is arithmetic in `link-budget.ts`. The seed site appears in both because it has one deadline of each kind.
