import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import type { RelayReservationSupervisorOptions } from '../src/relay-reservation.js';

/**
 * The per-strand relay-reservation supervisors `buildStrandRuntime` wires over the
 * node it built — one per configured relay — and their lifecycle through quiesce, stop
 * and a failed launch. The supervisor itself (re-drives, per-relay held check, the
 * `beforeRedrive` hook) is `relay-reservation.spec.ts`'s, over real relays; what this
 * file pins is that the manager starts the right ones, hands each the right relay and
 * hook, waits for their first attempts WITHOUT letting a failure fail the launch, and
 * stops them BEFORE the node they supervise goes away.
 *
 * Same doubles as the sibling `strand-instance-manager-*.spec.ts` files: no real node
 * or database, so the fake node needs only what the wiring reads (`peerId`, `stop`).
 */
const mocks = vi.hoisted(() => {
  /** Every call the doubles record, in order — the stop-ordering assertions read it. */
  const sequence: string[] = [];
  const nodeStop = vi.fn(async () => { sequence.push('node.stop'); });
  const createLibp2pNode = vi.fn(async (_options: Record<string, unknown>) => ({
    coordinatedRepo: {},
    stop: nodeStop,
    peerId: { toString: () => 'strand-delegate-peer' }
  }));
  let initializeFails = false;
  // The first-sync gate probes `Strand.Header` on every non-founder launch; this double
  // reports the row held, so every launch here is a machine that has synced before.
  const headerHeldDb = { eval: async function* () { yield { Count: 1 }; }, schemaManager: { getSchema: () => undefined } };
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return {
      initialize: vi.fn(async () => {
        if (initializeFails) {
          throw new Error('initialize failed on purpose');
        }
      }),
      close: vi.fn(async () => { sequence.push('database.close'); }),
      getDatabase: () => headerHeldDb
    };
  });
  interface FakeSupervisor {
    addrs: readonly string[];
    opts: RelayReservationSupervisorOptions | undefined;
    firstAttempt: Promise<void>;
    driving: boolean;
    retryAtMs: number | null;
    lastError: string | null;
    stop: () => void;
  }
  const supervisors: FakeSupervisor[] = [];
  let firstAttemptError: string | null = null;
  const superviseRelayReservation = vi.fn(
    (_node: unknown, addrs: readonly string[], opts?: RelayReservationSupervisorOptions): FakeSupervisor => {
      const supervisor: FakeSupervisor = {
        addrs,
        opts,
        firstAttempt: Promise.resolve(),
        driving: false,
        retryAtMs: firstAttemptError === null ? null : Date.now() + 2_000,
        lastError: firstAttemptError,
        stop: vi.fn(() => { sequence.push(`supervisor.stop:${addrs.join(',')}`); })
      };
      supervisors.push(supervisor);
      return supervisor;
    }
  );
  return {
    sequence,
    nodeStop,
    createLibp2pNode,
    StrandDatabase,
    supervisors,
    superviseRelayReservation,
    setInitializeFails: (value: boolean) => { initializeFails = value; },
    setFirstAttemptError: (value: string | null) => { firstAttemptError = value; }
  };
});

vi.mock('@optimystic/db-p2p', () => ({ createLibp2pNode: mocks.createLibp2pNode }));
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));
vi.mock('../src/relay-reservation.js', () => ({ superviseRelayReservation: mocks.superviseRelayReservation }));

const RELAY_1 = '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
const RELAY_2 = '/ip4/5.6.7.8/tcp/4001/p2p/12D3KooWSHj3RRbBjD15g6wekV8y3mdevbrifQRQXMhQdgTrZQqR';

