----
description: Unauthenticated public POST /seed on the 0.0.0.0-bound health server can inject control-network peer-cache entries
files: packages/cadre-cli/src/server/health.ts, docker-compose.yml
----
The cadre-cli health server exposes a seed-application endpoint that is reachable by any peer on the network without authentication, allowing a reachable attacker to mutate the control-network peer cache.

The health HTTP server binds `0.0.0.0` (`packages/cadre-cli/src/server/health.ts:215`) and routes `POST /seed` to `handleSeedRequest` (`health.ts:201-202`). That handler reads the request body, base64url-decodes the `seed` field, JSON-parses it, and calls `node.applySeed(decodedSeed)` directly (`health.ts:222-258`, notably the decode/apply at `health.ts:244-250`) with no authentication, authorization, or origin check of any kind. Applying a seed pre-populates the control-network peer cache, so a successful submission injects attacker-chosen entries into control-plane peer state.

This endpoint is intended to be world-reachable in real deployments: port 8080 is published to the host in `docker-compose.yml`, and the README deployment guide instructs operators to open it. Combined with the binding, the `/seed` route is exposed to the public network rather than confined to a local/trusted control surface.

The signature validation in cadre-core does not close the gap. cadre-core verifies the seed's ed25519 signature, but the `signerKey` trust policy is a documented TODO — see the related ticket `tickets/plan/seed-signerkey-trust-policy-self-asserting.md`. Because the seed can vouch for its own signer (self-asserting authority), a self-signed seed submitted by any reachable peer passes the trust gate and is applied. The unauthenticated network path described here is the delivery vector that makes that trust-policy gap remotely exploitable; the two issues are complementary and should be addressed together.

This is inconsistent with the project's own treatment of less sensitive operations. The admin channel requires a bearer token and binds loopback only (see `tickets/complete/6.6-cadre-node-admin-channel.md`), yet seed application — which mutates control-plane peer state — is both unauthenticated and bound to all interfaces.

Expected behavior: the seed-application endpoint must not be world-reachable while unauthenticated. At minimum it should require authentication (for example a bearer token, consistent with the admin channel) and/or bind to loopback so it is not exposed on `0.0.0.0`, and seed application must be gated behind the seed trust policy rather than accepting self-asserted authority. The deployment surface (`docker-compose.yml` port mapping and the README deployment guide) should be revisited so the seed endpoint is not exposed publicly by default. The relevant code paths are `packages/cadre-cli/src/server/health.ts` (`startHealthServer` binding and the `/seed` route, `handleSeedRequest`) and the port publication in `docker-compose.yml`.

Related: `tickets/plan/seed-signerkey-trust-policy-self-asserting.md` (self-asserting seed trust gate / absent out-of-band anchor) and `tickets/complete/6.6-cadre-node-admin-channel.md` (authenticated, loopback-bound admin channel precedent).
