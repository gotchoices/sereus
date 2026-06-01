----
description: Provider default auth is 'none' (wildcard) and ports/labels leak on provisioning failure
files: packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts
----
`@serfab/cadre-provider` is the multi-tenant Docker host: it provisions and isolates cadre containers per customer/party. Two properties of its current default behavior undermine that role — it runs fully open out of the box, and it leaks allocated host ports when provisioning fails.

## Insecure default authentication and unenforced permissions

`DEFAULT_CONFIG.auth.mode` is `'none'` (`packages/cadre-provider/src/config/types.ts:117-119`). In that mode, `registerAuth` injects a synthetic identity `{ customerId: 'dev-customer', permissions: ['*'] }` into every request and returns before any authorization check (`packages/cadre-provider/src/server/auth.ts:45-51`). Because `cadre-provider start` falls back to `DEFAULT_CONFIG` when no config file is supplied (`packages/cadre-provider/src/bin/provider.ts:37-45`), a provider launched with no configuration runs fully open: every caller is treated as the same wildcard-permission customer, so authentication and per-customer ownership isolation are both bypassed.

Compounding this, permission scopes are never actually enforced anywhere in the request path. Routes verify only the *presence* of a `customer` identity, not whether that customer holds a specific permission scope. So even with a real auth mode and a token-derived identity, the `permissions` array carries no enforcement weight today.

For a deployable multi-tenant host, the safe default must be closed: running with `mode: 'none'` should require an explicit, deliberate opt-in (e.g. an env flag or an unmistakable config acknowledgement) rather than being the silent fallback for a missing config. The wildcard `dev-customer` identity must not be the implicit behavior of a fresh `cadre-provider start`. Permission scopes attached to a customer identity should be enforced at the routes that perform privileged or customer-scoped actions, so that an authenticated identity is constrained to the operations its scopes permit and to resources it owns.

## Host port (and label) leak on provisioning failure

`DockerOrchestrator.createContainer` allocates three host ports (health, metrics, p2p) from the `PortAllocator` *before* it calls Docker to create the container (`packages/cadre-provider/src/service/docker-orchestrator.ts:69-71`). The mapping from `dockerId` to allocated ports is recorded only *after* a successful `container.start()` (`docker-orchestrator.ts:110-111`), and ports are released only in `removeContainer`, keyed off that same `containerPorts` map (`docker-orchestrator.ts:129-142`).

If `createContainer` throws after the `allocate()` calls — image pull failure, `docker.createContainer` rejecting, `container.start()` rejecting — the three allocated ports are never recorded and therefore never released. The allocator draws from the bounded 10000-20000 host-port range, so each failed provisioning attempt permanently consumes ports until the range is exhausted and no further containers can be placed. The container-service error path makes this worse: a container that ends in status `'error'` without ever obtaining a `dockerId` records the failure but performs no orchestrator-level cleanup (`packages/cadre-provider/src/service/container-service.ts:110-119`), so there is no later opportunity to reclaim those ports either.

The expected behavior is that any port (and any other host-scoped resource such as Docker labels/names) allocated during provisioning is released on *every* failure path, not just the successful-then-removed path. Allocation and release should be balanced regardless of where in `createContainer` the failure occurs, and the container-service error handling should ensure orchestrator resources are reclaimed even when no `dockerId` was ever produced.

## Scope

Both issues live entirely within `@serfab/cadre-provider`:

- `packages/cadre-provider/src/config/types.ts` — default auth mode.
- `packages/cadre-provider/src/server/auth.ts` — `none`-mode wildcard identity injection and absent scope enforcement.
- `packages/cadre-provider/src/bin/provider.ts` — config fallback that activates the open default.
- `packages/cadre-provider/src/service/docker-orchestrator.ts` — port allocate/release lifecycle.
- `packages/cadre-provider/src/service/container-service.ts` — provisioning error handling and cleanup.
