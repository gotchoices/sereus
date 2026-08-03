/**
 * DonationService unit tests — the donate-a-node lifecycle on the host side,
 * exercised against a fake orchestrator (no real child processes) and a real
 * on-disk DonationStore + GrantService.
 *
 * Covers: provision → awaiting_seed (pinned keys threaded, seedToken persisted +
 * redacted), seedToken survival across a store reconstruct, per-grant quota-race
 * serialization, reclaim-on-post-spawn-failure, seeding, respawn, terminate, the
 * stale-awaiting_seed reap, and the stuck-provisioning reap (the host died
 * between writing the row and finishing the spawn).
 *
 * A recurring theme: **an ending that lands mid-operation wins.** `provision`,
 * `applySeed`, and `respawn` each hold an entry-time copy of the record across a
 * slow `await`, and `DonationStore.put` replaces the whole row — so each must
 * re-read before writing or it resurrects a loan the borrower just ended. The
 * three suites drive that race through `FakeOrchestrator.onCreate` / `onSpawned`
 * (the spawn window, before and after the orchestrator drops the old handle) and
 * a stubbed `globalThis.fetch` (seed window).
 *
 * `applySeed` is exercised here against that `fetch` stub. `getPeer` still does a
 * real `fetch` to a live node, so its happy path lives in the cross-package
 * integration scenario (`cadre-host-node-donation`), not here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DonationService,
  DONATION_AWAITING_SEED_TTL_MS,
  DONATION_PROVISIONING_TTL_MS,
} from '../donation-service.js';
import { DonationStore } from '../donation-store.js';
import { GrantService } from '../grant-service.js';
import { GrantStore } from '../grant-store.js';
import type { Donation } from '../types.js';
import { DonationError } from '../types.js';
import { FakeOrchestrator } from './fake-orchestrator.js';

/**
 * A well-formed 32-byte base64url owner key. `provision` shape-checks the pins at
 * the boundary, so a placeholder string like `OWNER_KEY` is now a
 * rejection rather than an opaque fixture.
 */
const OWNER_KEY = Buffer.alloc(32, 7).toString('base64url');

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
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-donation-svc-'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Stub the donated node's `POST /seed` with `body`. `duringRequest` — when given
 * — runs exactly once and is awaited before the response resolves, so whatever
 * it starts lands *inside* the seed window. It is the `fetch` analogue of
 * `FakeOrchestrator.onCreate`.
 */
