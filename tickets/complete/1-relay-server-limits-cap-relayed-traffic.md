----
description: The relay server this project deploys used to put a small cap on every connection it carried, so messages sent to a phone or browser tab through it were silently dropped. The cap is now off by default, both relay limits are configurable by an operator, and the deployment stacks actually pass those settings through to the container.
prereq:
files: ops/docker/libp2p-infra/src/main.ts, ops/docker/libp2p-infra/README.md, ops/docker/README.md, ops/docker/relay/docker-compose.yml, ops/docker/relay/env.example, ops/docker/bootstrap-relay/docker-compose.yml, ops/docker/bootstrap-relay/env.example, docs/architecture.md
difficulty: easy
----

# What shipped

`ops/docker/libp2p-infra/src/main.ts` passes an explicit `CircuitRelayServerInit`
instead of calling `circuitRelayServer()` bare:

```ts
services.relay = circuitRelayServer({
  reservations: {
    applyDefaultLimit: RELAY_APPLY_DEFAULT_LIMIT,   // env, default false
    maxReservations: RELAY_MAX_RESERVATIONS         // env, default 500
  }
})
```

- `RELAY_APPLY_DEFAULT_LIMIT` (`true`/`false`, default `false`). libp2p's own
  default is `true`, which stamps each reservation with a ~128 KiB / 2 min
  `Limit` and marks the resulting connection "limited"; handlers that do not opt
  in with `runOnLimitedConnection: true` refuse such streams. Now off by default.
- `RELAY_MAX_RESERVATIONS` (positive integer, default `500`), replacing libp2p's
  default of 15.
- Both parsed strictly at startup by two small helpers; malformed value throws,
  empty value takes the default. Resolved values logged next to `peerId` for the
  relay roles.
- Documented in a new `ops/docker/libp2p-infra/README.md` (image env contract),
  in `ops/docker/README.md` (site knob list), in both relay stacks' `env.example`,
  and in `docs/architecture.md`'s Relay Integration section — including the
  abuse tradeoff of running an unauthenticated relay with no per-connection cap.

Review added the deployment wiring (below) that made the two variables actually
reachable, and corrected the justification text.

## Review findings

### Checked

Implement diff read first, before the handoff summary. Reviewed: the config
change itself against the resolved `@libp2p/circuit-relay-v2@3.x` type
declarations (`ReservationStoreInit`, `CircuitRelayServerInit`); the two env
parsers for edge cases; the end-to-end operator path from `env.local` through
compose into the container; every doc the change touched and the docs it should
have touched; the truth of the claims made in code comments and prose; and
whether any test in the repo would catch a regression.

### Found and fixed in this pass

- **The two new environment variables never reached the container.**
  `ops/docker/relay/docker-compose.yml` and `bootstrap-relay/docker-compose.yml`
  enumerate `environment:` explicitly (`SEREUS_ROLE`, `ANNOUNCE_ADDRS` only);
  docker compose does not forward unlisted variables from `env.local`. An
  operator setting `RELAY_APPLY_DEFAULT_LIMIT=true` or `RELAY_MAX_RESERVATIONS`
  would have seen no effect at all. The bug fix itself still worked (the code
  default is what a bare deployment gets), but the "configurable" half of the
  ticket was inert. Both variables added to both compose files, documented in
  both `env.example` files and in `ops/docker/README.md`'s `env.local` knob list.
- **The justification was factually wrong about sereus's own protocols.** Code
  comment, `libp2p-infra/README.md` and `docs/architecture.md` all asserted that
  "none of `@optimystic/db-p2p`'s services or sereus's control protocols" pass
  `runOnLimitedConnection`. Verified: db-p2p's four database services (`repo`,
  `cluster`, `sync`, `block-transfer`) register handlers with no opt-in, and
  seed delivery (`cadre-core/src/seed-bootstrap.ts`) deliberately does not — but
  `strand-wake-protocol.ts` and `strand-addr-protocol.ts` **do** opt in, on both
  handler and dialer side, with comments saying it is required for the relay
  path. Rewritten in all three places: the opted-in protocols survive the
  limited flag but still die once the connection crosses the cap, which is the
  accurate reason the cap has to go.
- **No cross-link between the image README and the ops README.** The new
  `libp2p-infra/README.md` documents the image's env contract while
  `ops/docker/README.md` documents site-level knobs; neither pointed at the
  other, and nothing said that adding an image variable also requires touching
  the compose files. Both directions linked, with that rule stated.
