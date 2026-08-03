/**
 * Cross-package node-donation integration.
 *
 * This is the **donate-a-node (donor) scenario**: cadre-host contributes a node
 * to an *external* requester's cadre. The complementary own-cadre (founder)
 * flow — where the host spawns a node that founds *its own* cadre — is covered
 * by `cadre-host-owner-node.integration.ts`.
 *
 * The requester's authority ("phone") is a **second real `@serfab/cadre-cli`
 * child** that founds its own cadre (party `P`). cadre-host then donates a node
 * *into* `P`, and we assert the full lifecycle over the real wire:
 *
 *   1. requester authority node up (its owner key + dialable multiaddrs become
 *      the donation's `ownerKeys` + `bootstrapNodes`)
 *   2. host donates a node via `DonationService.provision` → `awaiting_seed`
 *   3. `getPeer` reports the donated node's real peerId + multiaddrs
 *   4. the requester mints a seed for it (`OwnerNodeClient.addDrone`)
 *   5. `applySeed` → `peersAdded >= 1` (the gate proving the pinned-owner-key
 *      trust wiring works — a cold node with no pin rejects here)
 *   6. the donated node syncs into party `P` (a live control connection), NOT a
 *      host party
 *   7. `terminate` releases the node + workdir
 *
 * Everything is loopback. **WAN reachability is out of scope** here (a green
 * donation test says nothing about a remote phone reaching the host over NAT) —
 * that is the deferred `backlog/feat-cadre-host-wan-grant-reachability`.
 *
 * The orchestrator resolves the real cadre-cli bin (no `spawn.entrypoint`
 * override), so this requires `@serfab/cadre-cli` and `@serfab/cadre-host` to be
 * built. Two real libp2p + control-DB children make this slow, so each node is
 * spawned once with generous timeouts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import { ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
  OWNER_CONTAINER_ID,
  OwnerNodeClient,
  HostProcessOrchestrator,
  GrantService,
  GrantStore,
  DonationService,
  DonationStore,
  type DonationSeedResult,
  type OwnerSpawnConfig,
} from '@serfab/cadre-host';

import { readNodeLocalStore, waitUntil, withPeerId, writeIdentity } from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;

describe('cadre-host donates a node into a requester’s cadre (real cadre-cli)', () => {
  let tmpRoot: string;
  let requesterOrch: HostProcessOrchestrator;
  let hostOrch: HostProcessOrchestrator;
  let requesterClient: OwnerNodeClient;
  let donationService: DonationService;
  let requesterPeerId: string;
  /** The requester owner's base64url public key — pinned on the donated node. */
  let requesterOwnerKey: string;
  let bootstrapNodes: string[];
  const partyId = `donation-int-${Math.random().toString(36).slice(2)}`;

  // Threaded across the ordered step tests below (vitest runs them in order).
  let grantToken: string;
  let donationId: string;
  let peerInfo: { peerId: string; multiaddrs: string[] };
  let encodedSeed: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-donation-'));

    // (1) Requester authority node — a second real cadre-cli child standing in
    // for the phone. It founds its OWN cadre (party P); we donate INTO it.
    const identityPath = join(tmpRoot, 'requester-identity.key');
    const { key } = await writeIdentity(identityPath);
    requesterPeerId = peerIdFromPrivateKey(key).toString();
    // The donated node must pin THIS key to accept the requester-signed seed.
    requesterOwnerKey = ed25519KeyPairFromLibp2p(key).publicKeyB64;

    requesterOrch = new HostProcessOrchestrator({
      // Dedicated high band (distinct from the owner-node scenario's 19600–19899).
      rootDir: join(tmpRoot, 'requester-orchestrator'),
      portRange: { start: 19900, end: 20039 },
      stopTimeoutMs: 5_000,
    });
    await requesterOrch.init();

    const cfg: OwnerSpawnConfig = {
      identityPath,
      partyId,
      // Ephemeral libp2p port — OS-assigned, so getMultiaddrs() reports the real
      // bound address and cross-suite TCP collisions are avoided.
      libp2pPort: 0,
      profile: 'storage',
    };
    const requesterNode = await requesterOrch.ensureOwnerNode(cfg);
    expect(requesterNode.id).toBe(OWNER_CONTAINER_ID);

    requesterClient = new OwnerNodeClient(() => requesterOrch.getOwnerAdminEndpoint());
    try {
      await waitUntil(
        async () => (await requesterClient.getPeerId()) === requesterPeerId,
        { timeoutMs: STARTUP_MS, intervalMs: 250, description: 'requester admin channel ready' },
      );
    } catch (err) {
      let nodeLog = '';
      try { nodeLog = await requesterOrch.getLogs(requesterNode.dockerId, 200); } catch { /* ignore */ }
      throw new Error(
        `requester node never became ready: ${(err as Error).message}\n--- node.log ---\n${nodeLog}`,
        { cause: err },
      );
    }

    // Requester's dialable control-network addrs → the donated node's bootstrap.
    const addrs = await requesterClient.getMultiaddrs();
    bootstrapNodes = addrs.map((a) => withPeerId(a, requesterPeerId));

    // (2 setup) Donor host: its own orchestrator + grant/donation services.
    hostOrch = new HostProcessOrchestrator({
      rootDir: join(tmpRoot, 'host-orchestrator'),
      portRange: { start: 20040, end: 20199 },
      stopTimeoutMs: 5_000,
    });
    await hostOrch.init();

    const grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
    grantToken = grants.issue({ label: 'integration test cadre' }).token;
    donationService = new DonationService({
      orchestrator: hostOrch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });
  }, STARTUP_MS + 15_000);

  afterAll(async () => {
    for (const orch of [hostOrch, requesterOrch]) {
      if (!orch) continue;
      try { await orch.stopOwnerNode(); } catch { /* ignore */ }
      for (const n of orch.listNodes()) {
        try { await orch.removeContainer(n.dockerId); } catch { /* ignore */ }
      }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  });

  it('step 2: host provisions a donated node into party P (awaiting_seed, pinned owner key)', async () => {
    const donation = await donationService.provision({
      grantToken,
      partyId,
      bootstrapNodes,
      ownerKeys: [requesterOwnerKey],
      profile: 'storage',
    });
    donationId = donation.id;
    expect(donation.status).toBe('awaiting_seed');
    expect(donation.partyId).toBe(partyId);

    // The donated node is registered with the HOST orchestrator, but joined the
    // REQUESTER's party — not any host party.
    const info = hostOrch.getNode(donationId);
    expect(info?.partyId).toBe(partyId);
    // NOTE: the pinned CADRE_OWNER_KEYS env threading is asserted at the unit
    // level (cadre-host orchestrator suite). Here the observable proof the pin
    // took effect is step 5 — a cold node with no pin rejects the seed.
  }, STARTUP_MS);

  it('step 3: getPeer reports the donated node’s real peer id + multiaddrs', async () => {
    await waitUntil(async () => {
      try {
        peerInfo = await donationService.getPeer(donationId);
        return !!peerInfo.peerId;
      } catch {
        return false;
      }
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'donated node peer identity' });

    expect(peerInfo.peerId).toMatch(/^12D3Koo/); // Ed25519 libp2p peer id prefix
    expect(peerInfo.multiaddrs.length).toBeGreaterThanOrEqual(1);
  }, STARTUP_MS);

  it('step 4–5: requester mints a seed (addDrone), donated node accepts it (peersAdded ≥ 1)', async () => {
    const drone = await requesterClient.addDrone({
      dronePeerId: peerInfo.peerId,
      droneMultiaddrs: peerInfo.multiaddrs,
    });
    encodedSeed = drone.encodedSeed;
    expect(typeof encodedSeed).toBe('string');
    expect(encodedSeed.length).toBeGreaterThan(0);

    // applySeed may briefly race the node's seed-route readiness — poll until it
    // reports `seeded`. A cold node WITHOUT the pinned owner key comes back
    // `rejected`, so this (correctly) times out if the pin wiring is broken.
    let result: DonationSeedResult | undefined;
    await waitUntil(async () => {
      result = await donationService.applySeed(donationId, encodedSeed);
      return result.outcome === 'seeded';
    }, { timeoutMs: OP_MS, intervalMs: 1_000, description: 'donated node accepts seed' });

    expect(result?.outcome).toBe('seeded');
    expect(result?.outcome === 'seeded' ? result.peersAdded : 0).toBeGreaterThanOrEqual(1);
    expect(donationService.get(donationId)?.status).toBe('seeded');
  }, OP_MS + 10_000);

  it('step 6: the donated node syncs into the requester’s cadre (party P, live control peer)', async () => {
    const info = hostOrch.getNode(donationId);
    expect(info).toBeDefined();
    const statusUrl = `http://127.0.0.1:${info!.ports.health}/status`;

    // The donated node dials the requester owner (delivered in the seed) and
    // opens a control connection; sync lags applySeed, so poll. partyId === P
    // proves it joined the REQUESTER's cadre, not a host party.
    await waitUntil(async () => {
      const res = await fetch(statusUrl);
      if (!res.ok) return false;
      const status = (await res.json()) as {
        node?: { partyId?: string; connectionPaths?: { total?: number } };
      };
      return status.node?.partyId === partyId && (status.node?.connectionPaths?.total ?? 0) >= 1;
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'donated node synced into requester cadre' });
  }, STARTUP_MS);

  // The donated node's whole reason for holding a durable identity key is that
  // `cadre-cli start` opens the file-backed bootstrap-peer and trusted-owner
  // stores only when one is configured, and puts them beside it. Unit tests can
  // only prove the spawn argument; this is the one place a real cadre-cli child
  // has actually run and taken a real seed, so it is where that link is checked.
  it('step 6b: the donated node persists its identity + node-local stores in its workdir', async () => {
    const workdir = hostOrch.getNode(donationId)!.workdir;

    const identityPath = join(workdir, 'identity.key');
    const key = privateKeyFromProtobuf(new Uint8Array(readFileSync(identityPath)));
    // The peer id the requester approved IS the one on disk — so a re-spawn
    // from this workdir rejoins as the same node rather than as a stranger.
    expect(peerIdFromPrivateKey(key).toString()).toBe(peerInfo.peerId);

    // Both stores are written on seed intake, which lags applySeed's response.
    // They are snapshot-written only from a `put`, so a file existing already
    // means at least one entry landed — but assert the payload anyway, since
    // "some file with the right prefix" would also pass for a foreign party or
    // a stranger's key.
    await waitUntil(
      async () =>
        !!readNodeLocalStore(workdir, 'bootstrap-peers') && !!readNodeLocalStore(workdir, 'trusted-owners'),
      { timeoutMs: OP_MS, intervalMs: 500, description: 'node-local stores materialise in the donated workdir' },
    );

    // The retained cold-start dial target is the requester owner the seed
    // nominated, and the anchored owner key is the one the node was pinned to.
    const peers = readNodeLocalStore(workdir, 'bootstrap-peers')!;
    expect(peers.partyId).toBe(partyId);
    expect(Object.keys(peers.peers ?? {})).toContain(requesterPeerId);

    const owners = readNodeLocalStore(workdir, 'trusted-owners')!;
    expect(owners.partyId).toBe(partyId);
    expect(Object.keys(owners.owners ?? {})).toContain(requesterOwnerKey);
  }, OP_MS + 5_000);

  it('step 7: terminate removes the node and marks the donation terminated', async () => {
    await donationService.terminate(donationId);
    expect(donationService.get(donationId)?.status).toBe('terminated');
    // Node handle + workdir released by the orchestrator.
    expect(hostOrch.getNode(donationId)).toBeUndefined();
  }, OP_MS);
});
