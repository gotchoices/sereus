description: Release host ports (and remove partial containers/labels) on every provisioning failure path in the Docker orchestrator and container service
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/__tests__/ (new test files)
----

`DockerOrchestrator` draws host ports from a bounded range (`10000-20000`, `config/types.ts:130-133`). Today those ports leak on failure, permanently shrinking the range until no container can be placed. Two coupled bugs cause it; this ticket makes allocation and release **balanced on every path**. Independent of the secure-default-auth ticket; can land in either order.

## Bug 1 — orchestrator allocates before it can guarantee release

`DockerOrchestrator.createContainer` allocates three ports (health, metrics, p2p) up front (`docker-orchestrator.ts:69-71`), but only records them in `containerPorts` *after* a successful `container.start()` (`:110-111`), and only ever releases them in `removeContainer` keyed off that map (`:131-144`). So any throw after `allocate()` — `docker.createContainer` rejecting, `container.start()` rejecting — leaks all three ports, and a created-but-unstarted container also leaves its name (`cadre-<id>`) and labels behind, blocking re-creation. There's even a partial-allocation leak inside the three `allocate()` calls themselves: if the range is nearly exhausted, the 1st/2nd succeed and the 3rd throws `No available ports`, leaking the first two.

**Design.** Make the orchestrator self-balancing: allocate atomically, and on any failure between allocation and the successful record, release the ports and best-effort remove any partially-created container.

Add helpers on `DockerOrchestrator`:

```ts
/** Allocate `count` ports atomically; release any already taken if one fails. */
private allocatePorts(count: number): number[] {
  const ports: number[] = [];
  try {
    for (let i = 0; i < count; i++) ports.push(this.portAllocator.allocate());
    return ports;
  } catch (err) {
    for (const p of ports) this.portAllocator.release(p);
    throw err;
  }
}

/** Release a set of ports (used by both the failure path and removeContainer). */
private releasePorts(ports: { health: number; metrics: number; p2p: number }): void {
  this.portAllocator.release(ports.health);
  this.portAllocator.release(ports.metrics);
  this.portAllocator.release(ports.p2p);
}
```

Restructure `createContainer` so the Docker calls run inside a `try` that releases on failure:

```ts
const [healthPort, metricsPort, p2pPort] = this.allocatePorts(3);
let container: Docker.Container | undefined;
try {
  container = await this.docker.createContainer({ /* ...unchanged... */ });
  await container.start();
} catch (err) {
  this.releasePorts({ health: healthPort, metrics: metricsPort, p2p: p2pPort });
  if (container) {
    // free the reserved name + labels left by a created-but-unstarted container
    try { await container.remove({ force: true }); }
    catch (rmErr) { log('Cleanup of partial container failed: %O', rmErr); }
  }
  throw err;
}
const dockerId = container.id;
this.containerPorts.set(dockerId, { health: healthPort, metrics: metricsPort, p2p: p2pPort });
// ...return result unchanged...
```

Refactor `removeContainer` to reuse `releasePorts`. The `pullImage()` call (only when `pullPolicy === 'always'`) already runs *before* allocation, so a pull failure leaks nothing — keep it before `allocatePorts`. Do **not** eat the original error: always rethrow after cleanup (cleanup failures are logged, never masked, per AGENTS.md "don't eat exceptions").

**Testability seam.** `DockerOrchestrator` currently does `new Docker(...)` in its constructor, leaving no way to inject a failing client. Add an optional second constructor parameter for the Docker client (defaulting to the real one) so tests can pass a fake:

```ts
constructor(config: DockerConfig, docker?: Docker) {
  this.config = config;
  this.docker = docker ?? new Docker({ socketPath: config.socketPath });
  // ...
}
```

(`server.ts:93` constructs `new DockerOrchestrator(config.docker)` — unchanged.)

## Bug 2 — container-service error path never reclaims orchestrator resources

`ContainerService.provisionContainer` (`container-service.ts:77-122`) calls `orchestrator.createContainer`, then `store.getContainer`, then mutates+saves, then `waitForEnrollment`. Two gaps:

1. **`if (!updated) return;` (`:97`)** — if the container record vanished after a *successful* `createContainer`, the method returns without removing the now-running container: its `dockerId` exists, ports are held, nothing reclaims them.
2. **The `catch` (`:112-121`)** records `status: 'error'` but performs no orchestrator cleanup. When the failure happened *after* a `dockerId` was obtained (e.g. `waitForEnrollment` throwing, or the post-create save failing), that container keeps running with its ports held.

