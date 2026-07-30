import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HibernationManager, type HibernationCallbacks } from '../src/hibernation-manager.js';
import type { StrandInstance, HibernationConfig } from '../src/types.js';
import { HIBERNATION_TIMEOUTS } from '../src/types.js';

describe('HibernationManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the fake clock to 0 so the check-in backoff tests can assert absolute
    // `nextCheckIn` timestamps (Date.now() otherwise starts at the real epoch).
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createInstance(strandId: string, latencyHint: StrandInstance['latencyHint'] = 'interactive'): StrandInstance {
    return {
      strandId,
      status: 'active',
      connectedPeers: 0,
      lastActivity: new Date(),
      latencyHint,
      mode: 'networked'
    };
  }

  function createCallbacks() {
    const callbacks = {
      idleCalls: [] as string[],
      hibernateCalls: [] as string[],
      wakeCalls: [] as string[],
      checkInCalls: [] as string[],
      onIdle: vi.fn(async (strandId: string) => { callbacks.idleCalls.push(strandId); }),
      onHibernate: vi.fn(async (strandId: string) => { callbacks.hibernateCalls.push(strandId); }),
      onWake: vi.fn(async (strandId: string) => { callbacks.wakeCalls.push(strandId); }),
      onCheckIn: vi.fn(async (strandId: string) => { callbacks.checkInCalls.push(strandId); })
    };
    return callbacks;
  }

  /**
   * Small fast timeouts for the check-in backoff tests so a few escalations and
   * the cap plateau cover only a few thousand fake ms. base=100, factor=2,
   * cap=800 → delays 100, 200, 400, 800, 800, …
   */
  const FAST_BACKOFF: HibernationConfig = {
    enabled: true,
    customTimeouts: {
      interactive: {
        idleTimeout: 1000,
        hibernateTimeout: 1000,
        checkInInterval: 100,
        checkInBackoffFactor: 2,
        checkInMaxInterval: 800
      }
    }
  };

  describe('constructor', () => {
    it('should create disabled manager by default', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: false }, callbacks);
      
      const status = manager.getStatus();
      expect(status.enabled).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should start and stop cleanly', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      
      manager.start();
      expect(manager.getStatus().enabled).toBe(true);
      
      manager.stop();
      expect(manager.getStatus().enabled).toBe(false);
    });
  });

  describe('tracking strands', () => {
    it('should not track when disabled', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: false }, callbacks);
      manager.start();
      
      const instance = createInstance('strand-1');
      manager.trackStrand(instance);
      
      expect(manager.getStatus().trackedStrands).toBe(0);
      manager.stop();
    });

    it('should not track realtime strands', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();
      
      const instance = createInstance('strand-1', 'realtime');
      manager.trackStrand(instance);
      
      // Realtime strands never hibernate
      expect(manager.getStatus().trackedStrands).toBe(0);
      manager.stop();
    });

    it('should track non-realtime strands', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();
      
      const instance = createInstance('strand-1', 'interactive');
      manager.trackStrand(instance);
      
      expect(manager.getStatus().trackedStrands).toBe(1);
      manager.stop();
    });
  });

  describe('idle transitions', () => {
    it('should transition to idle after timeout', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();
      
      const instance = createInstance('strand-1', 'interactive');
      manager.trackStrand(instance);
      
      // Fast forward past idle timeout
      const timeouts = HIBERNATION_TIMEOUTS.interactive;
      await vi.advanceTimersByTimeAsync(timeouts.idleTimeout + 100);
      
      expect(callbacks.idleCalls).toContain('strand-1');
      manager.stop();
    });

    it('should not transition realtime strands', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();
      
      const instance = createInstance('strand-1', 'realtime');
      manager.trackStrand(instance);
      
      // Fast forward a long time
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour
      
      expect(callbacks.idleCalls).not.toContain('strand-1');
      manager.stop();
    });
  });

  describe('activity recording', () => {
    it('should reset idle timer on activity', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();
      
      const instance = createInstance('strand-1', 'interactive');
      manager.trackStrand(instance);
      
      const timeouts = HIBERNATION_TIMEOUTS.interactive;
      
      // Fast forward to just before idle timeout
      await vi.advanceTimersByTimeAsync(timeouts.idleTimeout - 1000);
      expect(callbacks.idleCalls).not.toContain('strand-1');
      
      // Record activity - should reset timer
      manager.recordActivity(instance);
      
      // Fast forward again to just before new idle timeout
      await vi.advanceTimersByTimeAsync(timeouts.idleTimeout - 1000);
      expect(callbacks.idleCalls).not.toContain('strand-1');

      manager.stop();
    });
  });

  describe('hibernate + wake coalescing', () => {
    it('fires onHibernate after idle+hibernate timeouts', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();

      const instance = createInstance('strand-hib', 'interactive');
      manager.trackStrand(instance);

      const timeouts = HIBERNATION_TIMEOUTS.interactive;

      // Drive past the idle timeout, then past the hibernate timeout.
      await vi.advanceTimersByTimeAsync(timeouts.idleTimeout + 100);
      expect(callbacks.idleCalls).toContain('strand-hib');

      await vi.advanceTimersByTimeAsync(timeouts.hibernateTimeout + 100);
      expect(callbacks.hibernateCalls).toContain('strand-hib');

      manager.stop();
    });

    it('a rejecting onHibernate is caught (no unhandled rejection, no check-in scheduled)', async () => {
      const callbacks = createCallbacks();
      // onHibernate now releases resources and can reject (e.g. db.close throws).
      callbacks.onHibernate.mockRejectedValueOnce(new Error('quiesce boom'));
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();

      const instance = createInstance('strand-reject', 'interactive');
      manager.trackStrand(instance);

      const timeouts = HIBERNATION_TIMEOUTS.interactive;
      // Driving past idle + hibernate must not throw despite the rejected wake.
      await vi.advanceTimersByTimeAsync(timeouts.idleTimeout + timeouts.hibernateTimeout + 200);

      // The rejection was swallowed: tracking state stays consistent and the
      // manager is still usable (the failed hibernate just skipped check-in setup).
      expect(callbacks.onHibernate).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().enabled).toBe(true);

      manager.stop();
    });

    it('fires onWake exactly once for two near-simultaneous activities', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();

      const instance = createInstance('strand-hib', 'interactive');
      manager.trackStrand(instance);

      const timeouts = HIBERNATION_TIMEOUTS.interactive;
      await vi.advanceTimersByTimeAsync(timeouts.idleTimeout + timeouts.hibernateTimeout + 200);
      expect(callbacks.hibernateCalls).toContain('strand-hib');

      // The real CadreNode hibernate callback marks the instance hibernating; the
      // mock here only records calls, so simulate that state transition.
      instance.status = 'hibernating';

      // Two activities arriving back-to-back (before the wake settles) must
      // coalesce into a single onWake — otherwise two libp2p nodes get built.
      manager.recordActivity(instance);
      manager.recordActivity(instance);

      // Let the in-flight wake settle (and its cleanup run).
      await vi.advanceTimersByTimeAsync(0);

      expect(callbacks.wakeCalls).toEqual(['strand-hib']);
      expect(callbacks.onWake).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it('force wakeStrand coalesces with an in-flight activity wake', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();

      const instance = createInstance('strand-hib', 'interactive');
      manager.trackStrand(instance);
      instance.status = 'hibernating';

      // Kick off an activity-driven wake, then force-wake before it settles.
      manager.recordActivity(instance);
      await manager.wakeStrand('strand-hib');

      expect(callbacks.onWake).toHaveBeenCalledTimes(1);

      manager.stop();
    });
  });

  describe('hibernates (realtime predicate)', () => {
    it('is false for realtime, true for non-realtime hints', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);

      expect(manager.hibernates(createInstance('rt', 'realtime'))).toBe(false);
      expect(manager.hibernates(createInstance('ix', 'interactive'))).toBe(true);
      expect(manager.hibernates(createInstance('bg', 'background'))).toBe(true);
      expect(manager.hibernates(createInstance('ar', 'archive'))).toBe(true);
    });

    it('honours a customTimeouts override that makes a hint never hibernate', () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager(
        { enabled: true, customTimeouts: { background: { idleTimeout: Infinity } } },
        callbacks
      );
      expect(manager.hibernates(createInstance('bg', 'background'))).toBe(false);
    });
  });

  describe('forceHibernate (imperative background-entry)', () => {
    it('cancels pending idle/hibernate timers and does not re-arm check-ins (no resurrection)', async () => {
      const callbacks = createCallbacks();
      callbacks.onHibernate.mockImplementation(async (id: string) => {
        callbacks.hibernateCalls.push(id);
        instance.status = 'hibernating';
      });
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();

      const instance = createInstance('strand-force', 'interactive');
      manager.trackStrand(instance); // arms the idle transition

      const hibernated = await manager.forceHibernate(instance);
      expect(hibernated).toBe(true);
      expect(callbacks.onHibernate).toHaveBeenCalledTimes(1);
      expect(instance.status).toBe('hibernating');

      // Advance well past idle + hibernate + several check-in intervals. Because
      // forceHibernate cancelled the timers and armed NO check-in, nothing fires:
      // no second hibernate, no check-in resurrecting the strand.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(callbacks.onHibernate).toHaveBeenCalledTimes(1);
      expect(callbacks.onCheckIn).not.toHaveBeenCalled();
      expect(instance.status).toBe('hibernating');

      manager.stop();
    });

    it('is a no-op (returns false, no onHibernate) for a realtime strand', async () => {
      const callbacks = createCallbacks();
      const manager = new HibernationManager({ enabled: true }, callbacks);
      manager.start();

      const instance = createInstance('strand-rt', 'realtime');
      const hibernated = await manager.forceHibernate(instance);

      expect(hibernated).toBe(false);
      expect(callbacks.onHibernate).not.toHaveBeenCalled();
      expect(instance.status).toBe('active');

      manager.stop();
    });
  });

  describe('check-in backoff', () => {
    /**
     * Drive a tracked interactive strand (FAST_BACKOFF) through idle@1000 +
     * hibernate@2000. Stops at 2050 — the first check-in (armed @2100) has NOT
     * fired yet.
     */
    async function driveToHibernating(): Promise<void> {
      await vi.advanceTimersByTimeAsync(2050);
    }

    it('escalates the check-in delay per no-activity check-in and advances nextCheckIn, capped at the per-hint ceiling', async () => {
      // onHibernate marks hibernating (mirrors CadreNode); onCheckIn leaves the
      // strand hibernating → the manager treats every tick as "no activity".
      const instance = createInstance('strand-backoff', 'interactive');
      const callbacks = createCallbacks();
      callbacks.onHibernate.mockImplementation(async (id: string) => {
        callbacks.hibernateCalls.push(id);
        instance.status = 'hibernating';
      });

      const manager = new HibernationManager(FAST_BACKOFF, callbacks);
      manager.start();
      manager.trackStrand(instance);

      await driveToHibernating();
      expect(callbacks.onHibernate).toHaveBeenCalledTimes(1);
      expect(instance.status).toBe('hibernating');
      // First check-in armed at base (100ms) after hibernation (@2000) → 2100.
      expect(instance.nextCheckIn?.getTime()).toBe(2100);

      // Tick 1 @2100 (delay 100): reschedule at +200 → 2300.
      await vi.advanceTimersByTimeAsync(100);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(1);
      expect(instance.nextCheckIn?.getTime()).toBe(2300);

      // Tick 2 @2300 (delay 200): reschedule at +400 → 2700.
      await vi.advanceTimersByTimeAsync(200);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(2);
      expect(instance.nextCheckIn?.getTime()).toBe(2700);

      // Tick 3 @2700 (delay 400): reschedule at +800 (= cap) → 3500.
      await vi.advanceTimersByTimeAsync(400);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(3);
      expect(instance.nextCheckIn?.getTime()).toBe(3500);

      // Tick 4 @3500 (delay 800 = cap): next delay min(1600, 800) stays 800 → 4300.
      await vi.advanceTimersByTimeAsync(800);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(4);
      expect(instance.nextCheckIn?.getTime()).toBe(4300);

      // Tick 5 @4300 (delay 800): cap plateau holds → 5100.
      await vi.advanceTimersByTimeAsync(800);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(5);
      expect(instance.nextCheckIn?.getTime()).toBe(5100);

      manager.stop();
    });

    it('awaits onCheckIn before scheduling the next tick (a slow check-in never overlaps)', async () => {
      const instance = createInstance('strand-slow', 'interactive');
      const callbacks = createCallbacks();
      callbacks.onHibernate.mockImplementation(async (id: string) => {
        callbacks.hibernateCalls.push(id);
        instance.status = 'hibernating';
      });

      let inFlight = 0;
      let maxConcurrent = 0;
      let releaseCheckIn: (() => void) | null = null;
      // A check-in that blocks until we release it.
      callbacks.onCheckIn.mockImplementation((id: string) => {
        callbacks.checkInCalls.push(id);
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        return new Promise<void>((resolve) => {
          releaseCheckIn = () => { inFlight--; resolve(); };
        });
      });

      const manager = new HibernationManager(FAST_BACKOFF, callbacks);
      manager.start();
      manager.trackStrand(instance);

      // Hibernate + fire the first check-in (which now blocks).
      await vi.advanceTimersByTimeAsync(2150);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(1);

      // Advance well past several base intervals: because the manager awaits the
      // in-flight check-in, NO further tick may schedule or fire.
      await vi.advanceTimersByTimeAsync(2000);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(1);
      expect(maxConcurrent).toBe(1);

      // Release it → the next tick (escalated delay 200) schedules and fires.
      releaseCheckIn!();
      await vi.advanceTimersByTimeAsync(300);
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(2);
      expect(maxConcurrent).toBe(1);

      // Release the second so its reschedule is clean before teardown.
      releaseCheckIn!();
      await vi.advanceTimersByTimeAsync(0);

      manager.stop();
    });

    it('a check-in that wakes the strand resets backoff to base on the next hibernation', async () => {
      const hibTimes: number[] = [];
      const checkInTimes: number[] = [];
      let wakeThisCheckIn = false;

      const instance = createInstance('strand-reset', 'interactive');

      const callbacks: HibernationCallbacks = {
        onIdle: vi.fn(async () => { instance.status = 'idle'; }),
        onHibernate: vi.fn(async () => { instance.status = 'hibernating'; hibTimes.push(Date.now()); }),
        onWake: vi.fn(async () => { instance.status = 'active'; }),
        onCheckIn: vi.fn(async () => {
          checkInTimes.push(Date.now());
          if (wakeThisCheckIn) {
            // Simulate the app recording activity during the window: the strand
            // stays active and the idle timer is re-armed (the real activity path).
            instance.status = 'active';
            manager.recordActivity(instance);
          }
        })
      };

      const manager = new HibernationManager(FAST_BACKOFF, callbacks);
      manager.start();
      manager.trackStrand(instance);

      // First hibernation cycle (hib1 @2000). Two no-activity check-ins escalate.
      await vi.advanceTimersByTimeAsync(2050);  // hib1, first check-in armed @2100
      await vi.advanceTimersByTimeAsync(100);   // tick @2100 (delay 100) → resched @2300
      await vi.advanceTimersByTimeAsync(200);   // tick @2300 (delay 200) → resched @2700
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(2);

      // Third check-in finds activity → wakes; manager stops the check-in chain.
      wakeThisCheckIn = true;
      await vi.advanceTimersByTimeAsync(400);   // tick @2700 (delay 400) → active + idle re-armed @3700
      expect(instance.status).toBe('active');
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(3);

      // Second hibernation cycle: idle@3700 → hib2@4700 → first check-in @4800.
      wakeThisCheckIn = false;
      await vi.advanceTimersByTimeAsync(2200);  // reach the first cycle-2 check-in
      expect(hibTimes).toHaveLength(2);

      const cycle2First = checkInTimes.find(t => t > hibTimes[1]!)!;
      // Reset proves out: base (100) again, NOT the escalated 800 the chain
      // would have continued with had backoff not reset on the new hibernation.
      expect(cycle2First - hibTimes[1]!).toBe(100);

      manager.stop();
    });

    it('re-arms the idle→hibernate cycle after an activity-driven wake', async () => {
      const instance = createInstance('strand-rearm', 'interactive');
      const callbacks = createCallbacks();
      // The real wake transitions the strand to active (CadreNode does this);
      // the default mock only records the call.
      callbacks.onWake.mockImplementation(async (id: string) => {
        callbacks.wakeCalls.push(id);
        instance.status = 'active';
      });

      const manager = new HibernationManager(FAST_BACKOFF, callbacks);
      manager.start();
      manager.trackStrand(instance);
      // Simulate a hibernated strand (mock onHibernate would not flip status).
      instance.status = 'hibernating';

      // Activity wakes it.
      manager.recordActivity(instance);
      await vi.advanceTimersByTimeAsync(0); // let the wake settle + re-arm
      expect(callbacks.wakeCalls).toEqual(['strand-rearm']);
      expect(instance.status).toBe('active');

      // The idle timer was re-armed: after idleTimeout (1000) it goes idle again,
      // so the strand can hibernate → check-in afresh rather than staying active.
      await vi.advanceTimersByTimeAsync(1000 + 10);
      expect(callbacks.idleCalls).toContain('strand-rearm');

      manager.stop();
    });

    it('a throwing onCheckIn does not break the chain (the next tick still fires)', async () => {
      const instance = createInstance('strand-throw', 'interactive');
      const callbacks = createCallbacks();
      callbacks.onHibernate.mockImplementation(async (id: string) => {
        callbacks.hibernateCalls.push(id);
        instance.status = 'hibernating';
      });
      // First check-in rejects (e.g. resume threw); later check-ins record.
      callbacks.onCheckIn
        .mockRejectedValueOnce(new Error('resume boom'))
        .mockImplementation(async (id: string) => { callbacks.checkInCalls.push(id); });

      const manager = new HibernationManager(FAST_BACKOFF, callbacks);
      manager.start();
      manager.trackStrand(instance);

      await vi.advanceTimersByTimeAsync(2050); // hibernating, first check-in armed @2100
      await vi.advanceTimersByTimeAsync(100);  // tick 1 @2100 throws → still reschedules @2300
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);  // tick 2 @2300 succeeds
      expect(callbacks.onCheckIn).toHaveBeenCalledTimes(2);
      expect(instance.status).toBe('hibernating');

      manager.stop();
    });
  });
});

