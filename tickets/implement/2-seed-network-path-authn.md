----
description: Harden the unauthenticated, internet-bound POST /seed network surface
prereq: seed-trust-policy-and-authority-identity
files: packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/admin-server.spec.ts
effort: medium
----

## Problem

The cadre-cli health server binds to `0.0.0.0` (`packages/cadre-cli/src/server/health.ts:274`) and exposes `POST /seed` (`health.ts:260-261`, `handleSeedRequest` `health.ts:281-317`) with **no authentication**. Any reachable peer can submit a seed for `applySeed`. Even after the trust-policy work (`seed-trust-policy-and-authority-identity`) makes forged seeds non-applicable, this remains an unauthenticated, internet-facing endpoint that drives peer-store mutation and outbound dials — a remote injection / resource-exhaustion surface that does not belong on the public health port.

The threat model for the trust policy explicitly includes this path, so it must be closed rather than relying on the trust gate alone (defense in depth).

## Design

The health server's legitimate job is liveness/readiness probes (`/health`, `/ready`, `/status`) — those stay public. Seed submission is a privileged control operation and belongs on an authenticated channel, not the public health port.

Preferred approach: **remove `POST /seed` from the public health server** and route seed submission through the already-authenticated loopback admin channel (`AdminServer`, `admin-server.ts`), which is bound to `127.0.0.1` and gated by the `CADRE_STARTUP_TOKEN` bearer secret (`start.ts:228-243`). If an admin seed route does not already exist, add `POST /seed` there with the same bearer-token check the admin channel uses for its other routes.

If a network-reachable seed-submission endpoint must be retained (decide during implementation by checking how operators/provider tooling actually deliver seeds — the legitimate transports are the `/sereus/seed/1.0.0` libp2p protocol, `CADRE_SEED` env, and provider API, none of which need the public HTTP endpoint), then gate it behind a bearer token and prefer binding to loopback. Do not leave it open on `0.0.0.0`.

The `/sereus/seed/1.0.0` libp2p protocol handler (`seed-bootstrap.ts:525-622`) is a separate transport and is already covered by the trust policy; it is out of scope here beyond confirming it still routes through the hardened `applySeed`.

## Key tests

- `POST /seed` on the public health port is gone (404) or rejects unauthenticated requests (401/403); `/health`, `/ready`, `/status` remain reachable unauthenticated.
- If moved to the admin channel: a seed POST with the correct bearer token applies the seed; a missing/wrong token is rejected; the route is bound to loopback.

## TODO

- [ ] Decide and document (in the review handoff) whether `POST /seed` is removed from the health server or moved to the admin channel — default to moving it to `AdminServer`.
- [ ] Remove the `/seed` branch + `handleSeedRequest` from the public health server, or gate it behind auth + loopback.
- [ ] If moved: add an authenticated `POST /seed` route to `AdminServer` reusing its existing bearer-token check; wire the decode→`node.applySeed` logic there.
- [ ] Update `packages/cadre-cli/test/admin-server.spec.ts` (and any health-server tests) for the new location/auth behavior.
- [ ] `yarn build` + `yarn test` in `packages/cadre-cli` (stream output with `| tee`).
