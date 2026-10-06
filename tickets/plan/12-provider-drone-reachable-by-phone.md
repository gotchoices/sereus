description: A phone cannot connect to a node rented from the multi-tenant hosting service, for the same two reasons a self-hosted machine's lent node was unreachable: the rented node only accepts plain TCP connections, and creating it demands an address for the phone. The architecture guide calls a phone adding a hosted node "the most common case".
files: packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/types.ts, docs/architecture.md
tradeoffs: The provider product is a multi-tenant Docker service with no phone customers in this repo yet, and each container would need one more published port, so a maintainer may reasonably wait until a phone actually rents a node.
----
# A phone can use a rented cadre-provider node

## What is wrong

`docs/architecture.md` → "Enrollment Flow: Phone Adds Provider Drone" describes a phone behind NAT renting a provider node and dialing it after seeding. cadre-provider cannot do that today:

- `buildNodeEnv` (`service/container-env.ts` ~53) sets `CADRE_LISTEN_ADDRS=/ip4/0.0.0.0/tcp/<p2p>`. A React Native phone has no TCP transport, so it cannot dial the container.
- `POST /containers` requires a non-empty `bootstrapNodes` (`server/bootstrap-node-validation.ts`), and `buildNodeEnv` joins it into `CADRE_BOOTSTRAP_NODES`. A phone has no address to give.

## Template

cadre-host fixes the same pair for its lent nodes in `implement/donated-node-reachable-by-phone`: a second listen entry `/ip4/0.0.0.0/tcp/<ws>/ws` with its own allocated port, and an optional `bootstrapNodes` (the per-entry address rule unchanged; only the list-level requirement relaxed). The phone side (`owner-keeps-dialing-node-it-added`) is shared cadre-core code and already covers a provider node.

Provider-specific parts to work out when picked up:

- Docker port publishing for the extra WebSocket port, and the provider's own port allocator (`backlog/debt-duplicate-port-allocator-across-orchestrators` and `backlog/bug-provider-port-allocator-forgets-live-ports-on-restart` touch the same code).
- Whether an empty `CADRE_BOOTSTRAP_NODES=` reaches cadre-cli as "no bootstrap nodes" (its env loader treats an all-empty split as unspecified).
- `provider-seed-accepted.integration.ts` uses a TCP-dialable requester; a phone-shaped variant would mirror `donation-scenario-phone-shaped-requester`.

## Provenance

Found while planning `phone-adds-cadre-host-node-to-its-cadre` (2026-09-15), by reading the code; not run.
