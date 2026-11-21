# Operating Sereus relay infrastructure

`ops/` holds what an operator needs to run a dedicated libp2p relay for Sereus nodes: a container image, a Docker Compose stack, an installer, check scripts, and the procedures that go with them. It is for whoever runs a relay, for one party or for many. Nothing in this tree is application code and nothing in it is published to npm.

Related: [how a cadre node uses a relay](../docs/network/relay.md) · [concepts and glossary](../docs/concepts.md)

## What an operator runs

One process: a libp2p Circuit Relay v2 server that also answers STUN.

- The **relay** forwards connections to nodes that cannot be dialled directly, such as phones, browser tabs and machines behind a home router.
- The **STUN responder** tells a node its public address. Two nodes need that before they can replace a relayed connection with a direct WebRTC one.

The relay belongs to no cadre and no strand and holds no database content. Its only state is its identity key.

To run one, follow [`docker/README.md`](docker/README.md).

## Layout

| Path | Contents |
| --- | --- |
| [`docker/README.md`](docker/README.md) | The runbook: a fresh host to a running, verified relay, and how to update it. |
| [`docker/libp2p-infra/`](docker/libp2p-infra/README.md) | The relay image: its source (`src/`), `Dockerfile`, and the reference for its environment variables, limits and ports. |
| `docker/relay/` | The Compose stack that runs the image (`docker-compose.yml`) and the settings template (`env.example`). |
| `docker/site-scripts/svc.sh` | The `svc` command an operator runs in a site instance directory: `up`, `down`, `logs`, `ps`, `dns`. |
| `scripts/install` | Creates a site instance directory for the stack. |
| [`docs/`](docs/README.md) | Procedures that do not depend on Docker: DNS records, the identity key, STUN. |
| [`test/`](test/README.md) | Scripts that check a deployed relay from another machine. |

## Design decisions

### No bootstrap or DHT service

Sereus has no network-wide DHT or directory. A cadre's control network and each strand are separate libp2p networks, each with its own FRET instance, and only the nodes of that network take part in it. A node joins a network by dialling a node that is already in it, either directly or through a relay.

So there is no shared service for a bootstrap node to provide. What a joining node needs is the address of one reachable node in the network it is joining, and it gets that from a seed or an invitation. The relay is the only libp2p service that is shared between networks and therefore the only one this tree deploys.

### Relay and STUN in one process

A node that reaches its peers through a relay is the node that needs STUN, so the relay answers STUN itself. Apps derive the STUN address from the relay address they are configured with, and an operator has one service to deploy and one host name to publish. [`docs/ice-servers.md`](docs/ice-servers.md) covers how clients find it and why there is no TURN server.

### The relay does not cap what it forwards

libp2p's relay server limits each relayed connection to 128 KiB or two minutes by default. The image turns that limit off, because cadre database traffic does not fit inside it. The relay also does not authenticate its clients. [`docker/libp2p-infra/README.md`](docker/libp2p-infra/README.md#relay-limits) owns the reasoning and the accepted risk.

### A party's own always-on node is not deployed from here

A headless cadre node (a drone) belongs to one party's cadre, so it is not shared infrastructure and `scripts/install` does not create one. Its Docker template ships with `@serfab/cadre-cli` in `packages/cadre-cli/docker/`; see the [cadre-cli README](../packages/cadre-cli/README.md). A `server`-class cadre node also runs a relay server by default; [`docs/network/relay.md`](../docs/network/relay.md) covers that.

## Limits and accepted tradeoffs

- **Docker is the only supported deployment.** `scripts/install` accepts no mode other than `docker`. The relay process can be run directly with Node.js (see [Running without Docker](docker/libp2p-infra/README.md#running-without-docker)), but nothing here installs or supervises it that way.
- **TLS is the operator's to provide.** The image listens on raw TCP and plain WebSockets. A browser page served over https can only dial `wss`, which needs a TLS reverse proxy in front of the relay; see [`docs/dnsaddr.md`](docs/dnsaddr.md#serving-browsers-over-https).
