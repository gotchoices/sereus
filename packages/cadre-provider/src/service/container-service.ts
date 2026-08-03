/**
 * Container lifecycle management service.
 */

import debug from 'debug';
import { nanoid } from 'nanoid';
import type {
  Container,
  ContainerStatus,
  CreateContainerRequest,
  ContainerStatusResponse,
} from '../types.js';
import type { ProviderStore } from './store.js';
import type { ContainerRunState, RecoverableOrchestrator } from './orchestrator.js';
import type { ProviderPushConfig, PushCredentials } from '../config/types.js';
import { fetchContainerHealthStatus } from './container-health.js';

const log = debug('cadre:provider:container');

/** How long a freshly-created container has to report healthy before the wait gives up. */
export const CONTAINER_ENROLLMENT_TIMEOUT_MS = 60_000;

/** How often the enrollment wait re-reads the container's `/status`. */
export const CONTAINER_ENROLLMENT_POLL_MS = 2_000;

/** Lines of container log tailed into the operator's debug log when enrollment fails. */
const ENROLLMENT_FAILURE_LOG_LINES = 50;

/**
 * Age past which a `pending` / `creating` / `stopping` record is treated as
 * abandoned by a provider that died mid-flight. Generous compared with
 * cadre-host's 5 minutes because `creating` spans an orchestrator call that can
 * include a Docker image pull (`pullPolicy: 'always'`) over a slow link — and
 * the record is not touched during that pull, so the TTL is the only thing
 * standing between a slow pull and a false reap of a provision that is genuinely
 * still in flight.
 */
export const CONTAINER_PROVISIONING_TTL_MS = 15 * 60 * 1000;

/**
 * Age past which an `enrolling` record is no longer owned by an in-process
 * `waitForEnrollment` (which gives up after `CONTAINER_ENROLLMENT_TIMEOUT_MS`),
 * so the sweep may resolve it without two writers racing on the same record.
 */
export const CONTAINER_ENROLLMENT_TTL_MS = 5 * 60 * 1000;

/** How often the reap sweep runs while the provider is up. */
export const CONTAINER_REAP_SWEEP_MS = 5 * 60 * 1000;

/**
 * Restarts tolerated during enrollment before the wait calls it a crash loop.
 * `DockerOrchestrator` runs tenant nodes under `RestartPolicy: unless-stopped`
 * precisely so a transient first-boot failure recovers by itself, so one restart
 * is the policy working; a second inside the same enrollment window is a loop.
 */
const ENROLLMENT_TOLERATED_RESTARTS = 1;

/** The container's process is down right now and has already exited at least once. */
function isChildDown(state: ContainerRunState): boolean {
  return !state.running && state.exitedAt !== undefined;
}

/**
 * Whether the orchestrator's readings prove the container's process is gone for
 * good — judged across two consecutive polls, not one.
 *
 * One reading cannot separate "crashed once and is booting again" from "crash
 * looping": under `unless-stopped` both report `restartCount > 0` and a finish
 * time, and a node takes several polls to come up, so it reads unhealthy in
 * between either way. Two readings can — a restart count past the tolerated one
 * is a loop, and a container that was down-and-exited a poll ago and still is
 * (the only state a never-restarting orchestrator can reach) will not come back.
 */
function hasChildDied(state: ContainerRunState, previous: ContainerRunState | undefined): boolean {
  if (state.restartCount > ENROLLMENT_TOLERATED_RESTARTS) return true;
  return isChildDown(state) && previous !== undefined && isChildDown(previous);
}

/**
 * The same two signals as {@link hasChildDied}, judged on ONE reading — for the
 * reap sweep, which sees a single reading every few minutes and has no previous
 * one to compare against.
 *
 * Sound there precisely because the record has already sat on `enrolling` past
 * its TTL: the "crashed once and is booting again" case {@link hasChildDied}
 * protects has had minutes to come back and has not, so a down-and-exited
 * reading now is the end state rather than a moment inside a restart.
 */
