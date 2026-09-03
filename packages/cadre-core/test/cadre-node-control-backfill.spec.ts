import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import { MemoryRawStorage, type IRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * **What this protects: the ARMING GATE — and the MEMBERSHIP GATE — of the CONTROL
 * network's peer-join block catch-up.**
 *
 * `PeerJoinBackfill` itself is covered by `peer-join-backfill.spec.ts`, and the physical
 * two-node property by `control-offline-read-after-restart.integration.ts`. Neither can
 * see the decision this file owns: what `CadreNode.startControlBackfill` hands the
 * catch-up, and whether it hands it anything at all.
 *
 * The load-bearing case is `authorizePeer`. The control network's inbound connection gate
 * deliberately admits non-members in several states (seed delivery to an un-enrolled node,
 * an open enrollment window, an outstanding invitation, configured bootstrap/relay peers),
 * so a catch-up wired WITHOUT that gate would push the party's entire membership, peer
 * addresses and strand list to any of them. That regression is invisible to the
 * integration scenario, whose joiner is authorized before the dial — it would still pass.
 * Hence an explicit assertion here that the gate is wired and that it is
 * `isAuthorizedMember`, not some looser predicate.
 *
 * Everything below runs on a bare `new CadreNode` with a fake control libp2p node
 * attached: no node is started, no database is opened. `PeerJoinBackfill` is mocked so the
 * deps object it was constructed with is directly inspectable.
 */

const mocks = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const scheduleConnectedPeers = vi.fn();
  const PeerJoinBackfill = vi.fn(function PeerJoinBackfillMock() {
    return { start, stop, scheduleConnectedPeers };
  });
  return { PeerJoinBackfill, start, stop, scheduleConnectedPeers };
});

vi.mock('../src/peer-join-backfill.js', () => ({ PeerJoinBackfill: mocks.PeerJoinBackfill }));

const PARTY_ID = 'ctrl-backfill-party';

function createConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
  return {
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
    profile: 'transaction',
    // A MemoryRawStorage passes through `wrapStorageWithCache` unwrapped, so these
    // tests leave nothing registered in the process-wide cache pool.
    storage: { provider: () => new MemoryRawStorage() },
    ...overrides
  };
}

/** A control libp2p stand-in: only what the catch-up's arming path reads off it. */
function fakeControlNode(opts: { keyNetwork?: boolean } = {}): Libp2p {
  return {
    getConnections: () => [],
    addEventListener: () => { /* the mocked backfill never subscribes */ },
    removeEventListener: () => { /* ditto */ },
    stop: async () => { /* cleanup() stops the control node */ },
    ...(opts.keyNetwork === false ? {} : { keyNetwork: {} })
  } as unknown as Libp2p;
}

/**
 * Arm the catch-up the way `start()` does — private, reached by cast for the same reason
 * `cadre-node-control-node-options.spec.ts` casts to `buildControlNodeOptions`: it reads
 * only `this.config` and the attached control node, so calling it directly keeps this a
 * pure unit test.
 */
function armControlBackfill(node: CadreNode, controlNode: Libp2p | null = fakeControlNode()): void {
  (node as unknown as { controlNode: Libp2p | null }).controlNode = controlNode;
  (node as unknown as { startControlBackfill(): void }).startControlBackfill();
}

interface CapturedDeps {
  label: string;
  protocolPrefix: string;
  storage: IRawStorage;
  authorizePeer?: (peerId: string) => Promise<boolean>;
}

/** Deps + config handed to the most recent `PeerJoinBackfill` construction. */
function lastConstruction(): { deps: CapturedDeps; config: { debounceMs?: number; enabled?: boolean } | undefined } {
  const calls = mocks.PeerJoinBackfill.mock.calls as unknown[][];
  const last = calls[calls.length - 1]!;
  return { deps: last[0] as CapturedDeps, config: last[1] as { debounceMs?: number } | undefined };
}

