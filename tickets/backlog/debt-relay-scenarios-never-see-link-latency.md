description: Relay tests can now be run with a slow network, but only by slowing every machine in the test at once. There is no way to model the realistic case of one slow phone talking to a fast desktop, which is where the worst delays were seen on real devices.
architecture: docs/testing.md#topology-coverage-map
files:
  - packages/integration-tests/src/harness/ws-latency.ts (the fixture that landed; process-wide by construction)
  - packages/integration-tests/src/harness/dedicated-relay.ts (one listen address today; the recommended design gives it several)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (first user; its latency arm runs at 10 ms)
  - docs/testing.md (topology coverage map; "Where measurements live")
tradeoffs: The symmetric everything-is-slow case that already landed is the harsher one, so the asymmetric shape may never catch a defect the existing arm misses — and the relay fixture change it needs is real work.
----

# Relay scenarios cannot model one slow machine and one fast one

## What already landed

`packages/integration-tests/src/harness/ws-latency.ts` adds per-frame outbound delay to every WebSocket the test process dials, and `blind-relay-phone-to-phone-e2e.integration.ts` commits an arm at 10 ms of one-way latency. Relay scenarios are no longer blind to link delay in general. The measurements and the two delay modes are written up in `docs/testing.md` → "Where measurements live".

## What is still missing

The fixture swaps the global `WebSocket` constructor, which cannot tell one node's sockets from another's, so a delay applies to every machine in the process equally. The original motivation was asymmetric: the cross-party device run (`tickets/complete/rn-cross-party-relay-run.md`) delivered phone messages 1–4 minutes late with a phone on one end and an ordinary machine on the other, and the headless investigation for `rn-chat-poll-overlaps-slow-reads` reproduced the class by adding 150 ms each way **on one node's relay link only**. That shape — a slow phone talking to a fast desktop, where one side's queue builds while the other's does not — is still uncovered.

## Expected behaviour

A scenario can say "party A's link is slow, party B's is not" and assert bounds on it: for example that a row written on the slow party is visible to the fast one within N seconds at 150 ms, plus a check that the delayed path was actually the one used (a run where the delay was silently bypassed must fail, not pass quickly).

## Recommended design, not yet prototyped

Give `DedicatedRelay` more than one listen address and hand each node its own. The shim already sees the dial URI, so it can key a different delay off the destination port. Nothing can bypass it: a node that learns the relay's real port from another party's circuit addresses and dials it directly still goes through the same global constructor. The cost is the relay fixture change plus per-port bookkeeping in the shim.

## Rejected, with the reason recorded

A delaying TCP proxy per node, which is what the ad-hoc version of this used, does not work here:

- A node opened a direct connection to the relay's real port — learned from the other party's circuit addresses — and bypassed the proxy entirely: the proxy's byte counter fell to zero while operations kept succeeding quickly.
- Refusing those direct dials with a connection gater (`denyDialMultiaddr` on the real port, circuit addresses allowed) produced `cohort-unreachable` and `Failed to get super-majority` failures the device run never showed, so the gater changes behaviour and is not a faithful model.
- A proxy also has to keep chunk order by hand (queue each chunk with its due time, write sequentially), which the constructor shim gets for free.
