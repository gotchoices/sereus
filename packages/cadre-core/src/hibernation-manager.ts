import debug from 'debug';
import type {
  StrandInstance,
  LatencyHint,
  HibernationTimeouts,
  HibernationConfig
} from './types.js';
import { HIBERNATION_TIMEOUTS } from './types.js';

const log = debug('sereus:cadre:hibernation');

/** An armed check-in: its timer, and the instance the chain reschedules. */
interface PendingCheckIn {
  timer: ReturnType<typeof setTimeout>;
  instance: StrandInstance;
}

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
   * next hibernation); a strand left `hibernating` escalates the backoff. While
   * a wake or probe holds the strand, the chain passes to it instead.
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
  private readonly checkInTimers: Map<string, PendingCheckIn> = new Map();
  /**
   * In-flight wake promises keyed by strandId. Coalesces overlapping wake
   * triggers (two near-simultaneous activities, or activity racing a force wake)
   * so `onWake` — and the libp2p-node rebuild it drives — runs at most once per
   * concurrent wake.
   */
  private readonly wakePromises: Map<string, Promise<void>> = new Map();
  /**
   * Hibernating strands whose armed check-in a wake cancelled, held until that wake
   * settles. A wake that leaves the strand hibernating again (a failed rebuild, or a probe's
   * window that re-quiesced it) re-arms the chain from here ({@link rearmAfterWake}); without
   * it the strand is left with no runtime and nothing scheduled to retry.
   */
  private readonly checkInsCancelledByWake: Set<string> = new Set();
  /**
   * Strands an on-demand probe (`CadreNode.serviceWake`) holds from its wake to the end of its
   * window, with whether a check-in chain was armed when it began. While held, the probe's end
   * ({@link endProbe}) — not the wake's settle — sets the timers, since the window may
   * re-hibernate the strand after the wake settled.
   */
  private readonly probes: Map<string, { hadCheckInChain: boolean }> = new Map();
  /**
   * Strands whose check-in is running (its timer fired, `onCheckIn` not yet returned). A
   * force-hibernate or untrack removes the strand, so the run's return schedules nothing: a
   * check-in already running is part of the chain those calls cancel.
   */
  private readonly runningCheckIns: Set<string> = new Set();
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
    
    for (const { timer } of this.checkInTimers.values()) {
      clearTimeout(timer);
    }
    this.checkInTimers.clear();

    // In-flight wakes clean themselves up via their finally; drop the references
    // so a fresh start coalesces cleanly.
    this.wakePromises.clear();
    this.checkInsCancelledByWake.clear();
    this.probes.clear();
    this.runningCheckIns.clear();

    log('HibernationManager stopped');
  }

  /**
   * Whether a strand with this instance's latency hint ever hibernates — `false`
   * for realtime (Infinity idle timeout, see {@link HIBERNATION_TIMEOUTS}), also
   * honouring any per-hint `customTimeouts` override. Imperative callers
   * (`CadreNode.hibernateStrand` / `hibernateAll`) use this as the single source
   * of truth for "skip realtime", consistent with {@link trackStrand} declining
   * to track Infinity-timeout strands.
   */
  hibernates(instance: StrandInstance): boolean {
    return this.getTimeouts(instance.latencyHint).idleTimeout !== Infinity;
  }

  /**
   * Imperatively hibernate a tracked strand now, bypassing the idle/hibernate
   * timers — the mobile background-entry path. Cancels the strand's pending
   * idle/hibernate AND check-in timers so none can later re-fire `onHibernate`
   * on the already-quiesced strand or resurrect one the caller means to keep
   * down, then invokes `onHibernate` (quiesce + mark hibernating).
   *
   * Unlike the timer path ({@link handleHibernateTimeout}) it deliberately does
   * NOT re-arm the check-in chain: a force-hibernate keeps the strand down until
   * the caller drives the next wake on demand (push-delivered on mobile), so a
   * stray check-in timer must not bring it back up.
   *
   * @returns `true` if the strand was hibernated, `false` (no-op) for a realtime
   *   strand that never hibernates.
   */
  async forceHibernate(instance: StrandInstance): Promise<boolean> {
    if (!this.hibernates(instance)) {
      log('forceHibernate: strand %s is realtime; no-op', instance.strandId);
      return false;
    }
    // Cancel idle/hibernate + check-in timers BEFORE quiescing so nothing fights
    // the imperative hibernate (a stale hibernate timer firing on the quiesced
    // strand, or a check-in resuming a strand the caller wants kept down) — including
    // a chain an in-flight wake or probe would restore when it settles.
    this.clearTimers(instance.strandId);
    this.checkInsCancelledByWake.delete(instance.strandId);
    this.probes.delete(instance.strandId);
    this.runningCheckIns.delete(instance.strandId);
    await this.callbacks.onHibernate(instance.strandId);
    log('forceHibernate: strand %s hibernated (timers cancelled, not re-armed)', instance.strandId);
    return true;
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
    this.checkInsCancelledByWake.delete(strandId);
    this.probes.delete(strandId);
    this.runningCheckIns.delete(strandId);
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
      this.clearTimersForWake(strandId);
      // Fire-and-forget; force-wake awaiters see errors, so swallow (and log)
      // here to avoid an unhandled rejection on this best-effort path. The wake's
      // settle re-arms the timers for the state it leaves (see beginWake).
      void this.beginWake(instance).catch((err) => {
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
   * Force-wake a strand (an explicit or peer-sent wake). Works whether or not hibernation is
   * enabled; once the wake settles the strand has the timers its resulting state calls for
   * ({@link rearmAfterWake}).
   */
  async wakeStrand(instance: StrandInstance): Promise<void> {
    this.clearTimersForWake(instance.strandId);
    await this.beginWake(instance);
  }

  /**
   * Wake a strand for an on-demand probe (`CadreNode.serviceWake`), holding it until
   * {@link endProbe}: the probe's window runs after the wake settles and may re-hibernate the
   * strand, so the wake's settle arms nothing. Records whether a check-in chain was armed —
   * or already cancelled by a wake this one joins — so the end can restore it.
   */
  async probeWake(instance: StrandInstance): Promise<void> {
    const { strandId } = instance;
    const hadCheckInChain = this.checkInTimers.has(strandId) || this.checkInsCancelledByWake.has(strandId);
    this.probes.set(strandId, { hadCheckInChain });
    this.clearTimersForWake(strandId);
    await this.beginWake(instance);
  }

  /**
   * End a probe begun by {@link probeWake}, success or failure: arm the timers the strand's
   * state now calls for. A probe never creates a check-in chain, only restores one it
   * interrupted. No-op when the probe is no longer held (a force-hibernate or untrack during
   * it means "keep it down").
   */
  endProbe(instance: StrandInstance): void {
    const probe = this.probes.get(instance.strandId);
    if (!probe) return;
    this.probes.delete(instance.strandId);
    this.rearmAfterWake(instance, probe.hadCheckInChain);
  }

  /**
   * Begin a wake for a strand, or coalesce with one already in flight. Ensures
   * `onWake` runs at most once per concurrent wake — the returned promise is
   * shared by all overlapping callers and cleared once it settles. Force-wake
   * callers await it; activity-driven callers fire-and-forget. Success or failure,
   * the settle re-arms the strand's timers (unless a probe holds it), and a failure
   * then rejects.
   */
  private beginWake(instance: StrandInstance): Promise<void> {
    const { strandId } = instance;
    const existing = this.wakePromises.get(strandId);
    if (existing) {
      return existing;
    }

    const wake = (async () => {
      try {
        await this.callbacks.onWake(strandId);
      } finally {
        this.settleWake(instance);
      }
    })();
    this.wakePromises.set(strandId, wake);
    return wake;
  }

  private settleWake(instance: StrandInstance): void {
    const { strandId } = instance;
    const hadCheckInChain = this.checkInsCancelledByWake.delete(strandId);
    this.wakePromises.delete(strandId);
    if (!this.probes.has(strandId)) {
      this.rearmAfterWake(instance, hadCheckInChain);
    }
  }

  /**
   * {@link clearTimers} for a wake, first remembering an armed check-in so a wake that leaves
   * the strand hibernating can restore the chain. Only an ARMED chain is remembered: a strand
   * force-hibernated without one (the mobile background path) must not gain one from a wake,
   * and a check-in that is mid-run hands its chain to the wake when it returns
   * ({@link handCheckInChainToHolder}).
   */
  private clearTimersForWake(strandId: string): void {
    if (this.checkInTimers.has(strandId)) {
      this.checkInsCancelledByWake.add(strandId);
    }
    this.clearTimers(strandId);
  }

  /**
   * Leave a strand whose wake (or probe) settled with the timers its state calls for: the idle
   * countdown if it is live, or — if it reads `hibernating` again (a failed rebuild, or a probe
   * window that re-quiesced it) — the check-in chain it had before, at the base delay. A
   * strand that had no chain gains none, and one in any other state gets nothing.
   */
  private rearmAfterWake(instance: StrandInstance, hadCheckInChain: boolean): void {
    if (!this.config.enabled || !this.running) return;
    if (instance.status === 'hibernating') {
      // A hibernating strand has no idle countdown, e.g. one activity armed mid-probe.
      this.clearTimer(instance.strandId);
      if (hadCheckInChain) {
        log('Wake of strand %s left it hibernating; restoring its check-in chain', instance.strandId);
        this.scheduleCheckIn(instance);
      }
      return;
    }
    this.rearmIdleIfLive(instance);
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

    // Replace any existing check-in timer.
    this.clearCheckInTimer(strandId);

    const timer = setTimeout(() => {
      // Only ARMED check-ins stay in the map, so a wake during this run does not take it
      // for a chain to restore (see clearTimersForWake) — the run hands it over on return.
      this.checkInTimers.delete(strandId);
      void this.runCheckIn(instance, currentDelay);
    }, currentDelay);

    this.checkInTimers.set(strandId, { timer, instance });
    instance.nextCheckIn = new Date(Date.now() + currentDelay);
  }

  /**
   * Run a single check-in tick: invoke `onCheckIn` (a real resume → bounded
   * sync window → re-hibernate-if-idle cycle in `CadreNode`) and AWAIT it before
   * deciding the next step.
   *
   * - If a force-hibernate, untrack or stop cancelled the chain while it ran, stop.
   * - If a wake or probe holds the strand, hand the chain to it
   *   ({@link handCheckInChainToHolder}).
   * - If the strand woke during the check-in (`onCheckIn` left it non-
   *   `hibernating`), stop the chain and restart the idle countdown; the next
   *   hibernation restarts the chain at the base delay (backoff reset).
   * - Otherwise escalate the delay by `checkInBackoffFactor`, capped at
   *   `checkInMaxInterval`, and reschedule.
   */
  private async runCheckIn(instance: StrandInstance, currentDelay: number): Promise<void> {
    const { strandId, latencyHint } = instance;
    if (!this.running) return;

    log('Check-in for hibernating strand %s (delay=%dms)', strandId, currentDelay);
    this.runningCheckIns.add(strandId);

    try {
      await this.callbacks.onCheckIn(strandId);
    } catch (err) {
      // A failed check-in (e.g. resume threw) must not break the chain — log and
      // fall through to reschedule the next, longer-delayed attempt.
      log('onCheckIn failed for strand %s: %o', strandId, err);
    }

    if (!this.runningCheckIns.delete(strandId) || !this.running) {
      log('Check-in chain of strand %s was cancelled while it ran; not rescheduling', strandId);
      instance.nextCheckIn = undefined;
      return;
    }
    if (this.handCheckInChainToHolder(instance)) return;

    // The check-in either woke the strand (CadreNode left it active) or left it
    // hibernating. Inspect the shared instance the callback just mutated.
    if (instance.status !== 'hibernating') {
      log('Check-in woke strand %s; backoff resets on next hibernation', strandId);
      this.clearCheckInTimer(strandId);
      // The chain is stopping; drop the now-stale next-check-in advertisement so
      // `getStrand` doesn't report a phantom check-in for a strand that is awake.
      instance.nextCheckIn = undefined;
      this.rearmIdleIfLive(instance);
      return;
    }

    const timeouts = this.getTimeouts(latencyHint);
    const nextDelay = Math.min(
      currentDelay * timeouts.checkInBackoffFactor,
      timeouts.checkInMaxInterval
    );
    this.scheduleCheckIn(instance, nextDelay);
  }

  /**
   * Give a returning check-in's chain to a wake or probe that holds the strand, as if that
   * wake had cancelled an armed check-in: its settle ({@link settleWake}) or end
   * ({@link endProbe}) restores the chain at the base delay if the strand ends `hibernating`,
   * and starts the idle countdown if it ends live. The status the check-in left says nothing
   * yet: a check-in that failed before its rebuild leaves the strand to a wake still building
   * it (`starting`), and one that ends `hibernating` may be overtaken by a wake still in
   * flight. Deciding here would drop the chain if that wake then fails, or leave a check-in
   * armed on a strand it brings up.
   *
   * @returns whether a wake or probe took the chain.
   */
  private handCheckInChainToHolder(instance: StrandInstance): boolean {
    const { strandId } = instance;
    const probe = this.probes.get(strandId);
    if (probe) {
      probe.hadCheckInChain = true;
    } else if (this.wakePromises.has(strandId)) {
      this.checkInsCancelledByWake.add(strandId);
    } else {
      return false;
    }
    log('Check-in of strand %s returned while a wake holds it; the wake decides its timers', strandId);
    this.clearCheckInTimer(strandId);
    instance.nextCheckIn = undefined;
    return true;
  }

  /**
   * Start the idle countdown for a strand a check-in or wake left live. Activity recorded
   * while the runtime was still rebuilding found the strand neither idle nor active, so it
   * armed nothing — without this the strand would stay up until the next activity. Only for
   * a live status: a strand stopped or failed mid-rebuild must not gain a timer chain.
   */
  private rearmIdleIfLive(instance: StrandInstance): void {
    const live = instance.status === 'active' || instance.status === 'syncing';
    if (live && this.getTimeouts(instance.latencyHint).idleTimeout !== Infinity) {
      this.scheduleIdleTransition(instance);
    }
  }

  private clearTimer(strandId: string): void {
    const timer = this.timers.get(strandId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(strandId);
    }
  }

  private clearCheckInTimer(strandId: string): void {
    const pending = this.checkInTimers.get(strandId);
    if (pending) {
      clearTimeout(pending.timer);
      this.checkInTimers.delete(strandId);
      // `getStrand` must not advertise a check-in that is no longer scheduled.
      pending.instance.nextCheckIn = undefined;
    }
  }

  private clearTimers(strandId: string): void {
    this.clearTimer(strandId);
    this.clearCheckInTimer(strandId);
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
