/**
 * HostedNodeService unit tests — "Join a cadre" and what follows, on the host
 * side, exercised against a fake orchestrator (no real child processes), a real
 * on-disk HostedNodeStore, a stub NAT layer and a stubbed `globalThis.fetch` for
 * the child's `/status`.
 *
 * Covers: join → unclaimed (claim secret threaded to the child, persisted,
 * redacted), the claim details, the status watcher (claim → joined, liveness, and
 * a row removed mid-poll), respawn (same party, same secret, same ports), remove,
 * reset, and the stuck-spawning reap.
 *
 * A recurring theme: **an ending that lands mid-operation wins.** `join`,
 * `respawn` and the watcher each hold an entry-time copy of the record across a
 * slow `await`, and `HostedNodeStore.put` replaces the whole row — so each must
 * re-read before writing or it resurrects a node the admin just removed. The
 * suites drive that race through `FakeOrchestrator.onCreate` / `onSpawned` (the
 * spawn window) and the `fetch` stub (the status window).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeNodeClaimPayload } from '@serfab/cadre-core';

import type { NodeReachability } from '../../nat/types.js';
import {
  HostedNodeService,
  HOSTED_NODE_SPAWNING_TTL_MS,
  type HostedNodeAddressSource,
} from '../hosted-node-service.js';
import { HostedNodeStore } from '../hosted-node-store.js';
import type { HostedNode, HostedNodeChange } from '../types.js';
import { HostedNodeError } from '../types.js';
import { FakeOrchestrator } from './fake-orchestrator.js';

/** A peer id the child reports; the payload codec checks it parses. */
const PEER_ID = '12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';
/** The owner key `/status.node.claimedBy` reports after a claim. */
const OWNER_KEY = Buffer.alloc(32, 7).toString('base64url');

/** A NAT layer with no public address and no verdicts. */
const NO_ADDRESSES: HostedNodeAddressSource = {
  publicAddressesFor: () => [],
  getStatus: () => ({ nodes: [] }),
};

/** A store whose next `put` fails once — the post-spawn write-failure path. */
class FlakyStore extends HostedNodeStore {
  failNextPut = false;

  override put(node: HostedNode): void {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new HostedNodeError('storage_error', 'disk full');
    }
    super.put(node);
  }
}

let tmpRoot: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-hosted-svc-'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** What a child's `/status` answers, in the parts the service reads. */
interface StatusAnswer {
  peerId?: string | null;
  multiaddrs?: string[];
  claim?: 'awaiting' | 'claimed';
  partyId?: string;
  claimedBy?: string;
  connections?: number;
}

function statusBody(answer: StatusAnswer): unknown {
  const peerId = answer.peerId === undefined ? PEER_ID : answer.peerId;
  return {
    status: 'healthy',
    peerId,
    multiaddrs: answer.multiaddrs ?? [`/ip4/127.0.0.1/tcp/4101/ws/p2p/${peerId}`, `/ip4/192.168.1.20/tcp/4101/ws/p2p/${peerId}`],
    node: {
      running: true,
      peerId,
      partyId: answer.partyId ?? 'unclaimed',
      profile: 'storage',
      strands: { total: 0, syncing: 0, active: 0, idle: 0, hibernating: 0 },
      connectionPaths: { total: answer.connections ?? 0, relayed: 0, direct: answer.connections ?? 0, stuckOnRelay: 0, byTransport: {} },
      claim: answer.claim ?? 'awaiting',
      ...(answer.claimedBy ? { claimedBy: answer.claimedBy } : {}),
    },
  };
}

/**
 * Stub the child's `/status` with `answer`. `duringRequest` — when given — runs
 * exactly once and is awaited before the response resolves, so whatever it starts
 * lands *inside* the status window. It is the `fetch` analogue of
 * `FakeOrchestrator.onCreate`.
 */
function stubStatusFetch(answer: StatusAnswer | 'down', duringRequest?: () => unknown): void {
  let ran: Promise<unknown> | undefined;
  globalThis.fetch = (async () => {
    ran ??= (async () => duringRequest?.())();
    await ran;
    if (answer === 'down') throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => statusBody(answer) } as unknown as Response;
  }) as typeof globalThis.fetch;
}

