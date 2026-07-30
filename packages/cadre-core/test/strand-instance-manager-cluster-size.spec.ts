import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { DEFAULT_STRAND_CLUSTER_SIZE } from '../src/types.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

// Same doubles as strand-instance-manager-hibernation.spec.ts: the assertions
// here are purely about what reaches `createLibp2pNode`, so no real node or
// database is needed.
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop }));
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  });
  return { stop, createLibp2pNode, StrandDatabase };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

/**
 * A strand node's cluster size is its replication breadth, and it also bounds the
 * cohort the node independently derives when Optimystic's cluster-membership gate
 * judges a coordinator's declared peer set — so two nodes disagreeing about it can
 * refuse each other's writes. The value an embedder configures must therefore
 * actually reach `createLibp2pNode`, and omitting it must resolve to Cadre's strand
 * default rather than falling through to optimystic's own default of 10.
 */
describe('StrandInstanceManager cluster size wiring', () => {
  let authorPrivateKey: string;
  let authorPublicKey: string;

  const testSchema = 'create table Test (id text primary key);';
  const testVersion = '1.0.0';

  beforeEach(() => {
    vi.clearAllMocks();
    authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

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
      ...overrides
    };
  }

  it('applies the default when the config omits clusterSize', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-default'));

    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({ clusterSize: DEFAULT_STRAND_CLUSTER_SIZE })
    );
  });

  it('forwards a configured clusterSize to the strand node', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-override', { clusterSize: 4 }));

    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({ clusterSize: 4 })
    );
  });

  it('preserves clusterSize across a quiesce/resume cycle', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-resume', { clusterSize: 4 }));
    await manager.quiesceStrand('cs-resume');
    await manager.resumeStrand('cs-resume', { bootstrapNodes: [], mode: 'networked' });

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    // The rebuilt node must declare the same size — a resume that silently
    // dropped back to the default would split the strand's admission gate.
    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterSize: 4 })
    );
  });

  it('rejects a clusterSize below optimystic\'s minimum without creating a node', async () => {
    const manager = new StrandInstanceManager();

    await expect(
      manager.startStrand(createStartConfig('cs-invalid', { clusterSize: 1 }))
    ).rejects.toThrow(/clusterSize must be an integer >= 2/);

    expect(mocks.createLibp2pNode).not.toHaveBeenCalled();
  });
});
