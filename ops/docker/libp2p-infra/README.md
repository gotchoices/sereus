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
aborts the inbound stream, unless the caller opted in with
`runOnLimitedConnection: true`. None of `@optimystic/db-p2p`'s services or
sereus's control protocols set that option, so a relayed connection under the
library default silently carries no cadre traffic at all.

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

Both variables are parsed strictly at startup (`true`/`false` for the former,
a positive integer for the latter) and a malformed value throws immediately,
the same way a bad `SEREUS_ROLE` does. The resolved values are logged next to
the `peerId` line on startup.
