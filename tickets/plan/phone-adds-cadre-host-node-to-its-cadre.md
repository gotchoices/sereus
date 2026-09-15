description: A phone that owns its cadre cannot add a cadre-host machine's donated node to that cadre — the donated node only listens on a transport the phone cannot use, the donation flow expects the phone to be dialable (it never is), and the reference app has no way to make the request at all. This is the "phone, then add a backup at home" path the deployment docs describe as ordinary.
files:
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:566 (donated child gets `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<p2p>` — TCP only, no `/ws`)
  - packages/cadre-host/src/donation/donation-service.ts (provision → getPeer → applySeed lifecycle)
  - packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/routes/provision-request-validation.ts, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts:172-175 (`bootstrapNodes` required non-empty)
  - packages/cadre-core/src/seed-bootstrap.ts:762-777 (applied seed dials owner peers' first address; owners with no address are skipped)
  - packages/cadre-core/src/cadre-node.ts:413-416,1693-1724 (bootstrap peer ids admitted by the inbound gate)
  - packages/reference-app-rn/src/cadre-phone.ts:242-261 (phone transports WS + circuit relay + WebRTC; `listenAddrs: []`)
  - packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx (no host/grant/addDrone action exists)
  - packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts (requester is a TCP-dialable cadre-cli owner, driven in-process — never a phone)
  - docs/cadre-host.md (Node donation), docs/architecture.md (Deployment sizes / Enrollment flows), docs/reference-app-rn.md
----

# A phone adds a cadre-host donated node to its own cadre

## The use case

[`docs/architecture.md`](../../docs/architecture.md) calls a one-phone cadre the normal starting point and "add a backup" the normal next step, reached by a user action. [`docs/cadre-host.md`](../../docs/cadre-host.md) makes node donation cadre-host's primary role, and its typical requester is a phone. Put together, the headline flow is:

1. A phone starts a cadre on its own (the reference app's solo quick-start).
2. Someone who runs cadre-host (possibly the same person, at home) issues the phone's owner a grant token.
3. The phone asks that host for a node, the host spawns one that pins the phone's owner key, the phone signs a seed for it, and the node joins the phone's cadre.
4. From then on the phone and the donated node replicate the control database and the phone's strands.

Nothing in the tree performs this end to end, and three separate gaps make it impossible today. Found while preparing an on-device session on a physical Android phone (adb-reversed loopback to a Windows dev PC), by reading the code; not yet run.

## Gap 1 — the donated node listens only on TCP

`HostProcessOrchestrator` gives every donated child `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<port>` (`host-process-orchestrator.ts:566`) and scrubs every inherited `CADRE_*` variable, so nothing can add a WebSocket listener. With a TCP-only listen set cadre-core derives no WebSocket transport and db-p2p falls back to `tcp()` + circuit relay. A React Native phone has no TCP transport (WebSocket, circuit relay and WebRTC only — `cadre-phone.ts:243-255`), so it cannot dial the node at all.

The existing donation integration scenario does not notice because its requester is a cadre-cli owner node dialing over loopback TCP.

## Gap 2 — the flow's dial direction needs the phone to be dialable

The donation lifecycle as built has the **donated node dial the requester**: `POST /grants` requires a non-empty `bootstrapNodes` list naming the requester (`bootstrap-node-validation.ts:172-175`), and the applied seed dials owner peers' addresses (`seed-bootstrap.ts:762-777`). A phone has `listenAddrs: []`, holds no relay reservation, and publishes no dialable address, so there is nothing true to put in `bootstrapNodes` and nothing for the node to dial.

The reference-app flow and the architecture doc's "Phone Adds Provider Drone" sequence go the other way — the NAT'd phone dials the drone after the seed is applied. The backlog ticket `debt-docs-add-a-node-flows-dial-in-opposite-directions` records that the two documents disagree; this ticket is the code half: the donation flow has to work for a requester that can only dial out.

Things the design has to settle rather than assume:

- Whether the phone dials the donated node after seeding (so `bootstrapNodes` becomes optional, or names the phone only so the node's inbound gate admits it), or whether the phone first becomes dialable by reserving a relay slot — plausibly on the donated node itself, which runs the relay server by default on the storage profile. If the second, coordinate with the sibling ticket `phone-reachable-for-strand-invitations`, which needs the same capability.
- What the donated node does between provision and the phone's first dial (today it retries dialing its bootstrap/owner peers on the reconcile cadence — harmless, but it will retry forever against addresses that cannot answer).
- Whether the node's inbound gate admits the phone's first connection before the node has the phone's `CadrePeer` row (the seed's owner entry should cover it; confirm, don't infer).

## Gap 3 — the reference app cannot make the request

No code in `packages/reference-app-rn` calls `addDrone`, `createSeed`, or any `/grants` route. The pieces it would need exist: `useCadre()` exposes the live `CadreNode` (`use-cadre.ts:379`), the phone runs owner genesis and initializes seed bootstrap at start (`cadre-phone.ts:342-356`), and `CadreNode.addDrone({ dronePeerId, droneMultiaddrs })` returns `{ seed, encodedSeed }`.

The app needs a "request a node from a host" action: host address + grant token in; `POST /grants` (party id, owner public key, bootstrap per Gap 2), poll `GET /grants/:id/peer`, `addDrone`, `PUT /grants/:id/seed`, then connect per Gap 2 — with progress and failures surfaced in the UI (the donation calls fail in distinct ways: `400 invalid_request`, `peer_unavailable` while the child boots, `502 seed_failed`, `409` if the loan ended).

Reaching `/grants` is loopback-only in v1. For a USB-attached dev phone, `adb reverse` of the host's UI port makes `http://127.0.0.1:<port>` work and satisfies the origin guard; across a real network it does not, which is the separate backlog ticket `feat-cadre-host-wan-grant-reachability`. This ticket should not solve WAN reachability; it should make the same-machine/dev path work so the flow is provable on a device.

The debug build already permits cleartext `ws://`/`http://` to loopback (`android/app/src/debug/AndroidManifest.xml`).

## Expected behaviour when done

- On a phone running the reference app: solo start → enter host URL + grant token → tap request → the donated node appears in the phone's control database as a peer, a strand the phone created before the request becomes present on the donated node, and a message sent on the phone is readable on the node (and the reverse).
- The phone relaunching (same party id — see `feat-rn-persist-node-start-options`) reconnects to its donated node without repeating the request.
- An integration scenario proves the same thing headless with a requester that **cannot listen** (`listenAddrs: []`, WebSocket-only transports), so the phone shape is covered in CI rather than only on a device.

## Related

- `feat-cadre-host-wan-grant-reachability` — WAN reach to `/grants` and per-donated-node NAT mapping (out of scope here).
- `debt-docs-add-a-node-flows-dial-in-opposite-directions` — the documentation half of Gap 2.
- `feat-rn-persist-node-start-options` — without a persisted party id every relaunch is a new cadre, so "reconnects after relaunch" cannot be observed.
- `debt-host-process-orchestrator-untested` — touches the same file as Gap 1.
- `phone-reachable-for-strand-invitations` — the other half of "a phone is never dialable".
