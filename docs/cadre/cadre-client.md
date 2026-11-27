# The cadre client

`@serfab/cadre-client` is cadre management for an app, without UI: the person's cadrons (the
machines of their cadre), claiming a node by its code, removing one, backing up the owner key,
relays, whether anybody can reach this device, and which cadrons an invitation names. Usage is in
the [package README](../../packages/cadre-client/README.md); this page is the model behind it.

## Two entry points

- **`@serfab/cadre-client`** loads no cadre-core code: types, results, stores, node-code text and
  address judgement. A screen or a mock imports it freely.
- **`@serfab/cadre-client/sereus`** works over a running node. The app builds and owns the node and
  hands the client a small host (`CadreHost`); `edgeNodeHost` adapts an edge node.

Every operation returns a result with a stable error `kind` rather than throwing, and each piece of
screen state comes as a store that any UI framework binds to.

## Reachability

A phone cannot accept connections, so on its own it can be reached only through a relay
reservation. A device also counts as reachable when one of its always-on cadrons has an address
that reaches from anywhere, because an invitation names that cadron and it answers a join for the
party. A relay is then not needed to invite anybody.

## Which cadrons an invitation names

An open strand invitation carries a bootstrap list, the addresses a joiner dials to reach one of
the inviter's cadrons ([Which machines an invitation names](../strands/formation.md#which-machines-an-invitation-names)).
The client builds that list itself and the app puts it in the invitation before encoding it. The
list is not signed: the responder checks only the token.

### The order

- **Cadrons:** the ones the person marked preferred, in their order; then other always-on cadrons;
  then the rest, each group newest address record first.
- **Each cadron's addresses:** a public DNS name or IP over a WebSocket first, then a relayed
  address whose hop to the relay is a WebSocket, then WebRTC. Private addresses only when the person
  allows them. Never loopback, plain TCP, or a relay reached over plain TCP: no phone can dial those.
- **The cap:** one address per cadron before any cadron gets a second, at most the person's
  `maxAddrs` (two by default). Fewer addresses make a shorter link and a sparser QR code.
- **This device's own addresses** (a phone's relayed address) go in only when no cadron reaches from
  anywhere, unless the person chose always or never.

### The evidence for a cadron's addresses

- **Its address record**, all of it (`resolvePeerAddrs`).
- **A connection this device opened to it** with no relay hop, which shows the address answers.
- **Its claim**: the addresses its node code carried, kept in the bootstrap peer store until its
  first address record reaches this device.

### Ready to hand out

A cadron can answer a join for a new strand only once its own copy of the strand is live; until
then it refuses with the retryable `host-strand-unavailable`. A new strand's first sync comes from
the founder, so a phone that mints an invitation and goes to the background at once can leave its
cadron unable ever to answer.

The client reports an invitation **ready** once a commit of its strand is held by another machine
(`strand:commit-held`, or a commit reported `heldElsewhere`). The cadron then holds the strand's
data and finishes starting without the founder. A cadron's `StrandPeer` row is no evidence: it is
written before the cadron's copy is live. An established strand counts as ready when another
cadron serves it.

### Preferences

The person's preferred cadrons, their own names for them, the cap, and the choices about this
device and private addresses are kept on the device, in the host's `preferences` slot.

### The readable invitation

`describe` turns an encoded invitation into one line per address (the cadron's name or short peer
id, the address kind, host and port), the expiry, the link's length and the smallest QR version
that holds it.

## Limits and accepted tradeoffs

Each item is a workaround for something cadre-core does not yet do. The source marks each site
with `WORKAROUND(sereus: …)` naming the same feature.

- **The client replaces cadre-core's bootstrap list.** An open invitation names each sibling's
  first four addresses in the order the sibling published them, and a sibling publishes every
  address libp2p reports, loopback, private and plain TCP first, so a cadre-host machine on a
  server can be named only by addresses no phone can dial. Revisit when open invitations rank
  addresses, or published address records leave those addresses out.
- **A just-claimed cadron is named by its claim's addresses.** cadre-core leaves a sibling with no
  address record out of an invitation altogether. Revisit when a claim publishes the first record.
- **Readiness is read from commit durability.** cadre-core has no signal for when an invitation can
  be answered without its minting machine. Revisit when it does, or when a responder waits for its
  copy instead of refusing.
- **Preferences are per device.** Each of the person's devices keeps its own preferred cadrons and
  cap. Revisit when the control schema holds a party-level bootstrap policy.
- **The list is rewritten after minting.** `createOpenInvitation` takes no list or policy. Revisit
  when it does.
