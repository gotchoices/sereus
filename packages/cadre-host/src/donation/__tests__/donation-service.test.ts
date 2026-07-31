/**
 * DonationService unit tests — the donate-a-node lifecycle on the host side,
 * exercised against a fake orchestrator (no real child processes) and a real
 * on-disk DonationStore + GrantService.
 *
 * Covers: provision → awaiting_seed (pinned keys threaded, seedToken persisted +
 * redacted), seedToken survival across a store reconstruct, per-grant quota-race
 * serialization, reclaim-on-post-spawn-failure, and the stale-awaiting_seed reap.
 *
 * getPeer / applySeed do real `fetch` to a live node, so their happy paths live
 * in the cross-package integration scenario (`cadre-host-node-donation`), not
 * here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DonationService, DONATION_AWAITING_SEED_TTL_MS } from '../donation-service.js';
import { DonationStore } from '../donation-store.js';
import { GrantService } from '../grant-service.js';
import { GrantStore } from '../grant-store.js';
import type { Donation } from '../types.js';
import { DonationError } from '../types.js';
import { FakeOrchestrator } from './fake-orchestrator.js';

/** A store whose next `put` fails once — the post-spawn write-failure path. */
class FlakyDonationStore extends DonationStore {
  failNextPut = false;

  override put(donation: Donation): void {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new DonationError('storage_error', 'disk full');
    }
    super.put(donation);
  }
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-donation-svc-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeGrants(opts?: { maxNodes?: number }): { grants: GrantService; token: string } {
  const grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
  const token = grants.issue({ label: 'Alice', ...(opts?.maxNodes ? { maxNodes: opts.maxNodes } : {}) }).token;
  return { grants, token };
}

const baseRequest = (grantToken: string) => ({
  grantToken,
  partyId: 'party-P',
  bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
  ownerKeys: ['owner-key-b64url'],
});

describe('DonationService.provision', () => {
  it('spawns → awaiting_seed, threads pinned owner keys, persists (redacts) the seedToken', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const view = await svc.provision(baseRequest(token));

    expect(view.status).toBe('awaiting_seed');
    expect(view.partyId).toBe('party-P');
    expect(view.profile).toBe('storage'); // default
    expect(view.grantToken).toBe(token);
    // Redacted: host-only secret + loopback URL never cross the boundary.
    expect((view as Record<string, unknown>).seedToken).toBeUndefined();
    expect((view as Record<string, unknown>).seedEndpoint).toBeUndefined();

    // The orchestrator got the requester's pinned owner key (the seed-trust anchor).
    expect(orch.createCalls).toHaveLength(1);
    expect(orch.createCalls[0].pinnedOwnerKeys).toEqual(['owner-key-b64url']);
    expect(orch.createCalls[0].containerId).toBe(view.id);
    expect(orch.createCalls[0].partyId).toBe('party-P');

    // But the record on disk DOES retain the seedToken (crash-recovery).
    const stored = store.get(view.id);
    expect(stored?.seedToken).toBe('seed-token-1');
    expect(stored?.seedEndpoint).toBe('http://127.0.0.1:9001/seed');
    expect(store.liveNodeCount(token)).toBe(1);
  });

  it('honours an explicit transaction profile', async () => {
    const orch = new FakeOrchestrator();
    const { grants, token } = makeGrants();
    const svc = new DonationService({
      orchestrator: orch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });

    const view = await svc.provision({ ...baseRequest(token), profile: 'transaction' });
    expect(view.profile).toBe('transaction');
    expect(orch.createCalls[0].profile).toBe('transaction');
  });

  it('denies an unknown grant token before spawning (unauthorized)', async () => {
    const orch = new FakeOrchestrator();
    const { grants } = makeGrants();
    const svc = new DonationService({
      orchestrator: orch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });

    await expect(svc.provision(baseRequest('not-a-real-token')))
      .rejects.toMatchObject({ code: 'unauthorized' });
    expect(orch.createCalls).toHaveLength(0);
  });
});