function stubSeedFetch(body: unknown, duringRequest?: () => unknown): void {
  let ran: Promise<unknown> | undefined;
  globalThis.fetch = (async () => {
    ran ??= (async () => duringRequest?.())();
    await ran;
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof globalThis.fetch;
}

function makeGrants(opts?: { maxNodes?: number }): { grants: GrantService; token: string } {
  const grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
  const token = grants.issue({ label: 'Alice', ...(opts?.maxNodes ? { maxNodes: opts.maxNodes } : {}) }).token;
  return { grants, token };
}

const baseRequest = (grantToken: string) => ({
  grantToken,
  partyId: 'party-P',
  bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
  ownerKeys: [OWNER_KEY],
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
    expect(orch.createCalls[0].pinnedOwnerKeys).toEqual([OWNER_KEY]);
    expect(orch.createCalls[0].containerId).toBe(view.id);
    expect(orch.createCalls[0].partyId).toBe('party-P');

    // But the record on disk DOES retain the seedToken (crash-recovery).
    const stored = store.get(view.id);
    expect(stored?.seedToken).toBe('seed-token-1');
    expect(stored?.seedEndpoint).toBe('http://127.0.0.1:9001/seed');
    expect(store.liveNodeCount(token)).toBe(1);
  });

  /**
   * The pins are checked before the grant is even validated, so a typo costs the
   * requester nothing: no orchestrator call, no record, and — the point — no quota
   * slot burned on a node that could never have booted. Previously the request was
   * answered as provisioned and the child died at startup, leaving an `error`
   * record and a slot the grantee had to notice and reclaim.
   */
  it('rejects a malformed ownerKeys entry without provisioning or burning a quota slot', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    await expect(
      svc.provision({ ...baseRequest(token), ownerKeys: [OWNER_KEY, 'this-is-not-a-key'] }),
    ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('this-is-not-a-key') });

    expect(orch.createCalls).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('rejects a blank ownerKeys entry the same way', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    await expect(
      svc.provision({ ...baseRequest(token), ownerKeys: [''] }),
    ).rejects.toBeInstanceOf(DonationError);

    expect(orch.createCalls).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('threads the trimmed keys onto the record and the child, not the raw input', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const view = await svc.provision({ ...baseRequest(token), ownerKeys: [`  ${OWNER_KEY}\n`] });

    expect(orch.createCalls[0].pinnedOwnerKeys).toEqual([OWNER_KEY]);
    expect(store.get(view.id)?.ownerKeys).toEqual([OWNER_KEY]);
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

  it('lets a borrower terminate that lands mid-spawn win, and reclaims the new child', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    // The borrower's DELETE lands inside the spawn window. The record names no
    // dockerId yet, so terminate's own cleanup branch finds nothing to stop —
    // the abandon path here is the only thing that can reclaim this child.
    orch.createDelayMs = 20;
    let terminated: Promise<void> | undefined;
    orch.onCreate = (request) => { terminated ??= svc.terminate(request.containerId); };

    await expect(svc.provision(baseRequest(token))).rejects.toMatchObject({ code: 'invalid_state' });
    await terminated;

    const stored = store.list().find((d) => d.grantToken === token)!;
    expect(stored.status).toBe('terminated');
    expect(stored.dockerId).toBeUndefined();
    expect(orch.removed).toEqual(['dock_1']);
    // The ended loan no longer holds a quota slot.
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('does not rewrite a terminated record as error when the spawn then fails', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    // Ending first, host fault second: the borrower's `terminated` must survive
    // — a host-side error is not allowed to overwrite the borrower's own ending.
    orch.createDelayMs = 20;
    orch.failCreate = true;
    let terminated: Promise<void> | undefined;
    orch.onCreate = (request) => { terminated ??= svc.terminate(request.containerId); };

    await expect(svc.provision(baseRequest(token)))
      .rejects.toMatchObject({ code: 'orchestrator_error' });
    await terminated;

    const stored = store.list().find((d) => d.grantToken === token)!;
    expect(stored.status).toBe('terminated');
    expect(stored.error).toBeUndefined();
    expect(orch.removed).toEqual([]);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('reclaims the new child and recreates nothing when the record vanishes mid-spawn', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    orch.createDelayMs = 20;
    orch.onCreate = (request) => { store.remove(request.containerId); };

    await expect(svc.provision(baseRequest(token))).rejects.toMatchObject({ code: 'not_found' });

    // No row to protect, so none is written back and the child is fully
    // reclaimed rather than left holding ports and a workdir nothing names.
    expect(store.list()).toEqual([]);
    expect(orch.removed).toEqual(['dock_1']);
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
    // Nor does it reclaim the workdir by name: `createContainer`'s own unwind
    // already removed a directory its failed spawn created, and a second
    // attempt from here would be redundant.
    expect(orch.reclaimedWorkdirs).toEqual([]);
    expect(store.list().find((d) => d.grantToken === token)?.status).toBe('error');
    expect(store.liveNodeCount(token)).toBe(0);
  });
});

describe('DonationService.applySeed', () => {
  it('marks the record seeded and reports the peers the node added', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    stubSeedFetch({ success: true, peersAdded: 2 });

    const result = await svc.applySeed(provisioned.id, 'encoded-seed');

    expect(result).toEqual({ outcome: 'seeded', peersAdded: 2 });
    expect(store.get(provisioned.id)?.status).toBe('seeded');
  });

  it('reports a node that refuses the seed, and writes nothing', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    const before = store.get(provisioned.id)!;
    stubSeedFetch({ success: false, error: 'seed signer is not a trusted owner' });

    const result = await svc.applySeed(provisioned.id, 'encoded-seed');

    expect(result).toEqual({ outcome: 'rejected', error: 'seed signer is not a trusted owner' });
    // The node's own policy call is not our business to record.
    expect(store.get(provisioned.id)).toEqual(before);
  });

  it('lets a borrower terminate that lands mid-seed win', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    // The borrower's DELETE lands inside the seed window: the node accepts the
    // seed, but by the time it answers the loan is over.
    let terminated: Promise<void> | undefined;
    stubSeedFetch({ success: true, peersAdded: 2 }, () => {
      terminated = svc.terminate(provisioned.id);
      return terminated;
    });

    const result = await svc.applySeed(provisioned.id, 'encoded-seed');
    await terminated;

    expect(result).toEqual({ outcome: 'abandoned', status: 'terminated' });
    const stored = store.get(provisioned.id)!;
    expect(stored.status).toBe('terminated');
    expect(stored.dockerId).toBe('dock_1');
    // Unlike an abandoned respawn there is nothing left for us to clean up: the
    // record named its dockerId throughout, so the ending stopped + reclaimed
    // the child itself, and no live record remains for a supervisor to respawn.
    expect(orch.stopped).toEqual(['dock_1']);
    expect(orch.removed).toEqual(['dock_1']);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('lets a stale-seed reap that lands mid-seed win without restarting the TTL clock', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    const provisioned = await svc.provision(baseRequest(token));

    // Past the awaiting_seed TTL, so the sweep collects this record.
    clock = new Date(clock.getTime() + DONATION_AWAITING_SEED_TTL_MS + 60_000);
    const reapAtIso = clock.toISOString();
    let reaped: Promise<string[]> | undefined;
    stubSeedFetch({ success: true, peersAdded: 2 }, () => {
      // Move the clock on once the reap's terminal write has landed, so a seed
      // write that overwrote it would show up as a *later* updatedAt.
      reaped = svc.reapStaleAwaitingSeed().then((ids) => {
        clock = new Date(clock.getTime() + 1_000);
        return ids;
      });
      return reaped;
    });

    const result = await svc.applySeed(provisioned.id, 'encoded-seed');
    await expect(reaped).resolves.toEqual([provisioned.id]);

    expect(result).toEqual({ outcome: 'abandoned', status: 'terminated' });
    const stored = store.get(provisioned.id)!;
    expect(stored.status).toBe('terminated');
    // The reap's own "now" — a seed write here would restart the TTL clock.
    expect(stored.updatedAt).toBe(reapAtIso);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('abandons with no status when the record vanishes mid-seed', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    stubSeedFetch({ success: true, peersAdded: 2 }, () => { store.remove(provisioned.id); });

    const result = await svc.applySeed(provisioned.id, 'encoded-seed');

    expect(result).toEqual({ outcome: 'abandoned' });
    expect(store.get(provisioned.id)).toBeUndefined();
  });

  it('refuses to seed a terminated loan on entry', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    await svc.terminate(provisioned.id);
    stubSeedFetch({ success: true, peersAdded: 2 });

    await expect(svc.applySeed(provisioned.id, 'encoded-seed'))
      .rejects.toMatchObject({ code: 'invalid_state' });
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
      pinnedOwnerKeys: [OWNER_KEY],
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
    // Fails exactly once, on the write that follows the second createContainer.
    // It must fail only once, or the merge write below fails too and the test
    // proves nothing.
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
    // The record names the child that actually exists. `createContainer`
    // already dropped the handle `dock_1` named, so leaving it there would aim
    // every later stop/reclaim at an id the orchestrator cannot resolve — and
    // strand the node's workdir on disk forever.
    const stored = store.get(provisioned.id)!;
    expect(stored.dockerId).toBe('dock_2');
    expect(stored.seedEndpoint).toBe('http://127.0.0.1:9002/seed');
    expect(stored.seedToken).toBe('seed-token-2');
    // The attempt failed, so status and the reap clock are left alone.
    expect(stored.status).toBe('awaiting_seed');
    expect(stored.updatedAt).toBe(provisioned.updatedAt);
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

  it('reclaims the new child because the terminate could not clean up the old one', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    store.put({ ...store.get(provisioned.id)!, status: 'seeded' });

    // The borrower's DELETE lands in the window *after* the spawn dropped the
    // old handle — the window `abandonRespawn` was written for. (The test above
    // drives the same terminate from `onCreate`, i.e. before the drop, where the
    // terminate's own cleanup still works.) No `createDelayMs` needed: `onSpawned`
    // fires synchronously and `terminate` writes its `terminated` row before its
    // first `await`, so the row is terminal by the time `respawn` re-reads.
    let terminated: Promise<void> | undefined;
    orch.onSpawned = () => { terminated ??= svc.terminate(provisioned.id); };

    const result = await svc.respawn(provisioned.id);
    await terminated;

    expect(result).toEqual({ outcome: 'abandoned', status: 'terminated' });
    // Exact equality, not `toContain`: dock_1's ABSENCE is the whole claim. The
    // terminate aimed its own stop and reclaim at dock_1 — the handle this spawn
    // had already dropped — so it cleaned up nothing at all. That is why the
    // abandoned respawn has to reclaim dock_2 rather than merely stop it: dock_2
    // is the only thing left holding that spawn's ports and workdir.
    expect(orch.stopped).toEqual(['dock_2']);
    expect(orch.removed).toEqual(['dock_2']);
    // The ending's write stands whole, still naming the child it knew about.
    expect(store.get(provisioned.id)!.status).toBe('terminated');
    expect(store.get(provisioned.id)!.dockerId).toBe('dock_1');
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

  it('stops but does not reclaim the new child when the record goes error mid-spawn', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));

    // A give-up write landing inside the spawn window. Both spawns share one
    // workdir, so reclaiming here would delete the identity key `error`
    // deliberately keeps.
    orch.createDelayMs = 20;
    orch.onCreate = () => {
      store.put({ ...store.get(provisioned.id)!, status: 'error', error: 'gave up' });
    };

    const result = await svc.respawn(provisioned.id);

    expect(result).toEqual({ outcome: 'abandoned', status: 'error' });
    expect(orch.stopped).toContain('dock_2');
    expect(orch.removed).toEqual([]);
    const stored = store.get(provisioned.id)!;
    expect(stored.status).toBe('error');
    expect(stored.dockerId).toBe('dock_1');
  });

  it('abandons with no status when the record vanishes mid-spawn', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));

    orch.createDelayMs = 20;
    orch.onCreate = () => { store.remove(provisioned.id); };

    const result = await svc.respawn(provisioned.id);

    // No row to protect, so nothing is written back and the child is fully
    // reclaimed rather than left holding ports and a workdir nothing names.
    expect(result).toEqual({ outcome: 'abandoned' });
    expect(store.get(provisioned.id)).toBeUndefined();
    expect(orch.stopped).toContain('dock_2');
    expect(orch.removed).toContain('dock_2');
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
    // `removeContainer` already deleted the workdir — reclaiming by name on top
    // of that would be redundant, and would race the next spawn of the same id.
    expect(orch.reclaimedWorkdirs).toEqual([]);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('reclaims the workdir by name for a record that never got a dockerId', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    // A record the host died mid-provision on: `ensureNodeIdentity` created
    // `<rootDir>/grn_stuck` before anything produced a dockerId. Without this
    // branch, terminating it would move it to `terminated` — which the
    // stuck-`provisioning` reap no longer matches — stranding the directory.
    store.put({
      id: 'grn_stuck',
      grantToken: token,
      partyId: 'party-P',
      bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
      ownerKeys: [OWNER_KEY],
      profile: 'storage',
      status: 'provisioning',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    await svc.terminate('grn_stuck');

    expect(store.get('grn_stuck')?.status).toBe('terminated');
    expect(orch.reclaimedWorkdirs).toEqual(['grn_stuck']);
    expect(orch.stopped).toEqual([]);
    expect(orch.removed).toEqual([]);
  });

  it('swallows the second terminate of the same donation', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants();
    const svc = new DonationService({ orchestrator: orch, grants, store });

    const provisioned = await svc.provision(baseRequest(token));
    await svc.terminate(provisioned.id);

    // `terminate` does not gate on status, so the second pass re-aims its stop
    // and reclaim at a handle the first pass already removed. The orchestrator
    // rejects both; `safeStop` / `safeReclaim` log and swallow, so a duplicate
    // DELETE is a no-op rather than a 500. Reaps and retries both land here.
    await expect(svc.terminate(provisioned.id)).resolves.toBeUndefined();
    expect(orch.stopped).toEqual(['dock_1']);
    expect(orch.removed).toEqual(['dock_1']);
    expect(store.get(provisioned.id)!.status).toBe('terminated');
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

  it('leaves a loan alone when a seed lands mid-sweep, before its turn comes up', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants({ maxNodes: 5 });
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    const first = await svc.provision(baseRequest(token));
    const second = await svc.provision(baseRequest(token));
    clock = new Date(clock.getTime() + DONATION_AWAITING_SEED_TTL_MS + 60_000);

    // The borrower seeds the second loan while the sweep is still awaiting the
    // FIRST record's stop — the very write `applySeed` makes once its node
    // answers. The sweep's candidate list predates it, so acting on that stale
    // copy would terminate a loan that just came good.
    orch.onStop = (dockerId) => {
      if (dockerId !== 'dock_1') return;
      store.put({ ...store.get(second.id)!, status: 'seeded', updatedAt: clock.toISOString() });
    };

    await expect(svc.reapStaleAwaitingSeed()).resolves.toEqual([first.id]);

    expect(store.get(first.id)?.status).toBe('terminated');
    expect(store.get(second.id)?.status).toBe('seeded');
    expect(orch.stopped).toEqual(['dock_1']);
    expect(orch.removed).toEqual(['dock_1']);
    // The seeded loan still holds its quota slot; the reaped one does not.
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

describe('DonationService.reapStaleProvisioning', () => {
  /**
   * A donation whose host died right after writing the `provisioning` row —
   * exactly what `provisionLocked` writes before it ever calls the
   * orchestrator (see `donation-service.ts`). No `dockerId`: nothing beyond
   * this raw write ever happened for the record itself.
   */
  const stuckRecord = (opts: { id: string; token: string; at: string }): Donation => ({
    id: opts.id,
    grantToken: opts.token,
    partyId: 'party-P',
    bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
    ownerKeys: [OWNER_KEY],
    profile: 'storage',
    status: 'provisioning',
    createdAt: opts.at,
    updatedAt: opts.at,
  });

  it('reaps a donation stuck in provisioning past the TTL and marks it error', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants({ maxNodes: 5 });
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    store.put(stuckRecord({ id: 'grn_stuck', token, at: clock.toISOString() }));
    clock = new Date(clock.getTime() + DONATION_PROVISIONING_TTL_MS + 60_000);

    const reaped = await svc.reapStaleProvisioning(DONATION_PROVISIONING_TTL_MS);

    expect(reaped).toEqual(['grn_stuck']);
    expect(store.get('grn_stuck')?.status).toBe('error');
    expect(store.get('grn_stuck')?.error).toMatch(/provisioning/);
    // Nothing was ever spawned — no dockerId to resolve, so nothing to stop or
    // remove by handle. The workdir the dead spawn created is still reachable
    // by container name, though, and this is the only path that will ever
    // remove it.
    expect(orch.stopped).toEqual([]);
    expect(orch.removed).toEqual([]);
    expect(orch.reclaimedWorkdirs).toEqual(['grn_stuck']);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('stops and reclaims the child when the orchestrator can resolve its dockerId', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants({ maxNodes: 5 });
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    // Simulates a crash between the host spawning the child (the orchestrator
    // already knows it by dockerId) and `provisionLocked` writing that dockerId
    // onto the donation record — the resource-leak wrinkle from the ticket.
    const spawn = await orch.createContainer({
      containerId: 'grn_stuck',
      partyId: 'party-P',
      bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
      profile: 'storage',
      pinnedOwnerKeys: [OWNER_KEY],
    });
    store.put(stuckRecord({ id: 'grn_stuck', token, at: clock.toISOString() }));
    clock = new Date(clock.getTime() + DONATION_PROVISIONING_TTL_MS + 60_000);

    const reaped = await svc.reapStaleProvisioning(DONATION_PROVISIONING_TTL_MS);

    expect(reaped).toEqual(['grn_stuck']);
    expect(store.get('grn_stuck')?.status).toBe('error');
    expect(orch.stopped).toEqual([spawn.dockerId]);
    expect(orch.removed).toEqual([spawn.dockerId]);
    // `removeContainer` deletes that child's workdir itself; reclaiming by name
    // on top of it would be redundant.
    expect(orch.reclaimedWorkdirs).toEqual([]);
    expect(store.liveNodeCount(token)).toBe(0);
  });

  it('leaves a fresh provisioning record within the TTL alone', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants({ maxNodes: 5 });
    const clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    store.put(stuckRecord({ id: 'grn_fresh', token, at: clock.toISOString() }));

    expect(await svc.reapStaleProvisioning(DONATION_PROVISIONING_TTL_MS)).toEqual([]);
    expect(store.get('grn_fresh')?.status).toBe('provisioning');
    expect(orch.stopped).toEqual([]);
  });

  it('leaves a record alone that legitimately advances between the sweep snapshot and its per-record re-read', async () => {
    const orch = new FakeOrchestrator();
    const store = new DonationStore(join(tmpRoot, 'donations'));
    const { grants, token } = makeGrants({ maxNodes: 5 });
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new DonationService({ orchestrator: orch, grants, store, now: () => clock });

    const firstSpawn = await orch.createContainer({
      containerId: 'grn_first',
      partyId: 'party-P',
      bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
      profile: 'storage',
      pinnedOwnerKeys: [OWNER_KEY],
    });
    store.put(stuckRecord({ id: 'grn_first', token, at: clock.toISOString() }));
    store.put(stuckRecord({ id: 'grn_second', token, at: clock.toISOString() }));
    clock = new Date(clock.getTime() + DONATION_PROVISIONING_TTL_MS + 60_000);

    // The second record's own in-flight `provisionLocked` call finally lands
    // while the sweep is still awaiting the FIRST record's stop — the sweep's
    // candidate list predates that write, so acting on the stale copy would
    // wrongly terminate a provision that just came good.
    orch.onStop = (dockerId) => {
      if (dockerId !== firstSpawn.dockerId) return;
      store.put({ ...store.get('grn_second')!, status: 'awaiting_seed', updatedAt: clock.toISOString() });
    };

    const reaped = await svc.reapStaleProvisioning(DONATION_PROVISIONING_TTL_MS);

    expect(reaped).toEqual(['grn_first']);
    expect(store.get('grn_first')?.status).toBe('error');
    expect(store.get('grn_second')?.status).toBe('awaiting_seed');
    expect(store.liveNodeCount(token)).toBe(1);
  });
});
