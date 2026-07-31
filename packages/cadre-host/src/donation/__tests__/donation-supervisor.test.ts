/**
 * DonationSupervisor unit tests — the component that notices a donated node is
 * no longer running and calls `DonationService.respawn`, backs off between
 * attempts, and eventually gives up.
 *
 * Exercised against the shared `FakeOrchestrator` (no real child processes), a
 * real on-disk `DonationStore`, and an injected clock — so backoff and the
 * healthy-reset window are asserted without any wall-clock waiting.
 *
 * What is NOT covered here: that a really-respawned child rejoins the borrower's
 * cadre. That needs the cross-package `cadre-host-node-donation` integration
 * scenario.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ManagedNodeInfo } from '../../orchestrator/types.js';
import { DonationService } from '../donation-service.js';
import { DonationStore } from '../donation-store.js';
import {
  DonationSupervisor,
  DONATION_RESPAWN_HEALTHY_MS,
  DONATION_RESPAWN_MAX_ATTEMPTS,
} from '../donation-supervisor.js';
import { GrantService } from '../grant-service.js';
import { GrantStore } from '../grant-store.js';
import type { Donation, DonationView } from '../types.js';
import { FakeOrchestrator } from './fake-orchestrator.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-donation-sup-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Everything one test needs, sharing a single mutable clock. */
interface Harness {
  orch: FakeOrchestrator;
  store: DonationStore;
  service: DonationService;
  supervisor: DonationSupervisor;
  /** Move the shared clock forward. */
  advance: (ms: number) => void;
  nowMs: () => number;
  /** Provision one donation. */
  provision: () => Promise<DonationView>;
}

const START_MS = Date.parse('2026-01-01T00:00:00.000Z');

function makeHarness(): Harness {
  let nowMs = START_MS;
  const now = (): Date => new Date(nowMs);

  const orch = new FakeOrchestrator();
  const store = new DonationStore(join(tmpRoot, 'donations'));
  const grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
  const token = grants.issue({ label: 'Alice', maxNodes: 10 }).token;
  const service = new DonationService({ orchestrator: orch, grants, store, now });
  const supervisor = new DonationSupervisor({ service, store, orchestrator: orch, now });

  return {
    orch,
    store,
    service,
    supervisor,
    advance: (ms) => { nowMs += ms; },
    nowMs: () => nowMs,
    provision: () => service.provision({
      grantToken: token,
      partyId: 'party-P',
      bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
      ownerKeys: ['owner-key-b64url'],
    }),
  };
}

/** Force a record's status without going through the (fetch-driven) seed path. */
function setStatus(store: DonationStore, id: string, status: Donation['status']): void {
  store.put({ ...requireDonation(store, id), status });
}

function requireDonation(store: DonationStore, id: string): Donation {
  const donation = store.get(id);
  if (!donation) throw new Error(`no donation ${id}`);
  return donation;
}

function dockerIdOf(donation: { dockerId?: string }): string {
  if (!donation.dockerId) throw new Error('donation has no dockerId');
  return donation.dockerId;
}

/** Let queued fire-and-forget passes run. */
function flush(): Promise<void> {
  return new Promise((res) => setTimeout(res, 5));
}

