description: Every relay test runs over the local machine with almost no delay, so problems that only show on a real phone's slower link (reads piling up, writes taking minutes) pass every test and are first seen on a device. The test harness needs a way to add a realistic delay to one node's connection.
files:
  - packages/integration-tests/src/harness/dedicated-relay.ts
  - packages/integration-tests/src/harness/node-fixtures.ts (`controlNodeConfig`; already has `storageOpDelayMs` for slow storage, nothing for slow links)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (first user)
  - docs/testing.md (topology coverage map)
tradeoffs: A delayed scenario runs minutes rather than seconds and its timings are noisy, so it can only assert that latency stays bounded rather than exact numbers, and a device run may catch the same class more cheaply.
----

# Relay scenarios never run with link latency

## Why

The cross-party device run (`tickets/complete/rn-cross-party-relay-run.md`) delivered phone messages 1–4 minutes late. `blind-relay-phone-to-phone-e2e` covers the same topology and passes in about 2 s, because its gates only check that data arrives within 60 s and loopback adds no delay. The headless investigation for `implement/rn-chat-poll-overlaps-slow-reads` showed the problem appears once 150 ms each way is added on one node's relay link. With no delay, the same code looked fine.

## What is needed

A harness fixture that adds delay to one node's traffic to the relay, so a scenario can model "phone behind a relay" while the other party stays on loopback. It should be usable by the blind-relay scenario and the same-party circuit scenario.

## Known pitfalls, from the ad-hoc version

- A TCP proxy in front of the relay's WebSocket port, used as that node's `relayAddrs` entry, works at first. The node then opened a direct connection to the relay's real port, learned from the other party's circuit addresses, and bypassed the proxy: the proxy's byte counter went to 0 while operations kept succeeding quickly. The fixture must make that impossible, or assert it didn't happen.
- Refusing those direct dials with a connection gater (`denyDialMultiaddr` on the real port, circuit addresses allowed) produced `cohort-unreachable` and `Failed to get super-majority` failures that the device run never showed. So the gater changed behaviour and is not a faithful model. Candidates: have the relay listen only behind the proxy and give the undelayed party its own zero-delay proxy, or add the delay inside the node's transport instead of on the socket.
- The proxy must keep chunk order (queue each chunk with its due time, write sequentially).
- Assertions should be bounds (for example "a message is visible to the other party within N s at 150 ms") plus a check that the delayed path was actually used. Exact timings are too noisy.
