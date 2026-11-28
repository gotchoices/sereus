# The cadre client

`@serfab/cadre-client` is cadre management for an app, without UI: the person's cadrons (the
machines of their cadre), claiming a node by its code, removing one, backing up the owner key,
relays, whether anybody can reach this device, and which cadrons an invitation names. Usage is in
the [package README](../../packages/cadre-client/README.md); this page is the model behind it.

## Entry points

- **`@serfab/cadre-client`** loads no cadre-core code: types, results, stores, node-code text and
  address judgement. A screen or a mock imports it freely.
- **`@serfab/cadre-client/sereus`** works over a running node. The app builds and owns the node and
  hands the client a small host (`CadreHost`); `edgeNodeHost` adapts an edge node.
- **`@serfab/cadre-client/app-link`**: apps on one device handing a join request and its answer to
  each other by link, and recommending an app ([Between apps on one phone](apps.md#between-apps-on-one-phone)).
- **`@serfab/cadre-client/lifecycle`**: the background runner ([Strand hibernation and wake](../strands/hibernation.md)).

## Where it sits

cadre-client and the platform kits each build on cadre-core; neither builds on the other. The app
joins them: a kit builds the node (`createPhoneNode` on React Native, cadre-core's `createEdgeNode`
on the web and NativeScript), and the client manages it through an `EdgeNode` or a `CadreHost`.

- **cadre-client** holds the logic every platform shares: cadre management, invitation planning,
  app links, the background runner. A platform's own pieces are passed in (`canOpenURL`, app-state
  events, storage slots).
- **A platform kit** holds only what needs the platform: native crypto, storage, the secure store,
  polyfills, bundler setup, URL scheme registration, and the adapters that pass these in.

New platform-neutral logic belongs here, not in a kit.

Every operation returns a result with a stable error `kind` rather than throwing, and each piece of
screen state comes as a store that any UI framework binds to.

## Adding a cadron

Three ways, for three kinds of node ([Adding and removing machines](membership.md)):

- **By its node code** (`inspectNodeCode`, then `claimNode`): a node waiting to be claimed (cadre-host,
  a provider container, `cadre init`). The preview names the peer, whether it can be reached from
  anywhere, this device's network id and owner fingerprint, so the person checks it joins the
  right cadre before approving. A code can come from anyone, so nothing is claimed without approval.
- **By its address** (`connectNode`): a node started to listen for seeds. The client authorizes it
  (an owner-signed record) and delivers the seed; when the node does not take the seed over the
  network, the result carries it for delivery another way.
- **By a seed alone** (`createSeed`): for a node not created yet. A seed carries addresses and
  authorizes nothing, so the node is added by address or claim once it exists.

A code arriving while the screen is not ready, or while a claim runs, waits in a `nodeCodeInbox`:
one slot, the latest arrival kept. Listening for the links is the platform's.

## Removing a cadron

`removeMachine` is cadre-core's complete removal ([Removing a machine](removing-machines.md)): the
cadron's record, the invitations it could come back through, and the party's key in each closed
strand, so it reads nothing new there. It is refused for this device itself and on a device with no
owner key. `planRemoval` says beforehand what it will do, for an honest confirmation.

`changes.removed` reports a cadron leaving: removed through this client, or found gone when the
machine list is read again (a removal on another device). Comparing needs two complete reads, so a
read that timed out reports nothing.

## Reachability

A phone cannot accept connections, so on its own it can be reached only through a relay
reservation. A device also counts as reachable when one of its always-on cadrons has an address
that reaches from anywhere, because an invitation names that cadron and it answers a join for the
party. A relay is then not needed to invite anybody.

## Whether a cadron is alive

Each cadron in the status carries `connected` and `lastSeenAt`, and `cadronPresence` reads them
as one state for a status dot:

- **Connected:** this device holds a control-network connection to the cadron now. Every machine
  dials the always-on machines, so for an always-on cadron this is the answer.
- **Recent:** not connected, but its address record was published within 15 minutes, the record's
  freshness window; a running machine re-publishes every 7.5. Two phones rarely connect to each
  other even while both run, so a phone usually reads this way.
- **Quiet:** heard from, longer ago. **Unknown:** its record has not reached this device.

This device counts as connected while its own node runs. The machine list re-reads when a cadron
connects or drops: cadre-core emits no per-peer event, so the client listens to the control
node's libp2p connection events.

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
device and private addresses are kept on the device, in the host's `preferences` slot. The app
keeps the text opaque: it carries its own format version, and a later format is migrated inside
the package.

### The readable invitation

`describe` turns an encoded invitation into one line per address (the cadron's name or short peer
id, the address kind, host and port), the expiry, the link's length and the smallest QR version
that holds it.

## What re-reads a store

`cadreStore` re-reads on every change that has an event: this node starting or stopping, a cadron
connecting or dropping, the cadron preferences. Two changes have none, and a poll (30 s by default,
`pollMs`) catches them: a cadron added or removed on another device, which arrives by control
replication, and a cadron's record ageing, which turns its presence from recent to quiet.
`reachabilityStore` re-reads when this device's addresses change and polls for a cadron of the
party coming up or going quiet.

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
