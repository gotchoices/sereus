description: A machine reachable only through relays took about 18 seconds longer than it should to open a shared workspace in roughly half of launches, because libp2p's automatic relay search gave the relay slots to other members' machines and silently dropped the request for a configured relay. The automatic search is now switched off wherever cadre fills those slots itself; this needs a review pass.
architecture: docs/strands.md
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/node-transports.ts, packages/cadre-core/src/node-default-transports.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start-node.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/test/strand-instance-manager-relay.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, docs/architecture.md, docs/reference-app-rn.md, docs/testing.md
----
# Supervised relay slots are no longer filled by libp2p's relay discovery

Reported as gotchoices/sereus#34. Root cause, as the implement ticket confirmed: a cadre node gets one bare `/p2p-circuit` listen entry per configured relay, and each entry is one reservation slot that the per-relay supervisor fills. libp2p's `RelayDiscovery` fills the same slots from any connected peer whose identify lists the relay-hop protocol. A storage-profile member's strand node runs the relay server in the same identify namespace, so discovery reserved on it first. When a reservation took the last slot, the reservation store's `Queue.clear()` dropped the configured relay's queued `addRelay` without ever settling it, and `addStrand` waited out the whole relay drive (18 s at the default declared link).

## What was built

- **`withoutRelayDiscovery(transports)`** (`relay-reservation.ts`, next to `findCircuitRelayTransport`). It wraps each transport factory. When the built transport is the circuit-relay transport (duck-typed by its reservation store), it sets its `discovery` field to `undefined` before libp2p starts it. circuit-relay-v2 4.2.13 guards every use of that field, so no topology is registered and no peer-store scan or random walk ever runs. If the field is missing (a libp2p shape change), it logs one `console.warn` per process and leaves discovery on rather than failing the node.
- **`nodeTransportsOption(network, listenTransports, relaySlotsSupervised)`** (new `node-transports.ts`). Both build sites spread this:
  - the strand build passes `relayDialAddrs.length > 0`;
  - the control build passes `network.relayAddrs` non-empty.

  When slots are supervised, it wraps `network.transports` if the embedder gave one, else `network.defaultTransports(listenTransports)`. With neither, it returns `{}`: db-p2p then builds its own list with discovery on, and a debug line is logged. Unsupervised nodes keep the old behaviour exactly.
- **`NetworkConfig.defaultTransports`** (new field, `types.ts`) and the **Node-only subpath `@serfab/cadre-core/node-default-transports`** exporting `nodeDefaultTransports({ wsPort })`, which builds `[tcp(), webSockets() when wsPort is set, circuitRelayTransport()]`. A `NOTE:` says it mirrors db-p2p's `libp2p-node.ts` defaults. **cadre-cli injects it** in `buildNodeConfig` (`start-node.ts`) and `oneShotNodeConfig` (`node-session.ts`).
- `@libp2p/tcp`, `@libp2p/websockets` and `@libp2p/circuit-relay-v2` moved from cadre-core's `devDependencies` to `dependencies`. The implement ticket said they were already dependencies; they were dev-only. `yarn.lock` is unchanged, because a workspace's lock entry lists dev and runtime dependencies together. `yarn install` was not run, to keep away from the sibling junctions.
- Comments and docs:
  - The module header of `relay-reservation.ts` has a new section, "WHY LIBP2P'S RELAY DISCOVERY IS SWITCHED OFF", and its "One measured refinement" paragraph is rewritten as the cost: a slot freed by a hangup is now refilled at the 5 s liveness check instead of in ~25 ms.
  - Stale "discovery is not a conflict" and "discovery may land one" claims are corrected.
  - The `strand-network-config.ts` NOTE is updated.
  - `architecture.md` gains a paragraph under "Reservations are requested explicitly, not discovered", plus the new field in its `NetworkConfig` listing.
  - `reference-app-rn.md` no longer cites discovery as the reason a refused dial polls, and its stale 10 s figure is corrected.
  - `testing.md` now notes that `@libp2p/tcp` counts as Node-only for the `.` entry.

## Deviation from the implement ticket: where the default transport list lives

