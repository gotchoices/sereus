----
description: Harden the cadre-cli deployment surface for the now-gated POST /seed (docker-compose host-port binding, README/env docs)
prereq:
files: packages/cadre-cli/docker/docker-compose.yml, packages/cadre-cli/docker/env.example, packages/cadre-cli/README.md
----

> **Scope reduced after review of `seed-network-path-authn`.** The *code-side*
> auth work this ticket originally specified — `HealthServerOptions.seedToken`,
> the `POST /seed` bearer gate (disabled by default, 401/413), the
> `CADRE_SEED_TOKEN` wiring in `start.ts`, the shared `bearer.ts` helper, and
> `test/health-server.spec.ts` — **already landed** via
> `seed-network-path-authn` (commit `ticket(implement): seed-network-path-authn`,
> reviewed in `seed-network-path-authn` → complete). Do **not** re-implement it;
> the route is registered only when `CADRE_SEED_TOKEN` is set and requires
> `Authorization: Bearer <token>`. What remains is the **deployment-surface
> hardening** that the original ticket also called for but the network-path
> review did not touch.

## Problem (residual)

The cadre-cli health server binds `0.0.0.0` and the standalone docker-compose
template publishes the health port on all host interfaces
(`packages/cadre-cli/docker/docker-compose.yml:57` —
`"${HOST_HEALTH_PORT:-8080}:8080/tcp"`). `POST /seed` is now disabled-by-default
and bearer-gated in code, so the *unauthenticated* injection vector is closed,
but the deployment template and docs still:

- publish 8080 world-wide by default (defense-in-depth: the seed surface, once a
  token is set, and the read-only probes are reachable from any interface);
- do not document `CADRE_SEED_TOKEN` or that `/seed` is authenticated and
  off-by-default (`packages/cadre-cli/README.md` port table ~line 147 lists 8080
  as "Health endpoint" only; the firewall section ~line 150 covers 4001 only);
- `packages/cadre-cli/docker/env.example` does not mention `CADRE_SEED_TOKEN`.

## Design

- **`docker-compose.yml`**: bind the published health port to loopback by
  default — `"127.0.0.1:${HOST_HEALTH_PORT:-8080}:8080/tcp"` — or, if the team
  wants remote health probes working out of the box, keep the bare publish but
  add a prominent comment that 8080 must be firewalled and `CADRE_SEED_TOKEN`
  only set when HTTP seed delivery is intended. Pick one; state the rationale in
  the handoff. Add a comment documenting that `/seed` is disabled unless
  `CADRE_SEED_TOKEN` is set.
- **`env.example`**: add `CADRE_SEED_TOKEN` (commented, default unset) with a
  one-line note that setting it enables authenticated `POST /seed`.
- **`README.md`**: in the port table, note 8080 exposes only read-only probes by
  default and that `POST /seed` is authenticated-and-disabled-by-default (set
  `CADRE_SEED_TOKEN` to enable); add `CADRE_SEED_TOKEN` to the env-var reference;
  in the firewall/deployment section, state 8080 should not be opened to the
  public internet.

## TODO

- [ ] Harden `packages/cadre-cli/docker/docker-compose.yml` host-port binding +
      add the `/seed` / `CADRE_SEED_TOKEN` comment.
- [ ] Add `CADRE_SEED_TOKEN` (commented) to `packages/cadre-cli/docker/env.example`.
- [ ] Update `packages/cadre-cli/README.md` port table, firewall/deployment
      guidance, and env-var table for `CADRE_SEED_TOKEN`.
- [ ] No code changes expected; if any, `yarn workspace @serfab/cadre-cli build`
      + `test` must stay green.

## Notes

- The provider-side counterpart (per-container `CADRE_SEED_TOKEN` generation +
  injection, `HostIp: 127.0.0.1` on the provider's own `docker-orchestrator`
  bindings, sending the bearer header on the seed POST) is
  `cadre-provider-seed-endpoint-auth`, which `prereq`s this slug. That ticket
  covers the *provider* docker bindings; this one covers the *standalone cadre-cli*
  compose template and docs.
- Does not address the seed *trust-policy* gap
  (`seed-trust-policy-and-authority-identity`, already landed) — orthogonal.
