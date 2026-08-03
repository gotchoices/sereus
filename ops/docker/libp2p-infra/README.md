# sereus libp2p infra

Container image for the party-operated libp2p relay/bootstrap nodes. Built by
`Dockerfile` from `src/main.ts`; entry point picks its behavior off
`SEREUS_ROLE` (`relay` | `bootstrap` | `bootstrap-relay`).

## Environment variables

| Variable | Applies to | Default | Purpose |
| --- | --- | --- | --- |
| `SEREUS_ROLE` | all | *(required)* | `relay` \| `bootstrap` \| `bootstrap-relay`. |
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

## Setting these on a deployed node

The site-instance stacks (`../relay/`, `../bootstrap-relay/`) forward all four
variables from `env.local` into the container. Anything not listed in their
`docker-compose.yml` `environment:` block never reaches the process, so a new
image-level variable must be added there too. See `../README.md`.
