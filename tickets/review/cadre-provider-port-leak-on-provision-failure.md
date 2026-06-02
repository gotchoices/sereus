description: Review — host ports + partial containers/labels are now released on every provisioning failure path in the Docker orchestrator and container service
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-provider/src/service/__tests__/container-provision-cleanup.test.ts
----

## What changed

`DockerOrchestrator` draws host ports from a bounded range (`10000-20000`). Before this change those ports leaked on any provisioning failure, permanently shrinking the range. Two coupled bugs were fixed so allocation and release are now **balanced on every path**.

### Bug 1 — orchestrator (`docker-orchestrator.ts`)

- Added optional 2nd constructor param `docker?: Docker` (defaults to `new Docker({ socketPath })`) so tests can inject a fake. `server.ts:93` (`new DockerOrchestrator(config.docker)`) is unchanged.
- Added `allocatePorts(count)` — allocates atomically, releasing any already-taken ports if a later `allocate()` throws (fixes the partial-allocation leak when the range is nearly exhausted).
- Added `releasePorts({health,metrics,p2p})`, reused by both the failure path and `removeContainer`.
- `createContainer` now allocates the 3 ports, then runs `docker.createContainer(...)` + `container.start()` inside a `try`. On any throw it releases the ports and best-effort `container.remove({ force: true })` (frees the reserved `cadre-<id>` name + labels left by a created-but-unstarted container), then **rethrows** the original error. Cleanup failures are logged, never masked (per AGENTS.md "don't eat exceptions").
- The `pullImage()` call (only when `pullPolicy === 'always'`) still runs **before** allocation, so a pull failure leaks nothing.

### Bug 2 — container service (`container-service.ts`)

- `provisionContainer` now tracks `dockerId` locally (set from `result.dockerId` immediately after a successful `createContainer`).
- Added `safeReclaim(dockerId)` — best-effort `orchestrator.removeContainer`, logs but never throws (it runs on error/cleanup paths).
- Reclaim is invoked in two new spots: the `if (!updated) return` early-return (record vanished after a successful create) and the `catch` (any post-create failure, e.g. the enrolling save or a later step). Once `createContainer` returns a `dockerId`, cleanup ownership belongs to the service; a throw *inside* `createContainer` self-cleans (Bug 1) so nothing leaks there.

## How to validate

Build + tests pass:
- `yarn workspace @serfab/cadre-provider build` → exit 0 (tsc clean).
- `yarn workspace @serfab/cadre-provider test` → **37 passed (7 files)**.

New tests:

**`orchestrator-port-leak.test.ts`** (injected fake Docker, tiny port ranges so a single leak is observable):
- `createContainer` rejects → ports freed (a 2nd non-failing create in an exactly-3-port range still succeeds; without the fix it throws `No available ports in range`).
- `start()` rejects → `remove({ force: true })` called on the partial container **and** ports freed (retry succeeds).
- 2-port range but 3 ports needed → rejects `No available ports in range`, Docker never called, both briefly-taken ports released (a subsequent `allocatePorts(2)` does not throw).
- Happy path → endpoints returned, no `remove`, and the 3 ports stay held/recorded (next create exhausts the range).

**`container-provision-cleanup.test.ts`** (`MemoryStore` subclasses + stub orchestrator with spies):
- Post-create step fails (enrolling save throws) → `removeContainer('docker-xyz')` called, final status `error`, message propagated.
- Record vanishes after create (`getContainer` returns `undefined` post-create) → `removeContainer('docker-xyz')` called.
- Successful provision → `removeContainer` **not** called, status reaches `running`, `dockerId` persisted.

## Known gaps / honest notes for the reviewer

- **Tests use fakes, not real Docker.** The injected-Docker seam exercises the control flow and error handling, but real `dockerode` return/error shapes are not validated against a live daemon. Treat the unit tests as a floor; a real-network integration test (under `integration-tests/`) would be a stronger guarantee and is not included here.
- **Enrollment *timeout* is intentionally not a reclaim path.** `waitForEnrollment` swallows fetch errors and, on the 60s timeout, only logs and returns — it does **not** throw, set `error`, or reclaim. So a container that starts but never reports healthy stays in `enrolling` with its ports legitimately held (it *is* running; `terminateContainer` later releases them). This is pre-existing behavior and out of scope for this port-*leak* ticket, but flagging it: if the desired semantics are "timeout ⇒ error + reclaim", that's a follow-up (and it trades off keeping an unhealthy container around for debugging).
- **Tradeoff — errored containers are fully removed, discarding their Docker logs.** `safeReclaim` uses `removeContainer` (force-remove + port release in one call), chosen because reclaiming the bounded host-port resource is the priority and the container may never have reached "running". Capturing logs before removal is a possible future enhancement, not done here.
- **Tuple cast.** `allocatePorts(3) as [number, number, number]` assumes exactly 3 elements (safe for the fixed `count: 3` call site). Not generalized.
- **Concurrency.** `PortAllocator` is not guarded against concurrent allocation/release races; provisioning is assumed serial per container. Pre-existing, unchanged, out of scope.
