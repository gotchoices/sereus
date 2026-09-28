description: When one of a party's own machines forwards traffic for another machine that cannot be reached directly, it cuts every forwarded connection off after 128 KB or two minutes without saying so. Anything real sent that way, such as a database sync or a chat history, dies partway through. Make party-run relays forward without that cap, as the dedicated relay already does, and log the setting when the node starts.
files: packages/cadre-core/src/types.ts (NetworkConfig), packages/cadre-core/src/relay-addrs.ts (or a new relay-server.ts beside it), packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions, relayServerEnabled, constructor's UnauthorizedReservationBudget, start), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime), packages/cadre-core/src/membership-connection-gater.ts (UNAUTHORIZED_RESERVATION_TTL_MS, MAX_UNAUTHORIZED_RELAY_RESERVATIONS), packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, docs/architecture.md (NetworkConfig block, "Control-network inbound connection gate" bullet)
repro: static
----

Reported in the field as gotchoices/sereus#19 (2026-09-28): risavian's run, with 2 Android emulator phones and 2 Node cohort peers on cadre-core 1.6.0 and db-p2p 1.7.0, had its phones reaching their cohort through a party-run relay and logged 320 `TransferLimitError`s in one run. Those showed up as missing blocks and catch-up that stalled. The code is unchanged in 1.7.0. `repro: static` means I read the code in this session and did not rerun the field setup. The reporter's run is the observation.

## Background: two kinds of relay

A **circuit relay** is a libp2p node that forwards traffic for a peer that cannot accept incoming connections. Sereus has two kinds:

- a **dedicated** relay: the `ops/docker/libp2p-infra` container, plus `startDedicatedRelay` (`packages/integration-tests/src/harness/dedicated-relay.ts`), the test fixture that stands in for it;
- a **party-run** relay: an ordinary `CadreNode` with its relay server switched on. `network.enableRelay` defaults the server on for the `storage` profile, so every always-on machine a party runs is one. The control node and every strand node each build their own relay server from the same `NetworkConfig`.

## Root cause

`@libp2p/circuit-relay-v2` (4.1.3) defaults its server's reservation store to `applyDefaultLimit: true`. That puts `Limit { data: 128 KiB (1 << 17), duration: 2 min }` (`DEFAULT_DATA_LIMIT`, `DEFAULT_DURATION_LIMIT` in its `constants.js`) on every reservation. libp2p then marks the relayed connection "limited" and resets it once either limit is reached. db-p2p's database protocols do not set `runOnLimitedConnection`, so they are also refused outright on a limited connection. `@optimystic/db-p2p` exposes the setting as `NodeOptions.relayServerInit` (`libp2p-node-base.ts`, line ~209), which it passes to `circuitRelayServer(...)`.

Both dedicated relays turn the limit off. `ops/docker/libp2p-infra/src/main.ts` uses `RELAY_APPLY_DEFAULT_LIMIT`, default `false`, and `dedicated-relay.ts` hard-codes `false`. cadre-core never passes `relayServerInit`:

- `cadre-node.ts` → `buildControlNodeOptions`: `relay: enableRelay`, no init.
- `strand-instance-manager.ts` → `buildStrandRuntime` (the `createLibp2pNode({...})` call, line ~722): `relay: enableRelay`, no init. It also recomputes `enableRelay` itself (`config.network?.enableRelay ?? (config.profile === 'storage')`), which copies `CadreNode.relayServerEnabled()` by hand.

So every party-run relay gets libp2p's capped default, and `NetworkConfig` has no field that could change it.

A second default from the same init applies to party-run relays too: `maxReservations` defaults to 15. The dedicated-relay fixture raises it (ops uses 500) because "one machine costs one slot per strand it serves PLUS one for its control node" (`dedicated-relay.ts` header). A NAT'd member's strand nodes reserve on the same `network.relayAddrs` as its control node (`strand-network-config.ts`). When that relay is a party's always-on machine, all of those reservations land on its control node's relay server. For example, three phones serving four strands each need 3 × (1 + 4) = 15 slots, which is the whole default. `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` (8) also has a doc comment saying it must stay "well under" the store's size, and today that store holds 15. The fix touches the same init at the same site, so it covers this as a second arm.

