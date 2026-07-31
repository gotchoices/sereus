import debug from 'debug';

import type { Orchestrator } from '@serfab/cadre-provider';

import type { ManagedNodeInfo, NodeStateListener } from '../orchestrator/types.js';
import type { DonationService } from './donation-service.js';
import type { DonationStore } from './donation-store.js';
import type { Donation, DonationStatus } from './types.js';

const log = debug('cadre:host:donation-supervisor');

/**
 * Unit of the doubling respawn backoff: the wait after `n` consecutive failed
 * attempts is `base * 2^n`, capped at {@link DONATION_RESPAWN_BACKOFF_MAX_MS}.
 * So the first retry waits 10s (one attempt is already recorded by then), the
 * second 20s, and so on. A node with no recorded attempt is respawned
 * immediately.
 */
export const DONATION_RESPAWN_BACKOFF_BASE_MS = 5_000;

/**
 * Ceiling on the doubling respawn backoff. 5 minutes.
 *
 * NOTE: not reachable at the current {@link DONATION_RESPAWN_MAX_ATTEMPTS} of 5
 * — the longest wait actually served is the one before the 5th attempt,
 * `5s * 2^4` = 80s, and the 5th failure gives up. The cap only starts clamping
 * once a record can reach 6 recorded attempts (`5s * 2^6` = 320s), so raising
 * the attempt cap without revisiting this one changes nothing.
 */
export const DONATION_RESPAWN_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Consecutive respawn attempts after which the host stops trying and marks the
 * donation `error` — a node that will not stay up is a host-side fault the
 * borrower cannot see, so surface it instead of spinning forever.
 */
export const DONATION_RESPAWN_MAX_ATTEMPTS = 5;

/**
 * How long a respawned node must stay up before its attempt budget is refilled.
 * The last respawn produced something that survived, so the next crash starts
 * from a fresh budget rather than inheriting an old crash loop's count.
 */
export const DONATION_RESPAWN_HEALTHY_MS = 10 * 60_000;

/** How often the supervisor sweep runs while cadre-host is up. 1 minute. */
export const DONATION_RESPAWN_SWEEP_MS = 60_000;

/**
 * Statuses the supervisor considers. `provisioning` is a provision still in
 * flight (its own code path owns the child); `error` and `terminated` are
 * terminal — a loan the host gave up on or the borrower ended, neither of which
 * may come back on its own.
 */
const SUPERVISED_STATUSES: ReadonlySet<DonationStatus> = new Set<DonationStatus>([
  'awaiting_seed',
  'seeded',
]);

/**
 * The orchestrator surface the supervisor needs: the shared `Orchestrator`
 * (for `isRunning` / `stopContainer`) plus cadre-host's own exit-event
 * subscription, which is not part of that cross-package interface.
 * `HostProcessOrchestrator` satisfies this.
 */
export interface SupervisedOrchestrator extends Orchestrator {
  onStateChange(listener: NodeStateListener): () => void;
}

/** Constructor options. */
export interface DonationSupervisorOptions {
  /** Lifecycle service — the supervisor drives its `respawn`. */
  service: DonationService;
  /** Persistent donation store — the candidate list and the give-up write. */
  store: DonationStore;
  /** Orchestrator that owns the donated child processes. */
  orchestrator: SupervisedOrchestrator;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * DonationSupervisor — owns the invariant *a non-terminal donation is expected
 * to be running*.
 *
 * Nothing else re-spawns a donated node: `bin/host.ts` re-spawns only the host's
 * own owner node, the `/api/nodes/:id/{start,restart}` routes refuse non-owner
 * ids, and the stale-`awaiting_seed` reap only terminates. So without this class
 * a crashed, OOM-killed, or reboot-killed donated node stays dead with its
 * record still reading `seeded`, silently costing the borrower a node and their
 * grant a quota slot.
 *
 * One code path ({@link reconcile}) behind three triggers:
 *
 * - **host startup** — one pass after `orchestrator.init()`, which catches every
 *   node that died while the host was down;
 * - **exit signal** — the orchestrator's `onStateChange`, so a crash is noticed
 *   in milliseconds rather than at the next sweep;
 * - **periodic sweep** — the backstop for deaths no exit event covers (host was
 *   down, listener missed, orchestrator re-attached to an already-dead pid).
 *
 * Passes are serialized: `DonationService.respawn` is not itself serialized, and
 * two overlapping respawns of one id both spawn a child while the second drops
 * the first's orchestrator handle (see its docstring). Since two of the three
 * triggers can fire at once, the serialization lives here.
 */
export class DonationSupervisor {
  private readonly service: DonationService;
  private readonly store: DonationStore;
  private readonly orchestrator: SupervisedOrchestrator;
  private readonly now: () => Date;

  /** Serialization tail — see the class docstring. */
  private tail: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  /** At most one exit-triggered pass queued at a time (crash storms coalesce). */
  private exitPassQueued = false;
  /** Set by `stop()` so an in-flight pass abandons its remaining records. */
  private disposed = false;

