description: When a machine offers both a WebRTC address and a plain relayed address, a join or reconnect tries the WebRTC one first, and where WebRTC cannot connect the join fails outright instead of using the relay that would have worked. Dials that something waits on should go through the relay, and WebRTC should only ever be an extra.
architecture: docs/architecture.md#relay-integration
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/strand-formation-protocol.ts (`openFormationStream` ~836, `dialFormationChannel` ~864), packages/cadre-core/src/cadre-node.ts (`dialControlBootstrapPeers` ~3256), packages/integration-tests/src/scenarios/ (new scenario file), packages/integration-tests/package.json, docs/architecture.md (Relay Integration), ops/docs/ice-servers.md
difficulty: medium
----
# A WebRTC address never holds up a dial that something is waiting on

GitHub issue #61 (Node repro included there).

## What goes wrong

A node that listens on `/webrtc` (the web tab today; the phone once `phone-listens-on-webrtc` lands) advertises two addresses per relay: the plain relayed one, `<relay>/p2p-circuit/p2p/<id>`, and a WebRTC one signalled through the same relay, `<relay>/p2p-circuit/webrtc/p2p/<id>`. A WebRTC connection opens only if ICE (the WebRTC connectivity check, using STUN-derived public addresses) finds a path. Between two networks that don't allow it, which is common for two phones on different home or mobile networks since Sereus runs no TURN server, ICE never connects and the peer connection closes after about 23 s.

- **Formation.** `dialFormationChannel` calls `node.dial(addrs)` under one 25 s budget (the default `formationDeadlines().dialMs`). libp2p re-sorts the list itself (`libp2p/dist/src/connection-manager/dial-queue.js:386`, `defaultAddressSorter`), and its `circuitRelayAddressesLast` treats only an exact `Circuit` match as relayed. So the WebRTC address sorts first and uses up the whole budget, and the join fails with `FormationUnreachableError: Formation dial-connect timed out after 25000ms`. The issue reproduced this 3 of 3 times on two real phones and deterministically in Node. The NOTE on `openFormationStream` predicted it.
- **cadre-core's own per-address dials** (`dialPeerAddrs`: control-cohort reconcile, seed bootstrap, strand peer redial). `isRelayed` counts any address with a `p2p-circuit` component as relayed, so `directBeforeRelayed` leaves WebRTC and plain relayed addresses in record order. A WebRTC address listed first costs a full per-address budget (21.5 s at the default link) before the relayed one is tried.
- **Reuse.** `reusableConnection` says it mirrors libp2p's `findExistingConnection` but doesn't. libp2p counts `/p2p-circuit/webrtc` as direct (`isDirect = !Circuit.exactMatch`) and lets such a dial go ahead next to an open relayed connection. cadre's version hands back the relayed connection instead, so a dial of a WebRTC address never upgrades anything.

## The rule

Policy: **a dial that someone waits on goes through the relay. WebRTC is an extra that gets tried separately** (`relayed-connections-try-a-webrtc-upgrade`). Formation needs only one stream, and the bulk strand traffic is what benefits from going direct.

**Address kinds.** Represent this as one three-way classification in `peer-dial.ts`, used by every site below instead of each site's own substring test:

