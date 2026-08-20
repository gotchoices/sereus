description: A phone or laptop that cannot accept incoming connections stays reachable by asking one of the party's always-on machines to forward traffic for it. That always-on machine currently refuses the request whenever it has not yet heard that the phone is a member — and the phone has no other way to become reachable, so it ends up with no address at all and nobody can reach it. Let the forwarding request through, and decide who gets forwarded at the forwarding step rather than by slamming the door first.
prereq:
files: packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/relay-reservation.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/test/membership-connection-gater.spec.ts, docs/architecture.md
difficulty: hard
repro: verified

----

# A control node's membership gate denies a sibling's circuit-relay reservation

## The measurement

Reproduced end to end over real libp2p nodes in
`packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts`
(new, green, 3 cases, ~25 s). Topology: control node **A** (owner, `profile: 'storage'`,
so `circuitRelayServer` is on), control node **B** (an ordinary reachable member), and
control node **C** with no listener of its own whose only address can come from a
circuit-relay slot on A.

**Case 1 — C authorized before it boots: the whole chain works.** Every link asserted
separately and every one passes:

1. C's `getMultiaddrs()` gains a `/p2p-circuit` address once A grants the reservation.
2. identify/push carries that address into **A's** peerStore.
3. C republishes its `CadrePeer` row carrying the address (`self:peer:update` →
   `registerSelf`).
4. **B — which never connected to C directly — merges it into its own peerStore** via
   `warmSiblingAddrBook` on the 15 s control-cohort reconcile pass.

So the address-seeding machinery this repo already has is sound, and the identify
protocol-id candidate is eliminated (link 2 cannot pass unless both sides agree on
`/optimystic/control-<partyId>/id/push/1.0.0`).

**Case 2 — same topology, C NOT authorized, `network.relayAddrs` route: C does not boot.**
`C.start()` rejects with libp2p's `UnsupportedListenAddressesError`, whose cause is:

```
/ip4/127.0.0.1/tcp/<port>/ws/p2p/<A>/p2p-circuit:
  UnexpectedEOFError: Unexpected EOF - stream closed while reading 0/1 bytes
    at ReservationStore.#createReservation (@libp2p/circuit-relay-v2/.../transport/reservation-store.js:279)
```

That EOF is A killing the connection at `denyInboundEncryptedConnection` while C's
reservation stream is open.

**Case 3 — same denial on the fail-soft route: C boots and is permanently addressless.**
With a bare `/p2p-circuit` search listener driven by `CadreNode.reserveRelays`
(`relay-reservation.ts`), the identical denial yields `status: 'retrying'`, zero
multiaddrs, and the same reservation-stream EOF in `state.error`. The node is up, looks
healthy, and cannot be dialed by anyone. **This is the reported shape.** Authorizing that
same peer and re-driving the same reservation against the same relay makes it succeed —
nothing else changes, which isolates the gate as the cause.

## Root cause

One site: `CadreNode.admitInboundControlConnection` (`cadre-node.ts:1214`), reached
through `createMembershipConnectionGater`'s `denyInboundEncryptedConnection` composition
(`membership-connection-gater.ts:157`).

A circuit-relay reservation is established by the reserving peer dialing the relay. At
the relay that is an **inbound** connection, so it is judged by the membership connection
gate. When the gate reaches its `listAuthorizedMembers()` check and the peer's `CadrePeer`
row is not there, it denies — and the reservation dies with the connection.

The gate's own module doc names the escape hatch it relies on:

> NOTE: a sibling whose membership row has not yet replicated to this node is denied until
> the row converges (typically via the owner); either side's next outbound reconcile dial
> (outbound is never gated) re-establishes the link — self-healing, but visible as a
> transient deny.

**That escape hatch does not exist for a reservation.** A dialing out to C does not give C
a reservation, and A cannot dial C anyway — C has no address, which is the very thing the
reservation would have given it. The deny is therefore not self-healing on its own; it
clears only when the missing row happens to arrive.

