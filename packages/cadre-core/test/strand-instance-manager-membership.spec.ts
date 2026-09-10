import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import type {
  StrandMembershipReconcilerDeps,
  StrandMembershipReconciliationConfig,
  PendingMembershipInviteSource,
} from '../src/strand-membership-reconciler.js';

/**
 * **What this protects: the ARMING GATE and lifecycle of the membership
 * reconciler, plus `clearOwnMemberPeerBinding`.**
 *
 * The reconciler itself (the join ladder, burn arm, failure classification) is
 * covered by `strand-membership-reconciler.spec.ts` against a real strand DB.
 * What is NOT covered there is the decision `buildStrandRuntime` makes about
 * it: a CLOSED strand launched WITH a party key must arm it (launch and
 * hibernation resume alike), an OPEN strand or a keyless joiner must not, its
 * lifecycle must match the enforcer's (stopped on quiesce/stop, rebuilt on
 * resume), and its deps must be the lazy per-pass reads of the instance's live
 * handles. Same doubles as `strand-instance-manager-revocation.spec.ts` — no
 * real libp2p node, database, or reconciler is needed to observe the wiring.
 */
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const fakeDb = { fake: 'db' } as unknown as Database;
  const createLibp2pNode = vi.fn(async () => ({
    coordinatedRepo: {},
    stop,
    keyNetwork: {},
    peerId: { toString: () => 'own-transport-peer' },
  }));
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return {
      initialize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getDatabase: vi.fn(() => fakeDb),
    };
  });
  const reconcilerStart = vi.fn();
  const reconcilerStop = vi.fn();
  const reconcilerSettle = vi.fn(async () => {});
  const StrandMembershipReconciler = vi.fn(function StrandMembershipReconcilerMock() {
    return {
      start: reconcilerStart,
      stop: reconcilerStop,
      settle: reconcilerSettle,
      reconcile: vi.fn(async () => {}),
    };
  });
  const enforcerIsRevoked = vi.fn(() => false);
  const StrandRevocationEnforcer = vi.fn(function StrandRevocationEnforcerMock() {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn(async () => {}),
      authorizeStream: vi.fn(() => true),
      isRevoked: enforcerIsRevoked,
    };
  });
  const createRevocationConnectionGater = vi.fn(() => ({ composed: true }));
  const readStrandRevocationRows = vi.fn(async () => ({ memberKeys: new Set<string>(), bindings: [] }));
  const removeMemberPeer = vi.fn(async () => {});
  return {
    stop, fakeDb, createLibp2pNode, StrandDatabase,
    StrandMembershipReconciler, reconcilerStart, reconcilerStop, reconcilerSettle,
    StrandRevocationEnforcer, enforcerIsRevoked, createRevocationConnectionGater, readStrandRevocationRows,
    removeMemberPeer,
  };
});

vi.mock(import('@optimystic/db-p2p'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createLibp2pNode: mocks.createLibp2pNode as unknown as typeof actual.createLibp2pNode };
});
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));
vi.mock('../src/strand-membership-reconciler.js', () => ({
  StrandMembershipReconciler: mocks.StrandMembershipReconciler,
}));
vi.mock('../src/strand-revocation-enforcer.js', () => ({
  StrandRevocationEnforcer: mocks.StrandRevocationEnforcer,
  createRevocationConnectionGater: mocks.createRevocationConnectionGater,
  readStrandRevocationRows: mocks.readStrandRevocationRows,
}));
// Partial mock: only the binding-removal writer is stubbed — the manager calls it
// with the retained party key, and nothing here should hit a real database.
vi.mock(import('../src/strand-membership-writer.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, removeMemberPeer: mocks.removeMemberPeer as unknown as typeof actual.removeMemberPeer };
});

const testSchema = 'create table Test (id text primary key);';
const testVersion = '1.0.0';

let authorPrivateKey: string;
let authorPublicKey: string;
let partyKey: string;

beforeEach(async () => {
  vi.clearAllMocks();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  partyKey = await generateStrandMemberKey();
});

