import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { MemoryRawStorage, defaultCachePool, type IRawStorage } from '@optimystic/db-p2p/rn';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

/**
 * A strand instance OWNS one resolved raw storage for its lifetime.
 *
 * `buildStrandRuntime` used to call the embedder's storage provider itself, and it
 * runs on both `startStrand` and `resumeStrand` — so a hibernation wake got a second
 * `IRawStorage` over the same durable backend. Three consequences, all pinned below:
 * the provider saw two calls for one strand, the rebuilt libp2p node was handed a
 * different store than the first build, and (on the in-memory backend a `--storage
 * memory` CLI run and this suite both use) the strand's blocks vanished on resume.
 * The fourth test pins the release half: stopping the strand disposes the cache
 * wrapper, so a long-lived process does not accumulate one orphaned registration in
 * the shared cache pool per strand stop.
 *
 * NOTE: the pool-count arms below measure `defaultCachePool().stats().stores.length`
 * RELATIVE to a baseline taken inside the test, because the pool is process-wide and
 * other tests in this file leave registrations behind. That is sound only while vitest
 * runs the tests in this file sequentially (its default). If this file is ever marked
 * `concurrent`, those baselines race — give each arm its own `SharedCachePool` instead
 * of the default one.
 *
 * Mocks follow `strand-instance-manager-hibernation.spec.ts`: `createLibp2pNode` and
 * `StrandDatabase` are doubles, so no real libp2p node or Quereus database starts.
 * The mock replaces `@optimystic/db-p2p` wholesale, hence the storage imports above
 * come from `@optimystic/db-p2p/rn` — a different specifier, unmocked, and the same
 * class identity (both entrypoints re-export the same storage modules).
 */
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

/**
 * A launch config whose storage provider is `provider` — deliberately a FACTORY that
 * mints a fresh store per call (what `cadre-cli --storage memory` and the integration
 * harness's node fixtures do), since a memoizing provider would hide the defect.
 */
function createStartConfig(strandId: string, provider: (id: string) => IRawStorage): StartStrandConfig {
  return {
    strandRow: createStrandRow(strandId),
    sAppConfig: createSAppConfig(),
    profile: 'transaction',
    defaultLatencyHint: 'interactive',
    storage: { provider }
  };
}

/** The `storage` option handed to the Nth (0-based) `createLibp2pNode` call. */
function storageOfCall(index: number): IRawStorage | undefined {
  const calls = mocks.createLibp2pNode.mock.calls as unknown[][];
  return (calls[index]![0] as { storage?: IRawStorage }).storage;
}

describe('StrandInstanceManager storage ownership', () => {
  it('calls the storage provider once per strand id across quiesce -> resume', async () => {
    const calls: string[] = [];
    const manager = new StrandInstanceManager();

    await manager.startStrand(createStartConfig('s1', (id) => {
      calls.push(id);
      return new MemoryRawStorage();
    }));
    await manager.quiesceStrand('s1');
    await manager.resumeStrand('s1');

    expect(calls).toEqual(['s1']);
  });

  it('hands the SAME IRawStorage instance to the rebuilt libp2p node', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('s2', () => new MemoryRawStorage()));

    await manager.quiesceStrand('s2');
    await manager.resumeStrand('s2');

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(storageOfCall(0)).toBeInstanceOf(MemoryRawStorage);
    expect(storageOfCall(1)).toBe(storageOfCall(0));
  });

  it('a block written before quiesce is still readable after resume', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('s3', () => new MemoryRawStorage()));

    // Write through the store the FIRST build received...
    const beforeQuiesce = storageOfCall(0)!;
    await beforeQuiesce.saveMetadata('block-1', { ranges: [[0]] });

    await manager.quiesceStrand('s3');
    await manager.resumeStrand('s3');

    // ...and read through the store the POST-RESUME build received. With a
    // fresh-instance factory these are only the same block if the instance kept
    // its store; otherwise the woken strand comes up empty.
    const afterResume = storageOfCall(1)!;
    expect(await afterResume.getMetadata('block-1')).toEqual({ ranges: [[0]] });
  });

  it('stopping the strand disposes its cache wrapper exactly once, leaving no pool registration behind', async () => {
    // A non-Memory store, since `wrapStorageWithCache` passes MemoryRawStorage
    // through unwrapped — there would be no pool registration to leak. The bare
    // object never has a method called on it here: only the wrap, the pool
    // registration, and the dispose are under test.
    const manager = new StrandInstanceManager();
    const storesBefore = defaultCachePool().stats().stores.length;

    await manager.startStrand(createStartConfig('s4', () => ({}) as IRawStorage));
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);

    // The wake must NOT register a second store...
    await manager.quiesceStrand('s4');
    await manager.resumeStrand('s4');
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);

    // ...and the stop must retire the one that exists.
    await manager.stopStrand('s4');
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore);
  });

  it('a failed launch releases the store it resolved, so a retry starts from a live cache', async () => {
    const manager = new StrandInstanceManager();
    const storesBefore = defaultCachePool().stats().stores.length;

    mocks.initialize.mockRejectedValueOnce(new Error('schema apply boom'));
    await expect(
      manager.startStrand(createStartConfig('s5', () => ({}) as IRawStorage))
    ).rejects.toThrow(/schema apply boom/);

    expect(manager.hasStrand('s5')).toBe(false);
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore);
  });

  it('a strand launched with no storage provider still starts, quiesces, resumes and stops', async () => {
    // The no-storage path (`storage` omitted) must stay a plain absence, not a
    // map lookup that throws — the node simply gets `storage: undefined`.
    const manager = new StrandInstanceManager();
    await manager.startStrand({
      strandRow: createStrandRow('s6'),
      sAppConfig: createSAppConfig(),
      profile: 'transaction',
      defaultLatencyHint: 'interactive'
    });

    await manager.quiesceStrand('s6');
    await manager.resumeStrand('s6');
    expect(storageOfCall(1)).toBeUndefined();

    await manager.stopStrand('s6');
    expect(manager.hasStrand('s6')).toBe(false);
  });
});
