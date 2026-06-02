description: Control-network push-wake protocol so a cadre peer can signal a hibernating peer to come online
prereq: hibernation-checkin-backoff
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, docs/architecture.md, docs/STATUS.md
----

The architecture lists three wake paths (local, check-in, push), but only local exists today and check-in lands in the prereq ticket. This ticket adds the **push-wake** path: another node in the same cadre — e.g. an always-on server that participates in the strand and sees new activity — signals a hibernating cadre peer over the **control network** to bring a strand online, pull pending activity, and re-hibernate.

Push-wake travels the control network (the per-party network that connects this party's own cadre nodes), which is the only network a hibernating peer keeps connected. The sender is a same-cadre peer that knows there is activity for `strandId`; the receiver resumes that strand using the wake path from the `hibernation-resource-release` ticket.

### Design

Add a libp2p request/response protocol on the **control node**, modeled directly on `SeedBootstrapService` (`packages/cadre-core/src/seed-bootstrap.ts`): length-prefixed JSON frames, `node.handle(WAKE_PROTOCOL, ...)` for the receiver, `node.dialProtocol(addr, WAKE_PROTOCOL)` for the sender, the `decodeLengthPrefixedFrame` helper, and the same `LibP2PStream` shim. Protocol id `/sereus/strand-wake/1.0.0`.

Messages:

```ts
interface WakeRequest  { strandId: string; reason?: string }   // "activity" | "manual"
interface WakeAck      { accepted: boolean; status?: StrandStatus; reason?: string }
```

A `StrandWakeService` (new module, or a focused addition alongside seed-bootstrap):

- **Receiver**: on an inbound `WakeRequest`, look up the strand instance. If it is `hibernating`/`idle`, trigger the same wake path `CadreNode.wakeStrand` uses (→ `resumeStrand`); reply `WakeAck { accepted: true, status }`. If the strand is unknown or not participated in, reply `{ accepted: false, reason }`. Resume coalescing from the prereq ticket prevents a wake racing a concurrent check-in.
- **Sender API** on `CadreNode`: `pushWake(targetPeerId, strandId, reason?)` — resolve the target's dialable control-network multiaddr from `CadrePeer` membership (`controlDatabase.queryCadrePeers()` / peerStore), dial `WAKE_PROTOCOL`, send the request, return the ack. Reuse the relay/peerStore addressing already populated by the seed/invite flow so NAT'd peers are reachable via their circuit-relay address.

**Authorization:** the control network already restricts membership (only this party's cadre peers connect — schema-gated `CadrePeer`). A wake request is low-risk (it only causes the receiver to spend resources coming online for a strand it already participates in). Verify the remote peer is a `CadrePeer` member (`CadreNode.isMember(remotePeerId)`) before honoring a wake; reject otherwise. Do not require a signature beyond control-network membership for v1 — document this decision.

**Who triggers push-wake automatically** (a server detecting strand activity and fanning wakes to hibernating cadre peers) is an integration policy, not core transport. This ticket delivers the protocol + receive path + `pushWake` send API + membership check. The automatic-trigger policy and mobile FCM/APNs delivery are owned by `tickets/backlog/3-mobile-background-service.md` (push-wake delivery / background entry point) — note the dependency there rather than implementing trigger policy here.

Export the new service/types from `packages/cadre-core/src/index.ts` alongside the seed-bootstrap exports.

### Docs

- `docs/architecture.md:497-500` ("Wake Mechanisms"): describe all three paths as they now exist — local (app), check-in (resume-sync cycle on backoff), push (control-network `WAKE_PROTOCOL` from a same-cadre peer, membership-gated). Add a short note on the protocol id and message shape near the seed-protocol description.
- `docs/STATUS.md`: flip the push-wake checklist item.

### Key tests

- `strand-wake-protocol.spec.ts` (mirror `seed-bootstrap.spec.ts` style with in-memory libp2p or a mocked stream): a `WakeRequest` for a hibernating strand triggers the wake callback and returns `{ accepted: true }`; an unknown strand returns `{ accepted: false }`; a request from a non-member peer is rejected; length-prefix framing round-trips and oversized frames are rejected (reuse `decodeLengthPrefixedFrame` guards).
- `cadre-node.spec.ts`: `pushWake(peerId, strandId)` dials the target and a hibernating receiver transitions to `active` (mock the control node `dialProtocol`/`handle`).

## TODO

- [ ] Define `WAKE_PROTOCOL`, `WakeRequest`, `WakeAck` in `types.ts`; implement `StrandWakeService` (receiver `handle` + sender `dialProtocol`) following the `seed-bootstrap.ts` framing pattern.
- [ ] Register the wake handler on the control node in `CadreNode.start`/`cleanup` (alongside seed/solicitation services); wire the receiver to the existing wake path (`wakeStrand` → `resumeStrand`).
- [ ] Add `CadreNode.pushWake(targetPeerId, strandId, reason?)` that resolves the control-network address from `CadrePeer`/peerStore and dials `WAKE_PROTOCOL`; gate inbound wakes on `isMember(remotePeerId)`.
- [ ] Export the service + types from `index.ts`.
- [ ] Note the auto-trigger + mobile-delivery dependency in `tickets/backlog/3-mobile-background-service.md`.
- [ ] Update `docs/architecture.md` Wake Mechanisms + `docs/STATUS.md`.
- [ ] Add the tests above; run `yarn workspace @serfab/cadre-core test` + typecheck/build, streaming with `tee`.
