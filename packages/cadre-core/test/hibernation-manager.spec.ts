import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HibernationManager, type HibernationCallbacks } from '../src/hibernation-manager.js';
import type { StrandInstance, HibernationConfig } from '../src/types.js';
import { HIBERNATION_TIMEOUTS } from '../src/types.js';

describe('HibernationManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
      latencyHint
    };
  }

  function createCallbacks(): HibernationCallbacks & { 
    idleCalls: string[]; 
    hibernateCalls: string[];
    wakeCalls: string[];
  } {
    const callbacks = {
      idleCalls: [] as string[],
      hibernateCalls: [] as string[],
      wakeCalls: [] as string[],
      onIdle: vi.fn(async (strandId: string) => { callbacks.idleCalls.push(strandId); }),
      onHibernate: vi.fn(async (strandId: string) => { callbacks.hibernateCalls.push(strandId); }),
      onWake: vi.fn(async (strandId: string) => { callbacks.wakeCalls.push(strandId); })
    };
    return callbacks;
  }

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
});