function createStartConfig(strandId: string, type: 'o' | 'c', overrides?: Partial<StartStrandConfig>): StartStrandConfig {
  const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: type, FounderOwnerKey: null };
  const sAppConfig: SAppConfig = {
    id: authorPublicKey,
    version: testVersion,
    schema: testSchema,
    signature: signSchema(testSchema, testVersion, authorPrivateKey),
  };
  return {
    strandRow,
    sAppConfig,
    profile: 'transaction',
    defaultLatencyHint: 'interactive',
    ...overrides,
  };
}

/** The (deps, config) pair the most recent reconciler construction received. */
function lastReconcilerArgs(): [StrandMembershipReconcilerDeps, StrandMembershipReconciliationConfig | undefined] {
  const calls = mocks.StrandMembershipReconciler.mock.calls as unknown[][];
  return calls[calls.length - 1] as [StrandMembershipReconcilerDeps, StrandMembershipReconciliationConfig | undefined];
}

describe('membership reconciler arming', () => {
  it('arms it for a closed strand launched with a party key, and bring-up does not await the loop', async () => {
    const manager = new StrandInstanceManager();
    const instance = await manager.startStrand(createStartConfig('mem-closed', 'c', {
      partyMemberPrivateKey: partyKey,
    }));

    // startStrand resolved active with the (mocked, never-completing) loop merely started.
    expect(instance.status).toBe('active');
    expect(mocks.StrandMembershipReconciler).toHaveBeenCalledTimes(1);
    expect(mocks.reconcilerStart).toHaveBeenCalledTimes(1);
    const [deps] = lastReconcilerArgs();
    expect(deps.label).toBe('mem-closed');
    expect(deps.partyMemberPrivateKey).toBe(partyKey);
  });

  it('does NOT arm it for an open strand, even with a party key threaded by mistake', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-open', 'o'));

    expect(mocks.StrandMembershipReconciler).not.toHaveBeenCalled();
  });

  it('does NOT arm it for a closed strand with no party key (a joiner whose control row has not replicated)', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-keyless', 'c'));

    expect(mocks.StrandMembershipReconciler).not.toHaveBeenCalled();
  });

  it('reads the live database and transport peer id LAZILY, per pass', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-lazy', 'c', { partyMemberPrivateKey: partyKey }));

    const [deps] = lastReconcilerArgs();
    expect(deps.getDatabase()).toBe(mocks.fakeDb);
    expect(deps.getOwnPeerId()).toBe('own-transport-peer');

    await manager.quiesceStrand('mem-lazy');
    expect(deps.getDatabase()).toBeUndefined();
    expect(deps.getOwnPeerId()).toBeUndefined();
  });

  it('threads the pending-invitation source through untouched', async () => {
    const source: PendingMembershipInviteSource = { get: () => undefined, clear: () => {} };
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-invite', 'c', {
      partyMemberPrivateKey: partyKey,
      pendingMembershipInvite: source,
    }));

    const [deps] = lastReconcilerArgs();
    expect(deps.pendingInvite).toBe(source);
  });

  it('mirrors the revocation enforcer cadence into the reconciler config', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-cadence', 'c', {
      partyMemberPrivateKey: partyKey,
      revocationEnforcement: { pollIntervalMs: 7_000 },
    }));

    const [, config] = lastReconcilerArgs();
    expect(config).toEqual({ pollIntervalMs: 7_000 });
  });

  it('an explicit membershipReconciliation cadence wins over the mirrored enforcer one', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-cadence-own', 'c', {
      partyMemberPrivateKey: partyKey,
      revocationEnforcement: { pollIntervalMs: 7_000 },
      membershipReconciliation: { pollIntervalMs: 3_000 },
    }));

    const [, config] = lastReconcilerArgs();
    expect(config).toEqual({ pollIntervalMs: 3_000 });
  });

  it('does NOT arm when the embedder disabled it — fixtures that hand-drive the writers', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-off', 'c', {
      partyMemberPrivateKey: partyKey,
      membershipReconciliation: { enabled: false },
    }));

    expect(mocks.StrandMembershipReconciler).not.toHaveBeenCalled();
  });

  it('wires isSelfRevoked to the enforcer view of THIS node\'s own transport peer id', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-selfrev', 'c', { partyMemberPrivateKey: partyKey }));

    const [deps] = lastReconcilerArgs();
    mocks.enforcerIsRevoked.mockReturnValue(false);
    expect(deps.isSelfRevoked?.()).toBe(false);
    mocks.enforcerIsRevoked.mockReturnValue(true);
    expect(deps.isSelfRevoked?.()).toBe(true);
    expect(mocks.enforcerIsRevoked).toHaveBeenLastCalledWith('own-transport-peer');
  });

  it('leaves isSelfRevoked absent when the revocation gate is disarmed (fail-open: the loop just runs)', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-nogate', 'c', {
      partyMemberPrivateKey: partyKey,
      revocationEnforcement: { enabled: false },
    }));

    expect(mocks.StrandMembershipReconciler).toHaveBeenCalledTimes(1);
    const [deps] = lastReconcilerArgs();
    expect(deps.isSelfRevoked).toBeUndefined();
  });

  it('stops it on quiesce and rebuilds it on resume — the idempotent ladder re-runs', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-cycle', 'c', { partyMemberPrivateKey: partyKey }));
    expect(mocks.StrandMembershipReconciler).toHaveBeenCalledTimes(1);

    await manager.quiesceStrand('mem-cycle');
    expect(mocks.reconcilerStop).toHaveBeenCalledTimes(1);

    await manager.resumeStrand('mem-cycle', { bootstrapNodes: [] });
    expect(mocks.StrandMembershipReconciler).toHaveBeenCalledTimes(2);
    expect(mocks.reconcilerStart).toHaveBeenCalledTimes(2);
  });

  it('stops it on stopStrand too', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('mem-stop', 'c', { partyMemberPrivateKey: partyKey }));

    await manager.stopStrand('mem-stop');

    expect(mocks.reconcilerStop).toHaveBeenCalledTimes(1);
  });
});

