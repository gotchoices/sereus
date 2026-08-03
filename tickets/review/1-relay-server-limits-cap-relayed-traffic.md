description: The relay server this project deploys used to put a small cap on every connection it carries, so once a phone or browser tab started using it, messages sent to that device were silently dropped instead of delivered. The cap is now lifted by default and both the traffic cap and the per-relay client-capacity limit are configurable via environment variables.
prereq:
files: ops/docker/libp2p-infra/src/main.ts, ops/docker/libp2p-infra/README.md, docs/architecture.md
difficulty: easy
----

# Implementation summary

`ops/docker/libp2p-infra/src/main.ts` no longer calls `circuitRelayServer()`
bare. It now passes an explicit `CircuitRelayServerInit`:

```ts
services.relay = circuitRelayServer({
  reservations: {
    applyDefaultLimit: RELAY_APPLY_DEFAULT_LIMIT,   // env RELAY_APPLY_DEFAULT_LIMIT, default false
    maxReservations: RELAY_MAX_RESERVATIONS         // env RELAY_MAX_RESERVATIONS, default 500
  }
})
```

- `RELAY_APPLY_DEFAULT_LIMIT` (`true`/`false`, default `false`): libp2p's own
  default is `true`, which stamps every reservation with a ~128 KiB / 2 min
  `Limit` and marks the resulting connection "limited" — libp2p then refuses
  `newStream()`/inbound streams on it unless the caller opts in with
  `runOnLimitedConnection: true`. None of `@optimystic/db-p2p`'s services or
  sereus's control protocols pass that option, so under the old bare call
  every relayed connection was unusable. Default is now off; set the env var
  to `true` to restore libp2p's cap for a public-facing deployment (see the
  README's abuse-tradeoff note — this relay does not authenticate clients).
- `RELAY_MAX_RESERVATIONS` (positive integer, default `500`): forwarded to
  `reservations.maxReservations`. libp2p's own default is 15, which is below
  even a single mid-size cadre once every strand node's derived transport
  peerId is counted as its own reservation holder.
- Both env vars are parsed by two small helpers (`parseBooleanEnv`,
  `parsePositiveIntEnv`) mirroring the existing `ANNOUNCE_ADDRS` parsing style
  in the same file. A malformed value throws at startup, same as a bad
  `SEREUS_ROLE` does today — no silent fallback.
- The resolved values are logged on startup next to the existing `peerId`
  line, only when `SEREUS_ROLE` is `relay` or `bootstrap-relay`.
- `ops/docker/libp2p-infra/README.md` created (the file didn't exist before)
  documenting both env vars, `ANNOUNCE_ADDRS`, `SEREUS_ROLE`, and the abuse
  tradeoff of running with the default limit off.
- `docs/architecture.md`'s "Relay Integration" section (under "### Relay
  Integration", after the multi-node-resilience paragraph) now records that
  the deployed relay runs without libp2p's default reservation limit and
  points at the README for the two env vars.

## Validation performed

- `npm install && npm run build` (`tsc -p tsconfig.json`) in
  `ops/docker/libp2p-infra` — compiles clean. This directory is intentionally
  excluded from the root `eslint.config.mjs` (`ops/**` ignore, "own
  tsconfigs/scope"), so no lint step applies to it.
- **No Docker daemon was available in this execution environment** (`docker`
  CLI not installed), so the ticket's suggested container-level check
  ("bring up the relay, reserve from a scratch client, dial it from a third
  peer") could not be run against the built image. As a substitute, I wrote a
  throwaway Node script (not committed — deleted after use) that exercises
  the *exact* `circuitRelayServer(...)` call now in `main.ts`, using the same
  dependency versions `npm install` resolves for this package
  (`@libp2p/circuit-relay-v2@3.2.24`, `libp2p@2.10.0` — note: different major
  versions from the `@libp2p/circuit-relay-v2@4.1.3` / root-hoisted `libp2p`
  the ticket's own investigation quotes, but the same `reservations.{applyDefaultLimit,maxReservations}`
  field names and `Connection.newStream()` limited-connection behavior are
  present in both). Topology: relay node → "client" node that reserves a slot
  and registers a protocol handler with **no** `runOnLimitedConnection` (matching
  every real handler in this codebase) → third "dialer" node that dials the
  client through the relay's `/p2p-circuit` address and calls
  `dialProtocol()` with **no** options (matching real caller code).

  | relay init | dialer's `connection.limits` | `dialProtocol()` (no opt-in) | client handler invoked |
  | --- | --- | --- | --- |
  | `circuitRelayServer()` (old code, control run) | *(connection still limited)* | throws `LimitedConnectionError: Cannot open protocol stream on limited connection` | never |
  | `circuitRelayServer({ reservations: { applyDefaultLimit: false, maxReservations: 500 } })` (new code) | `undefined` (no `Limit` stamped — the not-limited state at this libp2p version; equivalent to the `null` the ticket's own table shows at `4.1.3`) | resolves | yes — payload round-tripped and byte length matched |

  This reproduces the exact defect and confirms the fix, just via an ad hoc
  script against the resolved dependency versions rather than the Docker
  image. A human (or a follow-up ticket) should still do the literal
  container-level check once Docker is available, per the original ticket's
  ask — flagging this as the one gap in validation coverage.

## Things to check in review

- Confirm `500` is an acceptable default for `RELAY_MAX_RESERVATIONS` — the
  ticket only asked for "something well above 15"; no specific cadre-scale
  number is documented elsewhere in this repo to size against.
- The abuse tradeoff (unauthenticated relay + no per-connection cap by
  default) is stated in both the README and `docs/architecture.md`, per the
  ticket's explicit ask not to resolve it silently — confirm that's
  sufficient surfacing, since it's a posture decision rather than a pure bug
  fix.
- No unit test was added (config literal, per the ticket's own guidance) —
  the manual script above is not part of the repo; only the container-level
  check is a true substitute if it matters for this deployment.
