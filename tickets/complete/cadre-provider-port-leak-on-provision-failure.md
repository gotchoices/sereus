description: Host ports + partial containers/labels are released on every provisioning failure path in the Docker orchestrator and container service
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/src/service/__tests__/container-provision-cleanup.test.ts
----

## What shipped

`DockerOrchestrator` draws host ports from a bounded range (`10000-20000`). Two coupled bugs that leaked ports on provisioning failure are fixed so allocation and release are balanced on every path.

- **Orchestrator (`docker-orchestrator.ts`)** — optional injectable `docker?: Docker` ctor param; `allocatePorts(count)` (atomic, releases partials on failure); `releasePorts(...)` shared by the failure path and `removeContainer`; `createContainer` wraps `docker.createContainer(...)` + `container.start()` in a `try` that, on throw, releases the ports and best-effort force-removes a partially-created container, then rethrows. `pullImage()` still runs before allocation.
- **Container service (`container-service.ts`)** — `provisionContainer` tracks `dockerId` from the create result; `safeReclaim(dockerId)` (best-effort `removeContainer`, logs, never throws) runs on the record-vanished early-return and in the catch.

## Review findings

**Implementation diff reviewed first (`git show 488778f`), then the handoff.** Build, lint, and tests all green.

### Validation run
- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc clean).
- `yarn lint` → 0 errors, 123 warnings. The only warnings in the touched files are two pre-existing `any` casts in `getStats` (`docker-orchestrator.ts:189-190`), outside this diff. No new lint debt introduced.
- `yarn workspace @serfab/cadre-provider test` → **38 passed (7 files)** (was 37; +1 added this pass).

### Aspects scrutinized
- **Resource cleanup / balance (core of the ticket)** — every `createContainer` exit path verified: pull-failure (pre-allocation, nothing held), port-range-exhausted (partials released), `docker.createContainer` throw (ports released, no partial container), `start()` throw (ports released + partial force-removed), success (ports recorded). Service paths: create-throws (orchestrator self-cleans, no service reclaim), record-vanished (reclaim), post-create step throws (reclaim), success (no reclaim). **Balanced. No leak found.**
- **No double-free** — ports allocated in `createContainer` live in locals until the success record writes them to `containerPorts`; the internal catch releases the locals directly. The service only reclaims once `createContainer` *returns* a `dockerId`, and an internal throw self-cleans — the two cleanup owners never overlap. Confirmed.
- **Error handling** — original errors are rethrown, cleanup failures logged not masked (honors AGENTS.md "don't eat exceptions"). `safeReclaim` correctly swallows-with-log since it runs on an already-failing path.
- **Type safety** — `allocatePorts(3) as [number, number, number]` tuple cast is local and safe for the fixed `count: 3` call site.
- **SPP / DRY / modular** — `allocatePorts`/`releasePorts` are small single-purpose helpers; `releasePorts` is shared by both release sites. Good.
- **Callers** — `server.ts:93` (`new DockerOrchestrator(config.docker)`) unaffected by the optional second ctor param. No other construction sites.
- **Docs** — `packages/cadre-provider/README.md` is high-level (config/usage) and makes no claim about port-allocation or cleanup internals, so nothing there contradicts the new behavior. No doc update warranted.

### Found & fixed inline (minor)
- **Missing regression guard on the `if (dockerId)` reclaim guard.** No test proved that when `orchestrator.createContainer` *itself* throws (the common case where no `dockerId` is ever produced), the service does **not** call `removeContainer(undefined)`. That guard is load-bearing — a future refactor moving the `dockerId` assignment could regress into a spurious `safeReclaim(undefined)`. Added `does not reclaim when the orchestrator create itself fails` to `container-provision-cleanup.test.ts` (asserts no `removeContainer`, status `error`, message propagated). Tests now 38.

### Considered, deemed acceptable (no action)
- **`removeContainer` does not release ports if `docker.remove` throws.** `removeContainer` removes first, then releases ports — if the remove rejects, the `containerPorts` entry persists. This is the service's reclaim path now, so it's a residual unbalanced edge. Judged acceptable: if the OS-level remove genuinely failed, the container may still hold the OS ports, and freeing the allocator entry would risk handing a still-bound port to the next container (a worse failure). Pre-existing ordering, unchanged by this diff.
- **A store write failing exactly on the `running` status update would let the reclaim destroy a healthy container.** Requires `waitForEnrollment`'s `updateStatus('running')` to throw; `waitForEnrollment` otherwise never throws (it swallows fetch errors and returns on timeout). Low-probability and consistent with the documented "reclaim the bounded port resource is the priority" trade-off.

### Carried forward from the implementer's honest notes (still accurate, out of scope)
- Tests use injected fakes, not a live daemon — real `dockerode` shapes are unvalidated; a real-network test under `integration-tests/` would be a stronger floor.
- **Enrollment *timeout* is intentionally not a reclaim path** — `waitForEnrollment` logs and returns on the 60s timeout; the container stays `enrolling` with ports legitimately held (it *is* running) until `terminateContainer`. If "timeout ⇒ error + reclaim" is desired, that's a separate follow-up (trades off keeping an unhealthy container for debugging).
- `safeReclaim` force-removes errored containers, discarding their Docker logs — log capture before removal is a possible future enhancement.
- `PortAllocator` is not guarded against concurrent allocation/release; provisioning is assumed serial per container. Pre-existing.

No major findings — no new fix/plan/backlog tickets filed.
