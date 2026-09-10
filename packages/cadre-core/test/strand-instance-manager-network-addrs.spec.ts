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
 * A strand node inherits the machine's one `NetworkConfig`, but NOT the two fields in
 * it that describe a single endpoint on the host: it binds an ephemeral port rather
 * than the operator's fixed one, and it advertises no announce address at all.
 * `strand-network-config.spec.ts` pins the derivation itself; what this file pins is
 * that `buildStrandRuntime` hands `createLibp2pNode` the derived view and nothing
 * else — the mistake it guards against is one of the two fields quietly coming back.
 *
 * `network.relayAddrs` is inherited the same way but resolves DIFFERENTLY here than on
 * the control node, and nothing else pins which of the two routes this caller takes.
 */
describe('StrandInstanceManager network-addrs wiring', () => {
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
    const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null };
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

  it('drops a configured announceAddrs — it names the address of the control node', async () => {
    const options = await strandOptions({ announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] });

    expect('announceAddrs' in options).toBe(false);
  });

  it('drops a configured appendAnnounceAddrs on the same terms', async () => {
    const options = await strandOptions({ appendAnnounceAddrs: ['/dns4/mynode.example.com/tcp/4001'] });

    expect('appendAnnounceAddrs' in options).toBe(false);
  });

  it('omits both keys entirely when network is absent', async () => {
    const options = await strandOptions();

    expect('announceAddrs' in options).toBe(false);
    expect('appendAnnounceAddrs' in options).toBe(false);
    expect('listenAddrs' in options).toBe(false);
  });

  /**
   * The regression this file exists for. `cadre-cli`'s example config ships
   * `/ip4/0.0.0.0/tcp/4001`; the control node binds it, so a strand node handed the
   * same entry cannot bind anything and the machine can start no strand at all.
   */
  it('hands the strand node an ephemeral port in place of the configured fixed one', async () => {
    const options = await strandOptions({ listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] });

    expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0']);
  });

  it('keeps an explicitly empty listenAddrs empty — a host that cannot listen still does not', async () => {
    const options = await strandOptions({ listenAddrs: [] });

    expect(options.listenAddrs).toEqual([]);
  });

  /**
   * An announce entry the strand node ignores must still be REJECTED somewhere, or a
   * templated `cadre.yaml` with an unsubstituted address variable would reach libp2p
   * on the control node and throw out of every later `getMultiaddrs()` call. The
   * control node validates it at its own build (`cadre-node.ts`), which runs first;
   * this pins that the strand path no longer re-validates a field it discards.
   */
  it('does not fail the strand start on a malformed announce entry it discards', async () => {
    const options = await strandOptions({ announceAddrs: ['not-a-multiaddr'] });

    expect('announceAddrs' in options).toBe(false);
  });

  it('still fails the strand start on a malformed relayAddrs entry, which it does use', async () => {
    const manager = new StrandInstanceManager();

    await expect(
      manager.startStrand(createStartConfig('relay-bad', { network: { relayAddrs: ['not-a-multiaddr'] } }))
    ).rejects.toThrow(/network\.relayAddrs entry is not a valid multiaddr/);
  });

  /**
   * Same inherited `NetworkConfig`, the other address list. The control node resolves
   * `relayAddrs` on the `'search'` route — one bare `/p2p-circuit`, reserved explicitly
   * after control-DB bring-up — and a strand node must NOT follow it there: nothing
   * drives an explicit reservation for a strand node, so a search entry would register
   * a pending reservation nobody fills and leave every NAT'd strand node undialable,
   * silently. The resolution rules themselves are `relay-addrs.spec.ts`'s; the only
   * thing pinned here is WHICH route this caller takes.
   */
  it('resolves an inherited relayAddrs on the CONFIGURED route, not the search route of the control node', async () => {
    const relay = '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
    const options = await strandOptions({ listenAddrs: ['/ip4/0.0.0.0/tcp/0'], relayAddrs: [relay] });

    expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0', `${relay}/p2p-circuit`]);
  });
});
