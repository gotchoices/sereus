# Running a relay with Docker

The procedure for taking a fresh host to a running, verified Sereus relay, and for keeping it updated. The relay is the image in [`libp2p-infra/`](libp2p-infra/README.md), run by the Compose stack in `relay/`. This page owns the stack's own settings (`HOST_*`); the image's variables are documented with the image.

Related: [what `ops/` is and why it is built this way](../README.md) · [DNS records](../docs/dnsaddr.md) · [identity key](../docs/keys.md) · [check scripts](../test/README.md)

## Prerequisites

- A Linux host that clients can reach from the internet, directly or through a port forward.
- Docker Engine with the Compose v2 plugin, started at boot. `svc` runs `docker compose`, so the standalone `docker-compose` v1 binary does not work. Follow [Docker's install instructions](https://docs.docker.com/engine/install/).
- Git and Bash on the host.
- A DNS name for the relay, with an A record (and AAAA if the host has IPv6) pointing at the host. The examples use `relay.example.org`.
- The firewall open for TCP `4001` (raw TCP), TCP `4011` (WebSockets) and UDP `3478` (STUN). These are the default host ports; see [Stack settings](#stack-settings).
- Node.js on a second machine, to run the checks.

## Install and start

The installer keeps code and configuration apart. The clone holds code and can be updated or replaced. A separate **site instance directory** holds this relay's settings and its identity key.

```text
~/sereus-ops/            the ops root
  sereus/                the git clone
  docker-relay/          the site instance directory
    env.local            settings (created from relay/env.example, mode 600)
    data/                the identity key; mounted into the container at /data
    svc                  symlink to the clone's ops/docker/site-scripts/svc.sh
    compose.yml          symlink to the clone's ops/docker/relay/docker-compose.yml, for reference
```

### 1. Clone and create the instance directory

```bash
mkdir -p ~/sereus-ops && cd ~/sereus-ops
git clone https://github.com/gotchoices/sereus.git sereus
./sereus/ops/scripts/install docker relay
```

The installer creates `./docker-relay/` in the current directory. It is safe to run again: it never overwrites an existing `env.local`, `svc` or `compose.yml`. To put the instance somewhere else, pass the path as a third argument; see [The instance directory](#the-instance-directory) for the naming rule.

### 2. Set the public host name

Edit `docker-relay/env.local` and set the name clients reach the relay at:

```bash
PUBLIC_HOST=relay.example.org
```

Without `PUBLIC_HOST` the relay advertises the addresses it bound inside the container, which no client can dial. If a router in front of the host forwards different external ports, also set `PUBLIC_TCP_PORT` and `PUBLIC_WS_PORT` to the ports clients dial.

### 3. Start the relay

```bash
cd docker-relay
./svc up
./svc logs
```

`./svc up` builds the image and starts the container in the background. On its first start the relay logs that it generated an identity key. Every start then logs:

```text
relay peerId=12D3KooW...
relay reservations: applyDefaultLimit=false maxReservations=500
stun: answering Binding requests on udp 0.0.0.0:3478
listening on: /ip4/0.0.0.0/tcp/4001, /ip4/0.0.0.0/tcp/4002/ws
advertising (from PUBLIC_HOST):
  /dns4/relay.example.org/tcp/4001/p2p/12D3KooW...
  /dns4/relay.example.org/tcp/4011/ws/p2p/12D3KooW...
```

Check that the `advertising` lines carry the public host name and the host ports. The log then repeats the WebSocket address, which is the one phones and browsers are configured with. The `listening on` line shows container-internal addresses; never publish those. The value after `peerId=` is the relay's peer ID, which every address for this relay ends with.

### 4. Publish DNS records

```bash
./svc dns
```

`./svc dns` prints the DNSADDR TXT records for this relay, built from `PUBLIC_HOST`, the public ports and the running relay's peer ID. Create them in the DNS zone. [`../docs/dnsaddr.md`](../docs/dnsaddr.md) explains the records and how to confirm they have propagated.

### 5. Verify from another machine

On a machine other than the relay host, with a clone of this repository in `sereus/`:

```bash
npm --prefix sereus/ops/test install
node sereus/ops/test/check-node.mjs --target /dnsaddr/relay.example.org --relay --all
node sereus/ops/test/check-stun.mjs --host relay.example.org
```

`check-node` must report `connected`, a ping time and `relay check: ok` for both the TCP and the WebSocket record. It stops at the first record that fails, so a later record is not tested until the earlier one passes. `check-stun` must print the public IP address of the machine it ran on. [`../test/README.md`](../test/README.md) describes both scripts and what they do not prove.

The relay is then ready. A cadre node uses it by listing the relay's address, ending in `/p2p/<PEER_ID>`, in its relay configuration; see [`docs/network/relay.md`](../../docs/network/relay.md).

## If a check fails

| Symptom | Likely cause |
| --- | --- |
| The log says `advertising (from bound)` and prints a warning | `PUBLIC_HOST` is empty in `env.local`. |
| `check-node` on a `/dnsaddr/` target fails with `dnsaddr TXT lookup failed` or `Target multiaddr must include /p2p/<peerId>` | No TXT record was found at `_dnsaddr.<host>`. Check the records, or pass `--dns-mode doh` if they are new. |
| The TCP record passes and the WebSocket record times out | The WebSocket host port is closed in the firewall, or the record names container port `4002` instead of the host port. |
| `check-stun` times out | UDP `3478` is blocked, or the relay is not running. |
| `check-stun` prints a `172.x.0.1` address | It was run on the relay host. Run it from another machine. |
| The container exits with `Cannot read identity key` or `is not a valid key file` | The key file is unreadable or damaged; see [`../docs/keys.md`](../docs/keys.md). |

## Stack settings

These variables in `env.local` are read by the Compose file and never reach the container.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_PORT` | `4001` | Host TCP port mapped to the container's raw-TCP listener (`4001`). |
| `HOST_WS_PORT` | `4011` | Host TCP port mapped to the container's WebSocket listener (`4002`). Phones and browsers can reach the relay only here. |
| `HOST_STUN_PORT` | `3478` | Host UDP port mapped to the STUN responder (`3478`). Apps assume `3478`; change it only if the apps are given an explicit STUN URL. |
| `HOST_BIND_IP` | `0.0.0.0` | Host address the three ports are published on. |
| `HOST_DATA_DIR` | the instance's `data/` | Host directory mounted at `/data`. It holds the identity key. |

The installer writes `HOST_DATA_DIR` as an absolute path. Keep it absolute: Compose resolves a relative path against the Compose file's directory inside the clone, not against the instance directory.

### Variables passed to the container

The Compose file forwards these from `env.local` to the relay process: `PUBLIC_HOST`, `PUBLIC_TCP_PORT`, `PUBLIC_WS_PORT`, `ANNOUNCE_ADDRS`, `LISTEN_ADDRS`, `RELAY_APPLY_DEFAULT_LIMIT`, `RELAY_MAX_RESERVATIONS` and `STUN_ENABLED`. [`libp2p-infra/README.md`](libp2p-infra/README.md#environment-variables) defines each one. An empty value means the image's default. The stack differs from the bare image in three ways:

- **Public ports default to the host ports.** `PUBLIC_TCP_PORT` and `PUBLIC_WS_PORT` default to `HOST_PORT` and `HOST_WS_PORT`, so setting `PUBLIC_HOST` alone advertises the ports the stack publishes.
- **`DATA_DIR` and `STUN_PORT` are not forwarded.** The key must stay in `/data`, where `HOST_DATA_DIR` is mounted, and the STUN port is moved with `HOST_STUN_PORT`. A variable that the Compose file's `environment:` block does not list never reaches the process.
- **The published container ports are fixed.** The stack maps container ports `4001`, `4002` and `3478` only. A `LISTEN_ADDRS` that binds other ports needs a matching change to `relay/docker-compose.yml`, or the listener is bound inside the container and unreachable, with no error.

## The instance directory

`svc` is run from the instance directory and wraps `docker compose` with the stack's Compose file and the instance's `env.local`.

| Command | Effect |
| --- | --- |
| `./svc up` | Build the image and start the container in the background. Warns when neither `PUBLIC_HOST` nor `ANNOUNCE_ADDRS` is set. |
| `./svc down` | Stop and remove the container. The key in `data/` stays. |
| `./svc logs` | Follow the container log. |
| `./svc ps` | Show the container's state. |
| `./svc dns [host]` | Print the DNSADDR TXT records to publish. `host` defaults to `PUBLIC_HOST`. The relay must be up, because the peer ID is read from its log. |

`svc` locates the clone by following its own symlink, so the instance directory can be anywhere. It chooses the stack from the directory's name: it strips a leading `docker-` and uses `ops/docker/<name>/docker-compose.yml`. Name the directory `docker-relay` or `relay`. Under another name `SEREUS_COMPOSE_FILE` can point `svc` at the Compose file, but `./svc dns` refuses to run and `./svc up` skips its `PUBLIC_HOST` warning, because both test the name.

Three environment variables override what `svc` finds: `SEREUS_REPO_DIR` (the clone), `SEREUS_COMPOSE_FILE` (the Compose file) and `SEREUS_ENV_FILE` (the settings file, default `./env.local`).

## Updating

```bash
cd ~/sereus-ops/sereus && git pull
cd ../docker-relay && ./svc up
```

`./svc up` rebuilds the image from the updated clone and replaces the container. The key in `data/` is untouched, so the peer ID and the published DNS records stay valid. The installer never rewrites `env.local`, so after an update compare it with `sereus/ops/docker/relay/env.example` for settings that were added; a variable missing from `env.local` takes its default.

## Restarts and reboots

The Compose file sets `restart: unless-stopped`. Docker restarts the relay after a crash and after a reboot, provided the Docker service itself starts at boot, and leaves it stopped after `./svc down`.

## Limits and accepted tradeoffs

- **One relay per Docker host.** The Compose file fixes the container name (`sereus_libp2p_relay`), so a Docker host runs one instance of this stack.
- **No TLS termination.** The stack publishes plain WebSockets. Serving `wss` needs a reverse proxy the operator runs, and `ANNOUNCE_ADDRS` to advertise it; see [`../docs/dnsaddr.md`](../docs/dnsaddr.md#serving-browsers-over-https).
