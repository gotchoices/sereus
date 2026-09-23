description: When one of your machines forwards traffic on your behalf, it hangs up on anyone outside your group who tries to reach you through it, five seconds in. That makes it impossible to invite an outsider into a private chat while relying on your own machine to be your address.
files: packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The five-second drop is a deliberate, tested defence — it is what stops an outsider from parking a connection on a party's machine — so loosening it costs security thinking, and nothing ships today that needs an outsider to dial through a party-run relay.
----

# The relay-only admission window has no room for a hop connect

## The two ways a peer uses a relay

A **circuit relay** forwards traffic for a node that cannot accept incoming connections. Two different peers connect to it for two different reasons:

- the **forwarded-for** node **reserves** a slot, so that it has an address at all;
- anyone **dialling** that node **hop-connects** through the relay to reach it.

A relay run by one of a party's own machines (any storage-profile `CadreNode`; `relayServerEnabled`) sees both as ordinary inbound connections.

## The defect

`admitInboundControlConnection` (`cadre-node.ts`) classifies an inbound peer it cannot recognise as a member, and cannot cover by any stranger carve-out, as `'admit-for-relay'` when the node runs a relay server. `createMembershipConnectionGater` then arms a `RELAY_ADMISSION_RESERVE_DEADLINE_MS` timer (5 s) against that connection and closes it unless a **reservation** for that peer is admitted at `denyInboundRelayReservation`, which is the only thing that disarms it.

A hop connect never touches that hook. So an outsider dialling *through* a party-run relay to reach a member gets its connection torn down five seconds later, taking the relayed connection with it.

`relay-only-control-addr.integration.ts` already asserts this drop, as intended behaviour: "an admitted-for-relay stranger speaks no control-DB protocol and is dropped when it never reserves". The module doc in `membership-connection-gater.ts` describes the same rule. Nothing about it is accidental — it just has no case for the peer that is using the relay the way a relay is meant to be used.

Found by reading the code while planning `phone-becomes-reachable-through-a-relay`; not observed on a wire.

## Why it matters

It is the difference between "a party's own machines can be the party's address" and "a party needs third-party relay infrastructure". Concretely: a person with a phone and a machine at home should be able to invite someone into a private chat with the home machine as the address, and the invitee is by definition an outsider to that party. Today the invitee's dial dies five seconds in.

The carve-out that would cover the invitee at the *connection* level does exist — an outstanding formation invitation suspends stranger denial — but it is unreachable on a lent node, which never calls `initializeStrandSolicitation` and so answers the check with "no service". Even where it is reachable it would be the wrong instrument: it admits the connection because a formation handshake might be riding it, not because the peer is using the hop.

## What a fix has to weigh

The deadline exists so an outsider cannot park a connection on a party's machine and sit there. Any fix has to keep that bound while letting a genuine hop through. Questions the ticket should answer:

- Can the gate observe that the connection opened a hop stream, and treat that as disarming the timer the way an admitted reservation does?
- If so, what bounds a hop connection? A hop to a peer that holds no reservation here should be refused outright; a hop to a peer that does is forwarding this party already pays for.
- Should hop-connect admission be a separate policy decision from reservation admission — the equivalent of `admitControlRelayReservation` for the forwarding side — so the two can be tuned apart?
- Whatever lands must keep the existing assertion in `relay-only-control-addr.integration.ts` honest: a connection that neither reserves nor hops is still dropped.

## Related

- `backlog/feat-phone-relays-through-its-own-always-on-node` — the capability this blocks.
- `backlog/bug-party-run-relay-caps-every-relayed-connection` — the other half of the same blockage, at a different code site.
- `backlog/debt-relay-reservation-decision-repeatable-cost` — the cost of the decision already made on this path. A new hop-admission decision would sit on the same hot path, so the two should be weighed together.

## The drop has not actually been happening (measured 2026-09-23)

The five-second drop this ticket describes has been a no-op over WebSockets, which is every control node's listening transport. `PendingReserveDeadlines.expire` aborts the connection, and `abort()` on a WebSocket never reaches the wire: `@libp2p/websockets` sends the reserved close code 1006, `ws` rejects it, and the failure is swallowed. The relay marked the connection gone and the socket stayed open on both ends.

So a hop-connecting outsider has in practice been surviving — until its own liveness ping failed, or forever if it kept pinging. That is not a reason to close this ticket: the behaviour was never intended, was invisible, and leaked a socket on the relay for each such peer. `fix/bug-relay-only-deadline-abort-leaves-the-stranger-half-open` makes the drop real, which is when the defect described above starts biting for the first time. Re-read this ticket's `severity` and `likelihood` once that lands.
