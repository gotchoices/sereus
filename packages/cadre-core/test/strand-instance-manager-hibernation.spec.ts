import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

// Mock the heavy runtime dependencies so quiesce/resume can be exercised without
// standing up a real libp2p node or Quereus database. The real-node integration
// path is covered by strand-instance-manager.spec.ts; here we assert lifecycle
// bookkeeping (resource release + rehydration) only. `vi.mock` is hoisted above
// the imports above, so StrandInstanceManager loads against these doubles.
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const initialize = vi.fn(async () => {});
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop }));
  // Use a non-arrow implementation so `new StrandDatabase(...)` is constructable.
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize, close };
  });
  return { stop, close, initialize, createLibp2pNode, StrandDatabase };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

describe('StrandInstanceManager quiesce/resume (hibernation)', () => {
  let authorPrivateKey: string;
  let authorPublicKey: string;

  const testSchema = 'create table Test (id text primary key);';
  const testVersion = '1.0.0';

  beforeEach(() => {
    vi.clearAllMocks();
    authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  function createStrandRow(id: string): StrandRow {
    return { Id: id, MemberPrivateKey: null, Type: 'o' };
  }

  function createSAppConfig(): SAppConfig {
    return {
      id: authorPublicKey,
      version: testVersion,
      schema: testSchema,
      signature: signSchema(testSchema, testVersion, authorPrivateKey)
    };
  }

  function createStartConfig(strandId: string, overrides?: Partial<StartStrandConfig>): StartStrandConfig {
    return {
      strandRow: createStrandRow(strandId),
      sAppConfig: createSAppConfig(),
      profile: 'transaction',
      defaultLatencyHint: 'interactive',
      ...overrides
    };
  }

  it('quiesce releases node + db but retains the instance record', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('q-strand'));

    expect(instance.status).toBe('active');
    expect(instance.libp2pNode).toBeDefined();
    expect(instance.database).toBeDefined();

    await manager.quiesceStrand('q-strand');

    // Instance is still tracked, but its resources have been released.
    expect(manager.hasStrand('q-strand')).toBe(true);
    expect(instance.libp2pNode).toBeUndefined();
    expect(instance.database).toBeUndefined();
    expect(instance.connectedPeers).toBe(0);
    // Identity/metadata survive for rehydration.
    expect(instance.strandId).toBe('q-strand');
    expect(instance.sAppInfo?.id).toBe(authorPublicKey);

    // Underlying stop()/close() were each called exactly once.
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('quiesce on an already-quiesced strand is a no-op', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('q-twice'));

    await manager.quiesceStrand('q-twice');
    await manager.quiesceStrand('q-twice');

    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('resume rebuilds node + db and returns to active, applying override seed/mode', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('r-strand'));

    await manager.quiesceStrand('r-strand');
    expect(instance.libp2pNode).toBeUndefined();

    const seed = ['/ip4/9.9.9.9/tcp/4001/p2p/QmPeer'];
    const resumed = await manager.resumeStrand('r-strand', { bootstrapNodes: seed, mode: 'networked' });

    expect(resumed).toBe(instance);
    expect(resumed.status).toBe('active');
    expect(resumed.libp2pNode).toBeDefined();
    expect(resumed.database).toBeDefined();

    // The runtime is rebuilt (createLibp2pNode called a second time) with the
    // freshly-resolved bootstrap seed.
    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ bootstrapNodes: seed })
    );
  });

  it('resume rejects when the strand is not tracked', async () => {
    const manager = new StrandInstanceManager();
    await expect(manager.resumeStrand('ghost')).rejects.toThrow(/not tracked/);
  });

  it('resume returns the live instance unchanged when not quiesced', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('live-strand'));

    const result = await manager.resumeStrand('live-strand');

    expect(result).toBe(instance);
    // No rebuild happened — createLibp2pNode still only called once (the start).
    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(1);
  });

  it('stopStrand after quiesce removes the instance and clears the retained launch config', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('stop-after-quiesce'));

    await manager.quiesceStrand('stop-after-quiesce');
    // stopStrand must cleanly no-op the already-released handles.
    await manager.stopStrand('stop-after-quiesce');

    expect(manager.hasStrand('stop-after-quiesce')).toBe(false);
    // Launch config was cleared: a resume can no longer find it (instance gone).
    await expect(manager.resumeStrand('stop-after-quiesce')).rejects.toThrow(/not tracked/);
    // stop()/close() were only the single pair from quiesce — stopStrand had
    // nothing left to tear down.
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