function nodeCleanup(node: CadreNode): Promise<void> {
  return (node as unknown as { cleanup(): Promise<void> }).cleanup();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CadreNode control-network peer-join catch-up arming', () => {
  it('arms with the control network name, its protocol prefix, and the control store', () => {
    const store = new MemoryRawStorage();
    const node = new CadreNode(createConfig({ storage: { provider: () => store } }));

    armControlBackfill(node);

    expect(mocks.PeerJoinBackfill).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    const { deps } = lastConstruction();
    expect(deps.label).toBe(`control-${PARTY_ID}`);
    // Must equal the prefix the receiver registered its block-transfer handler under —
    // `/optimystic/<networkName>` — or every push silently fails to dial.
    expect(deps.protocolPrefix).toBe(`/optimystic/control-${PARTY_ID}`);
    // The catch-up reads the SAME resolved control store the control node writes through,
    // not a second wrap over the same backend.
    expect(deps.storage).toBe(store);
  });

  it('resolves the control store even when nothing resolved it first', () => {
    // `start()` happens to build the node options (which resolve the store) before arming
    // the catch-up. Arming must not DEPEND on that ordering: reading a not-yet-populated
    // memo field would disarm the catch-up silently, and the only symptom would be members
    // reading control tables as empty after an offline restart.
    const node = new CadreNode(createConfig());

    armControlBackfill(node);

    expect(mocks.PeerJoinBackfill).toHaveBeenCalledTimes(1);
    expect(lastConstruction().deps.storage).toBeDefined();
  });

  it('wires the membership gate, and it is isAuthorizedMember', async () => {
    const node = new CadreNode(createConfig());
    const asked: string[] = [];
    (node as unknown as { isAuthorizedMember(peerId: string): Promise<boolean> }).isAuthorizedMember =
      async (peerId: string) => { asked.push(peerId); return peerId === 'member'; };

    armControlBackfill(node);

    const gate = lastConstruction().deps.authorizePeer;
    expect(gate).toBeTypeOf('function');
    expect(await gate!('member')).toBe(true);
    expect(await gate!('stranger')).toBe(false);
    expect(asked).toEqual(['member', 'stranger']);
  });

  it('defaults to a shorter settle window than the strand catch-up, and the embedder can override it', () => {
    const node = new CadreNode(createConfig());
    armControlBackfill(node);
    expect(lastConstruction().config?.debounceMs).toBe(250);

    const tuned = new CadreNode(createConfig({ controlBackfill: { debounceMs: 5_000 } }));
    armControlBackfill(tuned);
    expect(lastConstruction().config?.debounceMs).toBe(5_000);
  });

  it('does NOT arm when the embedder disabled it', () => {
    const node = new CadreNode(createConfig({ controlBackfill: { enabled: false } }));
    armControlBackfill(node);
    expect(mocks.PeerJoinBackfill).not.toHaveBeenCalled();
  });

  it('does NOT arm without a control node, without control storage, or without a keyNetwork', () => {
    const noNode = new CadreNode(createConfig());
    armControlBackfill(noNode, null);
    expect(mocks.PeerJoinBackfill).not.toHaveBeenCalled();

    const noStorage = new CadreNode(createConfig({ storage: undefined }));
    armControlBackfill(noStorage);
    expect(mocks.PeerJoinBackfill).not.toHaveBeenCalled();

    const noKeyNetwork = new CadreNode(createConfig());
    armControlBackfill(noKeyNetwork, fakeControlNode({ keyNetwork: false }));
    expect(mocks.PeerJoinBackfill).not.toHaveBeenCalled();
  });

  it('stops and drops the catch-up on cleanup, so a restart rebuilds it', async () => {
    const node = new CadreNode(createConfig());
    armControlBackfill(node);

    await nodeCleanup(node);
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    armControlBackfill(node);
    expect(mocks.PeerJoinBackfill).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    await nodeCleanup(node);
  });

  it('re-arms every connected peer when the authorized membership snapshot refreshes', async () => {
    // The production join order is connect-then-authorize, so the joiner's first pass is
    // denied while its connection stays up. Without this hook it would wait for a
    // reconnect to be caught up at all.
    const node = new CadreNode(createConfig());
    armControlBackfill(node);
    const priv = node as unknown as {
      _running: boolean;
      controlDatabase: unknown;
      listAuthorizedMembers(retry: boolean): Promise<Array<{ peerId: string; multiaddr: string | null }>>;
      refreshAuthorizedControlPeers(reason: string): Promise<void>;
    };
    priv._running = true;
    priv.controlDatabase = {};
    priv.listAuthorizedMembers = async () => [{ peerId: 'joiner', multiaddr: null }];

    await priv.refreshAuthorizedControlPeers('test');

    expect(mocks.scheduleConnectedPeers).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-arm when the membership refresh failed and kept the previous snapshot', async () => {
    // A failed read leaves the gate's snapshot stale; re-arming off it would spend a
    // whole-store pass per connected peer on nothing new.
    const node = new CadreNode(createConfig());
    armControlBackfill(node);
    const priv = node as unknown as {
      _running: boolean;
      controlDatabase: unknown;
      listAuthorizedMembers(retry: boolean): Promise<unknown>;
      refreshAuthorizedControlPeers(reason: string): Promise<void>;
    };
    priv._running = true;
    priv.controlDatabase = {};
    priv.listAuthorizedMembers = async () => { throw new Error('control DB unavailable'); };

    await expect(priv.refreshAuthorizedControlPeers('test')).resolves.toBeUndefined();

    expect(mocks.scheduleConnectedPeers).not.toHaveBeenCalled();
  });
});
