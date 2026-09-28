description: When one of a party's own machines forwards traffic for another machine that cannot be reached directly, it silently cuts every forwarded connection off after 128 KB or two minutes. Anything real sent that way — a database sync, a chat history — dies partway through with no explanation.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/integration-tests/src/harness/dedicated-relay.ts, ops/docker/libp2p-infra/src/main.ts
repro: static
severity: wrong-result
likelihood: common
tradeoffs: Lifting the cap for unplaceable peers gives them an uncapped slot; they are still bounded by count (`network.unauthorizedRelayReservationCap`) and reservation TTL.
----

## Reported in the field: gotchoices/sereus#19 (2026-09-28)

The "nothing routes real data over a party-run relay" premise below is wrong in practice. risavian's run (2 Android emulator phones plus 2 Node cohort peers, cadre-core 1.6.0, db-p2p 1.7.0) had phones reaching their cohort through a party-run relay; 320 `TransferLimitError`s in one run, surfacing as missing blocks and stalled catch-up. Still present in 1.7.0: `cadre-node.ts` (`buildControlNodeOptions`) and `strand-instance-manager.ts` (`buildStrandRuntime`) pass only `relay: enableRelay`.

**Policy (proposed at triage; the maintainer may override before this is worked):**
- Add a typed `network.relayServerInit` (db-p2p's `CircuitRelayServerInit`), forwarded to both the control node and every strand node.
- Default a party-run relay to `reservations: { applyDefaultLimit: false }`, matching the dedicated relay. Unplaceable peers are already bounded by reservation count and TTL.
- Derive `UNAUTHORIZED_RESERVATION_TTL_MS` in `membership-connection-gater.ts` from the resolved `reservationTtl` instead of the hand-kept copy.
- Log the resolved relay limit posture once at start, so an operator can see it.
- Adopt the reporter's regression idea as vitest cases that pass once fixed, in `cadre-node-control-node-options.spec.ts` and the `strand-instance-manager` option specs (their `node:test` file loads `dist/` and asserts the defect exists, so it can't be taken as-is).
- Reply on #19 after release (maintainer approves the post).

Fix together with, or before, `fix/2-strand-addr-refresh-and-responder-hide-failures` (#21/#22): a relay reset is one way the responder's read fails.


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
