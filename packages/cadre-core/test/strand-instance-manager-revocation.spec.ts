import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { ConnectionGater } from '@libp2p/interface';
import type { createLibp2pNode } from '@optimystic/db-p2p';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import type { StrandRow, SAppConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

/**
 * **What this protects: the ARMING GATE of the revoked-peer enforcement.**
 *
 * The enforcer itself (deny-set derivation, refresh contract, gater
 * composition) is covered by `strand-revocation-enforcer.spec.ts`. What is NOT
 * covered there is the decision `buildStrandRuntime` makes about it: a CLOSED
 * strand must arm both layers (the fail-closed `authorizeInboundStream`
 * predicate and the revocation-composed connection gater), an OPEN strand must
 * arm NEITHER (its node keeps the raw configured gater — cross-party peers are
 * legitimate there, and there are no membership rows to derive a deny set
 * from), and `revocationEnforcement.enabled: false` must restore the
 * pre-existing behaviour. Same doubles as
 * `strand-instance-manager-backfill.spec.ts` — no real libp2p node, database,
 * or enforcer is needed to observe which way the gate went.
 */
const mocks = vi.hoisted(() => {
  const stop = vi.fn(async () => {});
  const createLibp2pNode = vi.fn(async () => ({ coordinatedRepo: {}, stop, keyNetwork: {} }));
  const StrandDatabase = vi.fn(function StrandDatabaseMock() {
    return { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  });
  const enforcerStart = vi.fn();
  const enforcerStop = vi.fn();
  const enforcerRefresh = vi.fn(async () => {});
  const authorizeStream = vi.fn(() => true);
  const StrandRevocationEnforcer = vi.fn(function StrandRevocationEnforcerMock() {
    return { start: enforcerStart, stop: enforcerStop, refresh: enforcerRefresh, authorizeStream };
  });
  const composedGater = { composed: true } as unknown as ConnectionGater;
  const createRevocationConnectionGater = vi.fn(() => composedGater);
  const readStrandRevocationRows = vi.fn(async () => ({ memberKeys: new Set<string>(), bindings: [] }));
  return {
    stop, createLibp2pNode, StrandDatabase,
    StrandRevocationEnforcer, enforcerStart, enforcerStop, enforcerRefresh, authorizeStream,
    createRevocationConnectionGater, composedGater, readStrandRevocationRows
  };
});

// Partial mock: only `createLibp2pNode` is stubbed (see the backfill spec for why
// the rest of db-p2p stays real).
vi.mock(import('@optimystic/db-p2p'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createLibp2pNode: mocks.createLibp2pNode as unknown as typeof actual.createLibp2pNode };
});
vi.mock('../src/strand-database.js', () => ({ StrandDatabase: mocks.StrandDatabase }));
vi.mock('../src/strand-revocation-enforcer.js', () => ({
  StrandRevocationEnforcer: mocks.StrandRevocationEnforcer,
  createRevocationConnectionGater: mocks.createRevocationConnectionGater,
  readStrandRevocationRows: mocks.readStrandRevocationRows
}));

const testSchema = 'create table Test (id text primary key);';
const testVersion = '1.0.0';

let authorPrivateKey: string;
let authorPublicKey: string;

beforeEach(() => {
  vi.clearAllMocks();
  authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
});

function createStartConfig(strandId: string, type: 'o' | 'c', overrides?: Partial<StartStrandConfig>): StartStrandConfig {
  const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: type, FounderOwnerKey: null };
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

/** The options object the most recent libp2p-node construction received. */
function lastNodeOptions(): Parameters<typeof createLibp2pNode>[0] {
  const calls = mocks.createLibp2pNode.mock.calls as unknown[][];
  return calls[calls.length - 1]![0] as Parameters<typeof createLibp2pNode>[0];
}

describe('StrandInstanceManager revoked-peer enforcement arming', () => {
  it('arms BOTH layers for a closed strand: the per-stream gate and the composed gater', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-closed', 'c'));

    expect(mocks.StrandRevocationEnforcer).toHaveBeenCalledTimes(1);
    expect(mocks.enforcerStart).toHaveBeenCalledTimes(1);
    const options = lastNodeOptions();
    expect(options.authorizeInboundStream).toBeInstanceOf(Function);
    expect(options.connectionGater).toBe(mocks.composedGater);
  });

  it('hands the enforcer the strand id label and threads the config knob through', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-knob', 'c', {
      revocationEnforcement: { pollIntervalMs: 5_000 }
    }));

    const [deps, config] = mocks.StrandRevocationEnforcer.mock.calls[0] as unknown as [
      { label: string; readRows: unknown }, { pollIntervalMs?: number } | undefined
    ];
    expect(deps.label).toBe('rev-knob');
    expect(deps.readRows).toBeInstanceOf(Function);
    expect(config).toEqual({ pollIntervalMs: 5_000 });
  });

  it('routes the per-stream gate into the enforcer\'s authorizeStream', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-stream', 'c'));

    const verdict = await lastNodeOptions().authorizeInboundStream?.('peer-x', '/optimystic/strand-rev-stream/repo/1.0.0');

    expect(mocks.authorizeStream).toHaveBeenCalledWith('peer-x', '/optimystic/strand-rev-stream/repo/1.0.0');
    expect(verdict).toBe(true);
  });

  it('composes the embedder-supplied gater rather than replacing it', async () => {
    const baseGater: ConnectionGater = { denyDialMultiaddr: () => false };
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-compose', 'c', {
      network: { connectionGater: baseGater }
    }));

    const enforcerInstance = mocks.StrandRevocationEnforcer.mock.results[0]!.value;
    expect(mocks.createRevocationConnectionGater).toHaveBeenCalledWith(enforcerInstance, baseGater);
    expect(lastNodeOptions().connectionGater).toBe(mocks.composedGater);
  });

  it('composes over NO base gater too (the storage-profile default has none)', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-nobase', 'c'));

    const enforcerInstance = mocks.StrandRevocationEnforcer.mock.results[0]!.value;
    expect(mocks.createRevocationConnectionGater).toHaveBeenCalledWith(enforcerInstance, undefined);
  });

  it('does NOT arm either layer for an OPEN strand — the raw configured gater passes through', async () => {
    const baseGater: ConnectionGater = { denyDialMultiaddr: () => false };
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-open', 'o', {
      network: { connectionGater: baseGater }
    }));

    expect(mocks.StrandRevocationEnforcer).not.toHaveBeenCalled();
    expect(mocks.createRevocationConnectionGater).not.toHaveBeenCalled();
    const options = lastNodeOptions();
    expect('authorizeInboundStream' in options).toBe(false);
    expect(options.connectionGater).toBe(baseGater);
  });

  it('an OPEN strand with no configured gater passes no gater at all', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-open-bare', 'o'));

    const options = lastNodeOptions();
    expect('connectionGater' in options).toBe(false);
    expect('authorizeInboundStream' in options).toBe(false);
  });

  it('does NOT arm when the embedder disabled it — pre-existing behaviour restored', async () => {
    const baseGater: ConnectionGater = { denyDialMultiaddr: () => false };
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-off', 'c', {
      revocationEnforcement: { enabled: false },
      network: { connectionGater: baseGater }
    }));

    expect(mocks.StrandRevocationEnforcer).not.toHaveBeenCalled();
    const options = lastNodeOptions();
    expect('authorizeInboundStream' in options).toBe(false);
    expect(options.connectionGater).toBe(baseGater);
  });

  it('stops the enforcer on quiesce and rebuilds it (fresh snapshot) on resume', async () => {
    // The instance survives a quiesce but its runtime does not; a resume that
    // forgot to re-arm would leave a woken strand serving revoked peers forever.
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-cycle', 'c'));
    expect(mocks.StrandRevocationEnforcer).toHaveBeenCalledTimes(1);

    await manager.quiesceStrand('rev-cycle');
    expect(mocks.enforcerStop).toHaveBeenCalledTimes(1);

    await manager.resumeStrand('rev-cycle', { bootstrapNodes: [] });
    expect(mocks.StrandRevocationEnforcer).toHaveBeenCalledTimes(2);
    expect(mocks.enforcerStart).toHaveBeenCalledTimes(2);
  });

  it('gives the enforcer a LAZY handle on the live libp2p node for the teardown sweep', async () => {
    // Lazy because the enforcer is constructed before the node exists and the
    // node is dropped again on quiesce — a captured reference would sweep a
    // node that is gone (or miss the one that arrived).
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-network', 'c'));

    const [deps] = mocks.StrandRevocationEnforcer.mock.calls[0] as unknown as [
      { getNetwork: () => unknown }
    ];
    expect(deps.getNetwork()).toBe(manager.getInstance('rev-network')!.libp2pNode);

    await manager.quiesceStrand('rev-network');
    expect(deps.getNetwork()).toBeUndefined();
  });

  it('forwards the enforcer\'s self-revocation signal to the launch config, tagged with the strand id', async () => {
    const onSelfRevoked = vi.fn();
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-self', 'c', { onSelfRevoked }));

    const [deps] = mocks.StrandRevocationEnforcer.mock.calls[0] as unknown as [
      { onSelfRevoked: () => void }
    ];
    deps.onSelfRevoked();

    expect(onSelfRevoked).toHaveBeenCalledWith('rev-self');
  });

  it('refreshRevocationEnforcement drives an on-demand refresh (and sweep)', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-ondemand', 'c'));

    await manager.refreshRevocationEnforcement('rev-ondemand');

    expect(mocks.enforcerRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshRevocationEnforcement is a quiet no-op for an unknown, quiesced, open, or disarmed strand', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-quiet-open', 'o'));
    await manager.startStrand(createStartConfig('rev-quiet-off', 'c', {
      revocationEnforcement: { enabled: false }
    }));
    await manager.startStrand(createStartConfig('rev-quiet-cycle', 'c'));
    await manager.quiesceStrand('rev-quiet-cycle');

    // Matching quiesceStrand's posture: nothing to refresh is not an error.
    await expect(manager.refreshRevocationEnforcement('never-heard-of-it')).resolves.toBeUndefined();
    await expect(manager.refreshRevocationEnforcement('rev-quiet-open')).resolves.toBeUndefined();
    await expect(manager.refreshRevocationEnforcement('rev-quiet-off')).resolves.toBeUndefined();
    await expect(manager.refreshRevocationEnforcement('rev-quiet-cycle')).resolves.toBeUndefined();

    expect(mocks.enforcerRefresh).not.toHaveBeenCalled();
  });

  it('stops the enforcer on stopStrand too', async () => {
    const manager = new StrandInstanceManager();
    await manager.startStrand(createStartConfig('rev-stop', 'c'));

    await manager.stopStrand('rev-stop');

    expect(mocks.enforcerStop).toHaveBeenCalledTimes(1);
  });
});
