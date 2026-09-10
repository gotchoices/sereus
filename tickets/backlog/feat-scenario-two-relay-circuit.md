description: We have only ever tested two phones that happen to use the SAME forwarding server. In real life each phone picks its own, and nobody has checked that two people on different forwarding servers can still reach each other.
files: packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, packages/integration-tests/src/harness/dedicated-relay.ts, docs/testing.md, docs/strands.md, docs/architecture.md
difficulty: medium
tradeoffs: Nothing in the product picks a relay for a user yet — every deployment configures one by hand, so "both phones on the same relay" is the only shape anyone can ship today, and a maintainer may reasonably wait until relay selection or roaming exists before paying for a second relay in the suite.
----

# Two phones, two different relays

## Why this is the ordinary case, not an exotic one

Both relay scenarios in the suite stand up ONE relay and point both machines at it:

- `strand-circuit-same-party-e2e.integration.ts` — one party's two machines.
- `blind-relay-phone-to-phone-e2e.integration.ts` — two different parties, two strangers.

That is the convenient shape, not the expected one. A relay is infrastructure a user's app
picks (or is handed by its vendor); two strangers meeting through an invitation have no
reason to have picked the same one. The moment they haven't, the path between them is
asymmetric in a way neither existing scenario exercises:

- A holds a reservation on relay 1, so every address A can publish names relay 1.
- B holds a reservation on relay 2, so every address B can publish names relay 2.
- B reaching A means B dialling *through relay 1*, where B has no reservation and is
  simply a client of the hop.
- A reaching B means A dialling *through relay 2*, symmetrically.
- Each side therefore has to hold, at once, an outbound connection to a relay it does not
  reserve on and an inbound-carrying reservation on the one it does.

Nothing says this fails. It is a plain libp2p circuit dial, and the addresses that would
drive it are exactly the ones the existing scenarios already prove are carried correctly
(the invitation's bootstrap address, and the formation result's `strandAddrs`). But it has
never been run, and the failure modes it could hide are not cosmetic: a node that refuses
to dial a relay it does not reserve on, an address-book or announce path that assumes one
relay per node, or a reservation-slot accounting that double-counts.

## What the scenario should establish

Start from `blind-relay-phone-to-phone-e2e.integration.ts` — same two-strangers,
`listenAddrs: []`, closed-strand, formation-carried-seed flow — and change exactly one
thing: two `startDedicatedRelay()` fixtures, A pointed at the first and B at the second.
Then answer:

- Does the control-plane formation dial succeed across the relay boundary at all?
- Does the strand mesh form both ways from the formation-carried seed alone, with no
  hand-dial — the property the one-relay scenario proves?
- Do rows replicate in both directions?
- Is every cross-party connection still classified `relayed` and UNLIMITED on both ends?
- What is the reservation count **per relay**? The one-relay measurement is 4 on one relay
  (2 control + 2 strand); the expectation here is 2 and 2, but that is a prediction, not a
  measurement, and the measured answer is part of what the scenario is for.
- Does the final "nothing direct except to a relay" sweep still hold when there are two
  relays a node may legitimately hold a direct connection to?

## Use cases

- Two people who downloaded the same app from different vendors, or configured different
  relay hosts, forming a workspace.
- A party that later moves to a different relay — the roaming story is unsolved, but the
  first question it runs into ("can the two ends even be on different relays?") is this
  one, and answering it here removes a variable from that design.

## Notes

- Untested is recorded today in `docs/testing.md` (the uncovered list), `docs/strands.md`
  (SN–SN use case, "Still open"), `docs/architecture.md` (Relay Integration) and the
  scenario file's own header. All four should be updated when this lands.
- The relay fixture (`harness/dedicated-relay.ts`) already binds an ephemeral port per
  instance, so two concurrent relays need no new harness work.
- If the answer turns out to be "it does not work", this ticket produces a bug ticket plus
  a scenario pinning today's behaviour — not a silent skip.
