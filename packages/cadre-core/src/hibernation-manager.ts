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
  private readonly checkInTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
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
      checkInInterval: custom.checkInInterval ?? defaults.checkInInterval
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
      clearInterval(timer);
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
      void this.beginWake(strandId).catch((err) => {
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

  private scheduleCheckIn(instance: StrandInstance): void {
    const { strandId, latencyHint } = instance;
    const timeouts = this.getTimeouts(latencyHint);

    // Clear existing check-in timer
    const existing = this.checkInTimers.get(strandId);
    if (existing) {
      clearInterval(existing);
    }

    // Schedule periodic check-ins
    const timer = setInterval(() => {
      if (!this.running) {
        clearInterval(timer);
        return;
      }

      log('Check-in for hibernating strand %s', strandId);
      instance.nextCheckIn = new Date(Date.now() + timeouts.checkInInterval);

      // In a real implementation, this would query the cohort for pending activity
      // For now, we just update the nextCheckIn timestamp
    }, timeouts.checkInInterval);

    this.checkInTimers.set(strandId, timer);
    instance.nextCheckIn = new Date(Date.now() + timeouts.checkInInterval);
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
      clearInterval(checkInTimer);
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
