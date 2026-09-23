description: A measurement tool can now put one party on a slow link while the other stays fast, but no test asserts anything about it. Nothing yet fails when a message from a slow phone takes too long to reach a fast desktop, which is where the worst delays were seen on real devices.
architecture: docs/testing.md#topology-coverage-map
files:
  - packages/integration-tests/src/harness/ws-latency.ts (the fixture that landed; process-wide by construction)
  - packages/integration-tests/src/harness/counting-proxy.ts (the per-link delaying proxy that landed later; measures, does not assert)
  - packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts (its only user; opt-in measurement)
  - packages/integration-tests/src/harness/dedicated-relay.ts (one listen address today; the recommended design gives it several)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (first user; its latency arm runs at 10 ms)
  - docs/testing.md (topology coverage map; "Where measurements live")
tradeoffs: The symmetric everything-is-slow case that already landed is the harsher one, so the asymmetric shape may never catch a defect the existing arm misses — and the relay fixture change it needs is real work.
----

# Relay scenarios cannot model one slow machine and one fast one

## What already landed

`packages/integration-tests/src/harness/ws-latency.ts` adds per-frame outbound delay to every WebSocket the test process dials, and `blind-relay-phone-to-phone-e2e.integration.ts` commits an arm at 10 ms of one-way latency. Relay scenarios are no longer blind to link delay in general. The measurements and the two delay modes are written up in `docs/testing.md` → "Where measurements live".

## What is still missing

The fixture swaps the global `WebSocket` constructor, which cannot tell one node's sockets from another's, so a delay applies to every machine in the process equally. The original motivation was asymmetric: the cross-party device run (`tickets/complete/rn-cross-party-relay-run.md`) delivered phone messages 1–4 minutes late with a phone on one end and an ordinary machine on the other, and the headless investigation for `rn-chat-poll-overlaps-slow-reads` reproduced the class by adding 150 ms each way **on one node's relay link only**. No committed TEST covers that shape — one side's queue building while the other's does not — even now that the instrument for it exists (see the section below).

## Expected behaviour

A scenario can say "party A's link is slow, party B's is not" and assert bounds on it: for example that a row written on the slow party is visible to the fast one within N seconds at 150 ms, plus a check that the delayed path was actually the one used (a run where the delay was silently bypassed must fail, not pass quickly).

## Recommended design, not yet prototyped

Give `DedicatedRelay` more than one listen address and hand each node its own. The shim already sees the dial URI, so it can key a different delay off the destination port. Nothing can bypass it: a node that learns the relay's real port from another party's circuit addresses and dials it directly still goes through the same global constructor. The cost is the relay fixture change plus per-port bookkeeping in the shim.

## The per-link proxy this ticket once rejected has since landed (2026-09-23)

`packages/integration-tests/src/harness/counting-proxy.ts` is a delaying, counting TCP proxy per link plus the `denyDialMultiaddr` gater, used by `scenarios/relay-round-trip-measure.integration.ts` to run one party at 150 ms each way while the other stays fast. That is the asymmetric shape this ticket asks for, so the three reasons recorded below for rejecting the approach have to be read against what happened:

- **The bypass no longer reproduces.** Removing the gater and running two of the measurement's configurations left every path on the proxy port; libp2p had no reason to re-dial a peer it was already connected to.
- **The gater no longer changes behaviour.** Six gated runs at optimystic `9e5c1e85` produced no `cohort-unreachable`, no super-majority shortfall and no error of any kind. The failures recorded below were seen before the upstream cohort fixes.
- **Chunk order is kept, but only by accident of a constant delay** — node fires equal-duration timers in insertion order. A jittered delay would still need the hand-written queue.

**What is still missing is the ASSERTING fixture, not the instrument.** The measurement scenario deliberately asserts no bound on anything; this ticket's expected behaviour — "a row written on the slow party is visible to the fast one within N seconds at 150 ms" — remains uncovered, and can now be built either on the proxy or on the multi-listen-address design below. Whoever picks this up should compare the two rather than assume the proxy is out.

## Rejected in 2026-09-21, kept as the record of why

A delaying TCP proxy per node, which is what the ad-hoc version of this used, was judged not to work here:

- A node opened a direct connection to the relay's real port — learned from the other party's circuit addresses — and bypassed the proxy entirely: the proxy's byte counter fell to zero while operations kept succeeding quickly.
- Refusing those direct dials with a connection gater (`denyDialMultiaddr` on the real port, circuit addresses allowed) produced `cohort-unreachable` and `Failed to get super-majority` failures the device run never showed, so the gater changes behaviour and is not a faithful model.
- A proxy also has to keep chunk order by hand (queue each chunk with its due time, write sequentially), which the constructor shim gets for free.
