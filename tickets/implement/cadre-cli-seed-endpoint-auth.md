----
description: Gate cadre-cli health-server POST /seed behind a bearer token (disabled by default) and stop exposing it publicly
prereq:
files: packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/README.md, packages/cadre-cli/test/health-server.spec.ts
----

## Problem (reproduced)

The cadre-cli health server binds `0.0.0.0` and routes `POST /seed` straight to
`node.applySeed(decodedSeed)` with **no authentication of any kind**
(`packages/cadre-cli/src/server/health.ts:201-202`, `:215`, `:222-258`). A
reproducing test confirmed it: starting `HealthServer` with a mock node and
POSTing a forged seed (no auth header) returns `200` and invokes `applySeed`
exactly once. Because port 8080 is published to the host
(`packages/cadre-cli/docker/docker-compose.yml:57`, and the README port table
documents 8080 as a deployment port), any reachable peer can inject
attacker-chosen entries into the control-network peer cache.

> Note: the original ticket's `files:` referenced a repo-root `docker-compose.yml`;
> the actual template is `packages/cadre-cli/docker/docker-compose.yml`. The
> per-container provider path is `packages/cadre-provider/.../docker-orchestrator.ts`
> (handled by the sibling ticket `cadre-provider-seed-endpoint-auth`).

## Threat model & why the obvious fixes don't all apply

- **Loopback-only binding is not viable for the real consumer.** The only
  in-tree client of HTTP `POST /seed` is the cadre-provider, which reaches a
  managed container over a Docker-published port
  (`docker-orchestrator.ts:91,117`). A server bound to `127.0.0.1` inside the
  container is **not** reachable through Docker port publishing (that is exactly
  why the loopback admin channel in `6.6-cadre-node-admin-channel` is *only* for
  same-host orchestrators like cadre-host, not for Docker-network callers). So
  the seed route must stay bound on the container's `0.0.0.0` interface and be
  protected by a **shared secret**, not by binding alone.
- **Authentication is the primary control**, consistent with the admin-channel
  precedent (`admin-server.ts`: constant-time `Bearer` check, `MAX_BODY_BYTES`
  guard, refuses to expose the surface without a token).
- **Deployment surface is the secondary control**: the standalone docker-compose
  template and README must not expose the seed surface to the public internet by
  default.

This fix closes the **unauthenticated network delivery vector**. It does *not*
close the seed *trust-policy* gap (a self-signed seed that vouches for its own
signer still validates) — that is tracked separately in
`tickets/plan/seed-signerkey-trust-policy-self-asserting.md` and must land for
the control plane to be safe end-to-end. Keep that scope boundary explicit in
code comments and the handoff; do not let the bearer gate read as "seed
application is now trusted."

## Design

Add an optional bearer token to the health server and gate `POST /seed` on it,
**disabled by default**:

- `HealthServerOptions` gains `seedToken?: string`.
- If `seedToken` is empty/undefined, the `/seed` route is **not registered** —
  requests fall through to the existing `404 Not Found`. This makes the safe
  default (no token configured → no remotely-mutable control surface) automatic
  for the docker-compose template, systemd, and dev runs that don't opt in.
- If `seedToken` is set, `handleSeedRequest` first performs a constant-time
  `Authorization: Bearer <token>` check (reuse the exact pattern from
  `admin-server.ts` `isAuthorized` — `timingSafeEqual`, length short-circuit).
  On failure respond `401` with `{ success: false, error: 'unauthorized' }`
  before reading/parsing the body. Keep the existing decode/apply logic
  unchanged after the check.
- Add a `MAX_BODY_BYTES` guard to the seed body read (the current
  `handleSeedRequest` buffers the whole body unbounded; mirror admin-server's
  256 KiB cap).

Token source / wiring in `start.ts`:

- Resolve the token from `process.env.CADRE_SEED_TOKEN` (new, dedicated env var
  — keep it distinct from `CADRE_STARTUP_TOKEN`, whose semantics are PID
  verification / admin-channel bearer). Pass it into `new HealthServer({ ...,
  seedToken })`.
- When a seed token is configured, log a single line at startup
  (`✓ Seed endpoint authenticated`); when not, the route stays off — no log
  noise needed, but a `debug()` line stating the route is disabled aids ops.