With Bug 1 fixed, a throw *inside* `orchestrator.createContainer` self-cleans (no `dockerId` ever returned — nothing for the service to do). But once `createContainer` has returned a `dockerId`, ownership of cleanup passes to the service.

**Design.** Track the `dockerId` locally and reclaim on every non-success exit once it exists.

```ts
private async provisionContainer(container, request): Promise<void> {
  let dockerId: string | undefined;
  try {
    await this.updateStatus(container.id, 'creating');
    const result = await this.orchestrator.createContainer({ /* unchanged */ });
    dockerId = result.dockerId;

    const updated = await this.store.getContainer(container.id);
    if (!updated) {
      // Record vanished — reclaim the orchestrator resources we just created.
      await this.safeReclaim(dockerId);
      return;
    }
    // ...assign result fields, status 'enrolling', save...
    await this.waitForEnrollment(container.id, 60000);
  } catch (error) {
    log('Container %s provisioning error: %O', container.id, error);
    const updated = await this.store.getContainer(container.id);
    if (updated) { /* set status 'error', error message, save (unchanged) */ }
    if (dockerId) await this.safeReclaim(dockerId);
  }
}

/** Best-effort orchestrator removal; logs but never throws (we're already on an error/cleanup path). */
private async safeReclaim(dockerId: string): Promise<void> {
  try {
    await this.orchestrator.removeContainer(dockerId);
  } catch (err) {
    log('Failed to reclaim orchestrator resources for %s: %O', dockerId, err);
  }
}
```

`removeContainer` (not `stop` + `remove`) is sufficient here — it force-removes and releases ports in one call, and the container may never have reached "running". 

**Tradeoff (document in the review handoff):** removing an errored container discards its Docker logs. The priority per the ticket is reclaiming the bounded host-port resource, so full removal is the right default. Capturing logs before removal is a possible future enhancement, not in scope here.

## Key tests (add)

Use the injected-Docker seam for orchestrator tests and `MockOrchestrator`/a stub orchestrator for service tests.

- **Port release on `createContainer` failure (orchestrator):** fake Docker whose `createContainer` rejects → `orchestrator.createContainer(...)` rejects, and the ports are freed. Assert by using a tiny `portRange` (e.g. `start: 10000, end: 10002` — exactly 3 ports) and showing a *second* `createContainer` call (with a non-failing fake) still succeeds; without the fix it throws `No available ports`.
- **Port release + partial-container removal on `start` failure:** fake Docker whose `createContainer` resolves to an object with a `start` that rejects and a `remove` spy → orchestrator rejects, `remove({ force: true })` was called, ports freed (same tiny-range re-allocation check).
- **Partial allocation:** `portRange` of 2 ports, call into a path that needs 3 → rejects with `No available ports` and both allocated ports are released (a subsequent 2-port allocation succeeds).
- **Service reclaims on post-create failure:** stub orchestrator whose `createContainer` returns a `dockerId` but make `waitForEnrollment` path throw (e.g. orchestrator/`store` stub throws after create), and assert `orchestrator.removeContainer(dockerId)` was called and final status is `'error'`.
- **Service reclaims when record vanished:** stub `store.getContainer` to return the record once (initial save) then `undefined` after create → `orchestrator.removeContainer(dockerId)` called.
- **Happy path unchanged:** successful create → no `removeContainer`, ports recorded, status progresses to `enrolling`.

## TODO

- [ ] Add optional `docker?: Docker` constructor param to `DockerOrchestrator`.
- [ ] Add `allocatePorts`/`releasePorts` helpers; wrap `createContainer`'s Docker calls in try/catch that releases ports and best-effort-removes a partial container, then rethrows; refactor `removeContainer` to use `releasePorts`.
- [ ] Track `dockerId` locally in `ContainerService.provisionContainer`; add `safeReclaim`; reclaim on the `if (!updated)` early-return and in the `catch`.
- [ ] Add the orchestrator and service tests above.
- [ ] Run `yarn workspace @serfab/cadre-provider build` and `yarn workspace @serfab/cadre-provider test`; ensure type-check + tests pass. Stream output with `| tee`.
