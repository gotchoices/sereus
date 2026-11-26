import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { defaultCachePool, memoryNodeStorage, type IRawStorage, type NodeStorage } from '@optimystic/db-p2p/rn';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import { NODE_ROLE_PRESETS } from '../src/node-roles.js';

/**
 * A strand instance OWNS one opened storage for its lifetime.
 *
 * `buildStrandRuntime` used to call the embedder's storage opener itself, and it
 * runs on both `startStrand` and `resumeStrand` — so a hibernation wake got a second
 * set of stores over the same durable location. Three consequences, all pinned below:
 * the opener saw two calls for one strand, the rebuilt libp2p node was handed a
 * different store than the first build, and (on the in-memory backend a `--storage
 * memory` CLI run and this suite both use) the strand's blocks vanished on resume.
 * The fourth test pins the release half: stopping the strand releases its cache lease,
 * so a long-lived process does not accumulate one unreleasable registration in
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
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop, peerId: { toString: () => 'strand-peer' }, getConnections: () => [], addEventListener: () => {}, removeEventListener: () => {} }));
  // The first-sync gate probes `Strand.Header` on every non-founder launch; this double
  // reports the row held, so every launch here is a machine that has synced before.
  const headerHeldDb = { eval: async function* () { yield { Count: 1 }; }, schemaManager: { getSchema: () => undefined } };
  // Use a non-arrow implementation so `new StrandDatabase(...)` is constructable.
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize, close, getDatabase: () => headerHeldDb, reportPublished: () => {}, queuedTransactionIds: () => undefined };
  });
  return { stop, close, initialize, createLibp2pNode, StrandDatabase };
});

// Partial mock: only `createLibp2pNode` is stubbed (see the backfill spec for why
// the rest of db-p2p stays real).
vi.mock(import('@optimystic/db-p2p'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createLibp2pNode: mocks.createLibp2pNode as unknown as typeof actual.createLibp2pNode };
});
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

const testSchema = 'table Test (id text primary key);';
const testVersion = '1.0.0';
const testSchemaVersion = 1;

let authorPrivateKey: string;
let authorPublicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
});

function createStrandRow(id: string): StrandRow {
  return { Id: id, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };
}

function createSAppConfig(): SAppConfig {
  return {
    id: authorPublicKey,
    version: testVersion,
    schemaVersion: testSchemaVersion,
    schema: testSchema,
    signature: signSchema({ schema: testSchema, version: testVersion, schemaVersion: testSchemaVersion }, authorPrivateKey)
  };
}

/**
 * A launch config whose storage opener is `open` — deliberately one that mints a fresh
 * set of stores per call (what `cadre-cli --storage memory` and the integration
 * harness's node fixtures do), since a memoizing opener would hide the defect.
 */
function createStartConfig(strandId: string, open: (id: string) => Promise<NodeStorage>): StartStrandConfig {
  return {
    strandRow: createStrandRow(strandId),
    sAppConfig: createSAppConfig(),
    roles: NODE_ROLE_PRESETS.device,
    defaultLatencyHint: 'interactive',
    storage: { open }
  };
}

/** The `storage` option handed to the Nth (0-based) `createLibp2pNode` call. */
function storageOfCall(index: number): NodeStorage | undefined {
  const calls = mocks.createLibp2pNode.mock.calls as unknown[][];
  return (calls[index]![0] as { storage?: NodeStorage }).storage;
}

describe('StrandInstanceManager storage ownership', () => {
  it('opens the scope once per strand id across quiesce -> resume, and keeps the lease', async () => {
    const calls: string[] = [];
    const manager = new StrandInstanceManager();
    const storesBefore = defaultCachePool().stats().stores.length;

    await manager.startStrand(createStartConfig('s1', async (id) => {
      calls.push(id);
      // Blocks that are not in-memory, so the lease is observable in the pool count.
      return { ...memoryNodeStorage(), blocks: {} as IRawStorage };
    }));
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);

    await manager.quiesceStrand('s1');
    // The lease is HELD across the hibernation: releasing it at quiesce would start the
    // woken strand on a cold cache, which is the whole point of holding it for the
    // instance's lifetime.
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);
    await manager.resumeStrand('s1');

    expect(calls).toEqual(['s1']);
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);
    await manager.stopStrand('s1');
  });

  it('hands the SAME storage value to the rebuilt libp2p node', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('s2', async () => memoryNodeStorage()));

    await manager.quiesceStrand('s2');
    await manager.resumeStrand('s2');

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(storageOfCall(0)).toBeDefined();
    expect(storageOfCall(1)).toBe(storageOfCall(0));
  });

  it('a block written before quiesce is still readable after resume', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('s3', async () => memoryNodeStorage()));

    // Write through the store the FIRST build received...
    const beforeQuiesce = storageOfCall(0)!;
    await beforeQuiesce.blocks.saveMetadata('block-1', { ranges: [[0]] });

    await manager.quiesceStrand('s3');
    await manager.resumeStrand('s3');

    // ...and read through the store the POST-RESUME build received. With an opener that
    // mints a fresh value per call these are only the same block if the instance kept
    // its storage; otherwise the woken strand comes up empty.
    const afterResume = storageOfCall(1)!;
    expect(await afterResume.blocks.getMetadata('block-1')).toEqual({ ranges: [[0]] });
  });

  it('stopping the strand releases its cache lease exactly once, leaving no pool registration behind', async () => {
    // Blocks that are not in-memory, since `withReadCache` passes an in-memory block store
    // through unwrapped — there would be no pool registration to leak. The bare
    // object never has a method called on it here: only the wrap, the pool
    // registration, and the release are under test.
    const manager = new StrandInstanceManager();
    const storesBefore = defaultCachePool().stats().stores.length;

    await manager.startStrand(createStartConfig('s4', async () => ({ ...memoryNodeStorage(), blocks: {} as IRawStorage })));
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);

    // The wake must NOT register a second store...
    await manager.quiesceStrand('s4');
    await manager.resumeStrand('s4');
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore + 1);

    // ...and the stop must retire the one that exists.
    await manager.stopStrand('s4');
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore);
  });

  it('a failed launch releases the lease it took, so a retry starts from a live cache', async () => {
    const manager = new StrandInstanceManager();
    const storesBefore = defaultCachePool().stats().stores.length;

    mocks.initialize.mockRejectedValueOnce(new Error('schema apply boom'));
    await expect(
      manager.startStrand(createStartConfig('s5', async () => ({ ...memoryNodeStorage(), blocks: {} as IRawStorage })))
    ).rejects.toThrow(/schema apply boom/);

    expect(manager.hasStrand('s5')).toBe(false);
    expect(defaultCachePool().stats().stores.length).toBe(storesBefore);
  });

  it('a strand launched with no storage opener still starts, quiesces, resumes and stops', async () => {
    // The no-storage path (`storage` omitted) must stay a plain absence, not a
    // map lookup that throws — the node is simply given no `storage` option at all, which
    // is also what keeps Optimystic's own in-memory warning from being suppressed.
    const manager = new StrandInstanceManager();
    await manager.startStrand({
      strandRow: createStrandRow('s6'),
      sAppConfig: createSAppConfig(),
      roles: NODE_ROLE_PRESETS.device,
      defaultLatencyHint: 'interactive'
    });

    await manager.quiesceStrand('s6');
    await manager.resumeStrand('s6');
    expect(storageOfCall(1)).toBeUndefined();

    await manager.stopStrand('s6');
    expect(manager.hasStrand('s6')).toBe(false);
  });
});