  constructor(opts: DonationSupervisorOptions) {
    this.service = opts.service;
    this.store = opts.store;
    this.orchestrator = opts.orchestrator;
    this.now = opts.now ?? (() => new Date());
    log('DonationSupervisor initialized');
  }

  /**
   * One reconcile pass over the donation store. Serialized against every other
   * pass, so a caller may get a queued pass rather than an immediate one.
   * Returns the donation ids it respawned in *its own* pass.
   */
  reconcile(): Promise<string[]> {
    const run = (): Promise<string[]> => this.reconcileOnce();
    const next = this.tail.then(run, run);
    // The stored tail swallows outcomes — a failed pass must not reject the
    // next caller's wait, only sequence after it.
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Subscribe to child exits, start the periodic sweep, and run the startup
   * pass. Idempotent — a second call while started is a no-op.
   */
  start(): void {
    if (this.timer) return;
    this.disposed = false;
    // Subscribe before the first pass so an exit during it is not missed.
    this.unsubscribe = this.orchestrator.onStateChange((info) => { this.onNodeState(info); });
    this.timer = setInterval(() => { this.sweep('timer'); }, DONATION_RESPAWN_SWEEP_MS);
    this.timer.unref();
    this.sweep('startup');
  }

  /**
   * Stop the timer and unsubscribe. A pass already in flight abandons its
   * remaining records rather than being awaited — every record it has not
   * reached is picked up by the next host start's startup pass.
   */
  stop(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    log('DonationSupervisor stopped');
  }

  /** Fire-and-forget pass for the timer / exit / startup triggers. */
  private sweep(trigger: string): void {
    void this.reconcile()
      .then((ids) => {
        if (ids.length) log('%s sweep respawned %d donation(s): %o', trigger, ids.length, ids);
      })
      .catch((err) => {
        console.error(`donation respawn sweep failed: ${errorMessage(err)}`);
      });
  }

  /**
   * Exit-event trigger. Deliberately cheap: it does not map the handle back to a
   * donation (that needs a store read per event), it just asks for a pass. Owner
   * node exits are not ours — `bin/host.ts` owns re-spawning that one.
   */
  private onNodeState(info: ManagedNodeInfo): void {
    if (info.owner || info.status !== 'stopped') return;
    if (this.exitPassQueued) return;
    this.exitPassQueued = true;
    void this.reconcile()
      .catch((err) => { console.error(`donation respawn sweep failed: ${errorMessage(err)}`); })
      .finally(() => { this.exitPassQueued = false; });
  }

  /** The unserialized body of one pass. */
  private async reconcileOnce(): Promise<string[]> {
    const respawned: string[] = [];
    let candidates: Donation[];
    try {
      candidates = this.store.list().filter((d) => SUPERVISED_STATUSES.has(d.status));
    } catch (err) {
      // A malformed donations.json throws on every load; log rather than let an
      // unhandled rejection escape the timer.
      log('reconcile could not list donations: %s', errorMessage(err));
      return respawned;
    }

    for (const donation of candidates) {
      if (this.disposed) break;
      try {
        const id = await this.reconcileOne(donation);
        if (id) respawned.push(id);
      } catch (err) {
        // One bad record must never end the sweep — the others are still down.
        log('reconcile of donation %s failed: %s', donation.id, errorMessage(err));
      }
    }
    return respawned;
  }

  /** Reconcile one record. Returns its id when this pass respawned it. */
  private async reconcileOne(donation: Donation): Promise<string | undefined> {
    // No handle means nothing was ever spawned — `provision` owns that record
    // until it writes one, and replaying it here would race that provision.
    if (!donation.dockerId) return undefined;

    if (await this.orchestrator.isRunning(donation.dockerId)) {
      this.refillBudgetIfHealthy(donation);
      return undefined;
    }
    if (!this.backoffElapsed(donation)) {
      log('donation %s is down but still inside its respawn backoff', donation.id);
      return undefined;
    }
    return this.attemptRespawn(donation);
  }

  /**
   * Whether enough time has passed since the last attempt. A record with no
   * attempt history (or an unparsable timestamp — never wedge a node on bad
   * data) is eligible immediately.
   */
  private backoffElapsed(donation: Donation): boolean {
    const respawn = donation.respawn;
    if (!respawn) return true;
    const last = Date.parse(respawn.lastAttemptAt);
    if (Number.isNaN(last)) return true;
    const delay = Math.min(
      DONATION_RESPAWN_BACKOFF_BASE_MS * 2 ** respawn.attempts,
      DONATION_RESPAWN_BACKOFF_MAX_MS,
    );
    return this.now().getTime() - last >= delay;
  }

  /**
   * Clear the attempt count once a respawned node has been up long enough to
   * count as healthy, so the next crash gets a full budget instead of inheriting
   * the previous crash loop's.
   *
   * `updatedAt` is deliberately left alone: it is the age the stale-`awaiting_seed`
   * reap measures, and a liveness observation is not borrower activity.
   */
  private refillBudgetIfHealthy(donation: Donation): void {
    if (!this.budgetRefillDue(donation)) return;
    // Re-read before writing: `donation` comes from the snapshot this pass
    // started from, which can be several awaits old, and `store.put` replaces
    // the whole row — writing the stale copy back would undo a concurrent seed
    // or terminate that landed mid-pass.
    const current = this.store.get(donation.id);
    if (!current?.respawn || !this.budgetRefillDue(current)) return;
    try {
      this.store.put({ ...current, respawn: { ...current.respawn, attempts: 0 } });
      log('donation %s is healthy again — respawn budget refilled', donation.id);
    } catch (err) {
      // Costs one attempt off the next crash's budget, nothing more.
      log('failed to refill respawn budget for %s: %s', donation.id, errorMessage(err));
    }
  }

  /**
   * Whether a record carries a crash-loop count old enough to clear. An
   * unparsable timestamp is treated as not-due — unlike the backoff check,
   * being wrong here would erase real attempt history rather than free a node.
   */
  private budgetRefillDue(donation: Donation): boolean {
    const respawn = donation.respawn;
    if (!respawn || respawn.attempts === 0) return false;
    const last = Date.parse(respawn.lastAttemptAt);
    if (Number.isNaN(last)) return false;
    return this.now().getTime() - last > DONATION_RESPAWN_HEALTHY_MS;
  }

  /** One respawn attempt, with the give-up check on failure. */
  private async attemptRespawn(donation: Donation): Promise<string | undefined> {
    try {
      const result = await this.service.respawn(donation.id);
      switch (result.outcome) {
        case 'not_respawnable':
          // A record written before the spawn inputs were persisted. Not
          // respawnable and never will be; skip it every pass (cheap — no
          // orchestrator call is reached) rather than fail the sweep.
          log('donation %s is down but not respawnable (no persisted spawn inputs)', donation.id);
          return undefined;
        case 'abandoned':
          // The loan ended while the spawn was in flight and the ending won.
          // Nothing threw, so no attempt is persisted and the give-up path is
          // never entered — correct: this is not a failed attempt.
          log(
            'respawn of donation %s was abandoned (record went %s mid-spawn)',
            donation.id,
            result.status ?? 'missing',
          );
          return undefined;
        case 'respawned':
          log('respawned donation %s → %s', donation.id, result.donation.dockerId);
          return donation.id;
      }
    } catch (err) {
      const message = errorMessage(err);
      // `respawn` persists the incremented counter; re-read it rather than
      // recomputing, so a give-up decision is made on what is actually on disk.
      const attempts = this.store.get(donation.id)?.respawn?.attempts ?? 0;
      log('respawn attempt %d for donation %s failed: %s', attempts, donation.id, message);
      if (attempts >= DONATION_RESPAWN_MAX_ATTEMPTS) {
        await this.giveUp(donation.id, attempts, message);
      }
      return undefined;
    }
  }

  /**
   * Stop trying: mark the donation `error` and stop whatever child the record
   * still names. `error` is outside the store's live statuses, so the grant's
   * quota frees and the borrower can provision a fresh node.
   *
   * The record is written BEFORE the stop for the same reason `terminate` does
   * it in that order — the stop fires `onStateChange`, and a pass triggered by
   * it must not see "node gone, record still `seeded`" and start respawning
   * again.
   *
   * The child is stopped but NOT removed: `removeContainer` deletes the workdir,
   * and the workdir holds the identity key the borrower's cadre approved. A
   * later `terminate()` still works on an `error` record and reclaims it.
   *
   * NOTE: an `error`-after-give-up record therefore keeps its workdir forever
   * unless someone calls `terminate`. If stale `error` workdirs ever pile up on
   * real hosts, extend the reap sweep in `donation-service.ts` to cover them.
   */
  private async giveUp(id: string, attempts: number, lastError: string): Promise<void> {
    const donation = this.store.get(id);
    if (!donation) return;
    // The record may have gone terminal while the failing attempt was in flight
    // — a `terminate` mid-pass is exactly why `respawn` threw. Overwriting that
    // with `error` would rewrite the borrower's own ending as a host fault, and
    // the stop below would fire against a child `terminate` already reclaimed.
    if (!SUPERVISED_STATUSES.has(donation.status)) {
      log('donation %s went %s before give-up — leaving it alone', id, donation.status);
      return;
    }
    this.store.put({
      ...donation,
      status: 'error',
      error: `respawn gave up after ${attempts} attempts: ${lastError}`,
      updatedAt: this.now().toISOString(),
    });
    log('gave up respawning donation %s after %d attempts: %s', id, attempts, lastError);
    if (donation.dockerId) {
      try {
        await this.orchestrator.stopContainer(donation.dockerId);
      } catch (err) {
        // Expected when the failed respawn already dropped the handle
        // (`backlog/debt-failed-respawn-strands-donated-workdir`); the child is
        // dead either way, which is why we are here.
        log('failed to stop container %s while giving up: %s', donation.dockerId, errorMessage(err));
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