This is the same defect class that `strand-delegate-peer-relay-admission` (in `complete/`)
fixed for **strand delegates**: a NAT'd member's strand node was denied its reservation by
this same gate, and the cure was an explicit connection-only admission grant
(`delegate-admission.ts`). Nothing equivalent covers a member's **control** peer. That
asymmetry is exactly what the upstream report observed — the same devices' strand peer ids
carried working `/p2p-circuit` addresses while their control peer ids carried none.

### Why the window is not merely transient

Three ways a genuine member sits unauthorized-at-A for a long time or forever:

- **Boot ordering.** C's circuit listener runs inside `libp2p.start()`, before C's own
  control database exists. Nothing sequences that against A having C's row.
- **Replication lag by design.** A learns C's row only by control-DB replication; the row
  is typically written by the owner, which may not be A.
- **Replication that never completes.** `tickets/blocked/control-peer-row-refresh-invisible-to-third-node`
  is a measured upstream defect in which a third node's control-collection view forks and
  it *never* sees a newcomer's `CadrePeer` row. Under that fork the deny is permanent, and
  the relay-only member is permanently unreachable. **This ticket must not wait on that
  one** — the boot-ordering window exists even with perfect replication.

## What must change

The relay is deciding a **relay** question ("may this peer use my forwarding capacity?")
with a **membership** answer, at a checkpoint where a wrong answer is unrecoverable. The
two must be separated.

`@libp2p/circuit-relay-v2`'s server already offers the right seam. Verified in
`node_modules/@libp2p/circuit-relay-v2/dist/src/server/index.js:123`:

```js
if ((await this.components.connectionGater.denyInboundRelayReservation?.(connection.remotePeer)) === true) { ... }
```

`createMembershipConnectionGater` spreads its base gater, so a
`denyInboundRelayReservation` hook composes cleanly alongside the existing one, and
`buildControlNodeOptions` (`cadre-node.ts:1100`) already has `enableRelay` in scope at the
construction site.

### Recommended design — reservation-scoped admission

On a control node whose relay server is enabled, stop letting the membership
determination become a *connection* deny, and express it at the reservation seam instead:

- **Admit the connection** for a peer the gate would otherwise deny, when this node runs
  the relay server. The fail-closed per-stream gate
  (`CadreNode.authorizeInboundControlStream`) still refuses all four control-DB protocols;
  wake and strand-addr still check `isAuthorizedMember` in their handlers; seed and
  formation keep their own in-protocol trust decisions. So an admitted stranger gains
  identify/ping and the relay hop protocol, nothing else.
- **Grant the reservation** to such a peer on a bounded budget — a separate, small cap on
  concurrent *unauthorized* reservations counted in `denyInboundRelayReservation`, so a
  member whose row is in flight always gets a slot while an outsider cannot annex the
  party's relay. Authorized members are never counted against that cap.
- **Drop the connection if it is not reserving.** Arm a short deadline (a few seconds) on
  each stranger-admitted connection and close it unless the peer has taken a reservation
  by then. This preserves most of what the connection layer exists for — the module doc's
  "a known-nothing outsider is never even in the conversation" weakens to "is in it
  briefly, and can speak nothing" rather than being abandoned.

### The fallback, if the above proves too much machinery

Blanket-admit at the connection level on relay-enabled control nodes, with no reservation
cap and no deadline. This is the "admit-everyone on relay-enabled nodes" option that
`strand-delegate-peer-relay-admission` explicitly **rejected** — but it rejected it
because a cheaper carve-out (the member-announced delegate grant) existed for the strand
case. No such channel exists here: before the reservation, C and A share no
already-authenticated connection over which a grant could be announced, and C cannot dial
A any other way. If you take the fallback, record it as an accepted tradeoff `NOTE:` at
the gate and say so in the handoff.

**Rejected here, for the record:** a durable signed attestation row proving membership
ahead of the reservation — same objection the delegate ticket recorded, a
replication-latency dependency on a hard-fail path, which is precisely the dependency this
ticket exists to remove.

## Scope boundaries

- **Do not** change `relay-addrs.ts`'s fail-fast posture. A configured `relayAddrs` entry
  naming a relay that is down *should* stop a server from booting; that is a deliberate,
  documented decision. Once the gate stops denying members, case 2 stops firing.
- **Do not** touch `strand-instance-manager.ts` or the delegate-admission path. Strand
  cohort nodes keep the raw configured gater and are already covered.