describe('DonationService seedToken persistence', () => {
  it('reproduces the seedToken from a store rebuilt off disk (host-restart gap)', async () => {
    const orch = new FakeOrchestrator();
    const dir = join(tmpRoot, 'donations');
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store: new DonationStore(dir) });

    const view = await svc.provision(baseRequest(token));

    // Simulate a host restart: brand-new store instance, same directory.
    const reloaded = new DonationStore(dir);
    const record = reloaded.get(view.id);
    expect(record?.status).toBe('awaiting_seed');
    expect(record?.seedToken).toBe('seed-token-1');
    expect(record?.seedEndpoint).toBe('http://127.0.0.1:9001/seed');
  });
});

describe('DonationService quota-race serialization', () => {
  it('serializes per grant so two concurrent provisions at the boundary cannot both pass', async () => {
    const orch = new FakeOrchestrator();
    orch.createDelayMs = 40; // widen the check→create window so an unserialized impl would race
    const { grants, token } = makeGrants({ maxNodes: 1 });
    const svc = new DonationService({
      orchestrator: orch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });

    const [a, b] = await Promise.allSettled([
      svc.provision(baseRequest(token)),
      svc.provision(baseRequest(token)),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'quota_exceeded' });
    // Exactly one node was actually spawned.
    expect(orch.createCalls).toHaveLength(1);
  });
});