function isChildGone(state: ContainerRunState): boolean {
  return state.restartCount > ENROLLMENT_TOLERATED_RESTARTS || isChildDown(state);
}

/** The one wording for "this container's process died on us", used by the wait and the sweep. */
function childDiedMessage(state: ContainerRunState): string {
  return `container process exited during enrollment (restarts=${state.restartCount}, exitCode=${state.exitCode ?? 'unknown'})`;
}

/**
 * Age past which a record in this status is nobody's responsibility any more,
 * or `undefined` for a status the sweep never touches. `running` is watched by
 * billing, `stopped`/`error` are terminal, and everything else is either an
 * in-flight call's to finish or an abandoned record's to be reaped.
 */
function reapTtlMsFor(status: ContainerStatus): number | undefined {
  switch (status) {
    case 'pending':
    case 'creating':
    case 'stopping':
      return CONTAINER_PROVISIONING_TTL_MS;
    case 'enrolling':
      return CONTAINER_ENROLLMENT_TTL_MS;
    default:
      return undefined;
  }
}

/** Whether this record is in a reapable status AND has sat there past that status's TTL. */
function isStuck(container: Container, nowMs: number): boolean {
  const ttlMs = reapTtlMsFor(container.status);
  return ttlMs !== undefined && nowMs - container.updatedAt.getTime() >= ttlMs;
}

/**
 * Resolve the push credentials for ONE tenant: the per-tenant override keyed by
 * `customerId`, else the provider-level default, else none. This is the single
 * cross-tenant boundary — a tenant only ever sees its own override or the shared
 * default, never another tenant's override.
 */
export function resolveTenantPush(
  push: ProviderPushConfig | undefined,
  customerId: string,
): PushCredentials | undefined {
  if (!push) return undefined;
  return push.tenants?.[customerId] ?? push.default;
}

/**
 * Normalize the tenant-supplied seed-trust anchors to exactly what the node will
 * end up honouring: trimmed, empties dropped, deduped — the same reduction
 * `cadre-cli`'s `collectPinnedOwnerKeys` applies to `CADRE_OWNER_KEYS`. Returns a
 * fresh array, so a later mutation of the caller's array cannot rewrite what the
 * record says the node was told to trust.
 *
 * A request that arrived through `POST /containers` never reaches here with a blank
 * or malformed entry — `validatePinnedOwnerKeys` (`server/owner-key-validation.ts`) answers 400
 * first, including for `[""]`, which a caller only sends by mistake (trusting nobody
 * is spelled by omitting the field). This filter therefore stands as the guard for
 * *direct* `ContainerService` callers, which have no route in front of them.
 */
function normalizePinnedOwnerKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).map(key => key.trim()).filter(key => key.length > 0))];
}

/** Container service options */
export interface ContainerServiceOptions {
  /** Store for persisting container state */
  store: ProviderStore;
  /** Container orchestrator (Docker, K8s, etc.) */
  orchestrator: RecoverableOrchestrator;
  /**
   * Per-tenant push (FCM/APNs) credentials. Resolved by `customerId` at provision
   * time and injected into that tenant's node only. Omit to disable push.
   */
  push?: ProviderPushConfig;
  /** Override the enrollment give-up window; defaults to `CONTAINER_ENROLLMENT_TIMEOUT_MS`. */
  enrollmentTimeoutMs?: number;
  /** Override the enrollment poll interval; defaults to `CONTAINER_ENROLLMENT_POLL_MS`. */
  enrollmentPollMs?: number;
  /**
   * Clock override, so a reap TTL can be tested by handing the service a date
   * rather than by moving wall-clock time or faking timers.
   */
  now?: () => Date;
}

/**
 * Service for managing container lifecycle.
 * Handles creation, status monitoring, and termination.
 */
export class ContainerService {
  private readonly store: ProviderStore;
  private readonly orchestrator: RecoverableOrchestrator;
  private readonly push?: ProviderPushConfig;
  private readonly enrollmentTimeoutMs: number;
  private readonly enrollmentPollMs: number;
  private readonly now: () => Date;
  private reapInterval?: ReturnType<typeof setInterval>;
  /** A sweep that inspects many containers can outlast its interval; one at a time. */
  private sweeping = false;

