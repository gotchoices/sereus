description: Add a real-libp2p two-node integration test for control-network push-wake (CadreNode.pushWake → StrandWakeService over a real dial, NAT'd receiver via relay)
prereq: hibernation-push-wake
files: packages/integration-tests/src/scenarios/, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
----

The push-wake protocol (`hibernation-push-wake`) shipped with thorough unit coverage, but every test uses in-memory stream doubles (`wake-stream-helpers.ts`) and a mocked `dialProtocol`/`resolvePeerAddrs`. The actual wire path is **not** exercised end-to-end:

- real `node.handle(WAKE_PROTOCOL, …)` registration and dispatch,
- a real `dialProtocol` opening a stream over a real transport,
- libp2p 3.x half-close (`stream.close()` write-EOF) semantics with the read end staying open for the ack,
- multi-chunk framing across a relayed connection,
- `pushWake`'s composition with `resolvePeerAddrs` (signed-record freshness/trust → dialable addr), which is currently only stubbed with a fixed multiaddr.

`seed-bootstrap.spec.ts` has live-`CadreNode` round-trips; push-wake has no equivalent.

## What the test should cover

Boot two real `CadreNode`s on the same control network (one a member authority/server, one a hibernating receiver) and `pushWake` across them:

- happy path: server resolves the receiver's signed `CadrePeer` address, dials `WAKE_PROTOCOL`, and the hibernating receiver transitions to `active`; the returned `WakeAck` carries `{ accepted: true, status: 'active' }`.
- NAT'd receiver reached via its circuit-relay address (signaling-first ordering in `resolvePeerAddrs`) — the scenario that the in-memory tests cannot prove.
- non-member sender rejected over the real transport (`{ accepted: false }`, no wake).

Mirror the harness in `packages/integration-tests/src/scenarios/` (see `strand-formation-e2e.integration.ts` and the seed scenarios for the two-node + relay setup). Keep wall-clock under the agent-runnable ceiling or mark it as a CI-only scenario.
