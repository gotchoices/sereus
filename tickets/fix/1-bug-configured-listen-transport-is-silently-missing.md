description: A node told to listen on a WebSocket address never actually does — the address is accepted and then quietly ignored, so the phone app's companion server offers no WebSocket port even though its config and documentation both say it does.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-addrs.ts, packages/reference-app-rn/drone.cadre.yaml, packages/reference-app-rn/test-fixture/drone.fixture.yaml, packages/cadre-cli/README.md
repro: static
difficulty: medium
----

## What is wrong

A libp2p node can only bind an address whose transport it was actually built with.
The configuration file and the command line let an operator write **any** listen
address, but the list of transports a node gets is decided completely separately —
and nothing checks the two against each other. Write a WebSocket listen address in
YAML and the node comes up with no WebSocket transport, binds nothing for that
address, and says nothing about it.

## Where the two halves are decided

- **Listen addresses** come from `network.listenAddrs` in the config file (or from
  `CADRE_LISTEN_ADDRS`), and are passed through to the node essentially as written —
  `cadre-node.ts:1428` for the control node, `strand-network-config.ts` for strand
  nodes.
- **Transports** come from `network.transports`, which is a list of JavaScript
  factory functions. A YAML file cannot express one, so a config-file deployment
  always leaves it unset (grep confirms `cadre-cli` never sets it).
- With `network.transports` unset, `@optimystic/db-p2p`'s `createLibp2pNode`
  (`../optimystic/packages/db-p2p/src/libp2p-node.ts:14-36`) builds a default set of
  **TCP plus circuit-relay only**. Its WebSocket branch is gated on a separate
  `wsPort` option that `cadre-core` never passes.

So every non-TCP listen address an operator can write — `/ws`, `/wss`,
`/udp/…/quic-v1`, `/webrtc` — is inert on a config-file deployment.

## Two instances, both in shipped artifacts

- **`cadre start --ws-port <port>`.** The flag appends
  `/ip4/0.0.0.0/tcp/<port>/ws` to `network.listenAddrs`
  (`packages/cadre-cli/src/commands/start.ts:104-116`) and logs
  "Added WebSocket listen address". It never adds the WebSocket transport, so the
  flag does nothing observable. It is documented in the CLI README as a working
  option.
- **The React Native reference app's companion server.**
  `packages/reference-app-rn/drone.cadre.yaml` lists
  `/ip4/0.0.0.0/tcp/4002/ws` with the comment *"WebSocket for the React Native
  phone (required — RN can't do raw TCP)"*, and `README.md` tells the developer to
  check "the phone can reach the drone's IP on port 4002". Nothing ever listens on
  4002. `packages/reference-app-rn/test-fixture/drone.fixture.yaml` is worse: its
  only listen address is a WebSocket one, which should leave that node with no
  listenable address at all.

## Why it is silent

libp2p's transport manager sorts configured listen addresses by which transport
claims them. Addresses no transport claims are dropped, and it only raises an error
when **every** address was dropped. The drone config pairs a TCP address with the
WebSocket one, so the TCP address succeeds, the node starts, and the missing
listener is never reported.

## What "fixed" should mean

The point fix — teach `--ws-port` to add the transport — would leave the class
alive: the next operator writes `/quic-v1` in YAML and gets the same silence. The
invariant worth establishing is that **a configured listen address and the
transports the node will actually have are checked against each other in one
place**, at config resolution, before the node starts. Two shapes are worth
weighing as part of this ticket:

- **Reject**, the way `network.relayAddrs` and `network.announceAddrs` already fail
  fast on a malformed entry: name the address, name the transport it needs, and
  refuse to start. Consistent with how the rest of `NetworkConfig` treats operator
  typos, and it converts today's silence into a message.
- **Derive**, i.e. add the transport a configured address implies. Friendlier, but
  it means `cadre-core` deciding transport policy from address strings and pulling
  in transport packages it does not currently depend on.

Whichever is chosen, the check has to cover both the control node and strand nodes,
since both take their listen addresses from the same `NetworkConfig`.

## Confirming it

Not observed at runtime — read from the code paths above. What would confirm it:
start `cadre start -c packages/reference-app-rn/drone.cadre.yaml` and read back the
node's own multiaddrs (the health endpoint or `getMultiaddrs()`), expecting no
`/ws` entry; and boot a node from `drone.fixture.yaml`, expecting a hard start
failure because none of its listen addresses can bind.

## Out of scope

Programmatic embedders that pass `network.transports` themselves — the React
Native phone (`packages/reference-app-rn/src/cadre-phone.ts:243`), the web app, and
the integration-test harness (`node-fixtures.ts:154`) — are unaffected, and their
tests pass. This ticket is about the config-file and command-line surface only.
