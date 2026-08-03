import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { DEFAULT_STRAND_CLUSTER_SIZE, MIN_CLUSTER_SIZE, STRAND_CLUSTER_POLICY } from '../src/types.js';
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

  it('resolves the default freshly on resume rather than caching a stale value', async () => {
    // `buildStrandRuntime` is shared by startStrand and resumeStrand. A resumed
    // strand must re-resolve, so a node restarted after the default moved picks
    // up the new breadth instead of replaying whatever it was built with.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-default-resume'));
    await manager.quiesceStrand('cs-default-resume');
    await manager.resumeStrand('cs-default-resume', { bootstrapNodes: [], mode: 'networked' });

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterSize: DEFAULT_STRAND_CLUSTER_SIZE })
    );
  });

  it('forwards a configured clusterSize to the strand node', async () => {
    // 6, not 4: the override must differ from `DEFAULT_STRAND_CLUSTER_SIZE` or a
    // manager that ignored the config entirely would still pass this assertion.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-override', { clusterSize: 6 }));

    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({ clusterSize: 6 })
    );
  });

  it('preserves clusterSize across a quiesce/resume cycle', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-resume', { clusterSize: 6 }));
    await manager.quiesceStrand('cs-resume');
    await manager.resumeStrand('cs-resume', { bootstrapNodes: [], mode: 'networked' });

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    // The rebuilt node must declare the same size — a resume that silently
    // dropped back to the default would split the strand's admission gate.
    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterSize: 6 })
    );
  });

  it('rejects a clusterSize below optimystic\'s minimum without creating a node', async () => {
    const manager = new StrandInstanceManager();

    await expect(
      manager.startStrand(createStartConfig('cs-invalid', { clusterSize: 1 }))
    ).rejects.toThrow(/clusterSize must be an integer >= 2/);

    expect(mocks.createLibp2pNode).not.toHaveBeenCalled();
  });

  it('passes the shared STRAND_CLUSTER_POLICY, declaring the corroboration floor rather than defaulting it', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy'));

    // The shared constant itself, not an equal-looking copy: a hand-copied literal here is
    // exactly how this site and the plugin's networked e2e mesh drifted apart before.
    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({ clusterPolicy: STRAND_CLUSTER_POLICY })
    );

    // Declared, not left to default. The membership admission gate would default to this
    // same 2, but the read-repair corroboration floor falls back to `clusterSize` instead —
    // 4 for a strand — which makes two distinct non-self corroborators mandatory and so makes
    // repair impossible for a two-machine strand. See STRAND_CLUSTER_POLICY.
    expect(STRAND_CLUSTER_POLICY.assumedClusterSize).toBe(MIN_CLUSTER_SIZE);

    // A DEFAULT_STRAND_CLUSTER_SIZE-wide target is unsatisfiable by a strand of one to three
    // machines, so the cohort must be allowed to shrink to the mesh that exists.
    expect(STRAND_CLUSTER_POLICY.allowDownsize).toBe(true);
    expect(STRAND_CLUSTER_POLICY.sizeTolerance).toBe(0.5);

    // Absent on purpose: omitting it is what selects Optimystic's
    // DEFAULT_SUPER_MAJORITY_THRESHOLD (0.75) at both the coordinator and the cluster member.
    expect(STRAND_CLUSTER_POLICY).not.toHaveProperty('superMajorityThreshold');
  });
});
