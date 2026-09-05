----
description: The relay image's WebSockets listener is now published from every site stack, warns when it is bound but unadvertised, validates its multiaddr env vars, and no longer sits behind a key loader that could silently change the node's peer id.
files: ops/docker/libp2p-infra/src/env.ts, ops/docker/libp2p-infra/src/main.ts, ops/docker/libp2p-infra/Dockerfile, ops/docker/libp2p-infra/package.json, ops/docker/libp2p-infra/README.md, ops/docker/relay/docker-compose.yml, ops/docker/relay/env.example, ops/docker/bootstrap/docker-compose.yml, ops/docker/bootstrap/env.example, ops/docker/bootstrap-relay/docker-compose.yml, ops/docker/bootstrap-relay/env.example, ops/docker/README.md, ops/docs/keys.md, ops/test/check-node.mjs, ops/test/package.json, ops/test/README.md
----

# The WebSockets listener reaches past the container

Follow-on to PR #9, which added the listener React Native clients need. The listener
worked; everything around it did not. Implement commit `2b2d964`, review fixes in the
commit carrying this ticket.

## What is true now

- **Published.** `EXPOSE 4001/tcp 4002/tcp`, and every site stack maps the WS port under
  `HOST_WS_PORT` — `4011` relay, `4012` bootstrap, `4013` bootstrap-relay. Their own
  block, because `4002`/`4003` are already the TCP host ports of the other roles.
- **Advertised, or else said so.** A bound WebSocket listener with no advertised
  WebSocket address prints a warning naming `ANNOUNCE_ADDRS` and the address shape to
  add. A non-empty announce set replaces the advertised addresses, so this was the
  silent failure mode for exactly the fronted deployments that would offer `/wss`.
- **Validated.** `LISTEN_ADDRS` and `ANNOUNCE_ADDRS` share one parser that rejects an
  unparsable entry and one naming no address (`/`), naming the variable — the contract
  the README already claimed for its neighbours.
- **Checkable.** `ops/test/check-node.mjs` speaks WebSockets, so the tool the docs point
  operators at can dial the endpoint phones use.
- **Typed.** The env contract lives in `src/env.ts`; `main.ts` keeps its file-wide
  `@ts-nocheck` for one libp2p typing quirk, so validation logic there was unchecked by
  construction.

Usage, for an operator: `HOST_WS_PORT` in `env.local` (defaulted by compose if absent),
dial `/ip4/<host>/tcp/<HOST_WS_PORT>/ws/p2p/<peerId>` from a phone, and set
`ANNOUNCE_ADDRS` to include `/dns4/<host>/tcp/443/tls/ws` if the node sits behind a TLS
front. `node ops/test/check-node.mjs --target <that addr> --relay` proves it.

## Review findings

The implement diff was read before the handoff summary.

### Verified rather than taken on trust

- **The end-to-end claim.** Booted the relay, took the `/ws` address it printed, dialed
  it with `ops/test/check-node.mjs --relay`: connect, identify, ping 3 ms, relay check
  ok. The endpoint is dialable, not merely bound.
- **Startup matrix** — default, TCP-only, WS-only, announce-without-WS (warning),
  announce-with-`/tls/ws` (no warning), TCP-only-listen-plus-announce (no warning,
  nothing to advertise). All as the handoff describes.
- **Malformed values** — `not-a-multiaddr`, `/`, `,,` on `LISTEN_ADDRS` and `oops` on
  `ANNOUNCE_ADDRS` each exit 1 naming the variable; `" "` falls back to the default.
- **Compose** — all three files parsed, defaults interpolated as compose would with no
  `env.local`, mappings asserted, and no host port claimed twice across the stacks.
- `yarn lint` clean, `check-dep-ranges` 9/9, image build clean.

### Found and fixed in this pass (minor)

- **`loadOrCreatePrivateKey` regenerated the identity on *any* read failure.**
  `ops/docker/libp2p-infra/src/main.ts` caught every error from `readFile` *and* from
  `privateKeyFromProtobuf` and responded by generating a fresh key and overwriting the
  file. A permission change, an unmounted volume or a truncated copy would therefore
  have brought the relay up under a brand-new peer id — the exact value every client
  pins as `/p2p/<peerId>` — with no error and no log line. `ops/docs/keys.md` already
  said the key is created on first start *if missing*, so the code contradicted its own
  documentation. Now only `ENOENT` generates; every other read failure and every decode
  failure stops the node with a message naming the file and telling the operator to
  restore rather than delete. Creation logs a line. Pre-existing rather than introduced
  by PR #9, but it sits inside the function the diff moved code around, and the repo's
  "don't eat exceptions" rule is unambiguous. Verified all four paths: create, reuse
  (same peer id), unreadable (`EISDIR`, fatal), corrupt (fatal, file named).
- **`ops/docs/keys.md`** gained the paragraph that behaviour now deserves.
- **The startup warning was four `console.warn` calls**; now one.

### Considered and left alone

- **`@libp2p/websockets ^9` against `^10.1.3` in `packages/*`.** Not skew: this image
  runs libp2p 2.x while the workspace runs 3.x. The image lagging a major is real but
  pre-existing and out of scope here.
- **`relay-bootstrap-pair/{dialer,listener}.mjs` stay TCP-only.** `check-node.mjs` is
  the tool the docs point operators at; the pair harness is for a different scenario.
  Noted in the handoff, agreed with.
- **`docs/reference-app-rn.md` / `packages/reference-app-rn/README.md`** describe a
  *drone's* `4002/ws`, not this image's published port. Read both; neither is wrong and
  neither mentions the party relay's host ports, so no edit. Named here so the next
  reader does not re-derive it.
- **The `HOST_WS_PORT` defaults are this ticket's invention.** They avoid the collision
  and read as a block; nobody has ratified them. A maintainer who wants a different
  scheme changes one line per stack plus two doc tables.

### Not fixed — filed or already filed

- **Nothing automated re-checks any of this.** `ops/**` is eslint-ignored, is not a
  workspace, and the repo has no CI, so the image is built and run only by hand.
  `src/env.ts` is pure and trivially testable and has no test because the folder has no
  test runner. This is the `ops/**` arm of
  `debt-tooling-scripts-unlinted-and-unchecked`, which now carries this work as
  evidence — including the observation that two of the four original defects were the
  kind a single automated run catches.
- **No container was built.** Docker is not installed in this environment, so
  `docker build` and `docker compose config` never ran; the compose change is validated
  by parsing and interpolation, and `EXPOSE` not at all. Whoever deploys next should
  bring all three stacks up once and dial the WS port from another machine.
- **`/wss` behind a TLS front is untested** — only the multiaddr handling of a `/tls/ws`
  address was exercised. Standing up a TLS front is not agent-runnable here.

### Empty categories

No major findings: nothing in the diff needed a new fix or plan ticket. No tripwires
recorded — the conditional concerns that came up (port-scheme ratification, the libp2p
2.x/3.x lag) are either a human's call or already covered above, and neither is a
"fine now, breaks if X" that belongs as a `NOTE:` at a code site.
