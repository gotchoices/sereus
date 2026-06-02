----
description: POST /seed on the cadre-cli health port is now bearer-gated and disabled by default (network-path authn hardening)
files: packages/cadre-cli/src/server/bearer.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/health-server.spec.ts, packages/cadre-cli/test/bearer.spec.ts
----

## Summary

Closed the unauthenticated, internet-bound `POST /seed` surface on the cadre-cli
health server. The endpoint previously bound `0.0.0.0` with no auth and drove
`node.applySeed` for any reachable peer. It is now:

- **Not registered unless `CADRE_SEED_TOKEN` is set** → default config returns
  **404** (no remotely-mutable control surface out of the box).
- When a token is set, requires `Authorization: Bearer <token>` (constant-time
  compare) → **401** on missing/wrong/array/non-Bearer header, **before** the
  body is read.
- Body read bounded at 256 KiB → **413** on oversized payloads (was unbounded).

The constant-time bearer check was factored into a shared
`packages/cadre-cli/src/server/bearer.ts` (`checkBearer`) and `admin-server.ts`
was refactored to delegate to it (behaviour unchanged). `start.ts` resolves
`CADRE_SEED_TOKEN` (distinct from `CADRE_STARTUP_TOKEN`) and logs whether the
seed endpoint is authenticated or disabled.

This gate protects the seed **delivery path** only; seed **trust** (whether an
applied seed is honoured) is the separate, already-landed
`seed-trust-policy-and-authority-identity` work — called out in code comments so
the bearer gate is not misread as "seeds are now trusted."

The implementer took the ticket's documented **fallback** (bearer-gate on the
health port) rather than the *preferred* admin-channel move, because Docker
port-publishing maps a host port to the container's `0.0.0.0` interface and
**cannot reach** a `127.0.0.1` admin listener inside the container — the
in-tree consumers (cadre-provider `ContainerService.applySeed`, cadre-host
`host-process-orchestrator`) both POST to the health port. Verified during
review: `docker-orchestrator.ts:117-120` and `host-process-orchestrator.ts:460`
both target `…/seed` on the published health port. The divergence is sound.

## Review findings

**Method.** Read the implement diff (commit `410a3db`) with fresh eyes before
the handoff, then read the full current `health.ts`, `bearer.ts`,
`admin-server.ts`, and the `start.ts` seed-wiring block. Verified the
provider/host seed-delivery claims against the actual orchestrator source.
Scrutinized for SPP/DRY/modularity, error handling, resource cleanup, type
safety, and security (constant-time compare, auth-before-body ordering, body
bound, default-off posture). Ran typecheck + build + tests.

**Validation (all green):**
- `yarn workspace @serfab/cadre-cli typecheck` → clean.
- `yarn workspace @serfab/cadre-cli build` → exit 0.
- `yarn workspace @serfab/cadre-cli test` → **4 files, 40 tests passed** (was 30;
  +10 from the review's added coverage below).

**Code quality — no defects found.** The bearer extraction is correctly DRY;
`checkBearer` short-circuits on empty token, non-string header, wrong scheme, and
length mismatch (avoiding the `timingSafeEqual` unequal-length throw) before the
constant-time compare. Auth is checked *before* the body is read; the 256 KiB
bound matches `admin-server.ts`'s `MAX_BODY_BYTES`. The `/seed` route is gated on
`seedToken.length > 0` in the dispatcher *and* re-checked in `handleSeedRequest`,
so a misconfiguration can't open the surface. Errors are logged, not eaten.
Server cleanup (`stop()`) closes both listeners. No `any`, no inline `import()`
in the type surface (the `uint8arrays` dynamic import is a genuine lazy load).

**Findings fixed inline (minor):**
- *Test coverage gaps.* The implementer's suite covered 404/401/200/413 and
  probe reachability but not the remaining `handleSeedRequest` error branches or
  the shared helper's adversarial inputs. Added:
  - `test/bearer.spec.ts` (new, 7 cases): exact match, wrong same-length token,
    length-mismatch (no throw), **empty configured token never authorizes**
    (the angle the handoff flagged as not directly asserted), missing header,
    non-Bearer scheme, and **duplicated (array) Authorization header**.
  - `test/health-server.spec.ts` (+3 cases): missing `seed` field → 400, malformed
    JSON → 400, and `GET /seed` with a token set → 404 (method guard is not auth),
    each asserting `applySeed` is never called.

**Findings filed / dispositioned (no new tickets needed — existing ones adjusted):**
- *Redundant sibling ticket.* `tickets/implement/cadre-cli-seed-endpoint-auth`
  specified this exact code-side fix; its code work is now fully subsumed and
  re-running it would conflict (re-adding `seedToken`, `bearer.ts`, etc.).
  **Reduced its scope in place** to the only un-done part — deployment-surface
  hardening (`docker-compose.yml` loopback host-port binding, `env.example` +
  `README.md` `CADRE_SEED_TOKEN`/firewall docs) — preserving the slug that
  `cadre-provider-seed-endpoint-auth` prereqs. This avoids losing the deployment
  work while preventing a conflicting code re-run.
- *Stale provider-ticket context.* Added a note to
  `tickets/implement/cadre-provider-seed-endpoint-auth` that the cli-side auth
  contract already landed (so the next implementer doesn't treat it as pending).

**Findings deferred (out of this ticket's file scope — owned by the tickets above):**
- *Deployment surface still binds `0.0.0.0` by default.* The health listener and
  the standalone `docker-compose.yml` publish 8080 on all interfaces. With `/seed`
  disabled-by-default and bearer-gated this is not an open injection vector, but
  loopback binding + firewall docs are defense-in-depth. Owned by the reduced
  `cadre-cli-seed-endpoint-auth`.
- *Provider/host HTTP seed delivery is non-functional until the provider half
  ships* (no `CADRE_SEED_TOKEN` injected → 404). This is the intended secure
  default; the wiring is `cadre-provider-seed-endpoint-auth`.

**Categories checked and found clean (explicitly empty):**
- *Docs:* no stale docs. `docs/architecture.md`'s `POST /containers/:id/seed`
  refers to the provider's REST API, a different surface; the cadre-cli README
  port table never documented `/seed`, so nothing the change touched is now wrong
  (the missing `CADRE_SEED_TOKEN` doc is a gap, captured by the deployment ticket,
  not a regression).
- *Regressions:* `admin-server.spec.ts` unchanged and green — the `checkBearer`
  refactor preserved admin-channel behaviour. No pre-existing test failures.
- *Type safety / resource cleanup / error handling:* nothing to fix.

## Out of scope (unchanged)

- The `/sereus/seed/1.0.0` libp2p transport is untouched and continues to route
  through the hardened `applySeed`.
- Seed *trust policy* (`seed-trust-policy-and-authority-identity`) — already
  landed, orthogonal to this delivery-path gate.
