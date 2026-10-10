/**
 * HostedNodeSupervisor unit tests — the component that notices a hosted node is
 * no longer running and calls `HostedNodeService.respawn`, backs off between
 * attempts, and eventually gives up.
 *
 * Exercised against the shared `FakeOrchestrator` (no real child processes), a
 * real on-disk `HostedNodeStore`, and an injected clock — so backoff and the
 * healthy-reset window are asserted without any wall-clock waiting.
 *
 * What is NOT covered here: that a really-respawned child rejoins its cadre.
 * That is the cross-package `cadre-host-join-by-qr` integration scenario.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostedNodeService } from '../hosted-node-service.js';
import { HostedNodeStore } from '../hosted-node-store.js';
import {
  HostedNodeSupervisor,
  HOSTED_NODE_RESPAWN_HEALTHY_MS,
  HOSTED_NODE_RESPAWN_MAX_ATTEMPTS,
} from '../hosted-node-supervisor.js';
import type { HostedNode, HostedNodeChange, HostedNodeView } from '../types.js';
import { HostedNodeError } from '../types.js';
import { FakeOrchestrator } from './fake-orchestrator.js';
import { encodedTestInvitation } from './test-invitation.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-hosted-sup-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Everything one test needs, sharing a single mutable clock. */
interface Harness {
  orch: FakeOrchestrator;
  store: HostedNodeStore;
  service: HostedNodeService;
  supervisor: HostedNodeSupervisor;
  changes: HostedNodeChange[];
  /** Move the shared clock forward. */
  advance: (ms: number) => void;
  nowMs: () => number;
  /** Start one node waiting to be claimed. */
  join: () => Promise<HostedNodeView>;
}

const START_MS = Date.parse('2026-01-01T00:00:00.000Z');

function makeHarness(store?: HostedNodeStore): Harness {
  let nowMs = START_MS;
  const now = (): Date => new Date(nowMs);

  const orch = new FakeOrchestrator();
  const theStore = store ?? new HostedNodeStore(join(tmpRoot, 'hosted'));
  const service = new HostedNodeService({
    orchestrator: orch,
    store: theStore,
    addresses: { publicAddressesFor: () => [], getStatus: () => ({ nodes: [], gateway: { lanAddress: null } }) },
      primaryLan: async () => undefined,
    now,
  });
  const changes: HostedNodeChange[] = [];
  service.onChange((c) => changes.push(c));
  const supervisor = new HostedNodeSupervisor({ service, store: theStore, orchestrator: orch, now });

  return {
    orch,
    store: theStore,
    service,
    supervisor,
    changes,
    advance: (ms) => { nowMs += ms; },
    nowMs: () => nowMs,
    join: () => service.join(),
  };
}

/** Mark a record claimed without going through the (fetch-driven) status watcher. */
function markJoined(store: HostedNodeStore, id: string): void {
  store.put({ ...requireNode(store, id), status: 'joined', partyId: 'party-P', ownerKey: 'owner' });
}

function requireNode(store: HostedNodeStore, id: string): HostedNode {
  const node = store.get(id);
  if (!node) throw new Error(`no hosted node ${id}`);
  return node;
}

function dockerIdOf(node: { dockerId?: string }): string {
  if (!node.dockerId) throw new Error('hosted node has no dockerId');
  return node.dockerId;
}

/** Let queued fire-and-forget passes run. */
function flush(): Promise<void> {
  return new Promise((res) => setTimeout(res, 5));
}

/** A store whose every read fails — a malformed `hosted-nodes.json` on disk. */
class UnreadableStore extends HostedNodeStore {
  override list(): HostedNode[] {
    throw new HostedNodeError('storage_error', 'hosted-nodes file is not valid JSON');
  }
}