## Decided policy (the triage proposal on #19; the maintainer may override it)

- **A party-run relay does not limit what it forwards by default:** `reservations: { applyDefaultLimit: false }`, the same as the dedicated relay. Peers the node cannot place are still bounded by count (`network.unauthorizedRelayReservationCap`) and by the reservation lifetime (TTL). An unplaced peer's slot is uncapped once it is granted. That is the accepted tradeoff, and the doc comment on the new field should say so.
- **The init is configurable:** add a typed `network.relayServerInit?: CircuitRelayServerInit`. Take the type from `@libp2p/circuit-relay-v2`, which is already a cadre-core dependency. It is forwarded to the control node and to every strand node. cadre-cli's `cadre.yaml` and environment mapping do **not** get this field in this ticket. It is a libp2p object for embedders. A CLI operator who needs the brake back is out of scope unless someone asks.
- **Raise the party-run default for `maxReservations`** above libp2p's 15, so that a handful of NAT'd members with a few strands each do not use up the store, and so that `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` (8) really is "well under" it. Pick the value and write the reasoning next to the constant, using the arithmetic above: slots = NAT'd machines × (1 + strands each). I suggest something like 128. The dedicated relay's 500 is sized for many parties, and a party-run relay serves one party.
- **Merge the caller's init with the defaults; do not replace them.** A caller who sets only `reservations.maxReservations` must not silently turn the data limit back on. Deep-merge `reservations`, and take the other top-level keys from the caller.
- **Derive the unauthorized-budget TTL from the resolved `reservations.reservationTtl`** (falling back to libp2p's `DEFAULT_MAX_RESERVATION_TTL`, 2 h) instead of the hand-maintained copy. `UNAUTHORIZED_RESERVATION_TTL_MS` becomes the fallback, or goes away. Its "NOTE: a mirror, not a live coupling" comment goes away with it. The `CadreNode` constructor passes the resolved TTL as `UnauthorizedReservationBudget`'s second argument (`cadre-node.ts` line ~829).
- **Log the resolved setting once at start**, only when the relay server is on, with the `log(...)` debug logger `CadreNode.start()` already uses. Include `applyDefaultLimit`, `maxReservations`, `reservationTtl` and the unauthorized cap. The ops container prints the same fields (`main.ts` line ~175). Strand nodes use the same resolution, so the control node's line covers them. Do not add a line for each strand.

## Design: one resolver, both call sites

Both nodes build their relay server from one `NetworkConfig`, and the strand side already copies `relayServerEnabled` by hand. So one pure function should decide both "is the server on" and "with which init", and both call sites should use it. Then they cannot drift apart.

```ts
// relay-addrs.ts, or a new relay-server.ts next to it
export interface ResolvedRelayServer {
	/** Passed as db-p2p `relay` */
	enabled: boolean;
	/** Passed as db-p2p `relayServerInit` when enabled; merged defaults + caller override */
	init: CircuitRelayServerInit;
	/** For the unauthorized budget: init.reservations.reservationTtl ?? libp2p default */
	reservationTtlMs: number;
}
export function resolveRelayServer(network: NetworkConfig | undefined, profile: NodeProfile): ResolvedRelayServer;
```

- `CadreNode.relayServerEnabled()` becomes `resolveRelayServer(...).enabled`. Resolve once in the constructor if that is simpler. The admission code (`admitInboundControlConnection`) keeps reading the same answer.
- `buildControlNodeOptions`: `relay: resolved.enabled, ...(resolved.enabled && { relayServerInit: resolved.init })`.
- `buildStrandRuntime`: the same, using `resolveRelayServer(config.network, config.profile)` in place of its hand copy.
- Export the resolver and its type from `index.ts`, the same way `relay-addrs.ts`'s helpers are exported.

## Tests

The reporter's regression was a `node:test` file that loads `dist/` and asserts that the defect exists, so it cannot be reused as-is. Rewrite its idea as vitest cases that fail before the fix and pass after it:

- `cadre-node-control-node-options.spec.ts`, in the existing `describe('relay')`: one case where a storage-profile node's options carry `relayServerInit.reservations.applyDefaultLimit === false`, and a relay-disabled node's options carry no `relayServerInit`.
- The strand side: one case in `strand-instance-manager-cluster-size.spec.ts`, which already asserts on what reaches the mocked `createLibp2pNode` (or a sibling spec with the same doubles), showing the same init reaching the strand node.
- The resolver's merge has real branching, so give it one table-driven spec: default only; caller sets only `maxReservations` and the limit stays off; caller sets `applyDefaultLimit: true` and the limit comes back on; caller's `reservationTtl` sets `reservationTtlMs`.
- Wire-level check, only if it is cheap: `relay-only-control-addr.integration.ts` case 1 already has C holding a reservation on party node A. If a relayed connection to C through A exists or can be opened in a few lines, assert `conn.limits` is `undefined` on it, the same way `blind-relay-phone-to-phone-e2e.integration.ts` line ~159 does for the dedicated relay. That proves libp2p follows the init. Skip it if it needs a new scenario, because the unit cases pin the wiring.

## Related, not in this ticket

- `fix/2-strand-addr-refresh-and-responder-hide-failures` (#21/#22): a relay reset is one way the responder's read fails, so this ticket goes first. It is numbered 1 and that one 2.
- `fix/3-relay-node-dials-a-sibling-through-its-own-circuit` also touches `cadre-node.ts`, but a different site (dialing).
- `backlog/feat-phone-relays-through-its-own-always-on-node` depends on this. `backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it` is the other half of the same blockage, at a different code site.
- After release, reply on gotchoices/sereus#19. The maintainer approves the post, so the implementer does not post it. The reply is a human step, and the review/complete ticket should carry it forward.

## TODO

- Add `NetworkConfig.relayServerInit?: CircuitRelayServerInit` to `types.ts`. The doc comment should cover the party-run defaults (limit off, raised `maxReservations`), merge rather than replace, the unplaced-peer tradeoff, and that it reaches the control node and every strand node.
- Add `resolveRelayServer` (enabled, merged init, `reservationTtlMs`) along with a named constant for the party-run `maxReservations` default and its sizing comment. Export both from `index.ts`.
- `cadre-node.ts`: make `relayServerEnabled()` use the resolver. `buildControlNodeOptions` passes `relayServerInit` when enabled. The constructor passes `reservationTtlMs` to `UnauthorizedReservationBudget`. `start()` logs the resolved setting once when the server is on.
- `strand-instance-manager.ts` → `buildStrandRuntime`: replace the hand-copied `enableRelay` with the resolver and pass `relayServerInit`.
- `membership-connection-gater.ts`: make `UNAUTHORIZED_RESERVATION_TTL_MS` the libp2p-default fallback (or remove it and update the `index.ts` export), and delete the "mirror" NOTE. Recheck the `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` comment against the new store default.
- Tests as listed under "Tests".
- Docs: add `relayServerInit` to the `NetworkConfig` block in `docs/architecture.md` (around line 1239). Add one sentence to the "relay-reservation seam" text in the connection-gate bullet saying a party-run relay forwards unlimited by default and that unplaced peers are bounded by count and TTL.
- `yarn workspace @serfab/cadre-core build`, then its tests, then `yarn lint`. Run the relay integration scenarios touched here (`relay-only-control-addr`, `blind-relay-phone-to-phone-e2e`) in the foreground.
