----
description: The WebSockets listener is now published from every site stack, warns when it is bound but unadvertised, and validates its two multiaddr env vars. Review the operator surface and the port-numbering call.
files: ops/docker/libp2p-infra/src/env.ts, ops/docker/libp2p-infra/src/main.ts, ops/docker/libp2p-infra/Dockerfile, ops/docker/libp2p-infra/package.json, ops/docker/libp2p-infra/README.md, ops/docker/relay/docker-compose.yml, ops/docker/relay/env.example, ops/docker/bootstrap/docker-compose.yml, ops/docker/bootstrap/env.example, ops/docker/bootstrap-relay/docker-compose.yml, ops/docker/bootstrap-relay/env.example, ops/docker/README.md, ops/test/check-node.mjs, ops/test/package.json, ops/test/README.md
----

# The WebSockets listener now reaches past the container — review

Implement-stage commit: `2b2d964`. Original findings and their reproductions are in
the ticket body this replaces — read the diff first.

## What landed

**Reachability.** `EXPOSE 4001/tcp 4002/tcp`, and all three site stacks publish the
WS port under a new `HOST_WS_PORT` (`4011` relay, `4012` bootstrap, `4013`
bootstrap-relay). Those defaults deliberately start a new block rather than
continuing `400x`: `4002` and `4003` are already the TCP host ports of the other two
roles, so the obvious choice collides on a host running more than one. All three
stacks also forward `LISTEN_ADDRS`. `DATA_DIR` is deliberately *not* forwarded — it
must stay at `/data`, which is where `HOST_DATA_DIR` is mounted; forwarding it would
let an operator write the identity key somewhere unpersisted and silently churn the
peer id.

**Advertisement.** When the bound set contains a WebSocket address and the advertised
set does not, startup prints a warning naming `ANNOUNCE_ADDRS` and the shape of the
address to add. This is the silent case from the original review: a non-empty
announce set replaces the advertised addresses, so a fronted node bound WS and told
nobody.

**Validation.** `LISTEN_ADDRS` and `ANNOUNCE_ADDRS` now go through one parser that
rejects an unparsable entry and one that names no address (`/` — what an `env.local`
with an unsubstituted variable renders to), naming the variable. Previously the first
exited with an `InvalidMultiaddrError` stack from `@multiformats/multiaddr` and the
second bound nothing at all.

**Shape.** The env contract moved to `src/env.ts`, which type-checks — `main.ts`
carries a file-wide `@ts-nocheck` for an unrelated libp2p typing quirk, so validation
logic living there was unchecked by construction. `@multiformats/multiaddr` was a
transitive dependency being imported; it is now declared. WS detection reads parsed
protocol components rather than testing the string for `/ws`.

**Tooling.** `ops/test/check-node.mjs` gained `webSockets()`, so the script operators
are told to validate a deployed node with can dial the endpoint phones use.

## Verification actually performed

Everything below ran against the compiled source (`npm run build` then
`node dist/main.js`), not a container — see gaps.

- Build clean after adding `src/env.ts`.
- Startup matrix, all as expected: default (TCP+WS, WS block printed); `LISTEN_ADDRS`
  TCP-only (no WS block, no warning); WS-only (WS block); `ANNOUNCE_ADDRS` TCP-only
  (**warning**, no WS block); `ANNOUNCE_ADDRS` including `/tls/ws` (WS block, no
  warning); TCP-only listen *with* announce (neither — nothing to advertise).
- Malformed values, each exiting 1 with a message naming the variable:
  `LISTEN_ADDRS=not-a-multiaddr`, `LISTEN_ADDRS=/`, `LISTEN_ADDRS=,,`,
  `ANNOUNCE_ADDRS=oops`. `LISTEN_ADDRS=" "` correctly falls back to the default.
- End-to-end: booted the relay, took the `/ip4/127.0.0.1/tcp/4002/ws/p2p/…` address it
  printed, and dialed it with `ops/test/check-node.mjs --relay`. Connect, identify,
  ping (3 ms) and the relay-protocol check all passed — the endpoint is genuinely
  dialable over WebSockets, not merely bound.
- Compose: all three files parsed, `${VAR:-default}` interpolated the way compose does
  for an absent `env.local`, and the rendered mappings asserted
  (`0.0.0.0:4001:4001/tcp` + `0.0.0.0:4011:4002/tcp`, and the two siblings). No host
  port is claimed twice across the three stacks.
- `yarn lint` clean; `node --test scripts/check-dep-ranges.test.mjs` 9/9.

## Known gaps — treat these as the starting point

- **No container was built or run.** Docker is not installed in this environment, so
  `docker compose config` and `docker build` were never executed. The compose change
  is validated by parsing and hand-interpolation, and `EXPOSE` not at all. A reviewer
  with Docker should run all three stacks up and confirm a WS dial from another host.
- **No automated regression anywhere.** `ops/**` is eslint-ignored, is not a
  workspace, and there is no CI in the repo, so nothing re-checks any of this. `env.ts`
  is pure and eminently testable and has no test, because the folder has no test
  runner at all. That is the `ops/**` arm of
  `debt-tooling-scripts-unlinted-and-unchecked`, which this work has now been appended
  to as evidence — the gap is filed, not fixed.
- **`HOST_WS_PORT` defaults are a convention this ticket invented.** `4011`/`4012`/
  `4013` avoid the collision and read as a block, but nobody has ratified them. A
  human may prefer another scheme; changing them later is a one-line edit per stack
  plus the two doc tables.
- **`/wss` behind a TLS front is untested.** Only the multiaddr handling of a
  `/tls/ws` address was exercised (warning suppression, WS-block detection). No TLS
  front was stood up.
- **`relay-bootstrap-pair/{dialer,listener}.mjs` remain TCP-only.** Deliberately out of
  scope — `check-node.mjs` is the tool the docs point operators at — but the pair
  harness cannot exercise a WS-only relay.
- **The RN docs were read, not changed.** `docs/reference-app-rn.md` and
  `packages/reference-app-rn/README.md` describe a *drone's* `4002/ws`, which is a
  different thing from the party relay's published port; they are not wrong, but a
  reader moving between them could conflate the two. Worth a reviewer's judgement on
  whether a cross-reference is warranted.
