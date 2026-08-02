/**
 * The `withConnectedNode` branches a real node cannot produce.
 *
 * `one-shot-node.spec.ts` covers the happy shape against a genuinely booting node. The paths
 * left over are the ones that need a node that misbehaves on demand: a `start()` that never
 * connects, one that settles after the timeout already fired, and a `stop()` that fails. A real
 * `CadreNode` reaches none of them — `start()` emits `control:connected` at the end of start
 * without the event loop returning to the timers phase, so even a `timeoutMs` of 0 runs the
 * action (measured: 0, 1, 5, 20 and 60 ms all completed normally).
 *
 * Only the node class is swapped. `resolveConfig` — and with it the real
 * `validatePushCredentials`, key loading and `parseStrandFilter` — runs unmocked, which is why
 * every test writes an actual config file to disk.
 *
 * The late-settle tests are the reason this file exists. `withConnectedNode` awaits `start()`
 * and the timeout together in one `Promise.all`; awaiting them in sequence would leave the
 * timeout's rejection with no handler attached, and Node turns an unhandled rejection into a
 * process crash — taking down the operator's command along with the very message the timeout
 * exists to print. That regression is invisible to an assertion on the thrown error (which is
 * the same either way), so those tests watch `process.on('unhandledRejection')` instead.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The fake node's behaviour, reachable from the `vi.mock` factory at call time.
 *
 * `vi.mock` is hoisted above the imports, so the factory cannot close over anything declared
 * normally — `vi.hoisted` is the same escape hatch `subcommand-wiring.spec.ts` uses for its
 * shared node handle. Each field is reassigned per test; `beforeEach` puts them back.
 */