  constructor(options: ContainerServiceOptions) {
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.push = options.push;
    this.enrollmentTimeoutMs = options.enrollmentTimeoutMs ?? CONTAINER_ENROLLMENT_TIMEOUT_MS;
    this.enrollmentPollMs = options.enrollmentPollMs ?? CONTAINER_ENROLLMENT_POLL_MS;
    this.now = options.now ?? (() => new Date());
    log('ContainerService initialized');
  }

  /** Generate a unique container ID */
  private generateId(): string {
    return `ctr_${nanoid(16)}`;
  }

  /** Create a new container */
  async createContainer(request: CreateContainerRequest): Promise<Container> {
    const id = this.generateId();
    const now = new Date();

    log('Creating container %s for customer %s', id, request.customerId);

    const pinnedOwnerKeys = normalizePinnedOwnerKeys(request.pinnedOwnerKeys);
    const container: Container = {
      id,
      customerId: request.customerId,
      partyId: request.partyId,
      profile: request.profile,
      status: 'pending',
      resources: request.resources ?? {},
      tags: request.tags ?? {},
      createdAt: now,
      updatedAt: now,
      ...(pinnedOwnerKeys.length ? { pinnedOwnerKeys } : {}),
    };

    // Save initial state
    await this.store.saveContainer(container);

    // Start provisioning asynchronously
    this.provisionContainer(container, request).catch(err => {
      log('Provisioning failed for %s: %O', id, err);
    });

    return container;
  }

  /** Provision the container via orchestrator */
  private async provisionContainer(
    container: Container,
    request: CreateContainerRequest
  ): Promise<void> {
    // Once the orchestrator hands back a dockerId, this service owns cleanup of
    // those resources (bounded host ports) on every non-success exit.
    let dockerId: string | undefined;
    try {
      // Update status to creating
      await this.updateStatus(container.id, 'creating');

      // Resolve push strictly by the OWNING tenant's id — never another tenant's.
      const push = resolveTenantPush(this.push, container.customerId);

      // Seed-trust anchors come from THIS tenant's own create request and nowhere
      // else — same one-tenant-in, one-tenant-out discipline as push above, but
      // with no default tier at all: a provider-wide pin would let one tenant's
      // owner seed another tenant's node. Read off the record (normalized at
      // create time), so the stored field is the single authority on what the
      // node was told to trust and a future re-provision from the record alone
      // reproduces the same pins.
      const pinnedOwnerKeys = container.pinnedOwnerKeys ?? [];
      if (pinnedOwnerKeys.length === 0) {
        // Not an error — a container may legitimately be created before its owner
        // key is known. But it will refuse every seed until recreated, so make the
        // eventual refusal traceable to the create call that caused it.
        log('Container %s created with no pinned owner keys; it will reject any seed delivered to it', container.id);
      }

      // Create the container via orchestrator
      const result = await this.orchestrator.createContainer({
        containerId: container.id,
        partyId: request.partyId,
        bootstrapNodes: request.bootstrapNodes,
        profile: request.profile,
        resources: request.resources,
        strandFilter: request.strandFilter,
        ...(push ? { push } : {}),
        ...(pinnedOwnerKeys.length ? { pinnedOwnerKeys } : {}),
      });
      dockerId = result.dockerId;

      // Update with orchestrator details
      const updated = await this.store.getContainer(container.id);
      if (!updated) {
        // Record vanished after a successful create — reclaim the orchestrator
        // resources we just allocated so the host port range does not leak.
        await this.safeReclaim(dockerId);
        return;
      }

      updated.dockerId = result.dockerId;
      updated.healthEndpoint = result.healthEndpoint;
      updated.metricsEndpoint = result.metricsEndpoint;
      updated.seedEndpoint = result.seedEndpoint;
      updated.seedToken = result.seedToken;
      updated.status = 'enrolling';
      updated.updatedAt = new Date();
      await this.store.saveContainer(updated);

      log('Container %s provisioned, waiting for enrollment', container.id);

      // Wait for enrollment (health check shows healthy). Throws when the
      // container's process is found dead — the catch below records the failure
      // and reclaims, so there is exactly one failure path.
      await this.waitForEnrollment(container.id);

    } catch (error) {
      log('Container %s provisioning error: %O', container.id, error);
      const updated = await this.store.getContainer(container.id);
      if (updated) {
        updated.status = 'error';
        updated.error = error instanceof Error ? error.message : String(error);
        updated.updatedAt = new Date();
        await this.store.saveContainer(updated);
      }
      // If a container was created before the failure, reclaim it — otherwise it
      // keeps running with its host ports held.
      if (dockerId) await this.safeReclaim(dockerId);
    }
  }