describe('HostedNodeSupervisor.reconcile', () => {
  it('respawns a joined-but-stopped node, keeping its status and swapping its handle', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));

    const respawned = await h.supervisor.reconcile();

    expect(respawned).toEqual([view.id]);
    const stored = requireNode(h.store, view.id);
    expect(stored.dockerId).toBe('dock_2');
    expect(stored.status).toBe('joined');
    expect(h.orch.createCalls).toHaveLength(2);
  });

  it('respawns an unclaimed node whose handle is dead with the record\'s secret, on the previous handle\'s ports', async () => {
    const h = makeHarness();
    const view = await h.join();
    const { join: joinedBy } = requireNode(h.store, view.id);
    const secret = joinedBy.kind === 'claim' ? joinedBy.secret : undefined;
    const portsBefore = h.orch.getNode(view.id)!.ports;
    // A host restart that found the child dead: the handle is there, the process is not.
    h.orch.crash(dockerIdOf(view));

    await expect(h.supervisor.reconcile()).resolves.toEqual([view.id]);

    // The QR code already shown names this secret and these ports, so both must hold.
    expect(h.orch.createCalls[1]).toMatchObject({ containerId: view.id, partyId: 'unclaimed', claimSecret: secret });
    expect(h.orch.getNode(view.id)!.ports).toEqual(portsBefore);
    expect(requireNode(h.store, view.id)).toMatchObject({ status: 'unclaimed', dockerId: 'dock_2' });
  });

  it('respawns a joining invitation node with its invitation, and a joined one without it', async () => {
    const h = makeHarness();
    const invitation = encodedTestInvitation('party-P');
    const view = await h.service.join({ invitation });
    h.orch.crash(dockerIdOf(view));

    await expect(h.supervisor.reconcile()).resolves.toEqual([view.id]);
    // Still joining: the child redeems again, and a member answers a node that already got in as accepted.
    expect(h.orch.createCalls[1]).toMatchObject({ containerId: view.id, partyId: 'party-P', invitation });

    // Joined: a member whose rows are in its own database, and whose invitation may since have expired.
    h.store.put({ ...requireNode(h.store, view.id), status: 'joined' });
    h.orch.crash(dockerIdOf(requireNode(h.store, view.id)));
    h.advance(HOSTED_NODE_RESPAWN_HEALTHY_MS);

    await expect(h.supervisor.reconcile()).resolves.toEqual([view.id]);
    expect(h.orch.createCalls[2]).toEqual({ containerId: view.id, partyId: 'party-P', bootstrapNodes: [], profile: 'storage' });
  });

  it('leaves a running node alone', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(1);
  });

  it('never respawns a node the host gave up on', async () => {
    const h = makeHarness();
    const view = await h.join();
    h.store.put({ ...requireNode(h.store, view.id), status: 'error', error: 'gave up' });
    h.orch.crash(dockerIdOf(view));

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(1);
  });

  it('honours the backoff window, then attempts again once the clock passes it', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));
    h.orch.failCreate = true;

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(2);
    expect(requireNode(h.store, view.id).respawn?.attempts).toBe(1);

    // attempts = 1 → base * 2^1 = 10s. One second later is still too soon.
    h.advance(1_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(2);
    expect(requireNode(h.store, view.id).respawn?.attempts).toBe(1);

    h.advance(10_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(3);
    expect(requireNode(h.store, view.id).respawn?.attempts).toBe(2);
  });

  it('gives up after the attempt cap: record → error, child stopped but not reclaimed, change published', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));
    h.orch.failCreate = true;
    h.changes.length = 0;

    for (let i = 0; i < HOSTED_NODE_RESPAWN_MAX_ATTEMPTS; i++) {
      await h.supervisor.reconcile();
      // Well past the longest backoff, so every pass gets to attempt.
      h.advance(10 * 60_000);
    }

    const stored = requireNode(h.store, view.id);
    expect(stored.status).toBe('error');
    expect(stored.respawn?.attempts).toBe(HOSTED_NODE_RESPAWN_MAX_ATTEMPTS);
    expect(stored.error).toContain(`${HOSTED_NODE_RESPAWN_MAX_ATTEMPTS} attempts`);
    expect(stored.error).toContain('spawn boom');
    // The workdir holds the identity key the node's cadre approved — the
    // give-up path stops the child but must never reclaim it.
    //
    // Doubles as the standing guard on `FakeOrchestrator`'s drop being
    // success-only (mirroring `restoreDroppedHandles`): every create here fails,
    // so a fake that dropped the prior handle regardless would leave `giveUp`
    // with nothing to stop, and this line fails with
    // `expected [] to include 'dock_1'`.
    expect(h.orch.stopped).toContain(view.dockerId);
    expect(h.orch.removed).toEqual([]);
    expect(h.changes).toEqual([{ kind: 'changed', id: view.id }]);

    // `error` is terminal: no further attempts.
    const createsAtGiveUp = h.orch.createCalls.length;
    h.advance(10 * 60_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(createsAtGiveUp);
  });

  // A spawn that succeeds and then dies at once (a crash on boot, a port clash)
  // never throws out of `respawn`, so a give-up checked only on a throw would
  // respawn such a node forever.
  it('gives up on a node whose every respawn spawns but does not stay up', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));
    h.orch.onSpawned = (dockerId) => { h.orch.crash(dockerId); };

    for (let i = 0; i < HOSTED_NODE_RESPAWN_MAX_ATTEMPTS; i++) {
      await expect(h.supervisor.reconcile()).resolves.toEqual([view.id]);
      // Well past the longest backoff, so every pass gets to act.
      h.advance(10 * 60_000);
    }
    expect(h.orch.createCalls).toHaveLength(1 + HOSTED_NODE_RESPAWN_MAX_ATTEMPTS);
    expect(requireNode(h.store, view.id).status).toBe('joined');

    // The budget is spent and the last respawn died too: this pass gives up
    // instead of spawning again.
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    const stored = requireNode(h.store, view.id);
    expect(h.orch.createCalls).toHaveLength(1 + HOSTED_NODE_RESPAWN_MAX_ATTEMPTS);
    expect(stored.status).toBe('error');
    expect(stored.respawn?.attempts).toBe(HOSTED_NODE_RESPAWN_MAX_ATTEMPTS);
    expect(stored.error).toContain('did not stay running');
    // The child the record names is stopped, never reclaimed.
    expect(h.orch.stopped).toEqual([stored.dockerId]);
    expect(h.orch.removed).toEqual([]);

    h.advance(10 * 60_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(1 + HOSTED_NODE_RESPAWN_MAX_ATTEMPTS);
  });

  it('refills the attempt budget once a respawned node has stayed up', async () => {
    const h = makeHarness();
    const view = await h.join();
    h.store.put({
      ...requireNode(h.store, view.id),
      status: 'joined',
      respawn: { attempts: 3, lastAttemptAt: new Date(h.nowMs()).toISOString() },
    });

    // Still inside the healthy window — the crash loop's count stands.
    h.advance(HOSTED_NODE_RESPAWN_HEALTHY_MS - 1_000);
    await h.supervisor.reconcile();
    expect(requireNode(h.store, view.id).respawn?.attempts).toBe(3);

    h.advance(2_000);
    await h.supervisor.reconcile();
    expect(requireNode(h.store, view.id).respawn?.attempts).toBe(0);
  });

  it('leaves a still-spawning record alone — join owns that child', async () => {
    const h = makeHarness();
    // A handle written by a join that has not yet flipped to unclaimed.
    // Respawning it here would race that join and strand the record.
    h.store.put({
      id: 'hn_inflight', join: { kind: 'claim', secret: 's' }, partyId: 'unclaimed', profile: 'storage',
      status: 'spawning', dockerId: 'dock_inflight',
      createdAt: new Date(START_MS).toISOString(), updatedAt: new Date(START_MS).toISOString(),
    });

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toEqual([]);
    expect(requireNode(h.store, 'hn_inflight').status).toBe('spawning');
  });

  it('skips a record that has no orchestrator handle yet', async () => {
    const h = makeHarness();
    h.store.put({
      id: 'hn_nohandle', join: { kind: 'claim', secret: 's' }, partyId: 'unclaimed', profile: 'storage',
      status: 'unclaimed',
      createdAt: new Date(START_MS).toISOString(), updatedAt: new Date(START_MS).toISOString(),
    });

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toEqual([]);
  });

  it('does not undo a claim that lands while the pass is mid-flight', async () => {
    const h = makeHarness();
    const view = await h.join();
    h.store.put({
      ...requireNode(h.store, view.id),
      respawn: { attempts: 3, lastAttemptAt: new Date(h.nowMs()).toISOString() },
    });
    h.advance(HOSTED_NODE_RESPAWN_HEALTHY_MS + 1_000);

    // The watcher's claim write lands between the pass's store snapshot and the
    // budget-refill write — the refill must merge, not replay a stale row.
    h.orch.onIsRunning = () => {
      h.orch.onIsRunning = undefined;
      markJoined(h.store, view.id);
    };

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    const stored = requireNode(h.store, view.id);
    expect(stored.status).toBe('joined');
    expect(stored.partyId).toBe('party-P');
    expect(stored.respawn?.attempts).toBe(0);
  });

  it('leaves a record removed mid-attempt alone instead of recreating it as error', async () => {
    const h = makeHarness();
    const view = await h.join();
    h.store.put({
      ...requireNode(h.store, view.id),
      status: 'joined',
      // One attempt short of the cap (at the cap, the pass would give up before
      // attempting), and long past the longest backoff — so the next failure
      // lands straight in the give-up path.
      respawn: {
        attempts: HOSTED_NODE_RESPAWN_MAX_ATTEMPTS - 1,
        lastAttemptAt: new Date(h.nowMs() - 10 * 60_000).toISOString(),
      },
    });
    h.orch.crash(dockerIdOf(view));
    h.orch.failCreate = true;
    // The admin removes the node while the respawn's spawn is in flight.
    h.orch.onCreate = () => { h.store.remove(view.id); };

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);

    expect(h.store.get(view.id)).toBeUndefined();
    expect(h.orch.stopped).toEqual([]);
  });

  it('does not count a respawn abandoned mid-spawn as a failed attempt', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));
    // The admin removes the node while the respawn's spawn is in flight.
    h.orch.createDelayMs = 20;
    let removed: Promise<void> | undefined;
    h.orch.onCreate = () => { removed ??= h.service.remove(view.id); };

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    await removed;

    // Nothing threw, so no attempt was persisted and give-up never ran; the
    // abandoned child is stopped and reclaimed, not left holding ports.
    expect(h.store.get(view.id)).toBeUndefined();
    expect(h.orch.stopped).toContain('dock_2');
    expect(h.orch.removed).toContain('dock_2');
  });

  it('survives a pass over a store it cannot read', async () => {
    const h = makeHarness(new UnreadableStore(join(tmpRoot, 'hosted')));

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toEqual([]);
  });

  it('serializes overlapping passes so one id is never double-spawned', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));
    h.orch.createDelayMs = 20;

    const [first, second] = await Promise.all([
      h.supervisor.reconcile(),
      h.supervisor.reconcile(),
    ]);

    // Whichever pass wins the tail respawns; the other then finds it running.
    expect([...first, ...second]).toEqual([view.id]);
    // The original join plus exactly one respawn.
    expect(h.orch.createCalls).toHaveLength(2);
  });
});