const fake = vi.hoisted(() => ({
  /** What `start()` does. `emit` fires `control:connected` on the node under test. */
  start: async (emit: () => void): Promise<void> => { emit(); },
  /** What `stop()` does, after the call has been counted. */
  stop: async (): Promise<void> => { /* a clean shutdown by default */ },
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock('@serfab/cadre-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@serfab/cadre-core')>();

  /** Everything `withConnectedNode` touches on a node, and nothing else. */
  class FakeCadreNode {
    private readonly handlers = new Map<string, () => void>();

    constructor(_config: unknown) { /* the config is `oneShotNodeConfig`'s concern, not this fake's */ }

    on(event: string, handler: () => void): void {
      this.handlers.set(event, handler);
    }

    async start(): Promise<void> {
      fake.startCalls += 1;
      await fake.start(() => this.handlers.get('control:connected')?.());
    }

    async stop(): Promise<void> {
      fake.stopCalls += 1;
      await fake.stop();
    }
  }

  return { ...actual, CadreNode: FakeCadreNode };
});

const { withConnectedNode } = await import('../src/commands/node-session.js');

/** Short enough that a whole file of timeout tests stays cheap, long enough not to race. */
const TIMEOUT_MS = 50;

/** How long after `TIMEOUT_MS` a late `start()` settles — well clear of the timer. */
const LATE_SETTLE_MS = 200;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string;
let configPath: string;

beforeEach(() => {
  fake.start = async (emit) => { emit(); };
  fake.stop = async () => { /* clean */ };
  fake.startCalls = 0;
  fake.stopCalls = 0;

  // A real file, because `resolveConfig` is not mocked. Memory storage keeps it self-contained;
  // nothing here ever constructs the storage provider anyway.
  dir = mkdtempSync(join(tmpdir(), 'cadre-node-session-'));
  configPath = join(dir, 'cadre.json');
  writeFileSync(configPath, JSON.stringify({
    controlNetwork: { partyId: 'node-session-branches', bootstrapNodes: [] },
    profile: 'transaction',
    storage: { type: 'memory' },
    network: { listenAddrs: [] },
  }), 'utf8');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `body` with an `unhandledRejection` watcher installed, and report whether one fired.
 *
 * vitest installs its own handler, so this listener is additive — it observes, it does not
 * change what the process would have done. Removed in a `finally`: a leaked listener would
 * attribute a later test's rejection to this one.
 */
async function withUnhandledRejectionWatch(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    await body();
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('withConnectedNode connect timeout', () => {
  it('rejects with the timeout, never runs the action, and still stops the node', async () => {
    // Never settles and never connects: the timer is the only thing that can end this.
    fake.start = () => new Promise<void>(() => { /* hangs for the life of the test */ });
    let actionRuns = 0;

    await expect(withConnectedNode(configPath, async () => { actionRuns += 1; }, TIMEOUT_MS))
      .rejects.toThrow(`Timed out after ${TIMEOUT_MS}ms connecting to the control network`);

    expect(actionRuns).toBe(0);
    // The node was constructed and started, so it has resources to release even though it never
    // finished connecting — the `finally` has to reach it.
    expect(fake.startCalls).toBe(1);
    expect(fake.stopCalls).toBe(1);
  });
});

describe('withConnectedNode when start() outlives the timeout', () => {
  it('does not leave the timeout rejection unhandled when start() resolves late', async () => {
    fake.start = async (emit) => {
      await delay(LATE_SETTLE_MS);
      // A connection that lands after the caller has already given up: the resolve is a no-op
      // on a promise that rejected, but the sequencing is what the guard is about.
      emit();
    };

    const unhandled = await withUnhandledRejectionWatch(async () => {
      await expect(withConnectedNode(configPath, async () => { /* unreachable */ }, TIMEOUT_MS))
        .rejects.toThrow('Timed out after');
      // Past the late settle, plus a margin — an unhandled rejection is reported at the end of
      // the turn that orphaned it, so it has to be given the chance to fire.
      await delay(LATE_SETTLE_MS);
    });

    expect(unhandled).toEqual([]);
    expect(fake.stopCalls).toBe(1);
  });

  it('does not leave either rejection unhandled when start() rejects late', async () => {
    fake.start = async () => {
      await delay(LATE_SETTLE_MS);
      throw new Error('libp2p failed to start, slowly');
    };

    const unhandled = await withUnhandledRejectionWatch(async () => {
      // The timeout fires first, so the timeout is what the operator is told about; the late
      // start failure is handled by the same `Promise.all` rather than orphaned.
      await expect(withConnectedNode(configPath, async () => { /* unreachable */ }, TIMEOUT_MS))
        .rejects.toThrow('Timed out after');
      await delay(LATE_SETTLE_MS);
    });

    expect(unhandled).toEqual([]);
    expect(fake.stopCalls).toBe(1);
  });
});

describe('withConnectedNode teardown', () => {
  it('runs the action once connected and stops afterwards', async () => {
    let actionRuns = 0;

    await withConnectedNode(configPath, async () => { actionRuns += 1; }, TIMEOUT_MS);

    expect(actionRuns).toBe(1);
    expect(fake.stopCalls).toBe(1);
  });

  it('stops the node and propagates the action error unchanged when the action throws', async () => {
    const failure = new Error('control-database write refused');

    await expect(withConnectedNode(configPath, async () => { throw failure; }, TIMEOUT_MS))
      .rejects.toBe(failure);

    expect(fake.stopCalls).toBe(1);
  });

  it('warns about the dirty shutdown but still propagates the action error', async () => {
    // Both halves fail. The action's error is the one the operator has to see — a teardown
    // failure replacing it would report "did not shut down cleanly" for a command that in fact
    // refused a write, and the exit code would say nothing about which.
    const failure = new Error('control-database write refused');
    fake.stop = async () => { throw new Error('libp2p hung on shutdown'); };
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });

    await expect(withConnectedNode(configPath, async () => { throw failure; }, TIMEOUT_MS))
      .rejects.toBe(failure);

    expect(errors.join('\n')).toContain('Warning: node did not shut down cleanly: libp2p hung on shutdown');
  });

  it('warns and propagates nothing when only stop() fails', async () => {
    fake.stop = async () => { throw new Error('libp2p hung on shutdown'); };
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });

    // A shutdown that failed after the work landed is a warning, not a failed command: the
    // control-database write already happened, so a non-zero exit would be a lie.
    await expect(withConnectedNode(configPath, async () => { /* succeeds */ }, TIMEOUT_MS))
      .resolves.toBeUndefined();

    expect(errors.join('\n')).toContain('Warning: node did not shut down cleanly:');
  });
});