- `direct`: no `p2p-circuit` component. This includes `/webrtc-direct`, which is dialled without a relay.
- `relayed`: a `p2p-circuit` component with no transport after it (the shape libp2p's `Circuit` matcher accepts).
- `webrtc`: a `p2p-circuit` component followed by `webrtc`.

Prefer `@multiformats/multiaddr-matcher` (`Circuit`, `WebRTC`), which libp2p itself uses, if cadre-core can take it as a direct dependency at the version libp2p resolves. Otherwise walk the components, as `relaysThrough` already does.

**Where it applies:**

- **`dialPeerAddrs` ordering** (`directBeforeRelayed`): direct first, then relayed, then WebRTC last. A WebRTC address stays in the list rather than being dropped, so a peer whose only address is a WebRTC one is still dialled.
- **`reusableConnection`**: a `webrtc` address is not served by an open relayed connection, matching libp2p. This matters only to the upgrade dial in the next ticket, because blocking dials no longer reach a WebRTC address while a relayed one is untried.
- **Formation** (`dialFormationChannel`): drop `webrtc` addresses from the list passed to `node.dial` whenever any other address remains. Reordering cannot work because libp2p re-sorts the list. Rewrite the NOTE on `openFormationStream`: the WebRTC case is handled, but the hung-relay-host case it also describes is not.
- **`dialControlBootstrapPeers`** dials by peer id, so libp2p's sorter picks the order. It is best-effort and nobody waits on it. Leave it, with a `NOTE:` saying a WebRTC address in the bootstrap peer's record costs it up to one ICE timeout.

**Out of reach:** Optimystic's own dials by peer id (`dialProtocol` in `../optimystic/packages/db-p2p/src/network/open-protocol-stream.ts:320`) go through libp2p's sorter too, and Optimystic does not forward libp2p's `connectionManager.addressSorter`. The scenario below measures whether that hurts. If strand writes stall on it, file a `blocked/` report asking Optimystic to accept an address sorter, rather than working around it here.

## Edge cases & interactions

- **Only WebRTC addresses for a peer.** Formation keeps them, since filtering would leave nothing, and `dialPeerAddrs` tries them last. Verify by inspection.
- **`/webrtc-direct`** is `direct`, not `webrtc`: it needs no relay and no ICE fallback. A case in the classification test.
- **Multiple relays.** Each relay contributes one relayed and one WebRTC address. All relayed addresses come before any WebRTC address, not interleaved per relay. A case in the ordering test.
- **Self-relayed addresses**: `withoutSelfRelayed` still drops WebRTC addresses that relay through this node. Verify by inspection.
- **Formation's connection bookkeeping** (`heldBefore` / `formationConnectionUsers`) is unchanged. Only the address list shrinks.
- **The connection-path classifier** (`diagnostics/connection-path.ts`) labels open connections, not dial candidates, and stays as it is. Don't merge it with the new classification: it answers a different question about a different input.
- **Capped relays**: unchanged. A limited relayed connection is still not reused, as before.

## Tests

- **New integration scenario** (`webrtc-ice-failure-falls-back-to-relay.integration.ts`; the issue's script is the template). Two relay-only parties on a dedicated loopback relay, each with `webRTC({ rtcConfiguration: { iceServers: [], iceTransportPolicy: 'relay' } })` (ICE can never connect) and `listenAddrs: ['/webrtc']`. Assert the invitation carries a `/p2p-circuit/webrtc` address, formation succeeds within its normal budget, B's strand becomes writable, and a row B writes is readable at A. Before the fix it fails with `FormationUnreachableError` after 25 s. Log how long the strand steps take, so the Optimystic exposure above is measured, not guessed. Add `@libp2p/webrtc` at exactly `6.0.33`, matching cadre-core's devDependency, to `integration-tests` devDependencies. `node-datachannel` is already installed.
- **One table test** for the ordering contract: the classification plus `directBeforeRelayed`'s output over a mixed list (two relays, `webrtc-direct`, plain direct). Put it in the existing peer-dial spec if there is one.
- No test for the `reusableConnection` change on its own. The next ticket's scenario exercises it.

## TODO

- Add the three-way address classification to `peer-dial.ts`. Use it in `directBeforeRelayed` and `reusableConnection`, and correct the docstring that claims to mirror libp2p.
- Filter `webrtc` addresses out of formation's `node.dial` list when any other address remains, and rewrite the `openFormationStream` NOTE.
- Add the `NOTE:` on `dialControlBootstrapPeers`.
- Write the integration scenario and the table test, then run `yarn lint`, the cadre-core tests, and the new scenario.
- Docs: add a "Direct connections over WebRTC" subsection under Relay Integration in `docs/architecture.md` stating the rule (blocking dials go relayed first; WebRTC is tried separately), and one sentence in `ops/docs/ice-servers.md` under "Why there is no TURN" saying a failed ICE costs a join nothing.
- In the handoff, give the measured strand-step timings. If Optimystic's dials were the bottleneck, say so and file the `blocked/` report. Name GitHub #61 so the reviewer can close it.