  /** Best-effort orchestrator removal; logs but never throws (already on an error/cleanup path). */
  private async safeReclaim(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.removeContainer(dockerId);
    } catch (err) {
      log('Failed to reclaim orchestrator resources for %s: %O', dockerId, err);
    }
  }

  /** Best-effort stop; logs but never throws (cleanup path — `safeReclaim` follows regardless). */
  private async safeStop(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.stopContainer(dockerId);
    } catch (err) {
      log('Failed to stop container %s: %O', dockerId, err);
    }
  }

  /**
   * Wait for a freshly-created container to report healthy.
   *
   * Throws when the container's own process is found dead, so `provisionContainer`'s
   * catch records the failure and reclaims; returns normally when the container
   * enrolled, when the record went away, or when the window ran out on a node
   * that is merely slow.
   */
  private async waitForEnrollment(containerId: string): Promise<void> {
    const startTime = Date.now();
    /** Last liveness reading, so death is judged on a trend rather than one sample. */
    let previousRunState: ContainerRunState | undefined;

    while (Date.now() - startTime < this.enrollmentTimeoutMs) {
      const container = await this.store.getContainer(containerId);
      // The record entered this loop as 'enrolling' and only this loop promotes
      // it. Anything else — gone, failed, or a concurrent DELETE that moved it to
      // 'stopping'/'stopped' — means someone else now owns its fate. Bailing here
      // also keeps the liveness probe below from reading a deliberate teardown
      // (stop, then remove) as a crash.
      if (container?.status !== 'enrolling') return;

      if (await this.enrollIfHealthy(container)) return;

      // Health is read FIRST on purpose: a container that crashed once and came
      // back healthy must still enrol. Only an unhealthy read asks whether the
      // process behind it is even alive.
      // NOTE: one extra orchestrator inspect per poll per enrolling container,
      // bounded by the enrollment window. If many simultaneous provisions ever
      // become normal, probe every Nth poll instead of every poll.
      if (container.dockerId) {
        previousRunState = await this.checkChildAlive(containerId, container.dockerId, previousRunState);
      }

      await new Promise(resolve => setTimeout(resolve, this.enrollmentPollMs));
    }

    // The timeout leaves the record on 'enrolling' — deliberately, for a container
    // whose process is alive and simply not healthy yet (a dead child fails
    // above), because 'enrolling' stays seedable (`applySeed` accepts it) so a
    // merely-slow node still works. `reapStuckContainers` picks the record up
    // from here once CONTAINER_ENROLLMENT_TTL_MS has passed: it enrols a node
    // that came good late, and terminalizes one whose child is gone.
    log('Container %s enrollment timeout', containerId);
  }

  /**
   * Promote a container that reports healthy to `running`, recording the peerId
   * the same `/status` read carries. Shared by the enrollment wait and the reap
   * sweep, so "what enrolling successfully means" is written exactly once.
   *
   * Reads `/status` rather than `/health`: it reports the same `status` field and
   * additionally carries the node's `peerId`. `fetchContainerHealthStatus`
   * swallows unreachable/non-OK responses, so a node that is still starting
   * simply answers "not yet".
   *
   * @returns whether the container enrolled.
   */
  private async enrollIfHealthy(container: Container): Promise<boolean> {
    const health = await fetchContainerHealthStatus(container);
    if (health?.status !== 'healthy') return false;

    // peerId is durable for the life of the container's volume, so the first
    // healthy report is authoritative; it is absent only if the node reports
    // healthy before acquiring a libp2p identity.
    // NOTE: nothing backfills it afterwards. Harmless while every consumer of
    // peerId reads live `/status` (`getPeerInfo`); if the stored field ever
    // becomes a read path of its own, add a backfill on the next status read.
    await this.updateStatus(container.id, 'running', health.peerId ? { peerId: health.peerId } : undefined);
    log('Container %s is now running (peer %s)', container.id, health.peerId ?? 'unknown');
    return true;
  }

  /**
   * Throw when this reading and the previous one together prove the container's
   * process has died; otherwise hand the reading back to become the next poll's
   * `previous`.
   */
  private async checkChildAlive(
    containerId: string,
    dockerId: string,
    previous: ContainerRunState | undefined,
  ): Promise<ContainerRunState | undefined> {
    const state = await this.probeRunState(containerId, dockerId);
    if (!state || !hasChildDied(state, previous)) return state;

    await this.logContainerTail(containerId, dockerId);
    throw new Error(childDiedMessage(state));
  }

  /**
   * The orchestrator's current reading of the container's process.
   *
   * `undefined` for every ambiguous answer, which keeps the caller waiting and
   * discards the accumulated evidence: an orchestrator with no `inspectRunState`,
   * a container the orchestrator no longer knows (a concurrent terminate removed
   * it), or a probe that failed — a Docker API blip must not fail an otherwise
   * fine provision.
   */
  private async probeRunState(containerId: string, dockerId: string): Promise<ContainerRunState | undefined> {
    try {
      return await this.orchestrator.inspectRunState?.(dockerId);
    } catch (err) {
      log('Container %s liveness probe failed (still waiting): %O', containerId, err);
      return undefined;
    }
  }

  /**
   * Tail the dead container's own output into the operator's debug log — the
   * only view of *why* the node died. Deliberately not stored on the record:
   * it is tenant output, and the record is provider-side metadata.
   */
  private async logContainerTail(containerId: string, dockerId: string): Promise<void> {
    try {
      const logs = await this.orchestrator.getLogs(dockerId, ENROLLMENT_FAILURE_LOG_LINES);
      log('Container %s died during enrollment; last output:\n%s', containerId, logs);
    } catch (err) {
      log('Container %s died during enrollment; logs unavailable: %O', containerId, err);
    }
  }

  /** Update container status, optionally stamping additional fields in the same save. */
  private async updateStatus(
    id: string,
    status: ContainerStatus,
    patch?: Partial<Container>
  ): Promise<void> {
    const container = await this.store.getContainer(id);
    if (!container) return;
    if (patch) Object.assign(container, patch);
    container.status = status;
    container.updatedAt = new Date();
    await this.store.saveContainer(container);
  }

  /** Get container by ID */
  async getContainer(id: string): Promise<Container | undefined> {
    return this.store.getContainer(id);
  }

  /** Get detailed container status including health */
  async getContainerStatus(id: string): Promise<ContainerStatusResponse | undefined> {
    const container = await this.store.getContainer(id);
    if (!container) return undefined;

    const response: ContainerStatusResponse = { container };

    // Fetch live `/status` for running containers. The shared helper derives the
    // `/status` URL, short-circuits to `undefined` when there is no health
    // endpoint / the fetch fails / the response is non-OK, and parses into the
    // wire-accurate ContainerHealthStatus — so the declared type stays honest.
    if (container.status === 'running') {
      response.health = await fetchContainerHealthStatus(container);
    }

    return response;
  }

  /** List containers, optionally filtered by customer */
  async listContainers(customerId?: string): Promise<Container[]> {
    return this.store.listContainers(customerId);
  }

  /** Terminate a container */
  async terminateContainer(id: string): Promise<boolean> {
    const container = await this.store.getContainer(id);
    if (!container) return false;

    log('Terminating container %s', id);

    try {
      await this.updateStatus(id, 'stopping');

      if (container.dockerId) {
        await this.stopAndRemove(container.dockerId);
      }

      await this.updateStatus(id, 'stopped');
      log('Container %s terminated', id);
      return true;
    } catch (error) {
      log('Container %s termination error: %O', id, error);
      const updated = await this.store.getContainer(id);
      if (updated) {
        // NOTE: the record stops counting against the customer's plan here (see
        // QUOTA_CONSUMING_STATUSES) while its container may still be up — the
        // stop or remove is what just failed. Same trade the reap makes
        // deliberately: quota is generous to the tenant rather than exact. If
        // provider quota ever has to be exact, this is the site to revisit.
        updated.status = 'error';
        updated.error = error instanceof Error ? error.message : String(error);
        updated.updatedAt = new Date();
        await this.store.saveContainer(updated);
      }
      return false;
    }
  }

  /**
   * Stop and remove one container, treating "the orchestrator no longer has it"
   * as the desired end state rather than a failure.
   *
   * Every path that writes `status: 'error'` reclaims the container first but
   * leaves `dockerId` on the record, so a tenant who then issues
   * `DELETE /containers/:id` sends us at a handle Docker answers 404 for. Without
   * this, that record could never reach `stopped` — and before the quota rules
   * changed, that meant a slot no tenant action could release.
   *
   * Genuine failures (daemon unreachable, a container that is still there and
   * would not stop) rethrow onto the caller's error path. `inspectRunState` is
   * the seam: only a handle the orchestrator affirmatively does not know is
   * forgiven, and an orchestrator that cannot answer is treated as "still there".
   */
  private async stopAndRemove(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.stopContainer(dockerId);
      await this.orchestrator.removeContainer(dockerId);
    } catch (err) {
      if (await this.orchestratorKnows(dockerId)) throw err;
      log('Container handle %s is already gone; treating removal as done: %O', dockerId, err);
    }
  }

  /**
   * Whether the orchestrator still knows this handle. `true` whenever it cannot
   * say — no `inspectRunState`, or a probe that itself failed — because an
   * unanswerable question must never be read as "the container is gone".
   */
  private async orchestratorKnows(dockerId: string): Promise<boolean> {
    if (!this.orchestrator.inspectRunState) return true;
    try {
      return (await this.orchestrator.inspectRunState(dockerId)) !== undefined;
    } catch (err) {
      log('Could not confirm whether %s still exists; assuming it does: %O', dockerId, err);
      return true;
    }
  }

  /**
   * Start the periodic sweep for container records the provider abandoned
   * mid-flight, and run one immediately — records recovered from disk at startup
   * are the whole reason the sweep exists, so they must not wait a full interval.
   *
   * Idempotent; pair with {@link stopReaper}. A leaked interval keeps the
   * process (and a test runner) alive after shutdown.
   */
  startReaper(intervalMs: number = CONTAINER_REAP_SWEEP_MS): void {
    if (this.reapInterval) return;
    this.reapInterval = setInterval(() => { void this.runReapSweep(); }, intervalMs);
    log('Container reap sweep started with interval %dms', intervalMs);
    void this.runReapSweep();
  }

  /** Stop the periodic sweep. Safe to call when it was never started. */
  stopReaper(): void {
    if (!this.reapInterval) return;
    clearInterval(this.reapInterval);
    this.reapInterval = undefined;
  }

  /** One sweep, guarded so a slow orchestrator cannot have two running at once. */
  private async runReapSweep(): Promise<void> {
    if (this.sweeping) {
      log('Reap sweep still in flight; skipping this tick');
      return;
    }
    this.sweeping = true;
    try {
      const reaped = await this.reapStuckContainers();
      if (reaped.length) log('Reaped %d stuck container record(s): %o', reaped.length, reaped);
    } catch (err) {
      log('Reap sweep failed: %O', err);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Resolve container records nothing is watching any more.
   *
   * `createContainer` writes the record as `pending` before provisioning starts
   * and `provisionContainer` moves it to `creating` before calling the
   * orchestrator, so a provider that dies anywhere in that window (including
   * during the orchestrator call itself, which can span a Docker image pull)
   * leaves a record no in-flight call will ever advance. `stopping` has the same
   * shape from the terminate path, and `enrolling` outlives the in-process
   * `waitForEnrollment` that owned it — a container that came up healthy while
   * the provider was down would otherwise stay `enrolling` forever and never be
   * metered, since billing only reads `running` records.
   *
   * Best-effort per record: a failure is logged and the sweep continues.
   *
   * @returns the ids the sweep resolved.
   */
  async reapStuckContainers(): Promise<string[]> {
    const nowMs = this.now().getTime();
    const candidates = (await this.store.listContainers()).filter(c => isStuck(c, nowMs));
    const reaped: string[] = [];

    for (const candidate of candidates) {
      try {
        // Re-read: the list above is a snapshot and every reclaim awaits, so an
        // in-flight provision in THIS process can advance a record between the
        // snapshot and now. Re-test the predicate against what is stored now.
        const current = await this.store.getContainer(candidate.id);
        if (!current || !isStuck(current, nowMs)) continue;
        if (await this.reapOne(current)) reaped.push(current.id);
      } catch (err) {
        log('Failed to reap container %s: %O', candidate.id, err);
      }
    }

    return reaped;
  }

  /** Resolve one stuck record per its status; returns whether the sweep resolved it. */
  private async reapOne(container: Container): Promise<boolean> {
    if (container.status === 'enrolling') return this.reapStuckEnrolling(container);

    if (container.status === 'stopping') {
      // Reclaim first, then terminalize — the same order `terminateContainer`
      // uses, so a crash mid-reap leaves the record on `stopping` and the next
      // sweep simply retries it.
      await this.reclaimStuckContainer(container);
      await this.updateStatus(container.id, 'stopped');
      log('Reaped container %s stuck in stopping', container.id);
      return true;
    }

    // 'pending' / 'creating' — status FIRST, then reclaim, matching `terminate`'s
    // ordering rule in both packages: a crash mid-reap must leave a terminal
    // record rather than a repeat of the same stuck state. The status is read off
    // before the write, since a store may hand back the record by reference.
    const stuckIn = container.status;
    await this.updateStatus(container.id, 'error', {
      error: `stuck in ${stuckIn} past TTL — provider likely restarted mid-provision`,
    });
    await this.reclaimStuckContainer(container);
    log('Reaped container %s stuck in %s', container.id, stuckIn);
    return true;
  }

  /**
   * Decide the fate of an `enrolling` record no in-process waiter owns any more.
   *
   * Healthy → `running`, which is what closes the never-metered hole after a
   * provider restart. Otherwise ask whether the child is even alive: gone →
   * `error` + reclaim; alive-but-unhealthy, or an orchestrator that cannot say →
   * leave it alone. An alive container is genuinely consuming its resources, the
   * record honestly reflects that, and `enrolling` is still seedable — a tenant's
   * merely-slow node must not be terminalized.
   */
  private async reapStuckEnrolling(container: Container): Promise<boolean> {
    if (await this.enrollIfHealthy(container)) {
      log('Reaped container %s stuck in enrolling; it came up healthy', container.id);
      return true;
    }

    const state = container.dockerId
      ? await this.probeRunState(container.id, container.dockerId)
      : undefined;
    if (!state || !isChildGone(state)) {
      log('Container %s still enrolling past TTL; child is not proven gone, leaving it', container.id);
      return false;
    }

    await this.updateStatus(container.id, 'error', { error: childDiedMessage(state) });
    await this.reclaimStuckContainer(container);
    log('Reaped container %s stuck in enrolling; its child is gone', container.id);
    return true;
  }

  /**
   * Best-effort stop + remove of whatever container the stuck record still names:
   * the `dockerId` it carries, else whatever the orchestrator can find under the
   * provider's container id — a provider that died mid-provision never wrote one,
   * and that container is otherwise orphaned, running under `unless-stopped` with
   * host ports and a volume held and no record naming it.
   *
   * The stop/remove halves never throw (see `safeStop`/`safeReclaim`), so a
   * reclaim failure cannot roll back the terminal status write. A `resolveDockerId`
   * that throws does propagate, to the sweep's per-record catch: "the daemon could
   * not answer" is not "there is nothing to reclaim".
   *
   * NOTE: `removeContainer` deletes the container's named `/data` volume, so
   * reaping a stuck `creating` record destroys that container's node identity.
   * Correct for a container that never enrolled; if the reap is ever widened to a
   * status where the node HAS held an identity, that call needs an opt-out.
   */
  private async reclaimStuckContainer(container: Container): Promise<void> {
    const dockerId = container.dockerId ?? await this.orchestrator.resolveDockerId?.(container.id);
    if (!dockerId) return;
    await this.safeStop(dockerId);
    await this.safeReclaim(dockerId);
  }

  /**
   * Apply a seed to a container.
   * The seed is forwarded to the container's seed endpoint.
   *
   * @param id - Container ID
   * @param encodedSeed - Base64url-encoded seed
   * @returns Result of seed application
   */
  async applySeed(id: string, encodedSeed: string): Promise<{ success: boolean; peersAdded?: number; error?: string }> {
    const container = await this.store.getContainer(id);
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    if (container.status !== 'running' && container.status !== 'enrolling') {
      return { success: false, error: `Container is not running (status: ${container.status})` };
    }

    if (!container.seedEndpoint) {
      return { success: false, error: 'Container does not have a seed endpoint' };
    }

    // The container gates `POST /seed` behind `Authorization: Bearer <token>`; a
    // record with an endpoint but no token (e.g. a legacy container provisioned
    // before token injection) can never authenticate, so fail loudly here rather
    // than letting the node reject the request with an opaque 401.
    if (!container.seedToken) {
      return { success: false, error: 'Container does not have a seed token' };
    }

    log('Applying seed to container %s', id);

    try {
      const response = await fetch(container.seedEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${container.seedToken}`,
        },
        body: JSON.stringify({ seed: encodedSeed }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Seed endpoint returned ${response.status}: ${errorText}` };
      }

      const result = await response.json() as { success: boolean; peersAdded?: number; error?: string };
      log('Seed applied to container %s: %O', id, result);
      return result;
    } catch (error) {
      log('Failed to apply seed to container %s: %O', id, error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get the peer info for a container (peerId and multiaddrs).
   *
   * Reads the live `/status` payload on **every** call with no cache — matching
   * `getContainerStatus`'s freshness model so both `/status` read paths agree.
   * Caching peerId/multiaddrs warm-once served stale dial info forever after a
   * restart re-keyed the node's libp2p identity or remapped its multiaddrs.
   *
   * peerId/multiaddrs live in `/status` (not `/health`, which carries only
   * `{ status }`); the shared `fetchContainerHealthStatus` helper keeps the
   * `/status` URL derivation and wire shape in one place.
   *
   * @param id - Container ID
   * @returns Peer info, or undefined when the node has no peer identity yet
   */
  async getPeerInfo(id: string): Promise<{ peerId: string; multiaddrs: string[] } | undefined> {
    const container = await this.store.getContainer(id);
    if (!container) return undefined;

    // Fetch the live `/status` payload. `peerId` is `null` while the node is
    // still starting — treat that (and missing multiaddrs) as "not available".
    const status = await fetchContainerHealthStatus(container);
    if (!status?.peerId || !status.multiaddrs?.length) return undefined;

    return { peerId: status.peerId, multiaddrs: status.multiaddrs };
  }
}

