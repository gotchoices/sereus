description: A node is only given the network transports its own listening addresses need, so if it is pointed at a relay or a starting peer that is only reachable over a WebSocket address, it comes up with no way to reach that peer and never says why — it simply never joins the network.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/README.md
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: No configuration shipped in this repo names a WebSocket relay or bootstrap peer, and an operator who hits it can work around it today by adding any `/ws` listen address (which switches the transport on as a side effect), so a maintainer may judge the failure too rare to widen the check for.
----

# Transport derivation covers the addresses a node BINDS, not the ones it DIALS

## What is wrong

`resolveTransportOptions` (`packages/cadre-core/src/relay-addrs.ts`) closed half of a
real gap: a listen address whose transport the node would not have used to be dropped in
silence, and now it either brings its transport with it (`/ws`) or refuses start. That
check reads `network.listenAddrs` only.

The same node also **dials** addresses that come out of configuration, and nothing
derives transports from those:

| config field | what the node does with it | transport derived from it today |
| --- | --- | --- |
| `network.listenAddrs` | binds it | yes (`/ws` → WebSocket; anything unbindable refuses start) |
| `network.relayAddrs` | dials the relay to reserve a slot | **no** |
| `controlNetwork.bootstrapNodes` | dials each peer to join the network | **no** |

So a machine configured with, say, a TLS WebSocket relay in front of a load balancer —
`/dns4/relay.example.com/tcp/443/tls/ws/p2p/<peer id>` — and plain TCP listen addresses
gets `tcp()` and `circuitRelayTransport()` and no `webSockets()`. It starts cleanly. The
relay dial then has no usable address, so the reservation never lands. The same holds for
a WebSocket bootstrap peer: the node comes up, joins nothing, and the operator sees an
empty peer table rather than a message naming the address.

The circuit-relay transport does not rescue this. It carries traffic *through* a relay
once a connection to that relay exists; opening that first connection needs the relay's
own transport, the same as any other dial.

Two accidents keep this quiet in practice. No configuration in this repo names a
WebSocket relay or bootstrap peer. And a machine that happens to configure ANY `/ws`
listen address already gets `webSockets()` as a side effect, which makes its WebSocket
dials work for a reason unrelated to why they were configured.

## Confidence

Static — read from the code, not reproduced. What would confirm it: start a `CadreNode`
with `network.relayAddrs: ['/dns4/<host>/tcp/443/tls/ws/p2p/<id>']`, TCP-only
`listenAddrs`, and no `network.transports`, against a live WebSocket relay, and observe
that the reservation never lands while a `/ws` listen entry added to the same config
makes it land.

## What good would look like

The invariant worth stating is about the whole configuration, not about one field:

> Every multiaddr this node will bind **or dial** as a result of its configuration is
> claimed by a transport the node will actually have — otherwise it refuses to start and
> names the address.

That retires the class rather than the instance: it covers `relayAddrs` and
`bootstrapNodes` today and any future config field that yields an address, and it is one
extension of the function that already answers the question for listen addresses. Two
things it has to get right that the listen-only version did not have to:

- **Dialing is not binding.** `@libp2p/tcp` binds `/unix/<path>` but a peer is never
  reached at one; a `/p2p-circuit` entry is bindable but is not itself a dial target.
  The bindable set and the dialable set overlap without being equal.
- **Refusing a dial address is a bigger hammer than refusing a listen address.** An
  unreachable bootstrap peer is a degraded node; an unbindable listen address was a
  silently broken promise. Whether the dial half should refuse start or warn loudly is
  the open design question, and it should be settled before the code is written.

As with the listen half, a `network.transports` set by a programmatic embedder must skip
the whole check — the factories are opaque and the embedder owns the policy.

## Where this came from

Found reviewing `bug-configured-listen-transport-is-silently-missing`, which fixed the
bind half. Not a regression from it: this behaviour predates that change, and that change
neither widened nor narrowed it.