describe('clearOwnMemberPeerBinding', () => {
  it('removes this machine\'s own binding, signed with the retained party key, after stopping the reconciler', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('clear-live', 'c', { partyMemberPrivateKey: partyKey }));

    await manager.clearOwnMemberPeerBinding('clear-live');

    // The reconciler is silenced FIRST — and its in-flight pass awaited, since
    // stop() only disarms the poll — so no racing pass can re-register the binding.
    expect(mocks.reconcilerStop).toHaveBeenCalledTimes(1);
    expect(mocks.reconcilerSettle).toHaveBeenCalledTimes(1);
    expect(mocks.reconcilerSettle.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.removeMemberPeer.mock.invocationCallOrder[0]!);
    expect(mocks.removeMemberPeer).toHaveBeenCalledTimes(1);
    const [db, params] = mocks.removeMemberPeer.mock.calls[0] as unknown as [
      Database, { memberKeyPair: { publicKeyB64: string }; peerId: string }
    ];
    expect(db).toBe(mocks.fakeDb);
    expect(params.memberKeyPair.publicKeyB64).toBe(strandMemberKeyPair(partyKey).publicKeyB64);
    expect(params.peerId).toBe('own-transport-peer');
  });

  it('never throws — a rejected removal (strand already unreachable) is logged and swallowed', async () => {
    mocks.removeMemberPeer.mockRejectedValueOnce(new Error('no write quorum'));
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('clear-fail', 'c', { partyMemberPrivateKey: partyKey }));

    await expect(manager.clearOwnMemberPeerBinding('clear-fail')).resolves.toBeUndefined();
  });

  it('is a quiet no-op for an open strand, a keyless launch, and an untracked id', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('clear-open', 'o'));
    await manager.startStrand(createStartConfig('clear-keyless', 'c'));

    await expect(manager.clearOwnMemberPeerBinding('clear-open')).resolves.toBeUndefined();
    await expect(manager.clearOwnMemberPeerBinding('clear-keyless')).resolves.toBeUndefined();
    await expect(manager.clearOwnMemberPeerBinding('never-heard-of-it')).resolves.toBeUndefined();

    expect(mocks.removeMemberPeer).not.toHaveBeenCalled();
  });

  it('leaves the binding in place (with a log) when the strand is quiesced — best-effort, never a wake', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('clear-quiesced', 'c', { partyMemberPrivateKey: partyKey }));
    await manager.quiesceStrand('clear-quiesced');
    mocks.reconcilerStop.mockClear();

    await expect(manager.clearOwnMemberPeerBinding('clear-quiesced')).resolves.toBeUndefined();

    expect(mocks.removeMemberPeer).not.toHaveBeenCalled();
  });
});
