description: A machine reachable only through relays took about 18 seconds longer than it should to open a shared workspace in roughly half of launches, because libp2p's automatic relay search gave the relay slots to other members' machines and silently dropped the request for a configured relay. The automatic search is now switched off wherever cadre fills those slots itself.
architecture: docs/strands.md
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/node-transports.ts, packages/cadre-core/src/node-default-transports.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/link-budget.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/start-node.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/test/strand-instance-manager-relay.spec.ts, packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts, docs/architecture.md, docs/reference-app-rn.md, docs/testing.md
----
# Supervised relay slots are no longer filled by libp2p's relay discovery

Reported as gotchoices/sereus#34. A cadre node gets one bare `/p2p-circuit` listen entry per configured relay; each is one reservation slot that a per-relay supervisor fills. libp2p's `RelayDiscovery` used to fill the same slots from any connected peer whose identify lists the relay-hop protocol, and a storage-profile member's strand node runs the relay server in the same identify namespace, so discovery often reserved there first. When that took the last slot, the reservation store's `Queue.clear()` dropped the configured relay's queued `addRelay` unsettled and `addStrand` waited out the whole relay drive (18 s at the default declared link).

## What landed

- `withoutRelayDiscovery(transports)` (`relay-reservation.ts`) wraps each transport factory and clears the circuit-relay transport's `discovery` field before libp2p starts it. If the field is missing (a `@libp2p/circuit-relay-v2` shape change) it warns once per process and leaves discovery on.
- `nodeTransportsOption(network, listenTransports, relaySlotsSupervised)` (`node-transports.ts`) is spread at both build sites: the strand build when it has relays, the control build when `network.relayAddrs` is non-empty. It wraps `network.transports`, else `network.defaultTransports(listenTransports)`; with neither it returns `{}` and debug-logs that discovery stays on.
- `NetworkConfig.defaultTransports` plus the Node-only subpath `@serfab/cadre-core/node-default-transports` (`nodeDefaultTransports`, mirroring db-p2p's default list). cadre-cli injects it in `buildNodeConfig` and `oneShotNodeConfig`. It is a subpath because the NativeScript webpack build takes `@libp2p/tcp`'s Node implementation (needs `path`), which would break the rule that cadre-core's `.` entry loads in React Native and the browser.
- `@libp2p/tcp`, `@libp2p/websockets`, `@libp2p/circuit-relay-v2` moved to cadre-core `dependencies` (lockfile unchanged: Yarn 4's workspace entry lists both kinds together; checked).
- Reproduction spec: `relay-reservation.spec.ts` → `withoutRelayDiscovery` → "leaves both slots to the supervised relays when another relay is connected first".
- Docs: `architecture.md` (new paragraph under "Reservations are requested explicitly, not discovered", `defaultTransports` in the `NetworkConfig` listing), `reference-app-rn.md` (refused-dial cost, corrected 18 s figure), `testing.md` (`@libp2p/tcp` counts as Node-only).

Behaviour change: on a node with configured relays, a slot freed by a hangup while the relay stays up is refilled at the supervisor's next 5 s liveness check instead of by discovery in ~25 ms.

## Review findings

Read the `ticket(implement): relay-only-strand-launch-waits-out-relay-drive` diff first, then the handoff.

**Checked against the installed libp2p (circuit-relay-v2 4.2.13):**
- `CircuitRelayTransport` declares `discovery` as a class field assigned in the constructor, so the `hasOwnProperty` duck-type holds; every later use is guarded (`this.discovery?.startDiscovery()`, `start`/`stop` skip `undefined`), and `serviceDependencies` drops the identify requirement when it is `undefined`. `RelayDiscovery`'s constructor registers nothing with the components (the topology is registered in `start()`), so the orphaned instance is inert.
- The supervisor's `addRelay(…, 'discovered')` takes a pending slot id, and `#removeReservation` returns a `discovered` slot to the pending list, so a supervised slot freed by a hangup is reclaimable by the next drive. The store's `afterStart` redial of keep-alive-tagged relays cannot reintroduce an unsupervised reservation: cadre's peer store is in memory, so nothing is tagged at start.
- Both build sites' `relaySlotsSupervised` arguments match exactly when bare search entries are generated: control (`resolveListenAddrs` adds the entry iff `relayAddrs` is non-empty; a hand-written circuit listen entry is rejected) and strand (`strandNodeAddrs` emits one entry per relay dial address).
- `nodeDefaultTransports` matches db-p2p's `createLibp2pNode` default list (`../optimystic/packages/db-p2p/src/libp2p-node.ts`, read only). Passing a list makes db-p2p ignore `wsPort` for transports, and its `wsPort` default listen address never applies because supervised nodes always have explicit listen entries.
- Embedders: cadre-host and cadre-provider run nodes via the cadre CLI (covered by the injection); the integration harness, cadre-rn and the NativeScript/web reference apps pass `network.transports`. The web tab keeps discovery by design (no `relayAddrs`), as `CadreNode.reserveRelays`'s NOTE and `reference-app-web/README.md` already say.

**Tests:** The reproduction spec pays for itself: re-run with the wrapper removed it failed (`expected 4013 to be less than 2000`), and with it it passes. Kept. The two `strand-instance-manager-*` mock changes are required (the real `withoutRelayDiscovery` passes through) and correct. No test cut, none added.

**Validation run in review:** `yarn lint` clean; cadre-core `tsc --noEmit` clean; `yarn workspace @serfab/cadre-core test` 162 files, 2432 passed, 1 skipped; `yarn workspace @serfab/cadre-cli test` 23 files, 285 passed, 1 skipped (after rebuilding cadre-core `dist`, which my comment edits made stale). Bundle builds and integration scenarios were not re-run: the review's only source changes are comments, and the implement stage ran them against this code.

**Minor, fixed inline:**
- `link-budget.ts` `RELAY_RESERVATION_ROUND_TRIPS` justified its doubled budget by "libp2p's own relay discovery" satisfying the wait, which is no longer true on supervised nodes. Comment now names the browser-tab path where it still applies, with a `NOTE:` tripwire: on supervised nodes the doubling is headroom only and is what an unreachable configured relay costs each launch; if that matters, budget those nodes at 2.
- `node-default-transports.ts` NOTE now says to drop the module and `NetworkConfig.defaultTransports` if db-p2p gains an option to build its default list with discovery off. That is the reviewer question about the upstream alternative: the injected-subpath API is the right shape while `../optimystic` is read-only; nothing filed, since it is a cleanup, not a defect, and the trigger lives at the site.

**Major:** none. The reviewer-focus items were weighed: the `console.warn` fallback (rather than a throw) is acceptable because the reproduction spec fails loudly in CI on the same shape change; the 5 s refill-on-hangup cost is documented in the `relay-reservation.ts` header and `architecture.md` and is the intended tradeoff.

**Tripwires:** the implement stage's four `NOTE:`s (`requestOneReservation` refresh drop, `CadreNode.reserveRelays` tab exposure, `strand-network-config.ts` random walk where discovery stays on, `node-default-transports.ts` mirroring) were read and are accurate. Added one: `link-budget.ts` budget doubling (above).

**Docs:** read every doc the change touches plus `reference-app-web/README.md` and the remaining "discovery" mentions in `architecture.md` (the browser-tab sections at the supervisor and spec paragraphs); all accurate for the new behaviour. `docs/strands.md` (the anchor) does not discuss relay discovery and needs no change.

**Known gaps carried forward:** not run on a device or with the issue's three-process rig; the in-process spec is the reproduction. The one-off `cadre-node-dial-past-dead-addresses.spec.ts` timing failure the implement stage reported was triaged in `tess: triage pre-existing test failure` and did not recur in this review's full run.