describe('DonationService reclaim-on-failure', () => {
  it('reclaims the spawned resources and marks error when persistence fails after spawn', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    // Fail the SECOND put — the awaiting_seed write, after the orchestrator has
    // already handed back a dockerId. The service must reclaim it.
    const realPut = store.put.bind(store);
    let puts = 0;
    (store as unknown as { put: (d: unknown) => void }).put = (d: unknown) => {
      puts += 1;
      if (puts === 2) throw new DonationError('storage_error', 'disk full');
      realPut(d as never);
    };
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    await expect(svc.provision(baseRequest(token)))
      .rejects.toMatchObject({ code: 'orchestrator_error' });

    // The spawned child was reclaimed (removeContainer called with its dockerId).
    expect(orch.removed).toEqual(['dock_1']);
    // The record is marked error (the 3rd put, which succeeds) → not counted live.
    const errored = store.list().find((d) => d.grantToken === token);
    expect(errored?.status).toBe('error');
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('does not reclaim when the spawn itself throws (nothing was allocated)', async () => {
    const orch = new FakeOrchestrator();
    orch.failCreate = true;
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    await expect(svc.provision(baseRequest(token)))
      .rejects.toMatchObject({ code: 'orchestrator_error' });
    expect(orch.removed).toEqual([]);
    expect(store.list().find((d) => d.grantToken === token)?.status).toBe('error');
    expect(store.liveNodeCount(token)).toBe(0);
  });
});

describe('DonationService.respawn', () => {
  it('replays the persisted spawn inputs, swaps the handles, and leaves status alone', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    // Pretend the borrower seeded it, then the child died.
    store.put({ ...store.get(provisioned.id)!, status: 'seeded' });

    const result = await svc.respawn(provisioned.id);

    expect(result).toMatchObject({ outcome: 'respawned' });
    expect(result.outcome === 'respawned' && result.donation.status).toBe('seeded');
    // The replayed spawn carried the persisted inputs, not fresh ones.
    expect(orch.createCalls).toHaveLength(2);
    expect(orch.createCalls[1]).toMatchObject({
      containerId: provisioned.id,
      partyId: 'party-P',
      bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
      pinnedOwnerKeys: ['owner-key-b64url'],
      profile: 'storage',
    });

    const stored = store.get(provisioned.id)!;
    expect(stored.status).toBe('seeded');
    expect(stored.dockerId).toBe('dock_2');
    expect(stored.seedEndpoint).toBe('http://127.0.0.1:9002/seed');
    expect(stored.seedToken).toBe('seed-token-2');
    expect(stored.respawn?.attempts).toBe(1);
    // Nothing was stopped or reclaimed — the workdir (identity key, node-local
    // stores) has to survive for the respawn to be the same node.
    expect(orch.stopped).toEqual([]);
    expect(orch.removed).toEqual([]);
  });

  it('keeps awaiting_seed records awaiting_seed so a later seed hits the new endpoint', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    const result = await svc.respawn(provisioned.id);

    expect(result).toMatchObject({ outcome: 'respawned' });
    expect(result.outcome === 'respawned' && result.donation.status).toBe('awaiting_seed');
    expect(store.get(provisioned.id)?.seedToken).toBe('seed-token-2');
  });

  it('skips a record written before the spawn inputs were persisted', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    // A pre-existing row on disk: no bootstrapNodes / ownerKeys to replay.
    store.put({
      id: 'grn_legacy',
      grantToken: token,
      partyId: 'party-P',
      profile: 'storage',
      status: 'seeded',
      dockerId: 'dock_old',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    // A skip, not a throw — a sweep over the store must survive these.
    await expect(svc.respawn('grn_legacy')).resolves.toEqual({ outcome: 'not_respawnable' });
    expect(orch.createCalls).toHaveLength(0);
    expect(store.get('grn_legacy')?.dockerId).toBe('dock_old');
  });

  it('refuses to resurrect a terminated loan', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    await svc.terminate(provisioned.id);

    await expect(svc.respawn(provisioned.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(orch.createCalls).toHaveLength(1);
  });

  it('refuses a record whose provision is still in flight', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    // A host that died mid-provision leaves exactly this row: spawn inputs
    // persisted, status never advanced. Replaying it would race the provision
    // and strand the record in a status no reap sweep collects.
    store.put({ ...store.get(provisioned.id)!, status: 'provisioning' });

    await expect(svc.respawn(provisioned.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(orch.createCalls).toHaveLength(1);
  });

  it('records the attempt and throws when the spawn fails', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    orch.failCreate = true;

    await expect(svc.respawn(provisioned.id)).rejects.toMatchObject({ code: 'orchestrator_error' });

    const stored = store.get(provisioned.id)!;
    expect(stored.respawn?.attempts).toBe(1);
    // The old handles are untouched — the caller owns backoff, not cleanup.
    expect(stored.dockerId).toBe('dock_1');
    expect(stored.status).toBe('awaiting_seed');
  });

  it('stops — but never reclaims — the new child when the post-spawn write fails', async () => {
    const orch = new FakeOrchestrator();
    const store = new FlakyDonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    store.failNextPut = true;

    await expect(svc.respawn(provisioned.id)).rejects.toMatchObject({ code: 'orchestrator_error' });

    // Stopped, not removed: `removeContainer` deletes the workdir, and the
    // workdir is the identity key that makes a later respawn the SAME node.
    expect(orch.stopped).toEqual(['dock_2']);
    expect(orch.removed).toEqual([]);
    // The record still points at the old spawn, with the attempt recorded.
    const stored = store.get(provisioned.id)!;
    expect(stored.dockerId).toBe('dock_1');
    expect(stored.status).toBe('awaiting_seed');
    expect(stored.respawn?.attempts).toBe(1);
  });

  it('lets a borrower terminate that lands mid-spawn win, and cleans up the new child', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    store.put({ ...store.get(provisioned.id)!, status: 'seeded' });

    // The borrower's DELETE lands inside the respawn's spawn window.
    orch.createDelayMs = 20;
    let terminated: Promise<void> | undefined;
    orch.onCreate = () => { terminated ??= svc.terminate(provisioned.id); };

    const result = await svc.respawn(provisioned.id);
    await terminated;

    expect(result).toEqual({ outcome: 'abandoned', status: 'terminated' });
    const stored = store.get(provisioned.id)!;
    // The ending's write stands whole: no new handles, no attempt counter.
    expect(stored.status).toBe('terminated');
    expect(stored.dockerId).toBe('dock_1');
    expect(stored.seedToken).toBe('seed-token-1');
    expect(stored.respawn).toBeUndefined();
    // The child the ending could not see is stopped AND reclaimed — it is the
    // only thing left holding that spawn's ports and workdir.
    expect(orch.stopped).toContain('dock_2');
    expect(orch.removed).toContain('dock_2');
    // The ended loan no longer holds a quota slot.
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('lets a stale-seed reap that lands mid-spawn win without restarting the TTL clock', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    const provisioned = await svc.provision(baseRequest(token));

    // Past the awaiting_seed TTL, so the sweep collects this record.
    clock = new Date(clock.getTime() + DONATION_AWAITING_SEED_TTL_MS + 60_000);
    const reapAtIso = clock.toISOString();
    orch.createDelayMs = 20;
    let reaped: Promise<string[]> | undefined;
    orch.onCreate = () => {
      // Move the clock on once the reap's terminal write has landed, so a
      // respawn that overwrote it would show up as a *later* updatedAt.
      reaped ??= svc.reapStaleAwaitingSeed().then((ids) => {
        clock = new Date(clock.getTime() + 1_000);
        return ids;
      });
    };

    const result = await svc.respawn(provisioned.id);
    await expect(reaped).resolves.toEqual([provisioned.id]);

    expect(result).toEqual({ outcome: 'abandoned', status: 'terminated' });
    const stored = store.get(provisioned.id)!;
    expect(stored.status).toBe('terminated');
    // The reap's own "now" — a respawn write here would restart the TTL clock.
    expect(stored.updatedAt).toBe(reapAtIso);
    expect(orch.stopped).toContain('dock_2');
    expect(orch.removed).toContain('dock_2');
    expect(store.liveNodeCount(token)).toBe(0);
  });
});

describe('DonationService.terminate', () => {
  it('marks the record terminated BEFORE stopping the child', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    // The stop fires the orchestrator's state-change; a respawn supervisor
    // reacting to it must already see a terminal record, or it resurrects a
    // loan the borrower just ended.
    let statusAtStop: string | undefined;
    orch.onStop = () => { statusAtStop = store.get(provisioned.id)?.status; };

    await svc.terminate(provisioned.id);

    expect(statusAtStop).toBe('terminated');
    expect(orch.stopped).toEqual(['dock_1']);
    expect(orch.removed).toEqual(['dock_1']);
    expect(store.liveNodeCount(token)).toBe(0);
  });
});

