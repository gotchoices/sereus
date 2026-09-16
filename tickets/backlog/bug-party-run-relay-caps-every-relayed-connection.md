description: When one of a party's own machines forwards traffic for another machine that cannot be reached directly, it silently cuts every forwarded connection off after 128 KB or two minutes. Anything real sent that way — a database sync, a chat history — dies partway through with no explanation.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/integration-tests/src/harness/dedicated-relay.ts, ops/docker/libp2p-infra/src/main.ts
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Nothing in the product routes real traffic through a party-run relay today — every shipped and tested relay path uses the dedicated relay container, which already sets the limit off — so a maintainer may reasonably wait until a party-run relay is actually on a data path.
----

# A cadre node's relay server applies libp2p's default forwarding limit

## What a relay is here

A **circuit relay** is a libp2p node that forwards traffic for a node that cannot accept incoming connections. Sereus has two kinds:

- a **dedicated** relay — the `ops/docker/libp2p-infra` container, and the `startDedicatedRelay` fixture that stands in for it in tests;
- a **party-run** relay — an ordinary `CadreNode` with its relay server on, which is the default for the `storage` profile (`cadre-node.ts` → `relayServerEnabled`, `strand-instance-manager.ts`). Every always-on machine a party runs is one.

## The defect

`@libp2p/circuit-relay-v2` defaults to `applyDefaultLimit: true`, which stamps every reservation with a limit of 128 KiB and 2 minutes and resets the relayed stream once either is reached. `@optimystic/db-p2p` exposes the escape hatch as `NodeOptions.relayServerInit` and its own doc comment spells out the consequence ("silently killing long-lived service↔browser circuits").

Both dedicated relays set `applyDefaultLimit: false`: the ops container does it by default (`RELAY_APPLY_DEFAULT_LIMIT`, default `false`) and the test fixture hard-codes it. `blind-relay-phone-to-phone-e2e.integration.ts` treats it as load-bearing enough to assert live that `connection.limits` is absent on every relayed connection, because the database protocols do not set `runOnLimitedConnection` and a limited connection simply refuses them.

`cadre-core` passes neither. `buildControlNodeOptions` and `buildStrandRuntime` both pass `relay: enableRelay` and never `relayServerInit`, so every party-run relay takes the capped default. `NetworkConfig` has no field that could change it.

Found by reading the code while planning `phone-becomes-reachable-through-a-relay`; not observed on a wire.

## Why it is not showing up

No shipped path carries real data over a party-run relay yet. The only place a party node acts as a relay in the suite is `relay-only-control-addr.integration.ts`, where what is exercised is the reservation handshake and the address that rides on it — small, short-lived exchanges that fit inside the cap. The moment a party-run relay carries a control-database sync or a strand's traffic, the cap bites.

## What "fixed" should mean

Deciding the limit is a policy question, not a plumbing one, so the ticket should settle it rather than just plumb a field through:

- Is a party's own machine forwarding for its own members *trusted*, so the limit should simply be off, matching the dedicated relay? That is the argument for making it unconditional and needing no new config.
- Or should the limit be configurable, because a party-run relay also grants a bounded number of reservations to peers it cannot place (`network.unauthorizedRelayReservationCap`), and an unlimited slot for an unplaceable peer is a different bargain from one for a member?
- Whatever is chosen has to reach both the control node and strand nodes, since both build relay servers from the same config.

Whichever way it goes, the resolved posture should be visible to an operator — today nothing reports whether a node's relay server limits what it forwards.

## Related

- `backlog/feat-phone-relays-through-its-own-always-on-node` — the capability this blocks.
- `backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it` — the other half of the same blockage, at a different code site.
- `backlog/debt-strand-relay-redrive-on-party-run-relay-unscenarioed` — the other known gap in party-run relay coverage.