describe('DonationSupervisor.reconcile', () => {
  it('respawns a seeded-but-stopped node, keeping its status and swapping its handle', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    h.orch.crash(dockerIdOf(view));

    const respawned = await h.supervisor.reconcile();

    expect(respawned).toEqual([view.id]);
    const stored = requireDonation(h.store, view.id);
    expect(stored.dockerId).toBe('dock_2');
    expect(stored.dockerId).not.toBe(view.dockerId);
    // A seeded node needs no re-seeding — the loan is still live.
    expect(stored.status).toBe('seeded');
    // Fresh host↔node bearer for the new child.
    expect(stored.seedToken).toBe('seed-token-2');
    expect(h.orch.createCalls).toHaveLength(2);
  });

  it('leaves a running node alone', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(1);
  });

  it('never respawns a terminated loan', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    await h.service.terminate(view.id);

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(1);
    expect(requireDonation(h.store, view.id).status).toBe('terminated');
  });

  it('respawns a stopped awaiting_seed node so the borrower can still seed it', async () => {
    const h = makeHarness();
    const view = await h.provision();
    h.orch.crash(dockerIdOf(view));

    await expect(h.supervisor.reconcile()).resolves.toEqual([view.id]);
    const stored = requireDonation(h.store, view.id);
    expect(stored.status).toBe('awaiting_seed');
    expect(stored.seedEndpoint).toContain('9002');
  });

  it('honours the backoff window, then attempts again once the clock passes it', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    h.orch.crash(dockerIdOf(view));
    h.orch.failCreate = true;

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(2);
    expect(requireDonation(h.store, view.id).respawn?.attempts).toBe(1);

    // attempts = 1 → base * 2^1 = 10s. One second later is still too soon.
    h.advance(1_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(2);
    expect(requireDonation(h.store, view.id).respawn?.attempts).toBe(1);

    h.advance(10_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(3);
    expect(requireDonation(h.store, view.id).respawn?.attempts).toBe(2);
  });

  it('gives up after the attempt cap: record → error, child stopped but not reclaimed', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    h.orch.crash(dockerIdOf(view));
    h.orch.failCreate = true;

    for (let i = 0; i < DONATION_RESPAWN_MAX_ATTEMPTS; i++) {
      await h.supervisor.reconcile();
      // Well past the longest backoff, so every pass gets to attempt.
      h.advance(10 * 60_000);
    }

    const stored = requireDonation(h.store, view.id);
    expect(stored.status).toBe('error');
    expect(stored.respawn?.attempts).toBe(DONATION_RESPAWN_MAX_ATTEMPTS);
    expect(stored.error).toContain(`${DONATION_RESPAWN_MAX_ATTEMPTS} attempts`);
    expect(stored.error).toContain('spawn boom');
    // The workdir holds the identity key the borrower's cadre approved — the
    // give-up path stops the child but must never reclaim it.
    expect(h.orch.stopped).toContain(view.dockerId);
    expect(h.orch.removed).toEqual([]);

    // `error` is terminal: no further attempts, and the grant's quota is freed.
    const createsAtGiveUp = h.orch.createCalls.length;
    h.advance(10 * 60_000);
    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toHaveLength(createsAtGiveUp);
    expect(h.store.liveNodeCount(stored.grantToken)).toBe(0);
  });

  it('refills the attempt budget once a respawned node has stayed up', async () => {
    const h = makeHarness();
    const view = await h.provision();
    const provisioned = requireDonation(h.store, view.id);
    h.store.put({
      ...provisioned,
      status: 'seeded',
      respawn: { attempts: 3, lastAttemptAt: new Date(h.nowMs()).toISOString() },
    });

    // Still inside the healthy window — the crash loop's count stands.
    h.advance(DONATION_RESPAWN_HEALTHY_MS - 1_000);
    await h.supervisor.reconcile();
    expect(requireDonation(h.store, view.id).respawn?.attempts).toBe(3);

    h.advance(2_000);
    await h.supervisor.reconcile();
    expect(requireDonation(h.store, view.id).respawn?.attempts).toBe(0);
    // A liveness observation is not borrower activity — the stale-awaiting_seed
    // reap's clock must not be pushed forward by it.
    expect(requireDonation(h.store, view.id).updatedAt).toBe(provisioned.updatedAt);
  });

  it('skips a record that predates persisted spawn inputs without ending the sweep', async () => {
    const h = makeHarness();
    // Written first, so a throw here would starve the respawnable record below.
    h.store.put({
      id: 'grn_legacy',
      grantToken: 'tok-legacy',
      partyId: 'party-old',
      profile: 'storage',
      status: 'seeded',
      dockerId: 'dock_gone',
      createdAt: new Date(START_MS).toISOString(),
      updatedAt: new Date(START_MS).toISOString(),
    });

    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    h.orch.crash(dockerIdOf(view));

    await expect(h.supervisor.reconcile()).resolves.toEqual([view.id]);
    const legacy = requireDonation(h.store, 'grn_legacy');
    expect(legacy.status).toBe('seeded');
    expect(legacy.respawn).toBeUndefined();
  });

  it('skips a record that has no orchestrator handle yet', async () => {
    const h = makeHarness();
    h.store.put({
      id: 'grn_nohandle',
      grantToken: 'tok',
      partyId: 'party-P',
      bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
      ownerKeys: ['k'],
      profile: 'storage',
      status: 'awaiting_seed',
      createdAt: new Date(START_MS).toISOString(),
      updatedAt: new Date(START_MS).toISOString(),
    });

    await expect(h.supervisor.reconcile()).resolves.toEqual([]);
    expect(h.orch.createCalls).toEqual([]);
  });

  it('serializes overlapping passes so one id is never double-spawned', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    h.orch.crash(dockerIdOf(view));
    h.orch.createDelayMs = 20;

    const [first, second] = await Promise.all([
      h.supervisor.reconcile(),
      h.supervisor.reconcile(),
    ]);

    // Whichever pass wins the tail respawns; the other then finds it running.
    expect([...first, ...second]).toEqual([view.id]);
    // The original provision plus exactly one respawn.
    expect(h.orch.createCalls).toHaveLength(2);
  });
});

describe('DonationSupervisor start/stop', () => {
  it('sweeps at startup and again on a donated child exit', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');
    h.orch.crash(dockerIdOf(view));

    h.supervisor.start();
    try {
      // Queued behind the startup pass, so awaiting it proves that pass ran.
      await h.supervisor.reconcile();
      expect(requireDonation(h.store, view.id).dockerId).toBe('dock_2');

      // Now the exit-event trigger, with no manual reconcile in between.
      h.advance(60_000);
      h.orch.crash('dock_2');
      await flush();
      expect(requireDonation(h.store, view.id).dockerId).toBe('dock_3');
    } finally {
      h.supervisor.stop();
    }
  });

  it('ignores owner-node exits — bin/host.ts owns re-spawning that one', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');

    h.supervisor.start();
    try {
      await h.supervisor.reconcile(); // drain the startup pass (node is running)
      // Take the node down WITHOUT an exit event, so the only event in play is
      // the owner's.
      await h.orch.stopContainer(dockerIdOf(view));

      const ownerExit: ManagedNodeInfo = {
        id: 'owner',
        dockerId: 'dock_owner',
        partyId: 'host-party',
        profile: 'storage',
        status: 'stopped',
        spawnedAt: new Date(START_MS).toISOString(),
        workdir: '/fake/owner',
        ports: { health: 0, metrics: 0, p2p: 0, admin: 0 },
        owner: true,
      };
      h.orch.emit(ownerExit);
      await flush();

      expect(h.orch.createCalls).toHaveLength(1);
      expect(requireDonation(h.store, view.id).dockerId).toBe(view.dockerId);
    } finally {
      h.supervisor.stop();
    }
  });

  it('stops reacting to exits after stop()', async () => {
    const h = makeHarness();
    const view = await h.provision();
    setStatus(h.store, view.id, 'seeded');

    h.supervisor.start();
    await h.supervisor.reconcile();
    h.supervisor.stop();

    h.orch.crash(dockerIdOf(view));
    await flush();
    // The exit listener is gone, so the crash goes unnoticed until the next start.
    expect(requireDonation(h.store, view.id).dockerId).toBe(view.dockerId);
  });
});