describe('DonationService.reapStaleAwaitingSeed', () => {
  it('terminates awaiting_seed donations past the TTL and leaves fresh ones alone', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants({ maxNodes: 5 });
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    // Old donation (enters awaiting_seed at T0).
    const old = await svc.provision(baseRequest(token));

    // Advance well past the TTL, then provision a fresh one at the new "now".
    const ttlMs = 30 * 60 * 1000;
    clock = new Date(Date.parse('2025-01-01T00:00:00.000Z') + ttlMs + 60_000);
    const fresh = await svc.provision(baseRequest(token));

    const reaped = await svc.reapStaleAwaitingSeed(ttlMs);

    expect(reaped).toEqual([old.id]);
    expect(store.get(old.id)?.status).toBe('terminated');
    expect(store.get(fresh.id)?.status).toBe('awaiting_seed');
    // The stale child was stopped + removed.
    expect(orch.stopped).toContain('dock_1');
    expect(orch.removed).toContain('dock_1');
    // Only the fresh donation still counts against the quota.
    expect(store.liveNodeCount(token)).toBe(1);
  });

  it('is a no-op when nothing is stale', async () => {
    const orch = new FakeOrchestrator();
    const { grants, token } = makeGrants();
    const svc = new DonationService({
      orchestrator: orch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });
    await svc.provision(baseRequest(token));
    expect(await svc.reapStaleAwaitingSeed(30 * 60 * 1000)).toEqual([]);
    expect(orch.removed).toEqual([]);
  });
});