- **`npm run build` was a vacuous check.** `main.ts` opens with `@ts-nocheck`,
  so `tsc` verified nothing about the new call shape. Removed it and rebuilt
  against a real `npm install`: the only error is a pre-existing nominal clash
  from a duplicate `@libp2p/interface` nested under `@multiformats/dns` on
  `createLibp2p({ privateKey })`. Everything the ticket added — both parsers and
  the `circuitRelayServer({ reservations: { … } })` literal — type-checks clean.
  Directive restored (the duplicate dependency is not this ticket's to fix) with
  a comment recording exactly what it is load-bearing for and that it should be
  dropped if a dependency bump collapses the duplicate.

### Filed as a new ticket

- `backlog/debt-relay-check-verifies-reservation-limits` — `ops/test/check-node.mjs
  --relay` only pattern-matches the identify protocol list (its own output says
  "heuristic"), so a relay configured to drop every byte passes the check. That
  mattered less when the setting was hardcoded; it now varies per host via an
  environment variable, with no signal when it is wrong. Nothing in the repo
  catches it: the loopback relay specs in `packages/cadre-core/test/` stand up
  their own relay with library defaults and opt every stream into limited
  connections, so they exercise a configuration the deployment does not use.
  This is the ticket's own "container-level check" gap, given a home. Confirmed
  no open ticket already touches `ops/test/`.

### Recorded as tripwires, not tickets

- `main.ts`, at the `RELAY_MAX_RESERVATIONS` default — 500 is well past any
  cadre this repo describes and costs one map entry per peer. Two conditions
  would make it worth revisiting: members exhausting 500 slots, or sustained
  circuit setup past `circuitRelayServer`'s `maxOutboundStopStreams` default of
  300 (that cap is on concurrent connection *setup*, not held reservations, so
  it only bites under a simultaneous dial storm). This answers the implementer's
  open question about the 500 default: accepted.
- `libp2p-infra/README.md`, in the tradeoff section — `ReservationStoreInit`
  also accepts `defaultDataLimit` / `defaultDurationLimit`, so a public
  deployment wanting a bandwidth brake has a middle ground rather than choosing
  between "unmetered" and "broken". Noted that the right move there is to expose
  those two rather than flip `RELAY_APPLY_DEFAULT_LIMIT` on.

### Checked and clean

- **Env parsing edge cases** — empty string takes the default (so the
  `${VAR:-}` compose interpolation added above is safe), whitespace trimmed,
  `Number('1.5')`/`'abc'`/`'0'`/`'-1'` all rejected by the `Number.isInteger` +
  `> 0` guard, boolean parse is case-insensitive and rejects anything else.
  `Number('')` returning `0` is not reachable because empty is short-circuited
  first. No silent fallback anywhere.
- **Third hidden cap** — checked whether `ReservationStoreInit` has a per-peer
  reservation cap that would still bite (each cadre member holds several slots
  under distinct derived peer IDs). At `@libp2p/circuit-relay-v2@3.x` there is
  no `maxReservationsPerPeer`; the only relevant fields are the two now set plus
  `reservationClearInterval`, `reservationTtl` and the two default-limit sizes.
- **Abuse-tradeoff surfacing** — the implementer's second open question. Now
  stated at five sites an operator or reader would plausibly reach: the code
  comment, the image README, `ops/docker/README.md`, both stacks' `env.example`,
  and `docs/architecture.md`. Sufficient; it is a stated posture, not a silent
  default.
- **Other deployment paths** — `ops/docker/bootstrap/` runs `SEREUS_ROLE=bootstrap`
  with no relay service, so it correctly needs neither variable. The relay and
  bootstrap-relay quickstarts under `ops/docker/quickstarts/` document workflow
  steps and defer knob documentation to `../README.md`, which is now current, so
  they needed no edit. `packages/cadre-cli/docker/` is a cadre node, not this
  image, and is unaffected.
- **Resource cleanup / error handling / source hygiene** — nothing to report.
  The diff adds no resources to release; both parsers throw at startup before
  the node exists. `main.ts` is 118 lines, one purpose per function, comments
  explain the non-obvious library behavior rather than restating the code.

### Empty categories

- **No test changes.** The change is a configuration literal in a directory with
  no test harness (`ops/docker/libp2p-infra` has no vitest project and is
  excluded from the root ESLint config by the `ops/**` ignore). Adding one is
  exactly the filed ticket's second arm; duplicating it here would be the same
  work in the wrong place.
- **No performance or scalability findings.** The diff runs once at process
  start and changes two numeric/boolean library settings; there is no hot path
  to measure.

## Validation

- `npm run build` (`tsc -p tsconfig.json`) in `ops/docker/libp2p-infra` after a
  real `npm install` — clean. Additionally verified clean with `@ts-nocheck`
  removed except for the pre-existing duplicate-dependency error described
  above.
- `yarn lint` (root) — clean.
- `packages/cadre-core`: `vitest run test/relay-reservation.spec.ts
  test/strand-transport-relay.spec.ts` — 2 files, 20 tests, all pass.
- Root guards: `yarn test:dep-ranges` (9 pass), `test:vitest-typecheck-coverage`
  (16 pass), `test:test-file-typecheck-coverage` (30 pass).
- The full workspace suite was not run: this diff touches only `ops/` and
  `docs/`, and the suite carries documented pre-existing failures tracked in
  `tickets/.pre-existing-known.md`. No new failure was observed in anything run.
- **Docker was not available in this environment** (no daemon, no CLI), so
  neither the implementer's nor this pass's changes were exercised against the
  built image. The implementer confirmed the library behavior with a throwaway
  Node script against the resolved dependency versions; the compose wiring added
  in this pass is unexercised and is verified only by reading. The filed ticket
  is the durable fix for that gap.
