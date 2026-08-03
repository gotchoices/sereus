----
description: The relay server this project deploys puts a small cap on every connection it carries, so once a phone or browser tab starts using it, messages sent to that device are silently dropped instead of delivered. Lift the cap and make the relay's capacity settings configurable.
prereq:
files: ops/docker/libp2p-infra/src/main.ts, ops/docker/libp2p-infra/README.md, docs/architecture.md
difficulty: easy
----

# The deployed relay applies libp2p's default reservation limits, which break relayed cadre traffic

## What is wrong

`ops/docker/libp2p-infra/src/main.ts:51` starts the relay with a bare
`circuitRelayServer()`. In `@libp2p/circuit-relay-v2@4.1.3` that means
`applyDefaultLimit` is on: every reservation the relay hands out stamps a
`Limit` onto the connections it later carries for that client, and libp2p
treats such a connection as **limited**.

A limited connection is not merely capped — it is refused by default:

- `Connection.newStream()` throws `LimitedConnectionError` unless the caller
  passes `runOnLimitedConnection: true`
  (`node_modules/libp2p/dist/src/connection.js:80`).
- The **receiving** side aborts the inbound stream unless the protocol handler
  was registered with `runOnLimitedConnection: true`
  (`node_modules/libp2p/dist/src/connection.js:170`). None of the four
  Optimystic database services (`repo`, `cluster`, `sync`, `block-transfer`)
  register that option, and neither do the sereus control protocols.

The second one is the nasty half: the dialer's `newStream` still *resolves* —
multistream-select completes before the destination aborts — so the caller sees
a stream that never answers rather than an error.

## Measured

Two loopback relays, identical apart from the server init, each carrying a
dial from one peer to another peer's `/p2p-circuit` address. The destination
registered its protocol handler with no `runOnLimitedConnection` option, the
way db-p2p's services do:

| relay init | dialer's `connection.limits` | `newStream()` | `newStream({runOnLimitedConnection:true})` | destination handler invoked |
| --- | --- | --- | --- | --- |
| `circuitRelayServer()` — what `ops/` runs today | `{ bytes: 130430, seconds: 120000 }` | throws `LimitedConnectionError` | resolves | **never** |
| `circuitRelayServer({ reservations: { applyDefaultLimit: false } })` | `null` | resolves | resolves | yes |

So through today's relay, a relayed cadre connection carries at most ~127 KiB
or 2 minutes, and in practice carries nothing at all, because every handler on
the far side drops the stream.

A second, separate cap sits in the same call: `maxReservations` defaults to
`DEFAULT_MAX_RESERVATION_STORE_SIZE = 15`
(`node_modules/@libp2p/circuit-relay-v2/dist/src/constants.js:7`). The relay
therefore serves **15 concurrent clients**, and a single cadre member can
consume more than one slot — the control node holds a reservation, and each
strand node it runs holds another under its own derived transport peerId (see
`docs/architecture.md`, "Separate libp2p node").

## Why it has not been noticed

Nothing reaches the relayed path yet: browser tabs never obtain a reservation
in the first place, for an unrelated reason tracked by
`implement/2-relay-reservation-drive-explicit-reservation`. That ticket makes
reservations work; this one makes the resulting connection usable. They are
independent code changes — neither blocks the other — but a reservation
without this change buys a circuit address that silently swallows traffic.

## Expected behaviour

A cadre node that holds a reservation on the deployed relay can open its
ordinary protocol streams through it with no per-call opt-in and no data or
duration cap, and an operator can size the relay's client capacity without
editing source.

## Tradeoff to state, not to resolve silently

Turning the default limit off removes the only bandwidth brake on a relay that
does not authenticate its clients: anyone who can dial it can reserve a slot
and push unmetered bytes through it. That is the accepted posture for
party-operated infrastructure, and `@optimystic/db-p2p` already documents the
same choice for its trusted local clusters (see the `relayServerInit` doc
comment in `libp2p-node-base.ts`). Make it an environment variable rather than
a hardcoded constant so a public deployment can put the cap back, and say so in
the README — do not leave the reader to discover it from the code.

## TODO

- In `ops/docker/libp2p-infra/src/main.ts`, pass an explicit
  `CircuitRelayServerInit` to `circuitRelayServer(...)` instead of calling it
  bare.
- Lift the per-connection limit by default: `reservations.applyDefaultLimit`
  false unless an env var (e.g. `RELAY_APPLY_DEFAULT_LIMIT=true`) asks for it.
- Expose the client-capacity cap as an env var (e.g. `RELAY_MAX_RESERVATIONS`,
  defaulting to something well above 15 for a party relay) mapped onto
  `reservations.maxReservations`.
- Parse both the same way `ANNOUNCE_ADDRS` is parsed in that file — one small
  helper each, no new dependency. Reject a malformed value loudly at startup
  rather than falling back silently; this file already throws on a bad
  `SEREUS_ROLE`.
- Log the resolved relay settings next to the existing `peerId` / listening-addr
  startup lines, so an operator can see from the container log which limits are
  in force.
- Document both env vars in `ops/docker/libp2p-infra/README.md` (create the
  section if the file has none), including the abuse tradeoff above.
- Add a line to the relay section of `docs/architecture.md` recording that the
  deployed relay runs without libp2p's default reservation limit and why —
  without it, relayed control/strand streams are dropped by the receiving
  handler.
- No unit test is warranted for a config literal, but do a manual check against
  the built container: bring up the relay, reserve from a scratch client, dial
  it from a third peer, and confirm `connection.limits` is `null`. Record the
  result in the review handoff.