The ticket put the default list in cadre-core's main graph, on the premise that "browser bundles get nothing new". That premise is false for the NativeScript build. It was tried: `yarn workspace @serfab/reference-app-ns test:bundle` failed with `Can't resolve 'path'` from `@libp2p/tcp/dist/src/utils.js`, reached through `cadre-core/dist/node-transports.js`. NativeScript's webpack does not apply `@libp2p/tcp`'s `browser` mapping to that package's internal imports. That also breaks the constraint in `docs/testing.md` that cadre-core's `.` entry must load in React Native and the browser. So the list moved behind a Node-only subpath and is injected, which is the same pattern cadre-cli already uses for `push-node`.

Consequence: a Node embedder other than cadre-cli that names `relayAddrs` without passing `transports` or `defaultTransports` keeps discovery on. That is the old behaviour, not a regression, and it is debug-logged. The integration-test harness passes `transports`, so it is covered. **Reviewer:** an upstream alternative would be a db-p2p option to drop discovery from its own default list (for example `relayDiscovery: false`), which would remove `defaultTransports` entirely. That is an optimystic change, and nothing was filed for it.

## Test added

- `relay-reservation.spec.ts` → `withoutRelayDiscovery` → "leaves both slots to the supervised relays when another relay is connected first". This is the #34 reproduction in-process. The client has two bare `/p2p-circuit` entries and stock identify, its transports are `withoutRelayDiscovery([tcp(), circuitRelayTransport()])`, and it dials relay C first, then waits up to 1 s for a discovered reservation on C. Supervisors over A and B then get a 4 s deadline. The spec asserts both first attempts settle in under 2 s, neither supervisor has a `lastError`, and the circuit addresses go through A and B but not C. **Without the wrapper it failed 3 of 3** runs (`expected 4011 to be less than 2000`, the full deadline). With it, it passes in about 1.7 s, of which 1 s is the settle wait.

Changed, not added: the two `strand-instance-manager-*.spec.ts` files mock `relay-reservation.js`. Their mocks now keep the real `withoutRelayDiscovery`, because without it every relay-configured strand build threw.

No spec for `nodeTransportsOption` or the cadre-cli injection; both are wiring.

## Validation run

- `yarn workspace @serfab/cadre-core test`: the first run had 9 failures, 8 of them the mock gap above (fixed). After the fix: 162 files, 2432 passed, 1 skipped.
- `yarn workspace @serfab/cadre-cli test`: 23 files, 285 passed, 1 skipped (after `build`).
- `yarn lint`: clean. cadre-core and cadre-cli typecheck clean.
- Bundles, against a rebuilt cadre-core `dist`: `reference-app-web` `vite build` passes; `reference-app-ns test:bundle` reports 0 errors and 0 warnings; `reference-app-rn test:bundle` (`expo export --platform android`) exports.
- Integration scenarios, all green: `strand-circuit-same-party-e2e`, `blind-relay-phone-to-phone-e2e` (3 arms), `strand-relay-only-restart-reconverges` (2 opt-in arms skipped by design), `relay-only-control-addr` (5), `push-wake-e2e` (4), `strand-always-on-replica-survives-phone-loss`, `strand-late-cadre-join` (3).
- **Control-node case confirmed** with a throwaway spec (deleted): one bare entry, one configured relay A, connected first to relay C. Unwrapped, the supervisor took 3013 ms and failed with the `HadEnoughRelaysError` translation, and the client held C's circuit address. A control node on default `requireRelay` would throw `RelayReservationFailedError` in that state. Wrapped, it reserved through A in 30 ms.

## Known gaps

- Not run on a device or with the issue's three-process rig. The in-process spec is the reproduction.
- One `cadre-node-dial-past-dead-addresses.spec.ts` failure appeared once under full-suite load: its live address missed a 500 ms dial deadline. It passed in isolation and on the rerun. That spec uses no relays, so this change does not touch it. It is reported in `tickets/.pre-existing-error.md`.
- The `reserveRelays` path on a node with no `relayAddrs` (the browser tab) keeps discovery by design. That is recorded as a `NOTE:` at `CadreNode.reserveRelays`.

## Tripwires recorded (`NOTE:`)

- `requestOneReservation`: `Queue.clear()` can still drop a queued **refresh** when another relay's first reservation takes the last slot. If that is seen, also end the wait on `relay:found-enough-relays`. The real fix belongs to js-libp2p.
- `CadreNode.reserveRelays`: a browser tab connected to an unlisted relay-capable peer can lose its one slot the same way.
- `strand-network-config.ts`: where discovery stays on (a Node host passed no `defaultTransports`), each empty slot still runs a peer-store scan and a random walk, which would become real dials if strand nodes ever get a peer router.
- `node-default-transports.ts`: the list mirrors db-p2p's defaults; if those change, this list has to change too.

## Review focus

- Is `NetworkConfig.defaultTransports` plus a new subpath the right API, or should this wait for the db-p2p option above?
- `switchOffRelayDiscovery`'s duck-typing and its fallback when the field is missing.
- Control-node behaviour change: with `relayAddrs` set, a slot lost on a hangup is refilled at the 5 s liveness check rather than by discovery.