describe('HostedNodeSupervisor.restart', () => {
  it('stops and respawns a running node without spending its respawn budget', async () => {
    const h = makeHarness();
    const view = await h.join();
    const respawn = { attempts: 2, lastAttemptAt: new Date(h.nowMs()).toISOString() };
    const before: HostedNode = { ...requireNode(h.store, view.id), status: 'joined', partyId: 'party-P', respawn };
    h.store.put(before);
    h.advance(60_000);

    await h.supervisor.restart(view.id);

    expect(h.orch.stopped).toEqual([view.dockerId]);
    const after = requireNode(h.store, view.id);
    expect(after).toMatchObject({ status: 'joined', dockerId: 'dock_2', respawn, updatedAt: before.updatedAt });
  });
});

describe('HostedNodeSupervisor start/stop', () => {
  it('sweeps at startup and again on a child exit', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);
    h.orch.crash(dockerIdOf(view));

    h.supervisor.start();
    try {
      // Queued behind the startup pass, so awaiting it proves that pass ran.
      await h.supervisor.reconcile();
      expect(requireNode(h.store, view.id).dockerId).toBe('dock_2');

      // Now the exit-event trigger, with no manual reconcile in between.
      h.advance(60_000);
      h.orch.crash('dock_2');
      await flush();
      expect(requireNode(h.store, view.id).dockerId).toBe('dock_3');
    } finally {
      h.supervisor.stop();
    }
  });

  it('stops reacting to exits after stop()', async () => {
    const h = makeHarness();
    const view = await h.join();
    markJoined(h.store, view.id);

    h.supervisor.start();
    await h.supervisor.reconcile();
    h.supervisor.stop();

    h.orch.crash(dockerIdOf(view));
    await flush();
    // The exit listener is gone, so the crash goes unnoticed until the next start.
    expect(requireNode(h.store, view.id).dockerId).toBe(view.dockerId);
  });
});
