## Ops / Docker: sereus-node (pointer)

This folder used to carry its own copy of the headless cadre-node Docker
Compose template (`docker-compose.yml`, `env.example`). That copy was a
hand-maintained duplicate of the canonical template that ships with
`@serfab/cadre-cli`, and it drifted whenever the canonical one changed (e.g.
the loopback-binding + `CADRE_SEED_TOKEN` hardening on the health/seed ports
landed in the package template first and had to be re-applied here by hand).
The duplicate has been removed; use the canonical template instead:

**Canonical template:** [`packages/cadre-cli/docker/`](../../../packages/cadre-cli/docker/)
(`Dockerfile`, `docker-compose.yml`, `env.example`) — see
[`packages/cadre-cli/README.md`](../../../packages/cadre-cli/README.md) →
**Docker Deployment** for usage.

### Why this isn't a peer of `relay/` / `bootstrap/`

Unlike `relay/`, `bootstrap/`, `bootstrap-relay/`, `coturn/`, and
`turn-credential-issuer/`, a `sereus-node` is not shared operational
infrastructure — each one belongs to a single user's cadre (keyed by their own
`CADRE_PARTY_ID` and bootstrap nodes) and is normally deployed via npm/git +
systemd, or the Docker template above. It is intentionally **not** wired into
`ops/scripts/install` (`install docker sereus-node` does not exist) and has no
`quickstarts/` entry — there is nothing ops-shared to scaffold.

See `../README.md` for the ops/docker overview of the actually-shared
services (relay/bootstrap/coturn/etc).
