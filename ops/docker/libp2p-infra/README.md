# The relay image (`sereus-libp2p-infra`)

This directory builds the container image for a dedicated Sereus relay: one Node.js process that runs a libp2p Circuit Relay v2 server and a STUN responder. This page is the reference for what the process reads from its environment, the limits it runs with and why, and the ports it uses. To deploy it, follow the [relay runbook](../README.md).

Related: [why `ops/` deploys only this](../../README.md) · [how cadre nodes use a relay](../../../docs/network/relay.md) · [STUN](../../docs/ice-servers.md) · [identity key](../../docs/keys.md)

The process is `src/main.ts`. `src/env.ts` parses every environment variable, and `src/stun.ts` is the STUN responder.

## Environment variables

An empty value is the same as an unset one and takes the default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws` | Comma-separated multiaddrs to bind. The process has raw-TCP and WebSocket transports only. |
| `PUBLIC_HOST` | unset | DNS name or IP address clients reach the relay at. When set, the relay advertises one address per listener on this host. |
| `PUBLIC_TCP_PORT` | the bound port | Port advertised for the raw-TCP listener under `PUBLIC_HOST`. |
| `PUBLIC_WS_PORT` | the bound port | Port advertised for the WebSocket listener under `PUBLIC_HOST`. |
| `ANNOUNCE_ADDRS` | unset | Comma-separated multiaddrs to advertise exactly as written. Overrides `PUBLIC_HOST`. |
| `DATA_DIR` | `/data` | Directory that holds the identity key, `libp2p-private.key.pb`. `/data` is the container's volume. |
| `RELAY_APPLY_DEFAULT_LIMIT` | `false` | `true` restores libp2p's limit of 128 KiB or two minutes on each relayed connection. See [Relay limits](#relay-limits). |
| `RELAY_MAX_RESERVATIONS` | `500` | Number of reservation slots the relay grants at one time. |
| `STUN_ENABLED` | `true` | `false` turns the STUN responder off. |
| `STUN_PORT` | `3478` | UDP port the STUN responder binds, on all IPv4 interfaces. |

The default listen set has both transports because phones and browsers have no raw-TCP transport and can reach the relay only over WebSockets.

The [Compose stack](../README.md#variables-passed-to-the-container) forwards these variables from `env.local`, except `DATA_DIR` and `STUN_PORT`.

## Advertised addresses

The addresses the relay advertises are the ones clients are told to dial. A node behind NAT that reserves a slot also builds its own `/p2p-circuit` address on each of them and hands that to its peers. An address that cannot be dialled from outside therefore costs every peer of every client a failed dial. The relay takes its advertised set from the first of these that applies:

1. **`ANNOUNCE_ADDRS`**, used exactly as written. It replaces the whole set, so it must name every transport clients need. A list that names only a TCP address leaves the WebSocket listener bound and unadvertised, and the relay warns at startup when that happens.
2. **`PUBLIC_HOST`**. The relay re-expresses each bound listener on the public host: `/dns4/<host>/tcp/<port>` for raw TCP and `/dns4/<host>/tcp/<port>/ws` for WebSockets (`/ip4` or `/ip6` when the host is an address literal). The port is `PUBLIC_TCP_PORT` or `PUBLIC_WS_PORT`, defaulting to the bound port.
3. **Neither.** libp2p advertises what it bound. In a container that is the loopback address and the bridge address, so the relay logs a warning.

The bound port is the right public port only when the process runs directly on a publicly addressed host. Behind Docker's port mapping or a router's port forward the public port differs, which is why it is a separate setting.

`PUBLIC_HOST` cannot express everything. Use `ANNOUNCE_ADDRS` for a `/tls/ws` address behind a TLS reverse proxy, for a name that resolves only over IPv6 (`/dns6`), and whenever `LISTEN_ADDRS` binds two listeners of one transport on different ports.

At startup the process logs its peer ID, the resolved relay limits, the STUN state, the bound listeners, and then the advertised addresses with the setting they came from.

## Validation at startup

The process validates every variable before it binds anything and exits with an error that names the variable and the rejected value.

- **Booleans and numbers.** `RELAY_APPLY_DEFAULT_LIMIT` and `STUN_ENABLED` accept `true` or `false`. `RELAY_MAX_RESERVATIONS` accepts a positive integer. The port variables accept `1` to `65535`.
- **Multiaddr lists.** Every entry of `LISTEN_ADDRS` and `ANNOUNCE_ADDRS` must parse as a multiaddr and name an address. An entry of `/`, which is what an unsubstituted variable in a settings file produces, is rejected instead of binding or advertising nothing.
- **`PUBLIC_HOST`.** It must be a bare name or address, with no slash, comma or space. Deriving an address fails for a listener that is not raw TCP or plain WebSockets, and for a listener bound to port `0` with no public port set.
- **STUN.** If the STUN port cannot be bound, the process exits instead of running without STUN.
- **Identity key.** A key file that exists but cannot be read or decoded stops the process; see [`keys.md`](../../docs/keys.md).

## Relay limits

The image changes the libp2p defaults in this table. The liveness and timeout values are copied by hand from `@serfab/cadre-core`, because the image depends on neither cadre-core nor Optimystic.

| Setting | Image value | libp2p default |
| --- | --- | --- |
| Limit on each relayed connection | none | 128 KiB or 2 minutes |
| Reservation slots | 500 | 15 |
| Ping deadline, ping interval | 30 s, 35 s | adaptive from 5 s, 10 s |
| Ping handler timeout | 60 s | 10 s |
| `inboundUpgradeTimeout`, `dialTimeout` | 17 500 ms | 10 000 ms |

### No limit on a relayed connection

By default `@libp2p/circuit-relay-v2` stamps every reservation with a limit of 128 KiB or two minutes. libp2p marks a connection relayed under that limit as *limited*, and the relay resets it when either bound is reached.

Cadre traffic does not fit inside that limit. A database sync runs longer and carries more than the limit allows; one Optimystic cohort frame can be 512 KiB. Seed delivery does not use a limited connection at all, because a seed can be up to 1 MiB. With the limit on, nodes connect through the relay and then lose their reads and writes part-way.

The image therefore sets `applyDefaultLimit: false`. cadre-core makes the same choice for the relay server a party's own node runs (`packages/cadre-core/src/relay-server.ts`).

### 500 reservation slots

A node behind NAT holds one slot for its control node and one for each strand node it runs, because each strand node has its own peer ID. A relay therefore needs about (machines behind NAT) × (1 + strands each) slots, and libp2p's 15 is filled by three phones that each serve four strands. A dedicated relay serves many parties, and a slot costs it one map entry, so 500 is set well above what is expected.

Raise `RELAY_MAX_RESERVATIONS` if clients are refused reservations. A second libp2p bound, `maxOutboundStopStreams` (300), limits how many circuits can be in setup at the same instant, not how many slots are held; it matters only if hundreds of clients dial through the relay at once.

### Ping deadline, interval and handler timeout

libp2p pings every open connection and closes it on the first ping that misses its deadline. A phone running Noise encryption in JavaScript can be too busy during startup to answer a short deadline. The relay would then close the connection, the phone would redial and pay for another handshake, and it would never catch up. The relay uses the values cadre-core gives every node (`DEFAULT_CONNECTION_MONITOR` in `packages/cadre-core/src/types.ts`):

- **A 30-second deadline**, with libp2p's adaptive timeout pinned to that one value so that it cannot grow past the interval.
- **A 35-second interval**, longer than the deadline. libp2p starts a new ping each interval whether or not the previous one was answered, and allows one ping stream per connection. A second concurrent ping fails, and the monitor treats that failure as a timeout. An interval shorter than the deadline would therefore become the real deadline.
- **A 60-second ping handler timeout.** The side being pinged resets the ping stream when its own handler timer fires, and the pinging node counts the reset as a failed ping. The relay's handler timeout must stay above the 30-second deadline its clients use.

The cost is that the relay holds a dead peer's connection for 30 to 65 seconds after the peer stops answering.

### Connection setup timeouts

`inboundUpgradeTimeout` is how long the relay lets an incoming connection take to finish its handshake. The image sets 17 500 ms, the value every cadre node runs with: five link round trips at the 3 500 ms round trip cadre-core declares by default (see [Dial budgets](../../../docs/network/deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds)). The aim is that the relay never gives up on a slow client sooner than the client's own node would. `dialTimeout` is set to the same value and has little effect, because a relay forwards a circuit over the connection its target already holds and dials almost nothing.

## Ports

| Container port | Protocol | Purpose | Published by the Compose stack as |
| --- | --- | --- | --- |
| `4001` | TCP | libp2p over raw TCP | `HOST_PORT` (default `4001`) |
| `4002` | TCP | libp2p over WebSockets | `HOST_WS_PORT` (default `4011`) |
| `3478` | UDP | STUN | `HOST_STUN_PORT` (default `3478`) |

Clients dial the published port, not the container port.

## Running without Docker

The image is an npm project outside the repository's yarn workspace, so it builds from this directory alone. With Node.js 22, the version the image uses:

```bash
cd ops/docker/libp2p-infra
npm install
npm run build
DATA_DIR=./data npm start
```

The process then listens on `4001` and `4002` directly, and `PUBLIC_TCP_PORT` and `PUBLIC_WS_PORT` default to those ports.

## Limits and accepted tradeoffs

- **Clients are not authenticated and traffic is not metered.** Anyone who can dial the relay can reserve a slot and forward any amount of data through it. This is accepted because the alternative, libp2p's default limit, makes the relay unable to carry cadre traffic. An operator limits exposure with `RELAY_MAX_RESERVATIONS` and the host's firewall.
- **There is no adjustable cap.** `RELAY_APPLY_DEFAULT_LIMIT=true` restores libp2p's fixed 128 KiB and two-minute limit, which breaks relayed cadre traffic. `@libp2p/circuit-relay-v2` also accepts `defaultDataLimit` and `defaultDurationLimit`, which could set a cap large enough for a cadre session; the image does not expose them. A public relay that needs a limit should add those two as variables instead of setting the boolean.
- **Liveness and timeout values are copied, not shared.** A change to `DEFAULT_CONNECTION_MONITOR` or to cadre-core's link budget must be repeated by hand in `src/main.ts`.
- **STUN answers over IPv4 only.**
- **No TLS and no transports other than raw TCP and WebSockets.** A `wss` address needs a TLS reverse proxy in front of the relay.
- **Builds are not reproducible.** The repository tracks no lockfile for the image and the `Dockerfile` copies none, so `npm install` resolves the newest versions the dependency ranges allow, and two builds of one commit can differ.