Consider factoring the constant-time bearer check into a tiny shared helper so
health.ts and admin-server.ts don't duplicate it (e.g.
`packages/cadre-cli/src/server/bearer.ts` exporting
`checkBearer(req, token): boolean`). Keep it DRY but don't over-engineer; a
local copy with a comment pointing at the admin-server original is acceptable if
a shared module adds friction.

## Deployment surface hardening

- **`packages/cadre-cli/docker/docker-compose.yml`**: the health port is
  published for liveness probes. Add a comment documenting that `/seed` is
  disabled unless `CADRE_SEED_TOKEN` is set, and (recommended) bind the host
  health port to loopback by default so the surface isn't world-exposed —
  e.g. publish as `"127.0.0.1:${HOST_HEALTH_PORT:-8080}:8080/tcp"`. If the
  team prefers to keep remote health probes working out of the box, instead add
  a prominent comment that operators must firewall 8080 and only set
  `CADRE_SEED_TOKEN` when they intend to accept HTTP seed delivery. Pick one and
  state the rationale in the handoff.
- **`packages/cadre-cli/README.md`** (port table around line 144-148 and the
  Linux deployment / firewall section ~150-153): document that the health port
  exposes only read-only probes by default, that `POST /seed` is
  authenticated-and-disabled-by-default (set `CADRE_SEED_TOKEN` to enable), and
  that 8080 should not be opened to the public internet. Add `CADRE_SEED_TOKEN`
  to the env-var reference table.

## TODO

- [ ] Add `seedToken?: string` to `HealthServerOptions`; store it (do not put it
      in the `Required<>` default-fill with a real default — empty string means
      disabled).
- [ ] In `startHealthServer`, only branch into `handleSeedRequest` when a token
      is configured; otherwise let `/seed` fall through to 404.
- [ ] In `handleSeedRequest`, add the constant-time `Bearer` check (401 on
      failure, before body read) and a `MAX_BODY_BYTES` (256 KiB) guard on the
      streamed body. Preserve the existing base64url-decode → JSON-parse →
      `applySeed` flow and its 200/400 result mapping.
- [ ] Add a short comment at the `/seed` handler clarifying that the bearer gate
      protects the *delivery path only* and that seed *trust* still depends on
      `seed-signerkey-trust-policy-self-asserting`.
- [ ] Wire `CADRE_SEED_TOKEN` through `start.ts` into the `HealthServer`
      constructor; add a startup log line when enabled.
- [ ] (Optional, DRY) extract the bearer check into a shared helper used by both
      health.ts and admin-server.ts.
- [ ] Harden `packages/cadre-cli/docker/docker-compose.yml` host port binding /
      comments; add `CADRE_SEED_TOKEN` to the env block (commented, default
      unset).
- [ ] Update `packages/cadre-cli/README.md` port table, deployment/firewall
      guidance, and env-var table for `CADRE_SEED_TOKEN`.
- [ ] Add `packages/cadre-cli/test/health-server.spec.ts` (new) covering, with a
      scriptable mock node like `test/admin-server.spec.ts`:
      - token-disabled (default): `POST /seed` → 404, `applySeed` never called;
      - token-enabled + no/invalid bearer: → 401, `applySeed` never called;
      - token-enabled + valid bearer: → 200, `applySeed` called once;
      - oversized body → 400/413 without calling `applySeed`;
      - `/health` and `/status` still respond 200 regardless of token.
      Use a fixed high port (the repro used 18099) or add a `get port()` accessor
      to `HealthServer` (mirrors `AdminServer.port`) so the test can bind port 0.
- [ ] `yarn workspace @serfab/cadre-cli build` and
      `yarn workspace @serfab/cadre-cli test` green.

## Handoff notes for the reviewer

- The provider half (inject `CADRE_SEED_TOKEN`, bind the published health port to
  127.0.0.1, send the bearer header on the seed POST) is the sibling ticket
  `cadre-provider-seed-endpoint-auth`, which `prereq`s this one for the auth
  contract. It also coordinates with `cadre-provider-seed-endpoint-never-populated`
  (which first makes `seedEndpoint` non-null at all).
- Be honest in the handoff that the seed *trust* gap remains open until
  `seed-signerkey-trust-policy-self-asserting` lands; this ticket only removes
  the anonymous-network delivery vector.