describe('StrandInstanceManager relay-reservation supervisors', () => {
  let authorPrivateKey: string;
  let authorPublicKey: string;

  const testSchema = 'create table Test (id text primary key);';
  const testVersion = '1.0.0';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sequence.length = 0;
    mocks.supervisors.length = 0;
    mocks.setInitializeFails(false);
    mocks.setFirstAttemptError(null);
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
      network: { listenAddrs: [], relayAddrs: [RELAY_1] },
      ...overrides
    };
  }

  let strandCounter = 0;
  function strandId(): string {
    strandCounter += 1;
    return `relay-strand-${strandCounter}`;
  }

  it('starts one supervisor per configured relay, each over exactly that relay', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig(strandId(), {
      network: { listenAddrs: [], relayAddrs: [RELAY_1, RELAY_2] }
    }));

    expect(mocks.supervisors.map((s) => s.addrs)).toEqual([[RELAY_1], [RELAY_2]]);
    // Default timings — the control node's — so no per-strand tuning is invented here.
    for (const supervisor of mocks.supervisors) {
      expect(supervisor.opts?.checkMs).toBeUndefined();
      expect(supervisor.opts?.minBackoffMs).toBeUndefined();
      expect(supervisor.opts?.maxBackoffMs).toBeUndefined();
    }
  });

  it('starts no supervisor when no relay is configured', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig(strandId(), { network: { listenAddrs: ['/ip4/0.0.0.0/tcp/0'] } }));

    expect(mocks.superviseRelayReservation).not.toHaveBeenCalled();
  });

  /**
   * The relay-restart case against a party-run relay: the in-memory delegate grant is
   * gone, so the re-drive has to be preceded by a fresh announce to THAT relay for
   * THIS strand node's peer id.
   */
  it('wires the re-announce callback as each supervisor\'s beforeRedrive, per relay and per delegate', async () => {
    const announce = vi.fn(async (_strandId: string, _relayAddr: string, _delegatePeerId: string) => {});
    const manager = new StrandInstanceManager();
    const id = strandId();
    await manager.startStrand(createStartConfig(id, {
      network: { listenAddrs: [], relayAddrs: [RELAY_1, RELAY_2] },
      announceDelegateToRelay: announce
    }));

    for (const supervisor of mocks.supervisors) {
      await supervisor.opts?.beforeRedrive?.();
    }
    expect(announce.mock.calls).toEqual([
      [id, RELAY_1, 'strand-delegate-peer'],
      [id, RELAY_2, 'strand-delegate-peer']
    ]);
  });

  it('gives the supervisor no hook when the caller supplied no callback', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig(strandId()));

    expect(mocks.supervisors[0]?.opts?.beforeRedrive).toBeUndefined();
  });

  /**
   * Fail-SOFT: a relay that is unreachable at launch must not fail the launch. The
   * strand's database is up and the supervisor keeps retrying; the alternative
   * (throwing) only trades that for `StrandWatcher`'s full-rebuild retry.
   */
  it('still reaches active when the first reservation attempt lands nothing', async () => {
    mocks.setFirstAttemptError('relay dial failed: connection refused');
    const manager = new StrandInstanceManager();

    const instance = await manager.startStrand(createStartConfig(strandId()));

    expect(instance.status).toBe('active');
    expect(instance.error).toBeUndefined();
    expect(mocks.supervisors[0]?.stop).not.toHaveBeenCalled();
  });

  it('stops every supervisor on quiesce, before the database closes and the node stops', async () => {
    const manager = new StrandInstanceManager();
    const id = strandId();
    await manager.startStrand(createStartConfig(id, {
      network: { listenAddrs: [], relayAddrs: [RELAY_1, RELAY_2] }
    }));

    await manager.quiesceStrand(id);

    expect(mocks.sequence).toEqual([
      `supervisor.stop:${RELAY_1}`,
      `supervisor.stop:${RELAY_2}`,
      'database.close',
      'node.stop'
    ]);
  });

  it('rebuilds fresh supervisors on resume and stops those on stop', async () => {
    const manager = new StrandInstanceManager();
    const id = strandId();
    await manager.startStrand(createStartConfig(id));
    await manager.quiesceStrand(id);
    expect(mocks.supervisors).toHaveLength(1);
    mocks.sequence.length = 0;

    await manager.resumeStrand(id);
    expect(mocks.supervisors).toHaveLength(2);
    expect(mocks.supervisors[1]?.addrs).toEqual([RELAY_1]);

    await manager.stopStrand(id);
    expect(mocks.sequence).toEqual([`supervisor.stop:${RELAY_1}`, 'database.close', 'node.stop']);
    // The old supervisor was stopped once, at quiesce — not again.
    expect(mocks.supervisors[0]?.stop).toHaveBeenCalledTimes(1);
    expect(mocks.supervisors[1]?.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the supervisors when the launch fails after the node was built', async () => {
    mocks.setInitializeFails(true);
    const manager = new StrandInstanceManager();
    const id = strandId();

    await expect(manager.startStrand(createStartConfig(id))).rejects.toThrow(/initialize failed on purpose/);

    expect(mocks.supervisors).toHaveLength(1);
    expect(mocks.supervisors[0]?.stop).toHaveBeenCalledTimes(1);
    expect(mocks.sequence.indexOf(`supervisor.stop:${RELAY_1}`)).toBeLessThan(mocks.sequence.indexOf('node.stop'));
    expect(manager.hasStrand(id)).toBe(false);
  });
});
