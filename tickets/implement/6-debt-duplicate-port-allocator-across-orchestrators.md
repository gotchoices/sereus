description: Two of our node managers each keep their own private copy of the same little "which network ports are in use" tracker, so a fix or improvement to one silently misses the other. Move it to one shared place both use, without changing which ports anything gets.
files: packages/cadre-provider/src/service/port-allocator.ts (new), packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/src/service/__tests__/port-allocator.test.ts (new), packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-ports.test.ts
difficulty: easy
----

# The duplication

Two orchestrators hand out host ports from a bounded range, each with its own tracker:

- `packages/cadre-host/src/orchestrator/port-allocator.ts` — exported `PortAllocator` (`allocate`, `release`, `markUsed`, `has`, constructor range validation) plus node-set helpers built on a fixed key order `NODE_PORT_KEYS = ['health', 'metrics', 'p2p', 'admin', 'ws']`: `allocateNodePorts` (all-or-nothing, overrides reserved first), `reserveNodePorts`, `releaseNodePorts`, `reusedNodePorts`.
- `packages/cadre-provider/src/service/docker-orchestrator.ts` — a module-private `PortAllocator` (only `allocate`/`release`, no validation), a private `allocatePorts(count)` all-or-nothing wrapper, and a private `releasePorts({health, metrics, p2p})`.

Note the host's node set is now **five** ports (`ws` was added after the ticket was first written), the provider's is three.

# Decision: the shared tracker lives in `@serfab/cadre-provider`

New module `packages/cadre-provider/src/service/port-allocator.ts`, exported from the package root (`src/index.ts`).

