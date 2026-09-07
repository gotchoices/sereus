# sereus libp2p infra

Container image for the party-operated libp2p relay/bootstrap nodes. Built by
`Dockerfile` from `src/main.ts`; entry point picks its behavior off
`SEREUS_ROLE` (`relay` | `bootstrap` | `bootstrap-relay`).

## Environment variables

| Variable | Applies to | Default | Purpose |
| --- | --- | --- | --- |
| `DATA_DIR` | all | `/data` | Where the identity key is persisted. `/data` is the container volume; set it to a writable path when running the process directly on a workstation. A stable value means a stable peer id across restarts. |
| `SEREUS_ROLE` | all | *(required)* | `relay` \| `bootstrap` \| `bootstrap-relay`. |
| `LISTEN_ADDRS` | all | `/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws` | Comma-separated multiaddrs to bind. Both TCP and WebSockets are listened on by default: **React Native has no raw-TCP transport**, so a mobile client can only reach this over `/ws` (or `/wss` behind a TLS front). Override to bind one transport only. |
| `ANNOUNCE_ADDRS` | all | unset | Comma-separated multiaddrs to advertise instead of the bound listen address (e.g. behind a reverse proxy/DNS front). |
| `RELAY_APPLY_DEFAULT_LIMIT` | `relay`, `bootstrap-relay` | `false` | See below. |
| `RELAY_MAX_RESERVATIONS` | `relay`, `bootstrap-relay` | `500` | Maximum concurrent reservation slots the relay hands out (`circuitRelayServer`'s `reservations.maxReservations`; libp2p's own default is 15). A cadre member can hold more than one slot — the control node's reservation plus one per strand node running under its own derived transport peerId. |

### `RELAY_APPLY_DEFAULT_LIMIT`

`@libp2p/circuit-relay-v2` defaults to `applyDefaultLimit: true`: every
reservation it hands out gets a `Limit` (~128 KiB / 2 minutes) stamped onto the
connections the relay later carries for that client, and libp2p treats such a
connection as **limited** — `newStream()` throws, and the *receiving* side
aborts the inbound stream, unless **both** sides opted in with
`runOnLimitedConnection: true`.

Most cadre traffic does not opt in. `@optimystic/db-p2p`'s four database
services (`repo`, `cluster`, `sync`, `block-transfer`) register their handlers
without it, as does sereus's control-network seed delivery, so their relayed
streams are aborted outright. Only the strand wake/addr protocols
(`cadre-core/src/strand-wake-protocol.ts`, `strand-addr-protocol.ts`) opt in on
both sides — and even those stop working once a relayed connection crosses the
~128 KiB / 2 minute cap, because the relay then closes it. So under the library
default a relayed connection carries almost no cadre traffic, and what it does
carry is short-lived.

This image sets `applyDefaultLimit: false` by default, matching the same
choice `@optimystic/db-p2p` makes for its trusted local clusters (see the
`relayServerInit` doc comment on `NodeOptions` in `libp2p-node-base.ts`).

**Tradeoff:** this relay does not authenticate clients. Turning the default
limit off removes the only bandwidth brake on it — anyone who can dial the
relay can reserve a slot and push unmetered bytes through it. That is the
accepted posture for party-operated infrastructure. Set
`RELAY_APPLY_DEFAULT_LIMIT=true` to restore libp2p's default cap for a
public-facing deployment that wants that brake back — note that with the
cap on, relayed cadre/control traffic that runs longer than ~2 minutes or
~128 KiB will be silently dropped by the receiving protocol handler.

A middle ground exists but is not wired up today: `ReservationStoreInit` also
accepts `defaultDataLimit` and `defaultDurationLimit`, so a deployment could
keep `applyDefaultLimit: true` while raising the cap to something a cadre
session survives, rather than choosing between "unmetered" and "broken". If a
public relay ever needs a brake, expose those two as env vars rather than
flipping `RELAY_APPLY_DEFAULT_LIMIT` on — flipping it on alone re-breaks
relayed cadre traffic.

Both variables are parsed strictly at startup (`true`/`false` for the former,
a positive integer for the latter) and a malformed value throws immediately,
the same way a bad `SEREUS_ROLE` does. An empty value is treated as unset and
takes the default. The resolved values are logged next to the `peerId` line on
startup.

`LISTEN_ADDRS` and `ANNOUNCE_ADDRS` are held to the same standard: every entry
must parse as a multiaddr *and* name an address, so a value of `/` — what an
`env.local` with an unsubstituted variable produces — is rejected rather than
quietly bound to nothing. Failures name the variable and the offending entry
(`src/env.ts`). An address that parses but no configured transport can listen on
fails a moment later inside libp2p, which names it too.

## Setting these on a deployed node

The site-instance stacks (`../relay/`, `../bootstrap/`, `../bootstrap-relay/`)
forward every image-level variable above from `env.local` into the container
except `DATA_DIR`, which stays at its `/data` default because that is where the
stacks mount the host data directory — overriding it would write the identity key
somewhere that is not persisted. Anything not listed in a stack's
`docker-compose.yml` `environment:` block never reaches the process, so a new
image-level variable must be added there too. See `../README.md`.

The stacks also have to *publish* the ports the process binds. Both default listen
addresses are published: container `4001` and container `4002` (WebSockets), the
latter under `HOST_WS_PORT` so it does not collide with the host-port block the
other roles use. Overriding `LISTEN_ADDRS` to bind different ports means changing
those mappings to match — a listener nothing maps to is bound inside the container
and unreachable from anywhere else, with no error to show for it.

## Reaching this from a mobile client

Phones dial `/ws`; they cannot dial `/ip4/.../tcp/4001` directly. On startup the
process prints its WebSocket addresses separately for that reason.

Further points that matter for a phone:

- **If you set `ANNOUNCE_ADDRS`, put the WebSocket address in it.** A non-empty
  announce set *replaces* the advertised addresses rather than adding to them, so a
  node fronted by a reverse proxy that announces only its TCP address binds
  WebSockets and tells no one — the listener is up and no client can find it. The
  process warns at startup when it is in that state; the fix is to announce the
  address clients should dial, e.g.
  `/dns4/relay.example.org/tcp/443/tls/ws` for a TLS front.
- Set `RELAY_APPLY_DEFAULT_LIMIT=false`. With the libp2p default, relayed
  connections are *limited* and the optimystic database services abort their
  streams — peers connect and then fail every read and write, which is a
  confusing way to find out.
- Dial the **host** port, not the container port. Running this image from a site
  stack, WebSockets are published on `HOST_WS_PORT` (`4011` relay, `4012`
  bootstrap, `4013` bootstrap-relay by default); running the process directly on a
  workstation it is `4002`. The examples below use `4002` for the direct case.
- An Android emulator reaches the host at the reserved address `10.0.2.2`, so
  `/ip4/10.0.2.2/tcp/4002/ws` works with no port forwarding. A USB-attached
  device needs `adb reverse tcp:4002 tcp:4002` first, then dials
  `/ip4/127.0.0.1/tcp/4002/ws`.