interface Harness {
  orch: FakeOrchestrator;
  store: HostedNodeStore;
  svc: HostedNodeService;
  changes: HostedNodeChange[];
}

function makeHarness(opts: { store?: HostedNodeStore; addresses?: HostedNodeAddressSource; now?: () => Date } = {}): Harness {
  const orch = new FakeOrchestrator();
  const store = opts.store ?? new HostedNodeStore(join(tmpRoot, 'hosted'));
  const svc = new HostedNodeService({
    orchestrator: orch,
    store,
    addresses: opts.addresses ?? NO_ADDRESSES,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const changes: HostedNodeChange[] = [];
  svc.onChange((c) => changes.push(c));
  return { orch, store, svc, changes };
}

function requireNode(store: HostedNodeStore, id: string): HostedNode {
  const node = store.get(id);
  if (!node) throw new Error(`no hosted node ${id}`);
  return node;
}

describe('HostedNodeService.join', () => {
  it('spawns a storage node under the placeholder party with a fresh claim secret, then records it unclaimed', async () => {
    const { orch, store, svc, changes } = makeHarness();

    const view = await svc.join();

    expect(view.id).toMatch(/^hn_[A-Za-z0-9_-]{16}$/);
    expect(view).toMatchObject({ status: 'unclaimed', partyId: 'unclaimed', profile: 'storage', join: { kind: 'claim' }, dockerId: 'dock_1' });
    // The secret never crosses the boundary.
    expect((view.join as Record<string, unknown>).secret).toBeUndefined();

    const stored = requireNode(store, view.id);
    expect(stored.join.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.statusEndpoint).toBe('http://127.0.0.1:9001/status');
    // The child got exactly the record's secret, through the request and nothing else.
    expect(orch.createCalls).toEqual([{
      containerId: view.id,
      partyId: 'unclaimed',
      bootstrapNodes: [],
      profile: 'storage',
      claimSecret: stored.join.secret,
    }]);
    expect(changes).toEqual([{ kind: 'added', id: view.id }]);
  });

  it('gives two joins at once their own id, secret and child', async () => {
    const { orch, store, svc } = makeHarness();
    orch.createDelayMs = 10;

    const [a, b] = await Promise.all([svc.join(), svc.join()]);

    expect(a.id).not.toBe(b.id);
    expect(requireNode(store, a.id).join.secret).not.toBe(requireNode(store, b.id).join.secret);
    expect(orch.createCalls.map((c) => c.containerId).sort()).toEqual([a.id, b.id].sort());
  });

  it('lets a remove that lands mid-spawn win, and reclaims the new child', async () => {
    const { orch, store, svc } = makeHarness();

    // The admin's DELETE lands inside the spawn window. The record names no
    // dockerId yet, so remove's own cleanup finds nothing to stop — the abandon
    // path here is the only thing that can reclaim this child.
    orch.createDelayMs = 20;
    let removed: Promise<void> | undefined;
    orch.onCreate = (request) => { removed ??= svc.remove(request.containerId); };

    await expect(svc.join()).rejects.toMatchObject({ code: 'not_found' });
    await removed;

    expect(store.list()).toEqual([]);
    expect(orch.removed).toEqual(['dock_1']);
  });

  it('marks the record error and reclaims nothing when the spawn itself throws', async () => {
    const { orch, store, svc, changes } = makeHarness();
    orch.failCreate = true;

    await expect(svc.join()).rejects.toMatchObject({ code: 'orchestrator_error' });

    const [stored] = store.list();
    expect(stored?.status).toBe('error');
    expect(stored?.error).toContain('spawn boom');
    expect(orch.removed).toEqual([]);
    // `createContainer`'s own unwind removed the directory its failed spawn created.
    expect(orch.reclaimedWorkdirs).toEqual([]);
    expect(changes).toEqual([{ kind: 'changed', id: stored!.id }]);
  });

  it('reclaims the child and marks error when the post-spawn write fails', async () => {
    const store = new FlakyStore(join(tmpRoot, 'hosted'));
    const { orch, svc } = makeHarness({ store });
    // The first put (the spawning row) succeeds; the second (unclaimed) fails.
    orch.onSpawned = () => { store.failNextPut = true; };

    await expect(svc.join()).rejects.toMatchObject({ code: 'orchestrator_error' });

    expect(orch.removed).toEqual(['dock_1']);
    expect(store.list()[0]?.status).toBe('error');
  });
});

describe('HostedNodeService.claimDetails', () => {
  it('answers the QR payload: public addresses with the peer id first, then the LAN addresses, loopback dropped', async () => {
    const reachability: NodeReachability = {
      nodeId: '', running: true, verdict: 'mapped', reason: null,
      tcp: { internalPort: 4001, externalPort: 4001, source: 'upnp', leaseExpiresAt: null, error: null },
      ws: { internalPort: 4101, externalPort: 4101, source: 'upnp', leaseExpiresAt: null, error: null },
      publicAddrs: [],
    };
    const asked: Array<{ nodeId: string; ports: { p2p: number; ws?: number } }> = [];
    const { store, svc } = makeHarness({
      addresses: {
        publicAddressesFor: (nodeId, ports) => {
          asked.push({ nodeId, ports });
          return ['/ip4/203.0.113.5/tcp/4001', '/ip4/203.0.113.5/tcp/4101/ws'];
        },
        getStatus: () => ({ nodes: [{ ...reachability, nodeId: asked[0]?.nodeId ?? '' }] }),
      },
    });
    const view = await svc.join();
    stubStatusFetch({});

    const details = await svc.claimDetails(view.id);

    // The fake's ports for dock_1, straight from the orchestrator handle.
    expect(asked).toEqual([{ nodeId: view.id, ports: { health: 9001, metrics: 9101, p2p: 4001, ws: 4101 } }]);
    expect(details.peerId).toBe(PEER_ID);
    expect(details.multiaddrs).toEqual([
      `/ip4/203.0.113.5/tcp/4001/p2p/${PEER_ID}`,
      `/ip4/203.0.113.5/tcp/4101/ws/p2p/${PEER_ID}`,
      `/ip4/192.168.1.20/tcp/4101/ws/p2p/${PEER_ID}`,
    ]);
    expect(details.reachability?.verdict).toBe('mapped');
    expect(decodeNodeClaimPayload(details.payload)).toEqual({
      peerId: PEER_ID,
      multiaddrs: details.multiaddrs,
      secret: requireNode(store, view.id).join.secret,
    });
    // The peer id is cached on the record; the view carries it.
    expect(svc.get(view.id)?.peerId).toBe(PEER_ID);
  });

  it('is 503 until the child answers, and 409 once the node is no longer unclaimed', async () => {
    const { store, svc } = makeHarness();
    const view = await svc.join();

    stubStatusFetch('down');
    await expect(svc.claimDetails(view.id)).rejects.toMatchObject({ code: 'node_unavailable' });
    stubStatusFetch({ peerId: null });
    await expect(svc.claimDetails(view.id)).rejects.toMatchObject({ code: 'node_unavailable' });

    store.put({ ...requireNode(store, view.id), status: 'joined', partyId: 'party-P' });
    await expect(svc.claimDetails(view.id)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(svc.claimDetails('hn_nobody')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('HostedNodeService status watcher', () => {
  it('writes joined with the party and owner the claim named, once the node is in that party', async () => {
    const { store, svc, changes } = makeHarness();
    const view = await svc.join();
    changes.length = 0;

    // The node records the claim before it restarts into the party: `claimed`
    // with the placeholder party is a claim in progress, not a joined node.
    stubStatusFetch({ claim: 'claimed', claimedBy: OWNER_KEY, partyId: 'unclaimed' });
    await svc.pollStatuses();
    expect(requireNode(store, view.id).status).toBe('unclaimed');
    expect(changes).toEqual([]);

    stubStatusFetch({ claim: 'claimed', claimedBy: OWNER_KEY, partyId: 'party-P', connections: 1 });
    await svc.pollStatuses();
    expect(requireNode(store, view.id)).toMatchObject({
      status: 'joined', partyId: 'party-P', ownerKey: OWNER_KEY, peerId: PEER_ID, connected: true,
    });
    expect(changes).toEqual([{ kind: 'claimed', id: view.id }]);

    // A joined node's `connected` follows the count, published only on a change.
    await svc.pollStatuses();
    expect(changes).toHaveLength(1);
    stubStatusFetch({ claim: 'claimed', claimedBy: OWNER_KEY, partyId: 'party-P', connections: 0 });
    void svc.pollStatuses(); // the 15 s cadence: a second poll in the same tick is skipped
    await svc.pollStatuses();
    expect(requireNode(store, view.id).connected).toBe(true);
  });

  it('writes nothing for a row removed while its poll was in flight', async () => {
    const { orch, store, svc, changes } = makeHarness();
    const view = await svc.join();
    changes.length = 0;

    let removed: Promise<void> | undefined;
    stubStatusFetch({ claim: 'claimed', claimedBy: OWNER_KEY, partyId: 'party-P' }, () => {
      removed = svc.remove(view.id);
      return removed;
    });

    await svc.pollStatuses();
    await removed;

    expect(store.get(view.id)).toBeUndefined();
    expect(orch.removed).toEqual(['dock_1']);
    expect(changes).toEqual([{ kind: 'removed', id: view.id }]);
  });

  it('retries a node that does not answer on the next pass', async () => {
    const { store, svc } = makeHarness();
    const view = await svc.join();

    stubStatusFetch('down');
    await svc.pollStatuses();
    expect(requireNode(store, view.id).status).toBe('unclaimed');

    stubStatusFetch({ claim: 'claimed', claimedBy: OWNER_KEY, partyId: 'party-P' });
    await svc.pollStatuses();
    expect(requireNode(store, view.id).status).toBe('joined');
  });
});

// The orchestrator refuses to re-spawn a container whose child is still running, so
// each case that expects a spawn has the first child (`dock_1`) go down first.
describe('HostedNodeService.respawn', () => {
  it('replays the record\'s party and secret, comes back on the same ports, swaps the handles and leaves status alone', async () => {
    const { orch, store, svc, changes } = makeHarness();
    const view = await svc.join();
    const secret = requireNode(store, view.id).join.secret;
    store.put({ ...requireNode(store, view.id), status: 'joined', partyId: 'party-P', ownerKey: OWNER_KEY, connected: true });
    const portsBefore = orch.getNode(view.id)!.ports;
    changes.length = 0;

    orch.crash('dock_1');
    const result = await svc.respawn(view.id);

    expect(result).toMatchObject({ outcome: 'respawned', node: { status: 'joined', dockerId: 'dock_2' } });
    // The claimed party now, and the same secret: cadre-cli honours claim.json and
    // answers a rival `already-claimed` with the secret still set.
    expect(orch.createCalls[1]).toEqual({
      containerId: view.id, partyId: 'party-P', bootstrapNodes: [], profile: 'storage', claimSecret: secret,
    });
    expect(orch.getNode(view.id)!.ports).toEqual(portsBefore);

    const stored = requireNode(store, view.id);
    expect(stored).toMatchObject({ status: 'joined', partyId: 'party-P', ownerKey: OWNER_KEY, dockerId: 'dock_2', statusEndpoint: 'http://127.0.0.1:9001/status' });
    expect(stored.respawn?.attempts).toBe(1);
    // Unknown until the watcher reads the new child.
    expect(stored.connected).toBeUndefined();
    // Nothing was stopped or reclaimed — the workdir (identity key, node-local
    // stores) has to survive for the respawn to be the same node.
    expect(orch.stopped).toEqual([]);
    expect(orch.removed).toEqual([]);
    expect(changes).toEqual([{ kind: 'changed', id: view.id }]);
  });

  it('refuses an error or spawning record', async () => {
    const { orch, store, svc } = makeHarness();
    const view = await svc.join();

    store.put({ ...requireNode(store, view.id), status: 'error', error: 'gave up' });
    await expect(svc.respawn(view.id)).rejects.toMatchObject({ code: 'invalid_state' });
    // A host that died mid-join leaves exactly this row; replaying it would race the join.
    store.put({ ...requireNode(store, view.id), status: 'spawning' });
    await expect(svc.respawn(view.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(orch.createCalls).toHaveLength(1);
  });

  it('records the attempt and throws when the spawn fails, keeping the old handles', async () => {
    const { orch, store, svc } = makeHarness();
    const view = await svc.join();
    orch.failCreate = true;

    await expect(svc.respawn(view.id)).rejects.toMatchObject({ code: 'orchestrator_error' });

    const stored = requireNode(store, view.id);
    expect(stored.respawn?.attempts).toBe(1);
    expect(stored.dockerId).toBe('dock_1');
    expect(stored.status).toBe('unclaimed');
  });

  it('stops — but never reclaims — the new child when the post-spawn write fails', async () => {
    const store = new FlakyStore(join(tmpRoot, 'hosted'));
    const { orch, svc } = makeHarness({ store });
    const view = await svc.join();
    store.failNextPut = true;

    orch.crash('dock_1');
    await expect(svc.respawn(view.id)).rejects.toMatchObject({ code: 'orchestrator_error' });

    // Stopped, not removed: `removeContainer` deletes the workdir, and the
    // workdir is the identity key that makes a later respawn the SAME node.
    expect(orch.stopped).toEqual(['dock_2']);
    expect(orch.removed).toEqual([]);
    // The record names the child that actually exists; the attempt failed, so
    // status and updatedAt are left alone.
    const stored = requireNode(store, view.id);
    expect(stored).toMatchObject({ dockerId: 'dock_2', status: 'unclaimed', updatedAt: view.updatedAt });
    expect(stored.respawn?.attempts).toBe(1);
  });

  it('lets a remove that lands after the spawn dropped the old handle win, and reclaims the new child', async () => {
    const { orch, store, svc } = makeHarness();
    const view = await svc.join();

    // The admin's DELETE lands in the window *after* the spawn dropped the old
    // handle — the window `abandonRespawn` was written for. The remove aimed its
    // stop and reclaim at dock_1, which the spawn had already dropped, so it
    // cleaned up nothing at all; dock_2 is the only thing holding the ports and workdir.
    let removed: Promise<void> | undefined;
    orch.onSpawned = () => { removed ??= svc.remove(view.id); };

    orch.crash('dock_1');
    const result = await svc.respawn(view.id);
    await removed;

    expect(result).toEqual({ outcome: 'abandoned' });
    expect(orch.stopped).toEqual(['dock_2']);
    expect(orch.removed).toEqual(['dock_2']);
    expect(store.get(view.id)).toBeUndefined();
  });

  it('stops but does not reclaim the new child when the record goes error mid-spawn', async () => {
    const { orch, store, svc } = makeHarness();
    const view = await svc.join();

    // A give-up write landing inside the spawn window. Both spawns share one
    // workdir, so reclaiming here would delete the identity key `error` keeps.
    orch.createDelayMs = 20;
    orch.onCreate = () => {
      store.put({ ...requireNode(store, view.id), status: 'error', error: 'gave up' });
    };

    orch.crash('dock_1');
    const result = await svc.respawn(view.id);

    expect(result).toEqual({ outcome: 'abandoned', status: 'error' });
    expect(orch.stopped).toContain('dock_2');
    expect(orch.removed).toEqual([]);
    expect(requireNode(store, view.id)).toMatchObject({ status: 'error', dockerId: 'dock_1' });
  });
});

describe('HostedNodeService.remove', () => {
  it('deletes the row BEFORE stopping the child, then reclaims it', async () => {
    const { orch, store, svc, changes } = makeHarness();
    const view = await svc.join();
    changes.length = 0;
    // The stop fires the orchestrator's state-change; the supervisor's pass must
    // already find no record, or it brings back a node the admin just removed.
    let rowAtStop: HostedNode | undefined;
    orch.onStop = () => { rowAtStop = store.get(view.id); };

    await svc.remove(view.id);

    expect(rowAtStop).toBeUndefined();
    expect(orch.stopped).toEqual(['dock_1']);
    expect(orch.removed).toEqual(['dock_1']);
    expect(orch.reclaimedWorkdirs).toEqual([]);
    expect(changes).toEqual([{ kind: 'removed', id: view.id }]);
    // Gone for good: the second remove finds neither a row nor a handle.
    await expect(svc.remove(view.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reclaims the workdir by name for a record that never got a dockerId', async () => {
    const { orch, store, svc } = makeHarness();
    const at = '2025-01-01T00:00:00.000Z';
    store.put({
      id: 'hn_stuck', join: { kind: 'claim', secret: 's' }, partyId: 'unclaimed', profile: 'storage',
      status: 'spawning', createdAt: at, updatedAt: at,
    });

    await svc.remove('hn_stuck');

    expect(store.get('hn_stuck')).toBeUndefined();
    expect(orch.reclaimedWorkdirs).toEqual(['hn_stuck']);
    expect(orch.stopped).toEqual([]);
  });

  it('removes a handle no record names, so a lost hosted-nodes.json cannot strand a child', async () => {
    const { orch, svc, changes } = makeHarness();
    const spawn = await orch.createContainer({ containerId: 'hn_orphan', partyId: 'party-P', bootstrapNodes: [], profile: 'storage' });

    await svc.remove('hn_orphan');

    expect(orch.stopped).toEqual([spawn.dockerId]);
    expect(orch.removed).toEqual([spawn.dockerId]);
    expect(changes).toEqual([{ kind: 'removed', id: 'hn_orphan' }]);
  });
});

describe('HostedNodeService.reset', () => {
  it('removes the node and starts a fresh one with a new id and secret', async () => {
    const { orch, store, svc } = makeHarness();
    const first = await svc.join();
    const firstSecret = requireNode(store, first.id).join.secret;

    const second = await svc.reset(first.id);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('unclaimed');
    expect(store.get(first.id)).toBeUndefined();
    expect(requireNode(store, second.id).join.secret).not.toBe(firstSecret);
    expect(orch.removed).toEqual(['dock_1']);
    expect(orch.createCalls[1]?.containerId).toBe(second.id);
  });
});

describe('HostedNodeService.reapStuckSpawning', () => {
  /** A record whose host died right after writing the `spawning` row. */
  const stuckRecord = (id: string, at: string): HostedNode => ({
    id, join: { kind: 'claim', secret: 's' }, partyId: 'unclaimed', profile: 'storage',
    status: 'spawning', createdAt: at, updatedAt: at,
  });

  it('marks a record stuck past the TTL error and reclaims what the orchestrator can find', async () => {
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const { orch, store, svc, changes } = makeHarness({ now: () => clock });
    // One whose child was spawned before the host died (the orchestrator knows it
    // by dockerId), one that never got that far.
    const spawn = await orch.createContainer({ containerId: 'hn_spawned', partyId: 'unclaimed', bootstrapNodes: [], profile: 'storage' });
    store.put(stuckRecord('hn_spawned', clock.toISOString()));
    store.put(stuckRecord('hn_never', clock.toISOString()));
    clock = new Date(clock.getTime() + HOSTED_NODE_SPAWNING_TTL_MS + 60_000);
    store.put(stuckRecord('hn_fresh', clock.toISOString()));

    const reaped = await svc.reapStuckSpawning();

    expect(reaped.sort()).toEqual(['hn_never', 'hn_spawned']);
    expect(requireNode(store, 'hn_spawned').status).toBe('error');
    expect(requireNode(store, 'hn_never').error).toMatch(/stuck starting/);
    expect(requireNode(store, 'hn_fresh').status).toBe('spawning');
    expect(orch.stopped).toEqual([spawn.dockerId]);
    expect(orch.removed).toEqual([spawn.dockerId]);
    expect(orch.reclaimedWorkdirs).toEqual(['hn_never']);
    expect(changes.map((c) => c.id).sort()).toEqual(['hn_never', 'hn_spawned']);
  });
});
