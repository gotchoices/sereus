import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
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

const testSchema = 'create table Test (id text primary key);';
const testVersion = '1.0.0';

let authorPrivateKey: string;
let authorPublicKey: string;

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

/** Config object handed to the most recent `createLibp2pNode` call. */
function lastCreateLibp2pNodeArgs(): { privateKey?: { raw: Uint8Array }; bootstrapNodes: string[] } {
  const calls = mocks.createLibp2pNode.mock.calls as unknown[][];
  return calls[calls.length - 1]![0] as { privateKey?: { raw: Uint8Array }; bootstrapNodes: string[] };
}

describe('StrandInstanceManager quiesce/resume (hibernation)', () => {
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

  it('resume that fails to rebuild rolls back the partial runtime, so a later resume retries', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('flaky-strand'));

    await manager.quiesceStrand('flaky-strand');
    expect(instance.libp2pNode).toBeUndefined();

    // The libp2p node comes up, but StrandDatabase.initialize() throws — the
    // failure mode that previously left the node attached (leaked) and the
    // instance falsely "already live".
    mocks.initialize.mockRejectedValueOnce(new Error('schema apply boom'));
    await expect(
      manager.resumeStrand('flaky-strand', { bootstrapNodes: [], mode: 'networked' })
    ).rejects.toThrow(/schema apply boom/);

    // Rolled back to a fully-released state: neither handle attached, status error.
    expect(instance.libp2pNode).toBeUndefined();
    expect(instance.database).toBeUndefined();
    expect(instance.status).toBe('error');
    // The node built during the failed resume was stopped (no leak): one stop
    // for the quiesce + one for the rollback.
    expect(mocks.stop).toHaveBeenCalledTimes(2);

    // A subsequent resume actually rebuilds (not a false "already live" return).
    const resumed = await manager.resumeStrand('flaky-strand', { bootstrapNodes: [], mode: 'networked' });
    expect(resumed.status).toBe('active');
    expect(resumed.libp2pNode).toBeDefined();
    expect(resumed.database).toBeDefined();
    // start (1) + failed resume (2) + successful resume (3).
    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(3);
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

describe('StrandInstanceManager resume transport identity', () => {
  // The strand's libp2p node peerId is derived once at launch from `config.privateKey`
  // (see cadre-node.ts's per-strand key derivation, pinned separately in
  // cadre-node-strand-launch-key.spec.ts). Waking a hibernated strand must rebuild
  // the runtime with that SAME key — any relay reservation or peer-store entry
  // recorded under the old peerId goes stale the moment resume hands libp2p a
  // different one. These tests pin `resumeStrand`'s reuse of the retained key.
  it('resume rebuilds the libp2p node with the same private key it launched with', async () => {
    const transportKey = await generateKeyPair('Ed25519');
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('key-strand', { privateKey: transportKey }));
    expect(lastCreateLibp2pNodeArgs().privateKey?.raw).toEqual(transportKey.raw);

    await manager.quiesceStrand('key-strand');
    await manager.resumeStrand('key-strand');

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(lastCreateLibp2pNodeArgs().privateKey?.raw).toEqual(transportKey.raw);
  });

  it('resume overrides (bootstrap addrs, mode) replace only those fields, leaving the key untouched', async () => {
    const transportKey = await generateKeyPair('Ed25519');
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('key-strand-override', {
      privateKey: transportKey,
      bootstrapNodes: ['/ip4/1.1.1.1/tcp/4001/p2p/QmOld'],
      mode: 'bootstrap'
    }));

    await manager.quiesceStrand('key-strand-override');
    const seed = ['/ip4/9.9.9.9/tcp/4001/p2p/QmNew'];
    await manager.resumeStrand('key-strand-override', { bootstrapNodes: seed, mode: 'networked' });

    const args = lastCreateLibp2pNodeArgs();
    expect(args.privateKey?.raw).toEqual(transportKey.raw);
    expect(args.bootstrapNodes).toEqual(seed);
  });

  it('the key survives repeated hibernate/wake cycles, not just the first', async () => {
    // resumeStrand REPLACES the retained launch config with its merged resumeConfig,
    // so cycle N+1 rebuilds from cycle N's output. A merge that lost the key would
    // still pass a single-cycle test if the loss only showed on the rewritten config.
    const transportKey = await generateKeyPair('Ed25519');
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('key-strand-cycles', { privateKey: transportKey }));

    for (const seed of [['/ip4/2.2.2.2/tcp/4001/p2p/QmA'], ['/ip4/3.3.3.3/tcp/4001/p2p/QmB']]) {
      await manager.quiesceStrand('key-strand-cycles');
      await manager.resumeStrand('key-strand-cycles', { bootstrapNodes: seed, mode: 'networked' });
      const args = lastCreateLibp2pNodeArgs();
      expect(args.bootstrapNodes).toEqual(seed);
      expect(args.privateKey?.raw).toEqual(transportKey.raw);
    }

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(3);
  });

  it('a strand launched with no private key resumes with none', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('no-key-strand'));
    expect(lastCreateLibp2pNodeArgs().privateKey).toBeUndefined();

    await manager.quiesceStrand('no-key-strand');
    await manager.resumeStrand('no-key-strand');

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(lastCreateLibp2pNodeArgs().privateKey).toBeUndefined();
  });

  it('fully stopping a strand drops the retained config, so a later launch does not inherit the old key', async () => {
    const oldKey = await generateKeyPair('Ed25519');
    const newKey = await generateKeyPair('Ed25519');
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('stop-then-relaunch', { privateKey: oldKey }));

    await manager.quiesceStrand('stop-then-relaunch');
    await manager.stopStrand('stop-then-relaunch');

    // Resume must not silently rehydrate the stopped strand from the dropped config.
    await expect(manager.resumeStrand('stop-then-relaunch')).rejects.toThrow(/not tracked/);

    // A fresh launch under the same strand id gets ITS OWN key, not the retained one.
    await manager.startStrand(createStartConfig('stop-then-relaunch', { privateKey: newKey }));
    expect(lastCreateLibp2pNodeArgs().privateKey?.raw).toEqual(newKey.raw);
    expect(lastCreateLibp2pNodeArgs().privateKey?.raw).not.toEqual(oldKey.raw);
  });
});
