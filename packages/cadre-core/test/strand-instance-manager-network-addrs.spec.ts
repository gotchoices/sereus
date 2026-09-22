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
  const createLibp2pNode = vi.fn(async (_options: Record<string, unknown>) => ({
    coordinatedRepo: {},
    stop,
    peerId: { toString: () => 'strand-peer' }
  }));
  // The first-sync gate probes `Strand.Header` on every non-founder launch; this double
  // reports the row held, so every launch here is a machine that has synced before.
  const headerHeldDb = { eval: async function* () { yield { Count: 1 }; }, schemaManager: { getSchema: () => undefined } };
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}), getDatabase: () => headerHeldDb };
  });
  // The per-relay reservation supervisor is wiring the manager does over the node it
  // built; `strand-instance-manager-relay.spec.ts` pins that wiring. Here it only has
  // to be inert against the fake node above (no `getMultiaddrs`, no `dial`).
  const superviseRelayReservation = vi.fn((_node: unknown, _addrs: readonly string[], _opts?: unknown) => ({
    firstAttempt: Promise.resolve(),
    driving: false,
    retryAtMs: null,
    lastError: null,
    stop: vi.fn()
  }));
  return { stop, createLibp2pNode, StrandDatabase, superviseRelayReservation };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));
vi.mock('../src/relay-reservation.js', () => ({ superviseRelayReservation: mocks.superviseRelayReservation }));

/**
 * A strand node inherits the machine's one `NetworkConfig`, but NOT the two fields in
 * it that describe a single endpoint on the host: it binds an ephemeral port rather
 * than the operator's fixed one, and it advertises no announce address at all.
 * `strand-network-config.spec.ts` pins the derivation itself; what this file pins is
 * that `buildStrandRuntime` hands `createLibp2pNode` the derived view and nothing
 * else — the mistake it guards against is one of the two fields quietly coming back.
 *
 * `network.relayAddrs` is inherited the same way and resolves to the same SEARCH shape
 * the control node binds — one bare `/p2p-circuit` per relay here, one for all there —
 * and the relay dial addrs it resolves beside them are runtime plumbing for the
 * per-relay reservation supervisor, NOT a `createLibp2pNode` option: this file pins
 * that they never reach the node builder.
 *
 * `network.noiseCrypto` is the opposite case — inherited literally, because every node
 * pays the Noise handshake — and is pinned here beside the fields that are not.
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

  it('hands the strand node the configured noiseCrypto, and omits the key when unset', async () => {
    const noiseCrypto = { fake: 'noise-crypto' } as unknown as NonNullable<StartStrandConfig['network']>['noiseCrypto'];
    const options = await strandOptions({ noiseCrypto });

    expect(options.noiseCrypto).toBe(noiseCrypto);

    vi.clearAllMocks();
    expect('noiseCrypto' in await strandOptions({ listenAddrs: [] })).toBe(false);
  });

  it('still fails the strand start on a malformed relayAddrs entry, which it does use', async () => {
    const manager = new StrandInstanceManager();

    await expect(
      manager.startStrand(createStartConfig('relay-bad', { network: { relayAddrs: ['not-a-multiaddr'] } }))
    ).rejects.toThrow(/network\.relayAddrs entry is not a valid multiaddr/);
  });

  /**
   * Same inherited `NetworkConfig`, the other address list. A strand node binds the
   * bare `/p2p-circuit` SEARCH entry — one per relay — and the manager fills each one
   * with a reservation supervisor over that relay (`superviseRelayReservation`); it
   * must never bind the configured `<relay>/p2p-circuit` shape, which libp2p reserves
   * from inside `listen()` and never re-reserves after a loss. The resolution rules
   * themselves are `strand-network-config.spec.ts`'s; pinned here is what reaches
   * `createLibp2pNode`, and that the relay dial addrs resolved beside the listen
   * entries do NOT.
   */
  it('hands the strand node one bare /p2p-circuit per relay, and keeps the relay dial addrs out of the node options', async () => {
    const relay = '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
    const options = await strandOptions({ listenAddrs: ['/ip4/0.0.0.0/tcp/0'], relayAddrs: [relay] });

    expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0', '/p2p-circuit']);
    expect('relayAddrs' in options).toBe(false);
    // The dial addr went to the supervisor instead.
    expect(mocks.superviseRelayReservation).toHaveBeenCalledTimes(1);
    expect(mocks.superviseRelayReservation.mock.calls[0]![1]).toEqual([relay]);
  });
});
