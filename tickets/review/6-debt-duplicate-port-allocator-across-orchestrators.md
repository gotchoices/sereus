description: Two of our node managers each kept their own private copy of the same "which network ports are in use" tracker; it now lives in one shared place both use, with no change to which ports anything gets.
files: packages/cadre-provider/src/service/port-allocator.ts (new), packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/src/service/__tests__/port-allocator.test.ts (new), packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-ports.test.ts
difficulty: easy
----

# What changed

- New `packages/cadre-provider/src/service/port-allocator.ts`: `PortAllocator` (moved verbatim from cadre-host with its comments) plus generic `allocatePortSet(allocator, keys, overrides?)`, `reservePortSet`, `releasePortSet`. The all-or-nothing, overrides-reserved-first body and its trusted-override `NOTE:` moved here from cadre-host's `allocateNodePorts`. All four exported from the `@serfab/cadre-provider` root.
- `docker-orchestrator.ts`: private `PortAllocator`, `allocatePorts(count)` and `releasePorts(...)` deleted. New `CONTAINER_PORT_KEYS = ['health','metrics','p2p']` and `ContainerHostPorts` type (used for the `containerPorts` map). `createContainer` keeps a `ports` record instead of three locals.
- cadre-host `orchestrator/port-allocator.ts` now holds only `NODE_PORT_KEYS` (`as const satisfies readonly (keyof NodePorts)[]`), thin wrappers `allocateNodePorts` / `reserveNodePorts` / `releaseNodePorts` over the shared set functions, and `reusedNodePorts` unchanged. A key added to `NodePorts` but not the list fails to compile at `allocateNodePorts`'s return (Record → NodePorts); a key in the list not in `NodePorts` fails the `satisfies`. No cast needed in either wrapper or at the provider call site.
- `host-process-orchestrator.ts` imports `PortAllocator` from `@serfab/cadre-provider` (merged into the existing import with inline `type` specifiers).

# Intended behaviour changes

- Provider `DockerOrchestrator` constructor now throws `Invalid port range: a..b` on a bad `portRange` (previously constructed and failed every allocation).
- Provider exhaustion message now includes the range; existing substring assertions still match.

# Tests

- Moved (not new): the three `PortAllocator` unit tests from cadre-host's `orchestrator-ports.test.ts` to `packages/cadre-provider/src/service/__tests__/port-allocator.test.ts` — sequential allocate/release/reuse, `markUsed` reservation, `markUsed` ignoring non-integers.
- `orchestrator-port-leak.test.ts` "range cannot satisfy the request": now asserts `portAllocator.has(10000)` / `has(10001)` are false after the failed create (the private `allocatePorts` it used is gone).
- No new tests; `allocatePortSet` branching stays covered through cadre-host's existing `allocateNodePorts` / reserve / release / `reusedNodePorts` tests.

# Validation run

- `yarn workspace @serfab/cadre-provider build` then test: 29 files, 225 passed.
- `yarn workspace @serfab/cadre-host typecheck` clean; test: 69 files, 663 passed, 4 skipped (pre-existing skips).
- `yarn workspace @serfab/cadre-provider typecheck` and `yarn lint` clean.

# Known gaps / for the reviewer

- The provider still never rehydrates its used-set on restart; that is `bug-provider-port-allocator-forgets-live-ports-on-restart`, which can now use `reservePortSet(this.portAllocator, CONTAINER_PORT_KEYS, …)`.
- No docs update: nothing in `docs/` names either allocator.
