description: Two machines that reach each other through a relay server stay on the relay for good, even when they could talk directly over WebRTC; nothing ever tries the direct path once the relayed connection is open. Each node should try the WebRTC path once in the background and switch to it when it works.
prereq: webrtc-addresses-never-hold-a-dial
architecture: docs/architecture.md#relay-integration
files: packages/cadre-core/src/webrtc-upgrade.ts (new), packages/cadre-core/src/cadre-node.ts (control node build), packages/cadre-core/src/strand-instance-manager.ts (strand node build ~1050), packages/cadre-core/src/peer-dial.ts (address kinds from the prereq), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/control-protocol-guard.ts (`/webrtc-signaling/0.0.1`), packages/integration-tests/src/scenarios/webrtc-ice-failure-falls-back-to-relay.integration.ts, docs/architecture.md
difficulty: medium
----
# Relayed connections try a WebRTC upgrade in the background

## Why

After `webrtc-addresses-never-hold-a-dial`, every dial that something waits on goes relayed-first, so WebRTC connections no longer open as a side effect of a dial picking the WebRTC address first. Nothing else starts one:

- js-libp2p never upgrades a relayed connection to WebRTC by itself.
- DCUtR (libp2p's hole-punching service) does not use WebRTC.

When ICE does connect, direct is worth having. GitHub #61 measured a 1 MB strand write at 2.4–3.2 s direct against 3.8 s relayed, both on a loopback relay and through `relay.sereus.org` with its STUN server. Phone-to-Node on one LAN opened directly in about 0.5 s. A direct path also takes the bytes off the relay.

## Design

A small service, `webrtc-upgrade.ts`, installed on every libp2p node cadre-core builds (the control node and each strand node), but only when that node can dial WebRTC. Confirm the right signal for that: the `/webrtc-signaling/0.0.1` handler, which `control-protocol-guard.ts` says exists only when the transports include WebRTC, or the transport manager's list, as `relay-reservation.ts` → `nodeTransports` reads it.

**Trigger.** libp2p's `peer:identify` event, because that is when the remote's addresses are known, not `connection:open`. Attempt when all of the following hold:

- The identify arrived on a `relayed` connection (the address kind from the prereq).
- The node has no open direct connection to that peer.
- The remote's identified listen addresses include a `webrtc` address.
- This side is the one that dials (next paragraph).
- The peer is not in backoff.

**Which side dials.** Exactly one side, so two upgrades don't cross:

- If only the remote advertises a `webrtc` address, this side dials. A WebRTC dialer needs the transport, not a `/webrtc` listener.
- If both advertise one, the side with the lower peer id (string comparison) dials.
- If this side does not advertise one and the remote doesn't either, nothing happens.

**The dial.** `node.dial(webrtcAddr, { signal })` straight on libp2p. libp2p's `findExistingConnection` lets a WebRTC address through next to an unlimited relayed connection, and `dialPeerAddrs` would order it last. Time it out with a budget derived in `link-budget.ts` (the deadline lint rule requires a derived value), roughly a relayed dial plus ICE gathering. The dial sits on no one's critical path, so it is better to err long than to cut off a working attempt.

**Backoff, per remote peer per node.**

- After a failure: no new attempt for 1 min, doubling to a 30 min cap.
- After a success: reset.
- Rationale: two networks that can't connect directly fail every time, and each attempt costs relay signalling plus ICE gathering, which wakes a phone's radio.
- Keep it in memory only. A restart starting over is fine.

**After success**, leave the relayed connection open:

- Closing it would race streams already on it.
- New streams already prefer the WebRTC connection: libp2p's `findExistingConnection` sorts direct connections first, and Optimystic's stream paths (`../optimystic/packages/db-p2p/src/network/open-protocol-stream.ts:198-210`) try non-limited connections newest first.

Add a `NOTE:` tripwire at the install site. Optimystic groups by limited/unlimited, not direct/relayed, so if the relayed connection is later re-opened it becomes the newest and wins. If that shows up, ask Optimystic to rank direct connections ahead of unlimited relayed ones.

## Edge cases & interactions

- **Node stop and strand hibernation**: remove the listener and abort in-flight dials when the node stops. Verify by inspection, plus the scenario tearing down cleanly.
- **Connection gater**: the dial goes through the node's gater like any other, so a closed strand's revoked-peer denial still applies. Verify by inspection.
- **The peer reconnects over the relay while in backoff**: no attempt until the backoff expires. The decision test covers this.
- **The upgrade succeeds, then the WebRTC connection drops**: the relayed connection is still open, and the next `peer:identify` on a relayed connection re-evaluates. Verify by inspection.
- **Several relays, so several `webrtc` addresses**: try one per attempt (the first in identify order). Don't fan out.
- **Capped relay (limited connection)**: an upgrade there is the only path the database protocols can use (`ops/docs/ice-servers.md` → "Why there is no TURN"), so the trigger must fire on limited relayed connections too. Verify by inspection.
- **The membership guard**: `/webrtc-signaling/0.0.1` is already in the `transport` class, which allows any peer. No change. Verify by inspection.
- **A peer that was never connected**: not this service's job. It acts only on an identify over an existing relayed connection.

## Tests

- **Scenario arm**, in the prereq's scenario file: the same two relay-only parties, but with ICE able to connect (loopback host candidates, `iceServers: []` without `iceTransportPolicy: 'relay'`). After formation, which now goes over the relay, assert that within a bounded wait each party's strand node holds a connection to the other that `classifyTransport` (`diagnostics/connection-path.ts`) labels `webrtc`, and that a write still replicates. In the ICE-fails arm, assert the strand still works. The prereq already covers that; just confirm the upgrade's failed attempt doesn't disturb it.
- **One table test** for the pure decision function (side, backoff state, connection kinds → attempt or not), since it carries the tie-break and backoff rules.

## TODO

- Add a `link-budget.ts` derivation for the upgrade dial's budget.
- Implement `webrtc-upgrade.ts`: a pure decision function plus a small wrapper that subscribes to the libp2p events.
- Install it on the control node and on each strand node, only when the node can dial WebRTC.
- Add the scenario arm and the decision table test, then run `yarn lint`, the cadre-core tests, and the scenario file.
- Docs: extend the "Direct connections over WebRTC" subsection the prereq adds to `docs/architecture.md` with the upgrade, covering which side dials, the backoff, and that the relayed connection is kept.
