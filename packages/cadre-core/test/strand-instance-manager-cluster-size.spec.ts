import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { DEFAULT_STRAND_CLUSTER_SIZE, MIN_CLUSTER_SIZE, STRAND_CLUSTER_POLICY, strandClusterPolicy } from '../src/types.js';
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
    await manager.resumeStrand('cs-default-resume', { bootstrapNodes: [] });

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
    await manager.resumeStrand('cs-resume', { bootstrapNodes: [] });

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

    // Structural, not identity: with no `servingMachines` the builder returns the shared
    // constant itself, but the assertion has to survive a config that DOES carry a count
    // (see the serving-machine tests below), where the policy is a derived object. What
    // must not drift is the shape — a hand-copied literal here is exactly how this site and
    // the plugin's networked e2e mesh diverged before. The identity of the unknown-count
    // path is pinned separately, immediately below.
    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({ clusterPolicy: expect.objectContaining({ ...STRAND_CLUSTER_POLICY }) })
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

  it('passes the frozen STRAND_CLUSTER_POLICY BY IDENTITY when no machine count is known', async () => {
    // THIS IS THE PRODUCTION PATH. No authenticated per-strand serving count exists yet, so
    // `CadreNode` passes no `servingMachines` at all and every strand node gets the frozen
    // constant itself — provably, not a look-alike object. See
    // `StartStrandConfig.servingMachines` for why the party's enrolled-machine count is not a
    // substitute, and `backlog/feat-strand-yardstick-from-serving-machines` for the count that
    // will eventually exercise the derived path the tests below cover.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy-unknown'));

    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({ clusterPolicy: STRAND_CLUSTER_POLICY })
    );
  });

  it('still passes STRAND_CLUSTER_POLICY BY IDENTITY after a quiesce/resume with no count', async () => {
    // The other half of the production path, and the one a hibernating strand walks many
    // times a day. `resumeStrand` rebuilds the retained launch config with an explicit
    // `servingMachines: overrides?.servingMachines ?? launchConfig.servingMachines`, so the
    // resumed config carries the KEY with an `undefined` value where the launch config had
    // no key at all. That must still resolve to the frozen constant itself — a rebuild that
    // started returning a derived look-alike would arm a repair floor nothing declared.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy-unknown-resume'));
    await manager.quiesceStrand('cs-policy-unknown-resume');
    await manager.resumeStrand('cs-policy-unknown-resume', { bootstrapNodes: [] });

    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ clusterPolicy: STRAND_CLUSTER_POLICY })
    );
  });

  it('declares the repair yardstick from the serving-machine count', async () => {
    // Plumbing coverage, not a production path: nothing feeds `servingMachines` today (see the
    // identity test above). It stays because the threading is the seam
    // `backlog/feat-strand-yardstick-from-serving-machines` plugs into, and a count that
    // silently stopped reaching `createLibp2pNode` would make that feature a no-op.
    //
    // Optimystic measures a block-repair answer against a DECLARED size, not the peers
    // currently visible — the visible set comes from unauthenticated routing, so a
    // partition can shrink it and, undeclared, talk the corroboration floor down to a
    // single voter. Five serving machines at a breadth of four declares four.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy-serving', { servingMachines: 5 }));

    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterPolicy: strandClusterPolicy(DEFAULT_STRAND_CLUSTER_SIZE, 5)
      })
    );
    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterPolicy: expect.objectContaining({
          repairCorroborationClusterSize: DEFAULT_STRAND_CLUSTER_SIZE,
          // Untouched: the admission gate's yardstick is a separate number now, and
          // raising it would make a party of phones unable to commit.
          assumedClusterSize: MIN_CLUSTER_SIZE
        })
      })
    );
  });

  it('caps the declared yardstick at this strand\'s own configured breadth', async () => {
    // A strand explicitly configured at the minimum has a cohort of two however many
    // machines serve it, and two is the honest declaration for it. Do not "fix" this to 5.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy-capped', {
      clusterSize: MIN_CLUSTER_SIZE,
      servingMachines: 5
    }));

    expect(mocks.createLibp2pNode).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterPolicy: expect.objectContaining({ repairCorroborationClusterSize: MIN_CLUSTER_SIZE })
      })
    );
  });

  it('reuses the retained machine count on a resume that overrides only the seed', async () => {
    // A hibernating strand rebuilds many times a day, and most of those wakes pass no
    // count (or an unknown one). Reverting to "undeclared" on such a wake would quietly
    // reopen the single-voter floor the launch-time declaration closed.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy-resume-retained', { servingMachines: 5 }));
    await manager.quiesceStrand('cs-policy-resume-retained');
    await manager.resumeStrand('cs-policy-resume-retained', { bootstrapNodes: [] });

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(2);
    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clusterPolicy: expect.objectContaining({
          repairCorroborationClusterSize: DEFAULT_STRAND_CLUSTER_SIZE
        })
      })
    );
  });

  it('applies a fresh machine count on resume and retains it for the next one', async () => {
    // A third machine started serving the strand while it slept; the rebuilt node must
    // declare three (which is what pins the floor at two corroborators), and a LATER
    // no-override resume must still see three rather than reverting to the launch value.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('cs-policy-resume-fresh', { servingMachines: 2 }));
    await manager.quiesceStrand('cs-policy-resume-fresh');
    await manager.resumeStrand('cs-policy-resume-fresh', { bootstrapNodes: [], servingMachines: 3 });

    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clusterPolicy: expect.objectContaining({ repairCorroborationClusterSize: 3 })
      })
    );

    await manager.quiesceStrand('cs-policy-resume-fresh');
    await manager.resumeStrand('cs-policy-resume-fresh', { bootstrapNodes: [] });

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(3);
    expect(mocks.createLibp2pNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clusterPolicy: expect.objectContaining({ repairCorroborationClusterSize: 3 })
      })
    );
  });
});
