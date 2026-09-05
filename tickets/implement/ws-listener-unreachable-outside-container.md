----
description: The relay image now listens on WebSockets so phones can dial it, but the port is never published, the address is never advertised behind a front, and a typo in the new setting dies with a library stack trace. Finish the listener so it is actually reachable and legible.
files: ops/docker/libp2p-infra/src/main.ts, ops/docker/libp2p-infra/Dockerfile, ops/docker/libp2p-infra/README.md, ops/docker/relay/docker-compose.yml, ops/docker/relay/env.example, ops/docker/bootstrap/docker-compose.yml, ops/docker/bootstrap/env.example, ops/docker/bootstrap-relay/docker-compose.yml, ops/docker/bootstrap-relay/env.example, ops/docker/README.md, ops/test/check-node.mjs, ops/test/package.json, ops/test/README.md
----

# The WebSockets listener stops at the container boundary

## Where this came from

Review of PR #9 (`feat/libp2p-infra-websockets-for-mobile`, commit `3b43d28`). The
listener itself works — built and ran the branch, both transports bind and the new
startup block prints the `/ws` addresses. Everything below is surface the change did
not carry along; each item was reproduced, not inferred.

## 1. The WebSocket port is never published

`Dockerfile` declares `EXPOSE 4001/tcp` only, and all three site stacks publish
`"${HOST_BIND_IP:-0.0.0.0}:${HOST_PORT:-400x}:4001/tcp"` — nothing maps container
`4002`. So on every containerised deployment the WS listener binds inside the
container and is unreachable from the host, which is the one thing the PR set out to
fix. Only the run-the-process-directly path (what the new `DATA_DIR` enables) works
today.

Expected: a phone on the LAN can dial the published WS port of a `relay`,
`bootstrap` or `bootstrap-relay` stack with no manual compose edit.

## 2. The obvious host port for it is already taken

`ops/docker/README.md` allocates host ports by role: relay `4001`, bootstrap `4002`,
bootstrap-relay `4003`. Publishing container `4002` on host `4002` therefore collides
with the bootstrap stack on any host running more than one role. The new WS host port
needs its own default per role, documented in the same table, and the container-side
port should stay `4002/ws` — that is the convention the RN drone config and
`docs/reference-app-rn.md` already use.

## 3. `ANNOUNCE_ADDRS` silently drops the WS address

Reproduced: with `ANNOUNCE_ADDRS=/dns4/relay.example.org/tcp/4001` and default listen
addrs, the node advertises only the announced address, and the new "WebSocket
addresses" block prints **nothing at all** — no warning, no hint. A non-empty announce
set replaces the advertised set entirely (`AddressManager.getAddressesWithMetadata()`
early-returns it), and `ANNOUNCE_ADDRS` is exactly what the reverse-proxy / DNS-front
deployments use — the same deployments that would terminate TLS and offer `/wss`.

An operator who follows the new README section on a fronted node gets a relay that
binds WS, advertises no WS, and gives them nothing to debug with.

Expected: when the listen set contains a WebSocket address and the announce set does
not, say so on startup, naming what to add. `packages/cadre-core/src/cadre-node.ts`
already does the equivalent for `announceAddrs` vs a relay listener — same shape.

## 4. `LISTEN_ADDRS` is not validated, though it is documented as validated

`parseListenAddrs()` only checks that the split produced a non-empty array. Reproduced
with `LISTEN_ADDRS=not-a-multiaddr`:

```
InvalidMultiaddrError: String multiaddr must start with "/"
    at stringToComponents (.../@multiformats/multiaddr/dist/src/components.js:76:15)
```

A raw stack trace out of a transitive dependency. That breaks the contract the same
README states for its neighbours: *"Both variables are parsed strictly at startup …
and a malformed value throws immediately, the same way a bad `SEREUS_ROLE` does."*
`ANNOUNCE_ADDRS` has the same hole and the same fix, so both belong to one helper.

`packages/cadre-core/src/announce-addrs.ts` is the reference for what "validated"
should mean here, including the case that parsing alone misses: `''` and `'/'` both
parse into a component-less multiaddr, so a set holding only those is non-empty yet
names nothing. The ops image cannot import that module (standalone deployable, its own
dependency tree, still on libp2p 2.x while the workspace is on 3.x) — mirror the rules,
don't share the code, and say why in a comment.

An unsupported-but-parsable address is already loud (libp2p's
`UnsupportedListenAddressesError` names the offending addr), so that case needs
nothing beyond keeping it loud.

## 5. Smaller things at the same sites

- `main.ts`'s new `DATA_DIR` comment points at *"chat's `scripts/relay.sh`"* — no such
  file in this repo or in either sibling workspace (`../quereus`, `../optimystic`).
  Leaked context from elsewhere; drop it or point at something real.
- `libp2p-infra/README.md` still says the site stacks "forward all four variables"
  — the PR made it six, and neither new one is forwarded by any compose file.
- `ops/docker/README.md` says "container listens on 4001" and lists the image's env
  contract as `SEREUS_ROLE`, `ANNOUNCE_ADDRS` and the two `RELAY_*` knobs. Both stale.
  The relay / bootstrap / bootstrap-relay `env.example` files carry the same stale
  parenthetical.
- The WS filter for the startup block is `ma.includes('/ws')` — a substring test on a
  structured address. Correct for `/ws` and `/tls/ws` today; prefer a protocol-aware
  check.
- `ops/test/check-node.mjs` configures `transports: [tcp()]`, so the in-repo tool an
  operator is told to validate a deployed node with cannot dial the new endpoint at
  all. Adding `webSockets()` there is what makes the feature verifiable by the people
  who deploy it.

## Edge cases & interactions

- **`LISTEN_ADDRS` set to TCP only.** Must still start, and must not print an empty WS
  block. Same for the WS-only override.
- **`ANNOUNCE_ADDRS` that does include a `/ws` or `/tls/ws` entry.** No warning — the
  operator has already handled it.
- **`ANNOUNCE_ADDRS` set while `LISTEN_ADDRS` is TCP-only.** No WS warning either;
  there is no WS listener to advertise.
- **Empty-ish values.** `LISTEN_ADDRS=","`, `" "`, `"/"`, `""` — the first three must
  fail with a named error; the empty string means unset and takes the default, matching
  how every other env var in this file behaves.
- **Existing deployments.** `env.local` files in the field predate the new host-port
  variable, so its default must be applied by compose rather than required.
- **Port collision.** Bringing up relay and bootstrap on one host must not fight over a
  host port, before or after this change.
- **`docker compose config` on all three stacks** must render with an unset `env.local`.

## TODO

- [ ] One validated multiaddr-list parser in `main.ts`, used by both `LISTEN_ADDRS` and
      `ANNOUNCE_ADDRS`; reject unparsable and component-less entries, naming the var.
- [ ] Warn at startup when a WS listener is bound but no WS address is advertised.
- [ ] Protocol-aware WS filter for the startup block.
- [ ] `EXPOSE` the WS port; publish it from all three stacks under a new host-port
      variable with a per-role default that does not collide with the existing block.
- [ ] `env.example` entries for the new variable in all three stacks.
- [ ] `webSockets()` transport in `ops/test/check-node.mjs` (+ its `package.json`).
- [ ] Docs: `libp2p-infra/README.md` (the "four variables" sentence, `ANNOUNCE_ADDRS`
      interaction in the mobile section), `ops/docker/README.md` (port table, image env
      contract, "container listens on 4001"), `ops/test/README.md` if the check's usage
      changes.
- [ ] Drop the dangling `scripts/relay.sh` reference.