- **Reporter-side candidates ruled out or out of scope:** the identify protocol-id
  mismatch is eliminated by case 1 link 2. The 6–15 s main-thread block during boot on a
  low-end device is the reporter's own environment; it would produce the same symptom, but
  nothing in our bring-up path was implicated by the measurement above.

## Handing the finding back upstream

[gotchoices/Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12) is currently
weighing a feature request premised on our earlier diagnosis — that nobody can ever teach a
relay-only peer's first address. The measurement above says that premise is wrong: both
seeding paths (`identifyPush` to the relay, and the address carried in the reserving node's
own cluster records) work, proved by case 1. The failure is a Sereus-side admission policy
denying the reservation before any address exists to seed.

**Outward-facing, so a human posts it — do not post from an agent run.** Draft, for whoever
does:

> Correction to our earlier analysis on this issue. We reproduced the reported topology
> end to end (relay-providing control node, relay-only control node, and an unrelated third
> member) and the address-seeding chain is intact: the relay-only peer obtains its
> `/p2p-circuit` address, `identifyPush` carries it into the relay's peer store, and a
> third member that never connected to it directly learns the address from the cluster
> records it coordinates. No db-p2p change is needed for that.
>
> The failure is on our side: our control node composes a membership connection gater that
> refuses an inbound encrypted connection from a peer whose membership record it has not
> yet replicated. A circuit-relay reservation *is* such an inbound connection, so the
> reservation stream dies mid-handshake (`UnexpectedEOFError` inside
> `ReservationStore.#createReservation`) and the peer never obtains an address to seed. Our
> strand-layer peers were unaffected because they hold an explicit admission grant that
> control peers had no equivalent of. Tracked and being fixed in Sereus.

## TODO

### Phase 1 — the fix

- Add the relay-reservation seam to `createMembershipConnectionGater`: compose a
  `denyInboundRelayReservation` hook alongside the existing
  `denyInboundEncryptedConnection`, preserving the base gater's own hook if it has one
  (deny from either wins), and keeping the same fail-open-on-error contract
- Thread the "this node runs the relay server" fact into the gater from
  `buildControlNodeOptions`, where `enableRelay` is already computed
- Stop `admitInboundControlConnection` from turning an unauthorized-outsider determination
  into a connection deny when the relay server is enabled; move the determination to the
  reservation hook
- Add the bounded unauthorized-reservation budget (a small cap, counted only for peers the
  membership check did not admit; authorized members uncapped)
- Add the not-reserving deadline: close a stranger-admitted connection that has taken no
  reservation within a few seconds
- Rewrite the `membership-connection-gater.ts` module doc — the "Announced delegate peers"
  carve-out section and the fail-open rationale both describe a world where the connection
  deny is the whole story
- Correct the stale self-healing claim in the `admitInboundControlConnection` doc comment
  (`cadre-node.ts` ~line 1205): outbound re-dial does not re-establish a reservation

### Phase 2 — tests

- **Flip cases 2 and 3** of `relay-only-control-addr.integration.ts` to assert success.
  Both carry a `CHARACTERIZATION` marker at the exact assertions to invert, and the file
  header says so; inverted, they are this fix's regression guard. Case 1 must stay green
  unchanged
- Add a case: an unauthorized peer that is admitted for its reservation still cannot speak
  any control-DB protocol (extends what `control-stream-authz.integration.ts` already
  proves) and is dropped when it takes no reservation
- Add a case that the unauthorized-reservation cap actually bounds: N+1 unauthorized
  reservers, the N+1th refused, an authorized member still admitted
- Unit-level coverage in `packages/cadre-core/test/membership-connection-gater.spec.ts` for
  the new hook's composition and fail-open behavior, matching the existing hook's coverage

### Phase 3 — docs + handoff

- Update `docs/architecture.md` where the membership enforcement chain is described, and
  the delegate-admission narrative in `docs/strands.md` if it claims the connection gate is
  the sole relay admission control
- Note in the review handoff whether the recommended design or the fallback was taken, and
  if the fallback, leave the accepted-tradeoff `NOTE:` at the gate
- Carry the upstream draft comment above into the handoff so a human can post it
