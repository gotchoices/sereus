import debug from 'debug';
import type {
  StrandInstance,
  LatencyHint,
  HibernationTimeouts,
  HibernationConfig
} from './types.js';
import { HIBERNATION_TIMEOUTS } from './types.js';

const log = debug('sereus:cadre:hibernation');

/**
 * Callbacks for hibernation state changes
 */
export interface HibernationCallbacks {
  onIdle: (strandId: string) => Promise<void>;
  onHibernate: (strandId: string) => Promise<void>;
  onWake: (strandId: string) => Promise<void>;
  /**
   * Perform a real cohort check-in for a hibernating strand. The implementation
   * (`CadreNode.handleStrandCheckIn`) resumes the strand, gives it a bounded
   * window to connect to reachable cohort peers and surface pending activity,
   * then re-hibernates if still idle. The manager AWAITS this before scheduling
   * the next (longer-delayed) check-in, so a slow check-in never overlaps the
   * next tick. After it resolves the manager inspects `instance.status`: a
   * strand left non-`hibernating` is treated as woken (backoff resets on the
   * next hibernation); a strand left `hibernating` escalates the backoff.
   */
  onCheckIn: (strandId: string) => Promise<void>;
}

/**
 * Manages strand hibernation state transitions based on activity.
 * 
 * State machine:
 *   active → idle (after idleTimeout with no activity)
 *   idle → hibernating (after hibernateTimeout with no activity)
 *   idle → active (on activity)
 *   hibernating → active (on wake signal or check-in with pending activity)
 */
export class HibernationManager {
  private readonly config: HibernationConfig;
  private readonly callbacks: HibernationCallbacks;
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /**
   * Pending check-in timers, one per hibernating strand. Unlike the old fixed
   * `setInterval`, these are single-shot `setTimeout`s rescheduled by
   * {@link runCheckIn} with an escalating delay — so a long-running `onCheckIn`
   * can never overlap the next tick, and the period adapts to the backoff.
   */
  private readonly checkInTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /**
   * In-flight wake promises keyed by strandId. Coalesces overlapping wake
   * triggers (two near-simultaneous activities, or activity racing a force wake)
   * so `onWake` — and the libp2p-node rebuild it drives — runs at most once per
   * concurrent wake.
   */
  private readonly wakePromises: Map<string, Promise<void>> = new Map();
  private running = false;

  constructor(config: HibernationConfig, callbacks: HibernationCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    log('HibernationManager created, enabled=%s', config.enabled);
  }

  /**
   * Get effective timeouts for a latency hint
   */
  private getTimeouts(hint: LatencyHint): HibernationTimeouts {
    const defaults = HIBERNATION_TIMEOUTS[hint];
    const custom = this.config.customTimeouts?.[hint];
    
    if (!custom) return defaults;

    return {
      idleTimeout: custom.idleTimeout ?? defaults.idleTimeout,
      hibernateTimeout: custom.hibernateTimeout ?? defaults.hibernateTimeout,
      checkInInterval: custom.checkInInterval ?? defaults.checkInInterval,
      checkInBackoffFactor: custom.checkInBackoffFactor ?? defaults.checkInBackoffFactor,
      checkInMaxInterval: custom.checkInMaxInterval ?? defaults.checkInMaxInterval
    };
  }

  /**
   * Start managing hibernation for all strands
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    log('HibernationManager started');
  }

  /**
   * Stop managing hibernation
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    
    for (const timer of this.checkInTimers.values()) {
      clearTimeout(timer);
    }
    this.checkInTimers.clear();

    // In-flight wakes clean themselves up via their finally; drop the references
    // so a fresh start coalesces cleanly.
    this.wakePromises.clear();

    log('HibernationManager stopped');
  }

  /**
   * Register a strand for hibernation management
   */
  trackStrand(instance: StrandInstance): void {
    if (!this.config.enabled || !this.running) return;
    
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);
    
    // Don't track strands that never hibernate
    if (timeouts.idleTimeout === Infinity) {
      log('Strand %s has realtime latency hint - no hibernation', strandId);
      return;
    }
    
