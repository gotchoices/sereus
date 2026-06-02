----
description: Review — POST /seed on the public health port is now bearer-gated and disabled by default
files: packages/cadre-cli/src/server/bearer.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/health-server.spec.ts, packages/cadre-cli/test/admin-server.spec.ts
----

## What the ticket asked

Close the unauthenticated, internet-bound `POST /seed` surface on the cadre-cli
health server (bound `0.0.0.0`, no auth, drove `node.applySeed`). The ticket's
*preferred* path was to remove `/seed` from the health port and move it to the
loopback admin channel; the *fallback* was to keep a network-reachable endpoint
but bearer-gate it and prefer loopback.

## Decision made (and why it diverges from the "preferred" path)

**Took the fallback: bearer-gated `/seed` on the health server, disabled by
default.** Investigation of how seeds actually reach a *running* node showed the
admin-channel path is not viable for the real consumers:

- **cadre-provider** delivers seeds via `ContainerService.applySeed` →
  `POST http://localhost:<healthPort>/seed` over a **Docker-published** port
  (`packages/cadre-provider/src/service/container-service.ts:248`,
  `docker-orchestrator.ts:117-120`). Docker port-publishing maps a host port to
  the container's `0.0.0.0` interface — it **cannot reach** a `127.0.0.1`
  listener *inside* the container, so the loopback `AdminServer` is unreachable
  by the provider.
- **cadre-host** also points seed delivery at the health port
  (`host-process-orchestrator.ts:460`: `seedEndpoint: .../seed`).

Moving `/seed` to the admin channel would break both orchestrators. So per the
ticket's explicit fallback clause, `/seed` stays on the health server but is now:

- **Not registered at all unless `CADRE_SEED_TOKEN` is set** → default config
  returns **404** (no remotely-mutable control surface out of the box).
- When a token is set, requires `Authorization: Bearer <token>` (constant-time
  check) → **401** on missing/wrong token, **before** the body is read.
- Body read is bounded at 256 KiB → **413** on oversized payloads (was
  previously unbounded).

The defense-in-depth point from the threat model holds: this gate protects the
*delivery path* only. Seed *trust* (a forged/self-asserting seed being honoured)
is the separate, already-landed `seed-trust-policy-and-authority-identity` work;
code comments at the route and on `HealthServerOptions.seedToken` say so
explicitly so the bearer gate is not misread as "seeds are now trusted."

## Changes

- **`packages/cadre-cli/src/server/bearer.ts`** (new): shared constant-time
  `checkBearer(req, token)` (length short-circuit, `timingSafeEqual`). Extracted
  to keep health.ts and admin-server.ts DRY.
- **`admin-server.ts`**: `isAuthorized` now delegates to `checkBearer`; the
  inline duplicate + `timingSafeEqual` import removed. Behaviour unchanged
  (existing admin tests still green).
- **`health.ts`**: `HealthServerOptions.seedToken?`; `/seed` route gated on a
  non-empty token (else falls through to 404); `handleSeedRequest` does the
  bearer check first, then a 256 KiB-bounded body read; added a `healthBoundPort`
  getter (mirrors `AdminServer.port`) so tests can bind port 0.
- **`start.ts`**: resolves `CADRE_SEED_TOKEN` (distinct from
  `CADRE_STARTUP_TOKEN`) and passes it to `HealthServer`; logs
  `✓ Seed endpoint authenticated` when set, a `debug()` line when not.
- **`test/health-server.spec.ts`** (new): token-disabled → 404 + applySeed never
  called; token-enabled + missing/wrong bearer → 401 + not called; valid bearer
  → 200 + called once; oversized body → 413 + not called; `/health`,`/ready`,
  `/status` stay 200 unauthenticated in both modes.

## Validation

- `yarn workspace @serfab/cadre-cli build` → exit 0.
- `yarn workspace @serfab/cadre-cli test` → 3 files, **30 tests passed**.

## Key tests / use cases for the reviewer

- Default (no `CADRE_SEED_TOKEN`): `POST /seed` → 404; probes → 200. ✔ covered.
- `CADRE_SEED_TOKEN` set: no/wrong bearer → 401 (no applySeed); correct bearer →
  200 (applySeed once); >256 KiB → 413. ✔ covered.
- Adversarial angles worth a second look: timing-safe path on the 401 (a
  zero-length token must never authorize — `checkBearer` returns false when
  `token.length === 0`, exercised implicitly by the default-disabled tests but
  not asserted directly); behaviour when `Authorization` header is an array
  (Node can produce `string[]` for duplicate headers — `checkBearer` treats
  non-string as unauthorized).

## Honest gaps / follow-ups (NOT done here)

- **Overlap with sibling tickets.** `tickets/implement/cadre-cli-seed-endpoint-auth`
  specifies essentially this exact cli-side fix (bearer-gate, disabled by
  default, `CADRE_SEED_TOKEN`, 256 KiB cap, shared bearer helper) — it is now
  **fully subsumed** by this work and should be closed/deleted rather than run
  again. I did not delete it (it lives in another stage); please retire it.
- **Provider/host wiring is still required and is out of scope here.** Now that
  `/seed` is disabled-by-default and bearer-gated, the orchestrators must (a)
  generate + inject a per-container `CADRE_SEED_TOKEN`, (b) send
  `Authorization: Bearer <token>` on their seed POST, and (c) bind the published
  host port to loopback (`HostIp: 127.0.0.1`). That is
  `tickets/implement/cadre-provider-seed-endpoint-auth` (which `prereq`s
  `cadre-cli-seed-endpoint-auth` — repoint it at this work). **Until that lands,
  provider/host seed delivery over HTTP will 404** because no token is injected.
  This is the intended secure default, but it means the HTTP seed path is
  non-functional for the provider until the provider half ships.
- **Deployment-surface hardening not touched.** This ticket's scope was the cli
  code path. The `docker-compose.yml` host-port binding and `README.md`
  port/firewall/env-var docs (called out in `cadre-cli-seed-endpoint-auth`) were
  **not** updated here — fold them into the provider-side follow-up.
- **`admin-server.spec.ts` not extended.** The ticket's TODO assumed a new admin
  `/seed` route; since `/seed` stayed on the health server, the new coverage
  lives in `health-server.spec.ts` instead. admin-server.spec.ts is unchanged
  and still green (validates the bearer-helper refactor caused no regression).
- The `/sereus/seed/1.0.0` libp2p transport is untouched and continues to route
  through the hardened `applySeed` (confirmed out of scope per the ticket).
