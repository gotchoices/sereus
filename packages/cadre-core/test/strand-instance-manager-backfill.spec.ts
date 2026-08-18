import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { wrapStorageWithCache } from '@serfab/quereus-plugin-sereus';
import { signSchema } from '../src/schema-verification.js';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

/**
 * **What this protects: the ARMING GATE of the peer-join block catch-up.**
 *
 * `StrandBackfill` itself is covered by `strand-backfill.spec.ts`. What is NOT
 * covered there is the one decision `buildStrandRuntime` makes about it — whether
 * to construct one at all — and that decision changed when the per-strand
 * `bootstrap`/`networked` mode was retired: the gate used to read
 * `mode === 'networked' && strandStorage && …`, so a strand founded on a lone
 * device (which inferred `bootstrap`) armed no catch-up and never replicated its
 * founding blocks to a peer that joined later, short of a relaunch. The gate is
 * now storage-only, which closes that hole; the first case below is the one that
 * would regress if anything re-introduced a peer-presence precondition.
 *
 * Same doubles as `strand-instance-manager-hibernation.spec.ts` — no real libp2p
 * node or Quereus database is needed to observe which way the gate went.
 */
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  // `keyNetwork` present by default: the gate's other arm (a node that exposes
  // none) is asserted explicitly below by dropping it.
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop, keyNetwork: {} }));
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  });
  const backfillStart = vi.fn();
  const backfillStop = vi.fn();
  const StrandBackfill = vi.fn(function StrandBackfillMock() {
    return { start: backfillStart, stop: backfillStop };
  });
  return { stop, createLibp2pNode, StrandDatabase, StrandBackfill, backfillStart, backfillStop };
});

// Partial mock: only `createLibp2pNode` is stubbed. The real module stays for the
// storage classes (`MemoryRawStorage`, `CachedRawStorage`) that cadre-core's cache
// wrap (`@serfab/quereus-plugin-sereus`'s `cached-storage.ts`) instanceof-checks on every strand launch.
vi.mock(import('@optimystic/db-p2p'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createLibp2pNode: mocks.createLibp2pNode as unknown as typeof actual.createLibp2pNode };
});
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));
vi.mock('../src/strand-backfill.js', () => ({ StrandBackfill: mocks.StrandBackfill }));

const testSchema = 'create table Test (id text primary key);';
const testVersion = '1.0.0';

let authorPrivateKey: string;
let authorPublicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
});

/** A stand-in raw store — the gate only tests its presence, never calls it. */
function fakeStorage(): IRawStorage {
  return {} as IRawStorage;
}

function createStartConfig(strandId: string, overrides?: Partial<StartStrandConfig>): StartStrandConfig {
  const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o' };
  const sAppConfig: SAppConfig = {
    id: authorPublicKey,
    version: testVersion,
    schema: testSchema,
    signature: signSchema(testSchema, testVersion, authorPrivateKey)
  };
  return {
    strandRow,
    sAppConfig,
    profile: 'transaction',
    defaultLatencyHint: 'interactive',
    storage: { provider: fakeStorage() },
    ...overrides
  };
}

/** Deps object handed to the most recent `StrandBackfill` construction. */
function lastBackfillDeps(): { strandId: string; protocolPrefix: string; storage: IRawStorage } {
  const calls = mocks.StrandBackfill.mock.calls as unknown[][];
  return calls[calls.length - 1]![0] as { strandId: string; protocolPrefix: string; storage: IRawStorage };
}

describe('StrandInstanceManager peer-join catch-up arming', () => {
  it('arms the catch-up for a strand launched ALONE (empty cohort seed)', async () => {
    const manager = new StrandInstanceManager();
    // No bootstrapNodes at all — the founded-alone shape. Arming here is what
    // lets a peer that joins later receive the founder's blocks.
    await manager.startStrand(createStartConfig('bf-solo', { bootstrapNodes: [] }));

    expect(mocks.StrandBackfill).toHaveBeenCalledTimes(1);
    expect(mocks.backfillStart).toHaveBeenCalledTimes(1);
  });

  it('hands the catch-up the strand\'s own store and the node\'s own protocol prefix', async () => {
    // A prefix that disagrees with the receiver's registered handler is a silent
    // no-op at run time, so it is pinned here rather than left to inspection.
    const storage = fakeStorage();
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('bf-wiring', { storage: { provider: storage } }));

    const deps = lastBackfillDeps();
    expect(deps.strandId).toBe('bf-wiring');
    // The catch-up gets the same CACHED view the strand node writes through — the
    // memoized wrap of the provided store, not a second cache over the same backend.
    expect(deps.storage).toBe(wrapStorageWithCache(storage, 'bf-wiring'));
    expect(deps.protocolPrefix).toBe('/optimystic/strand-bf-wiring');
  });

  it('does NOT arm without per-strand storage — there would be nothing to copy', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('bf-nostore', { storage: undefined }));

    expect(mocks.StrandBackfill).not.toHaveBeenCalled();
  });

  it('does NOT arm when the embedder disabled it', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('bf-off', { backfill: { enabled: false } }));

    expect(mocks.StrandBackfill).not.toHaveBeenCalled();
  });

  it('does NOT arm when the libp2p node exposes no keyNetwork', async () => {
    mocks.createLibp2pNode.mockResolvedValueOnce(
      { coordinatedRepo: {}, stop: mocks.stop } as unknown as Awaited<ReturnType<typeof mocks.createLibp2pNode>>
    );
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('bf-nokeynet'));

    expect(mocks.StrandBackfill).not.toHaveBeenCalled();
  });

  it('stops the catch-up on quiesce and re-arms it on resume', async () => {
    // The instance survives a quiesce but its runtime does not, so a resume that
    // forgot to re-arm would leave a woken strand silently non-replicating.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('bf-cycle'));
    expect(mocks.StrandBackfill).toHaveBeenCalledTimes(1);

    await manager.quiesceStrand('bf-cycle');
    expect(mocks.backfillStop).toHaveBeenCalledTimes(1);

    await manager.resumeStrand('bf-cycle', { bootstrapNodes: [] });
    expect(mocks.StrandBackfill).toHaveBeenCalledTimes(2);
    expect(mocks.backfillStart).toHaveBeenCalledTimes(2);
  });
});
