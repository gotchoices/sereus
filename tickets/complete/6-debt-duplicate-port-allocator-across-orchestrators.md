description: Two of our node managers each kept their own private copy of the same "which network ports are in use" tracker; it now lives in one shared place both use, with no change to which ports anything gets.
files: packages/cadre-provider/src/service/port-allocator.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/src/service/__tests__/port-allocator.test.ts, packages/cadre-host/src/orchestrator/port-allocator.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-ports.test.ts
difficulty: easy
----

# What changed

- `packages/cadre-provider/src/service/port-allocator.ts` (new) holds the single `PortAllocator` class plus generic `allocatePortSet` (all-or-nothing, overrides reserved first, with the trusted-override `NOTE:`), `reservePortSet` and `releasePortSet`. All four are exported from the `@serfab/cadre-provider` root.
- The provider's `DockerOrchestrator` dropped its private allocator and its `allocatePorts` / `releasePorts` helpers. It now uses `CONTAINER_PORT_KEYS = ['health','metrics','p2p']` with the shared set functions.
- cadre-host's `orchestrator/port-allocator.ts` keeps only `NODE_PORT_KEYS` (`as const satisfies readonly (keyof NodePorts)[]`), thin `allocateNodePorts` / `reserveNodePorts` / `releaseNodePorts` wrappers, and `reusedNodePorts`. `host-process-orchestrator.ts` imports `PortAllocator` from `@serfab/cadre-provider`.
- Intended behaviour changes in the provider: an invalid `portRange` now throws at construction, and the exhaustion message now names the range.

# Tests

- The three `PortAllocator` unit tests moved from cadre-host to `packages/cadre-provider/src/service/__tests__/port-allocator.test.ts`.
- The provider port-leak test now checks `portAllocator.has()` directly, because the private `allocatePorts` it called is gone.

# Review findings

Read the diff from `ticket(implement): debt-duplicate-port-allocator-across-orchestrators` before the handoff.

- **Correctness / regressions:** Allocation order is unchanged in both orchestrators: the provider keeps health, metrics, p2p and cadre-host keeps its five-key order. Rollback on partial failure and release on remove or failure are the same as before. The provider's `containerPorts` now holds the object returned by `allocatePortSet`. Nothing else keeps a reference to that object, so sharing it is safe. None found.
- **Type safety:** `allocatePortSet` infers `K` from the readonly tuple. The cadre-host wrapper's return fails to compile if `NodePorts` gains a key that is not in `NODE_PORT_KEYS`, and the `satisfies` catches the reverse case. No casts at the call sites. None found.
- **Behaviour change (throw on bad range):** Every provider test config and the defaults (10000..20000) are valid ranges, and failing at construction is better than failing on every allocation. Accepted as intended.
- **Comment hygiene (minor, fixed):** The comment on `CONTAINER_PORT_KEYS` in `docker-orchestrator.ts` described the key order by pointing at the deleted `allocatePorts(3)` destructure. I rewrote it to say why the order matters: reordering changes which host port each key gets, so a new key goes on the end.
- **Tests:** The moved `PortAllocator` tests cover real branching (exhaustion, reuse, rejecting non-integers in `markUsed`), so I kept them. The port-leak test change was forced by the removed private method and still checks that ports are released. I added no tests: cadre-host's existing node-set tests already cover the branching in `allocatePortSet`.
- **Docs:** No file in `docs/` names either allocator. The cadre-host `orchestrator/types.ts` comment that points to the node-set helpers in `port-allocator.ts` is still accurate. No update needed.
- **Resource cleanup / performance / error handling:** Allocation is the same linear scan with the same release paths. No change and none found.
- **Known follow-up (already tracked):** The provider still does not rebuild its used-port set on restart. That work is `bug-provider-port-allocator-forgets-live-ports-on-restart`, which can now call `reservePortSet(this.portAllocator, CONTAINER_PORT_KEYS, …)`. I filed no new ticket.
- **Validation:** Ran typecheck, build and test for `@serfab/cadre-provider` (29 files, 225 passed), typecheck and test for `@serfab/cadre-host` (69 files, 663 passed, 4 pre-existing skips), and `yarn lint` (exit 0).
