import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

// Same doubles as strand-instance-manager-cluster-size.spec.ts: the assertions here
// are purely about what reaches `createLibp2pNode`, so no real node or database is
// needed — which also keeps a bogus announce addr from ever reaching libp2p.
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  // Unlike the sibling specs' double, this one declares its parameter: the assertions
  // below ask whether a key is ABSENT, which needs the recorded call indexable rather
  // than only matchable with `expect.objectContaining`.
  const createLibp2pNode = vi.fn(async (_options: Record<string, unknown>) => ({ coordinatedRepo: {}, stop }));
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  });
  return { stop, createLibp2pNode, StrandDatabase };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));

/**
 * A strand node behind a reverse proxy has the same advertising need as the control
 * node, and inherits the same `NetworkConfig` — so `network.announceAddrs` /
 * `network.appendAnnounceAddrs` must reach `createLibp2pNode` here too, on exactly the
 * terms `cadre-node-control-node-options.spec.ts` pins for the control node. Without
 * this, a deployment would advertise a reachable address for its control node while
 * every strand node it runs kept advertising an unreachable one.
 */
describe('StrandInstanceManager announce-addrs wiring', () => {
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

  /** The options the manager handed `createLibp2pNode` for the one strand it started. */
  async function strandOptions(network?: StartStrandConfig['network']): Promise<Record<string, unknown>> {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('announce-' + Math.random().toString(36).slice(2), { network }));

    expect(mocks.createLibp2pNode).toHaveBeenCalledTimes(1);
    return mocks.createLibp2pNode.mock.calls[0]![0];
  }

  it('forwards a configured announceAddrs', async () => {
    const options = await strandOptions({ announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] });

    expect(options.announceAddrs).toEqual(['/dns4/mynode.example.com/tcp/4001']);
  });

  it('forwards a configured appendAnnounceAddrs', async () => {
    const options = await strandOptions({ appendAnnounceAddrs: ['/dns4/mynode.example.com/tcp/4001'] });

    expect(options.appendAnnounceAddrs).toEqual(['/dns4/mynode.example.com/tcp/4001']);
  });

  it('omits both keys entirely when network is absent', async () => {
    const options = await strandOptions();

    expect('announceAddrs' in options).toBe(false);
    expect('appendAnnounceAddrs' in options).toBe(false);
  });

  /**
   * The empty-means-unset rule matters more here than the forwarding does: libp2p reads
   * `announce: []` as "no override", so forwarding an empty array is harmless — but an
   * empty CONFIG value must never become an explicit empty announce set if that
   * semantic ever changes upstream. Dropping the key is the durable answer.
   */
  it('drops an empty announceAddrs rather than forwarding it as an explicit empty set', async () => {
    const options = await strandOptions({ announceAddrs: [], appendAnnounceAddrs: [] });

    expect('announceAddrs' in options).toBe(false);
    expect('appendAnnounceAddrs' in options).toBe(false);
  });

  it('fails the strand start on a malformed entry, rather than building a node that cannot report its addresses', async () => {
    const manager = new StrandInstanceManager();

    await expect(
      manager.startStrand(createStartConfig('announce-bad', { network: { announceAddrs: ['not-a-multiaddr'] } }))
    ).rejects.toThrow(/network\.announceAddrs entry is not a valid multiaddr/);
  });
});