    log('Tracking strand %s for hibernation (hint=%s)', strandId, latencyHint);
    this.scheduleIdleTransition(instance);
  }

  /**
   * Untrack a strand from hibernation management
   */
  untrackStrand(strandId: string): void {
    this.clearTimers(strandId);
    log('Untracked strand %s from hibernation', strandId);
  }

  /**
   * Record activity on a strand - resets idle timer
   */
  recordActivity(instance: StrandInstance): void {
    if (!this.config.enabled || !this.running) return;
    
    const { strandId, status, latencyHint } = instance;
    instance.lastActivity = new Date();
    
    // If idle or hibernating, wake up. Coalesce so two near-simultaneous
    // activities don't each fire onWake (which would rebuild two libp2p nodes).
    if (status === 'idle' || status === 'hibernating') {
      log('Activity on %s strand %s - waking', status, strandId);
      this.clearTimers(strandId);
      // Fire-and-forget; force-wake awaiters see errors, so swallow (and log)
      // here to avoid an unhandled rejection on this best-effort path.
      //
      // Once the wake settles (CadreNode rebuilds the runtime and marks the
      // strand `active`), re-arm the idle→hibernate→check-in cycle. Without this
      // a strand that wakes then goes quiet stays `active` forever and never
      // re-hibernates — so the check-in backoff could never restart at base.
      // Guarded on `active` so a wake that did not transition (a coalesced
      // no-op, or a still-mid-flight rebuild) never arms a stray timer.
      void this.beginWake(strandId).then(() => {
        if (this.running && instance.status === 'active') {
          const timeouts = this.getTimeouts(instance.latencyHint);
          if (timeouts.idleTimeout !== Infinity) {
            this.scheduleIdleTransition(instance);
          }
        }
      }).catch((err) => {
        log('Activity-driven wake failed for strand %s: %o', strandId, err);
      });
      return;
    }

    // Reschedule idle transition if active
    if (status === 'active') {
      const timeouts = this.getTimeouts(latencyHint);
      if (timeouts.idleTimeout !== Infinity) {
        this.scheduleIdleTransition(instance);
      }
    }
  }

  /**
   * Force wake a hibernating strand
   */
  async wakeStrand(strandId: string): Promise<void> {
    this.clearTimers(strandId);
    await this.beginWake(strandId);
  }

  /**
   * Begin a wake for a strand, or coalesce with one already in flight. Ensures
   * `onWake` runs at most once per concurrent wake — the returned promise is
   * shared by all overlapping callers and cleared once it settles. Force-wake
   * callers await it; activity-driven callers fire-and-forget.
   */
  private beginWake(strandId: string): Promise<void> {
    const existing = this.wakePromises.get(strandId);
    if (existing) {
      return existing;
    }

    const wake = (async () => {
      try {
        await this.callbacks.onWake(strandId);
      } finally {
        this.wakePromises.delete(strandId);
      }
    })();
    this.wakePromises.set(strandId, wake);
    return wake;
  }

  private scheduleIdleTransition(instance: StrandInstance): void {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);

    // Clear existing timer
    this.clearTimer(strandId);

    // Schedule idle transition
    const timer = setTimeout(() => {
      this.handleIdleTimeout(instance);
    }, timeouts.idleTimeout);

    this.timers.set(strandId, timer);
  }

  private handleIdleTimeout(instance: StrandInstance): void {
    const { strandId, latencyHint } = instance;

    if (!this.running) return;

    log('Idle timeout for strand %s', strandId);

    // Transition to idle. The callback can reject (e.g. a future idle handler
    // that releases resources); catch so the timer chain never unhandled-rejects.
    void this.callbacks.onIdle(strandId).then(() => {
      // Schedule hibernate transition
      const timeouts = this.getTimeouts(latencyHint);
      if (timeouts.hibernateTimeout !== Infinity) {
        this.scheduleHibernateTransition(instance);
      }
    }).catch((err) => {
      log('onIdle failed for strand %s: %o', strandId, err);
    });
  }

  private scheduleHibernateTransition(instance: StrandInstance): void {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);

    // Clear existing timer
    this.clearTimer(strandId);

    // Schedule hibernate transition
    const timer = setTimeout(() => {
      this.handleHibernateTimeout(instance);
    }, timeouts.hibernateTimeout);

    this.timers.set(strandId, timer);
  }

  private handleHibernateTimeout(instance: StrandInstance): void {
    const { strandId, latencyHint } = instance;

    if (!this.running) return;

    log('Hibernate timeout for strand %s', strandId);

    // Transition to hibernating. onHibernate now releases strand-network
    // resources (quiesce), so its close()/stop() can reject — catch so a failed
    // hibernate logs instead of producing an unhandled rejection.
    void this.callbacks.onHibernate(strandId).then(() => {
      // Schedule periodic check-ins
      const timeouts = this.getTimeouts(latencyHint);
      if (timeouts.checkInInterval !== Infinity) {
        this.scheduleCheckIn(instance);
      }
    }).catch((err) => {
      log('onHibernate failed for strand %s: %o', strandId, err);
    });
  }

  /**
   * Arm the next check-in for a hibernating strand. Each call is a single-shot
   * `setTimeout` (not a fixed `setInterval`) so the period escalates per
   * {@link runCheckIn} and a slow `onCheckIn` never overlaps the next tick.
   *
   * `delay` is omitted by the chain start ({@link handleHibernateTimeout}),
   * defaulting to the base `checkInInterval` — which is why backoff naturally
   * resets to base each fresh hibernation cycle, with no per-strand counter to
   * clear on wake. Subsequent ticks pass the escalated, capped delay.
   */
  private scheduleCheckIn(instance: StrandInstance, delay?: number): void {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);
    const currentDelay = delay ?? timeouts.checkInInterval;

    // Replace any existing check-in timer (no-op if the firing timer rescheduled us).
    const existing = this.checkInTimers.get(strandId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      void this.runCheckIn(instance, currentDelay);
    }, currentDelay);

    this.checkInTimers.set(strandId, timer);
    instance.nextCheckIn = new Date(Date.now() + currentDelay);
  }

  /**
   * Run a single check-in tick: invoke `onCheckIn` (a real resume → bounded
   * sync window → re-hibernate-if-idle cycle in `CadreNode`) and AWAIT it before
   * deciding the next step.
   *
   * - If the strand woke during the check-in (`onCheckIn` left it non-
   *   `hibernating`), stop the chain — the activity path has re-armed the
   *   idle/hibernate timers, and the next hibernation restarts the chain at the
   *   base delay (backoff reset).
   * - Otherwise escalate the delay by `checkInBackoffFactor`, capped at
   *   `checkInMaxInterval`, and reschedule.
   */
  private async runCheckIn(instance: StrandInstance, currentDelay: number): Promise<void> {
    const { strandId, latencyHint } = instance;
    if (!this.running) return;

    log('Check-in for hibernating strand %s (delay=%dms)', strandId, currentDelay);

    try {
      await this.callbacks.onCheckIn(strandId);
    } catch (err) {
      // A failed check-in (e.g. resume threw) must not break the chain — log and
      // fall through to reschedule the next, longer-delayed attempt.
      log('onCheckIn failed for strand %s: %o', strandId, err);
    }

    if (!this.running) return;

    // The check-in either woke the strand (CadreNode left it active) or left it
    // hibernating. Inspect the shared instance the callback just mutated.
    if (instance.status !== 'hibernating') {
      log('Check-in woke strand %s; backoff resets on next hibernation', strandId);
      this.checkInTimers.delete(strandId);
      // The chain is stopping; drop the now-stale next-check-in advertisement so
      // `getStrand` doesn't report a phantom check-in for a strand that is awake.
      instance.nextCheckIn = undefined;
      return;
    }

    const timeouts = this.getTimeouts(latencyHint);
    const nextDelay = Math.min(
      currentDelay * timeouts.checkInBackoffFactor,
      timeouts.checkInMaxInterval
    );
    this.scheduleCheckIn(instance, nextDelay);
  }

  private clearTimer(strandId: string): void {
    const timer = this.timers.get(strandId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(strandId);
    }
  }

  private clearTimers(strandId: string): void {
    this.clearTimer(strandId);

    const checkInTimer = this.checkInTimers.get(strandId);
    if (checkInTimer) {
      clearTimeout(checkInTimer);
      this.checkInTimers.delete(strandId);
    }
  }

  /**
   * Get the current status of hibernation tracking
   */
  getStatus(): { enabled: boolean; trackedStrands: number } {
    return {
      enabled: this.config.enabled && this.running,
      trackedStrands: this.timers.size + this.checkInTimers.size
    };
  }
}