Why provider and not `@serfab/cadre-core`:
- cadre-host already depends on cadre-provider (it implements provider's `Orchestrator` interface and imports its types), and cadre-provider's stale-build guard is already in cadre-host's `TARGETS` (`packages/cadre-host/src/__tests__/global-setup.ts`). No new dependency edge anywhere.
- cadre-provider currently has **zero** workspace dependencies (see the NOTE in `packages/cadre-provider/vitest.config.ts`); putting it in cadre-core would give provider its first one and oblige a new stale-build guard + `build-targets` spec there.
- Port-range allocation is an orchestrator concern. cadre-core is the cross-platform node library (also used on React Native), where it has no caller.

Tradeoff accepted: a general-purpose helper lives in a package named for one product. It is the package whose `Orchestrator` interface both orchestrators implement, so it is the natural home.

# Shared module shape

```ts
/** Range-based port tracker (moved verbatim from cadre-host, incl. its doc comments). */
export class PortAllocator {
	constructor(start: number, end: number);   // throws `Invalid port range: a..b` on bad input
	allocate(): number;                         // lowest free; throws `No available ports in range a..b`
	release(port: number): void;
	markUsed(port: number): void;               // no-op outside range / non-integer
	has(port: number): boolean;
}

/**
 * Take one port per key, all-or-nothing, in `keys` order. Overrides are reserved
 * (markUsed) FIRST, then the rest allocated; any throw releases everything taken.
 */
export function allocatePortSet<K extends string>(
	allocator: PortAllocator,
	keys: readonly K[],
	overrides?: Partial<Record<K, number>>,
): Record<K, number>;

/** markUsed each key's port; a missing/non-integer value is skipped by markUsed. */
export function reservePortSet<K extends string>(allocator: PortAllocator, keys: readonly K[], ports: Record<K, number>): void;

/** release each key's port; releasing a port never held is a no-op. */
export function releasePortSet<K extends string>(allocator: PortAllocator, keys: readonly K[], ports: Record<K, number>): void;
```

`allocatePortSet` is today's `allocateNodePorts` body with `NODE_PORT_KEYS` replaced by `keys`. Its doc comment, including the `NOTE:` about overrides being trusted rather than checked, moves with it (reword the caller-specific parts — owner `libp2pPort`, re-spawn — as examples from cadre-host).

`reservePortSet`/`releasePortSet` are included because both orchestrators need the release form and cadre-host needs the reserve form; the fix ticket `bug-provider-port-allocator-forgets-live-ports-on-restart` will want the reserve form in provider next. Do not add anything else (no persistence, no range defaults).

# cadre-host after the change

`packages/cadre-host/src/orchestrator/port-allocator.ts` keeps only what is specific to `NodePorts`:
- `NODE_PORT_KEYS` and its doc comment (the fixed-order rationale stays here — it is about cadre-host's deployed port assignments).
- `allocateNodePorts(allocator, overrides?)` → `allocatePortSet(allocator, NODE_PORT_KEYS, overrides)` (typed `NodePorts`; `Record<keyof NodePorts-in-order, number>` must be assignable — `NODE_PORT_KEYS` covers every `NodePorts` key, so declare the keys `as const satisfies readonly (keyof NodePorts)[]` or equivalent so the compiler catches a key added to `NodePorts` but not to the list).
- `reserveNodePorts`, `releaseNodePorts` → thin wrappers over the shared set functions.
- `reusedNodePorts` unchanged.
- The class `PortAllocator` is deleted here; `host-process-orchestrator.ts` imports `PortAllocator` from `@serfab/cadre-provider` (value import, alongside the existing `import type` from that package).

Keep the wrapper names so `host-process-orchestrator.ts`'s call sites (lines ~325, ~481 and the reserve/release sites) do not change.

# cadre-provider after the change

In `docker-orchestrator.ts`:
- Delete the private `PortAllocator` class, `allocatePorts(count)` and `releasePorts(...)`.
- Add `const CONTAINER_PORT_KEYS = ['health', 'metrics', 'p2p'] as const;` and `type ContainerHostPorts = Record<(typeof CONTAINER_PORT_KEYS)[number], number>;` — use it for the `containerPorts` map's value type.
- `createContainer`: `const ports = allocatePortSet(this.portAllocator, CONTAINER_PORT_KEYS);` then use `ports.health` etc. Order `health, metrics, p2p` matches today's `allocatePorts(3)` destructuring, so assigned ports are identical.
- Failure path and `removeContainer`: `releasePortSet(this.portAllocator, CONTAINER_PORT_KEYS, ports)`.

# Behaviour changes (intended, small)

- The provider's `DockerOrchestrator` constructor now throws `Invalid port range: a..b` for a non-integer, non-positive or inverted `portRange`. Previously such a config constructed fine and then failed every allocation. Config is operator-supplied; failing at startup is the better outcome.
- The provider's exhaustion message becomes `No available ports in range 10000..10002` (with the range). Existing assertions use the substring `'No available ports in range'` and still match.

Nothing else changes: same port order, same lowest-free choice, same override-first rule.

# Tests

No new behaviour, so no new tests. Move, don't duplicate:
- Move the `describe('PortAllocator', …)` block (3 tests) from `packages/cadre-host/src/__tests__/orchestrator-ports.test.ts` to a new `packages/cadre-provider/src/service/__tests__/port-allocator.test.ts`, next to the class.
- Keep the `allocateNodePorts` / `reusedNodePorts` tests in cadre-host as they are: they pin cadre-host's five-key order and the override rules through the wrapper cadre-host actually calls, and so cover `allocatePortSet`'s branching too. Don't copy them into provider.
- `orchestrator-port-leak.test.ts` reaches the deleted private `allocatePorts(2)` in the "range cannot satisfy the request" case. Replace that assertion with a check through the private `portAllocator` field using the new `has()`: after the failed create, `has(10000)` and `has(10001)` are both `false`. Update the `OrchestratorInternal` helper type accordingly.

# Edge cases & interactions

- **cadre-host resolves cadre-provider through `dist`.** Build it first: `yarn workspace @serfab/cadre-provider build`, then typecheck/test cadre-host. The stale-build guard will fail the cadre-host suite otherwise, which is the correct signal, not a flake. (cadre-provider is in this repo; building it is allowed. Sibling repos `../optimystic`, `../quereus`, `../Fret` are not.)
- **Port order preserved in both orchestrators** — verified by the existing `allocateNodePorts` order test (cadre-host) and by the provider's port-leak tests, which use a 3-port range where any order change or leak shows up as exhaustion.
- **Override inside the managed range** (cadre-host re-spawn reuse, owner `libp2pPort`) — reserved before allocation; covered by the existing `allocateNodePorts` override tests.
- **Partial failure mid-set** — the release-on-throw covers overrides as well as allocated ports; covered by the existing exhaustion tests in both packages.
- **Handle from an older `state.json` missing `ws`** — `reservePortSet`/`releasePortSet` must keep the "missing key is skipped" behaviour; that is `markUsed`'s integer check and `Set.delete` on `undefined`, unchanged. Covered by the existing `portsWithoutWs` tests.
- **Generic typing** — `allocatePortSet` returns `Record<K, number>`; check by inspection that no `as` cast is needed at the provider call site and only the existing one (or none) at `allocateNodePorts`.
- **Public export surface** — `PortAllocator`, `allocatePortSet`, `reservePortSet`, `releasePortSet` are exported from `@serfab/cadre-provider`'s root; cadre-host must not deep-import `@serfab/cadre-provider/dist/...` (the package `exports` map only exposes `.`).
- **Docs** — nothing in `docs/` names either allocator (grepped); no doc update expected. `packages/cadre-host/src/orchestrator/types.ts` ~line 49 mentions "the node-set helpers in `port-allocator.ts`", which remains true.

# TODO

- Create `packages/cadre-provider/src/service/port-allocator.ts` with `PortAllocator` (moved from cadre-host with its comments) and `allocatePortSet` / `reservePortSet` / `releasePortSet`; export all four from `packages/cadre-provider/src/index.ts`.
- Switch `docker-orchestrator.ts` to the shared module; delete its private class and the two private port methods; add `CONTAINER_PORT_KEYS` and type `containerPorts` from it.
- Update `orchestrator-port-leak.test.ts` to assert via `portAllocator.has()` instead of the deleted `allocatePorts`.
- Move the three `PortAllocator` unit tests to `packages/cadre-provider/src/service/__tests__/port-allocator.test.ts`.
- Reduce `packages/cadre-host/src/orchestrator/port-allocator.ts` to `NODE_PORT_KEYS` + the four node-set wrappers; import `PortAllocator` from `@serfab/cadre-provider` in it and in `host-process-orchestrator.ts`.
- `yarn workspace @serfab/cadre-provider build`, then run typecheck + tests for `@serfab/cadre-provider` and `@serfab/cadre-host`, and `yarn lint`.
