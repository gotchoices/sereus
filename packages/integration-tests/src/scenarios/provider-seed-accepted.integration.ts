/**
 * Cross-package provider-seed integration.
 *
 * Proves that a node started **the provider's way** — a real `@serfab/cadre-cli`
 * child whose environment comes from the provider's own `buildNodeEnv()`
 * (via `ProviderProcessOrchestrator`) — actually honours the seed the provider
 * delivers. Every other provider test stops at the provider's boundary
 * (`container-seed-endpoint.test.ts` stubs `fetch`), so a drift in the
 * provider→node env contract would pass all of them while every customer's
 * first seed is silently refused. This suite is the gap-closer.
 *
 * Two independent gates decide a delivered seed's fate, and both are exercised
 * for real here:
 *
 *   - the **delivery gate**: the per-container `CADRE_SEED_TOKEN` bearer the
 *     provider mints and presents on `POST /seed` (wrong bearer → 401),
 *   - the **trust gate**: the node's own seed-trust policy against the
 *     `CADRE_OWNER_KEYS` pin it was started with (untrusted signer → 400).
 *
 * Steps:
 *   1. owner authority node up (a real cadre-cli child via cadre-host's
 *      HostProcessOrchestrator — its key is the pin, its multiaddrs the
 *      bootstrap)
 *   2. `ContainerService.createContainer` provisions node A pinned to the
 *      owner; the store record reaches `running` via the service's real
 *      enrollment loop
 *   3. the owner mints a seed for A (`addDrone`) and `applySeed` succeeds —
 *      the assertion this suite exists for
 *   4. node B, pinned to a stranger's key, refuses the same seed (400 with the
 *      trust policy's reason) — and a wrong bearer on B's seed endpoint gets a
 *      401 instead, proving the two gates fail independently
 *   5. node A restarted from its surviving volume with NO pin still accepts a
 *      second seed — the first accepted seed anchored the owner key durably
 *
 * Everything is loopback; real Docker / `entrypoint.sh` execution stays out of
 * scope (the orchestrator reproduces the image env + entrypoint derivations in
 * process — see its module doc).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import { ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
  OWNER_CONTAINER_ID,
  OwnerNodeClient,
  HostProcessOrchestrator,
  type OwnerSpawnConfig,
} from '@serfab/cadre-host';
import { ContainerService, MemoryStore } from '@serfab/cadre-provider';

import {
  ProviderProcessOrchestrator,
  readNodeLocalStore,
  waitUntil,
  withPeerId,
  writeIdentity,
} from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;

describe('provider-started node accepts the seed the provider delivers (real cadre-cli)', () => {
  let tmpRoot: string;
  let ownerOrch: HostProcessOrchestrator;
  let ownerClient: OwnerNodeClient;
  let orchestrator: ProviderProcessOrchestrator;
  let store: MemoryStore;
  let containers: ContainerService;
  let ownerPeerId: string;
  /** The owner's base64url public key — pinned on node A at provision time. */
  let ownerKey: string;
  let bootstrapNodes: string[];
  const partyId = `provider-seed-int-${Math.random().toString(36).slice(2)}`;
  const customerId = 'cust-provider-seed-int';

  // Threaded across the ordered step tests below (vitest runs them in order).
  let idA: string;
  let idB: string;
  let peerInfoA: { peerId: string; multiaddrs: string[] };
  let encodedSeed: string;

  /** Tail a provider child's node.log for a failure message — never throws. */
  async function tailNodeLog(dockerId: string | undefined): Promise<string> {
    if (!dockerId) return '(no dockerId recorded)';
    try {
      return await orchestrator.getLogs(dockerId, 200);
    } catch {
      return '(node.log unavailable)';
    }
  }

  /**
   * Poll the provider store until the service's real enrollment loop settles
   * the record (`running`, or `error` on a provisioning failure), then require
   * `running` — with the child's node.log in the failure message, since a node
   * that never came up is otherwise a bare timeout.
   */
  async function requireRunning(id: string, label: string): Promise<void> {
    try {
      await waitUntil(async () => {
        const c = await store.getContainer(id);
        return c?.status === 'running' || c?.status === 'error';
      }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: `${label} enrollment settles` });
    } catch (err) {
      const record = await store.getContainer(id);
      const nodeLog = await tailNodeLog(record?.dockerId);
      throw new Error(
        `${label} never settled (status: ${record?.status}).\n--- node.log ---\n${nodeLog}`,
        { cause: err },
      );
    }
    const record = (await store.getContainer(id))!;
    if (record.status !== 'running') {
      const nodeLog = await tailNodeLog(record.dockerId);
      throw new Error(
        `${label} settled as '${record.status}' (error: ${record.error}).\n--- node.log ---\n${nodeLog}`,
      );
    }
  }

  /** A message for anything a poll can have thrown, `undefined` included. */
  function reasonOf(err: unknown): string {
    if (err === undefined) return 'none';
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Mint a seed on the owner for `peer` and deliver it through the provider's
   * real `applySeed`, retrying both halves together until the node accepts.
   *
   * Both halves are transiently flaky for reasons that are not this suite's
   * subject: the owner's `addDrone` can fail with an internal error while
   * cluster membership is in flux (and, after a restart, while it lacks read
   * quorum on the collection the restarted node holds replicas of), and the
   * node's seed route can lag the /status readiness that got us here. A node
   * whose trust source never reached it keeps refusing, so a broken env
   * contract still (correctly) times out — but with the mint error, the last
   * delivery result and the child's node.log attached, since `waitUntil` alone
   * reports a bare timeout with the cause swallowed.
   */
  async function deliverSeed(
    id: string,
    peer: { peerId: string; multiaddrs: string[] },
    description: string,
    timeoutMs: number,
  ): Promise<{ encodedSeed: string; peersAdded: number }> {
    let minted: string | undefined;
    let mintError: unknown;
    let result: { success: boolean; peersAdded?: number; error?: string } | undefined;
    try {
      await waitUntil(async () => {
        try {
          const drone = await ownerClient.addDrone({
            dronePeerId: peer.peerId,
            droneMultiaddrs: peer.multiaddrs,
          });
          minted = drone.encodedSeed;
          mintError = undefined;
        } catch (err) {
          mintError = err;
          throw err;
        }
        result = await containers.applySeed(id, minted);
        return result.success === true;
      }, { timeoutMs, intervalMs: 1_000, description });
    } catch (err) {
      const record = await store.getContainer(id);
      throw new Error(
        [
          (err as Error).message,
          `last mint error: ${reasonOf(mintError)}`,
          `last delivery result: ${JSON.stringify(result ?? null)}`,
          '--- node.log ---',
          await tailNodeLog(record?.dockerId),
        ].join('\n'),
        { cause: err },
      );
    }
    return { encodedSeed: minted!, peersAdded: result?.peersAdded ?? 0 };
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'provider-seed-'));

    // (1) Owner authority node — a real cadre-cli child standing in for the
    // customer's phone. It founds the cadre the provider-hosted nodes join.
    const identityPath = join(tmpRoot, 'owner-identity.key');
    const { key } = await writeIdentity(identityPath);
    ownerPeerId = peerIdFromPrivateKey(key).toString();
    // The provider-hosted node must pin THIS key to accept the owner's seed.
    ownerKey = ed25519KeyPairFromLibp2p(key).publicKeyB64;

    ownerOrch = new HostProcessOrchestrator({
      // Dedicated high band — 19600–20199 are claimed by the cadre-host suites.
      rootDir: join(tmpRoot, 'owner-orchestrator'),
      portRange: { start: 20200, end: 20339 },
      stopTimeoutMs: 5_000,
    });
    await ownerOrch.init();

    const cfg: OwnerSpawnConfig = {
      identityPath,
      partyId,
      // Ephemeral libp2p port — OS-assigned, so getMultiaddrs() reports the real
      // bound address and cross-suite TCP collisions are avoided.
      libp2pPort: 0,
      profile: 'storage',
    };
    const ownerNode = await ownerOrch.ensureOwnerNode(cfg);
    expect(ownerNode.id).toBe(OWNER_CONTAINER_ID);

    ownerClient = new OwnerNodeClient(() => ownerOrch.getOwnerAdminEndpoint());
    try {
      await waitUntil(
        async () => (await ownerClient.getPeerId()) === ownerPeerId,
        { timeoutMs: STARTUP_MS, intervalMs: 250, description: 'owner admin channel ready' },
      );
    } catch (err) {
      let nodeLog = '';
      try { nodeLog = await ownerOrch.getLogs(ownerNode.dockerId, 200); } catch { /* ignore */ }
      throw new Error(
        `owner node never became ready: ${(err as Error).message}\n--- node.log ---\n${nodeLog}`,
        { cause: err },
      );
    }

    // The owner's dialable control-network addrs → the hosted nodes' bootstrap.
    const addrs = await ownerClient.getMultiaddrs();
    bootstrapNodes = addrs.map((a) => withPeerId(a, ownerPeerId));

    // (2 setup) The provider, wired exactly as production wires it — real
    // ContainerService, real store, and an orchestrator that starts real
    // cadre-cli children from buildNodeEnv() output. No fetch stubs anywhere.
    orchestrator = new ProviderProcessOrchestrator({ rootDir: join(tmpRoot, 'provider-volumes') });
    store = new MemoryStore();
    containers = new ContainerService({ store, orchestrator });
  }, STARTUP_MS + 15_000);

  afterAll(async () => {
    if (orchestrator) {
      for (const handle of orchestrator.listHandles()) {
        try { await orchestrator.stopContainer(handle.dockerId); } catch { /* ignore */ }
      }
    }
    if (ownerOrch) {
      try { await ownerOrch.stopOwnerNode(); } catch { /* ignore */ }
      for (const n of ownerOrch.listNodes()) {
        try { await ownerOrch.removeContainer(n.dockerId); } catch { /* ignore */ }
      }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  });

  it('step 1: owner authority is up with a dialable identity', async () => {
    expect(await ownerClient.getPeerId()).toBe(ownerPeerId);
    expect(bootstrapNodes.length).toBeGreaterThanOrEqual(1);
  }, OP_MS);

  it('step 2: provider provisions node A pinned to the owner (record reaches running)', async () => {
    const created = await containers.createContainer({
      customerId,
      partyId,
      bootstrapNodes,
      profile: 'storage',
      pinnedOwnerKeys: [ownerKey],
    });
    idA = created.id;
    // No assertion on created.status: provisioning starts async and MemoryStore
    // hands back live references, so 'pending' may already read 'creating'.
    expect(created.pinnedOwnerKeys).toEqual([ownerKey]);

    // Provisioning is async — this is ContainerService's own enrollment loop
    // (real /status polls against the real child) settling the record.
    await requireRunning(idA, 'node A');

    const record = (await store.getContainer(idA))!;
    // The delivery credentials the provider will later present are persisted on
    // the record, and the seed endpoint is the health server's /seed route.
    expect(record.seedToken).toBeTruthy();
    expect(record.healthEndpoint).toBeTruthy();
    expect(record.seedEndpoint).toBe(record.healthEndpoint!.replace('/health', '/seed'));
  }, STARTUP_MS + 10_000);

  it('step 3: node A accepts the owner-signed seed the provider delivers', async () => {
    // The node's live identity — provider-side getPeerInfo reads real /status.
    let info: { peerId: string; multiaddrs: string[] } | undefined;
    await waitUntil(async () => {
      info = await containers.getPeerInfo(idA);
      return !!info;
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'node A peer identity' });
    peerInfoA = info!;
    expect(peerInfoA.peerId).toMatch(/^12D3Koo/); // Ed25519 libp2p peer id prefix
    expect(peerInfoA.multiaddrs.length).toBeGreaterThanOrEqual(1);

    const delivered = await deliverSeed(
      idA,
      peerInfoA,
      'node A accepts the delivered seed',
      OP_MS * 2,
    );
    encodedSeed = delivered.encodedSeed;
    expect(encodedSeed.length).toBeGreaterThan(0);
    expect(delivered.peersAdded).toBeGreaterThanOrEqual(1);
  }, STARTUP_MS + OP_MS * 2 + 10_000);

  it('step 4: node B pinned to a stranger refuses the same seed — and the token gate fails independently', async () => {
    // Guard the cross-test dependency before anything expensive. Without step
    // 3's minted seed the POST body serializes to `{}` and the node refuses
    // with its own 'seed is required' — a refusal that has nothing to do with
    // the trust policy this step exists to prove, and reads as a step-4 defect.
    expect(encodedSeed, 'step 3 must have minted a seed for this step to mean anything').toBeTruthy();

    // A well-formed but foreign pin: validatePinnedOwnerKeys runs at node
    // startup, so a garbage pin would keep B from ever starting (and a node
    // that never started must not masquerade as a trust refusal).
    const strangerKey = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519')).publicKeyB64;
    const created = await containers.createContainer({
      customerId,
      partyId,
      bootstrapNodes,
      profile: 'storage',
      pinnedOwnerKeys: [strangerKey],
    });
    idB = created.id;

    // B must be RUNNING before the negative assertion — a fetch error from a
    // still-starting node is not a trust refusal.
    await requireRunning(idB, 'node B');
    const record = (await store.getContainer(idB))!;

    // Trust gate: correct bearer (ContainerService presents B's own token), but
    // the seed is signed by a key B was not pinned to → HTTP 400 with the trust
    // policy's reason, wrapped by ContainerService as a non-OK response.
    const refusal = await containers.applySeed(idB, encodedSeed);
    expect(refusal.success).toBe(false);
    expect(refusal.peersAdded ?? 0).toBe(0);
    expect(refusal.error).toMatch(/^Seed endpoint returned 400: /);
    expect(refusal.error).toMatch(/(neither|not).*(anchored|pinned)/i);

    // Delivery gate: same endpoint, same seed, WRONG bearer → 401 before the
    // trust policy is ever consulted. Two refusals, two independent causes.
    const res = await fetch(record.seedEndpoint!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-the-minted-token',
      },
      body: JSON.stringify({ seed: encodedSeed }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'unauthorized' });
  }, STARTUP_MS + OP_MS);

  it('step 5: node A restarted from its volume with no pin still accepts a second seed', async () => {
    // The first accepted seed must have anchored the owner key in the durable
    // node-local trusted-owner store (the write lags applySeed's response).
    const volumeA = orchestrator.volumeDirFor(idA);
    await waitUntil(() => {
      const owners = readNodeLocalStore(volumeA, 'trusted-owners');
      return !!owners && owners.partyId === partyId
        && Object.keys(owners.owners ?? {}).includes(ownerKey);
    }, { timeoutMs: OP_MS, intervalMs: 500, description: 'owner key anchored on node A volume' });

    // Restart A the orchestrator way. ContainerService.createContainer always
    // mints a fresh ctr_ id, so the restart goes through the orchestrator
    // directly under the SAME containerId (same volume → same identity) with NO
    // pinnedOwnerKeys — the anchored store is now the only trust source.
    const record = (await store.getContainer(idA))!;
    await orchestrator.stopContainer(record.dockerId!);
    const fresh = await orchestrator.createContainer({
      containerId: idA,
      partyId,
      bootstrapNodes,
      profile: 'storage',
    });
    // Patch the provider record so the service's seed path targets the new
    // endpoints/token (a real provider restart would re-record the same way).
    //
    // NOTE: this is test-side surgery on a production record shape, and it is
    // silent if that shape changes — a renamed or added field is simply not
    // patched, and the step fails as a seed-path failure. If `ContainerService`
    // ever grows a restart-in-place path (one that reuses the ctr_ id instead of
    // minting a fresh one), call it here instead of hand-patching.
    record.dockerId = fresh.dockerId;
    record.healthEndpoint = fresh.healthEndpoint;
    record.metricsEndpoint = fresh.metricsEndpoint;
    record.seedEndpoint = fresh.seedEndpoint;
    record.seedToken = fresh.seedToken;
    record.status = 'running';
    record.updatedAt = new Date();
    await store.saveContainer(record);

    let info: { peerId: string; multiaddrs: string[] } | undefined;
    try {
      await waitUntil(async () => {
        info = await containers.getPeerInfo(idA);
        return !!info;
      }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'restarted node A live' });
    } catch (err) {
      const nodeLog = await tailNodeLog(fresh.dockerId);
      throw new Error(
        `restarted node A never came up: ${(err as Error).message}\n--- node.log ---\n${nodeLog}`,
        { cause: err },
      );
    }
    // The reused volume means the node rejoined as the SAME peer, not a stranger.
    expect(info!.peerId).toBe(peerInfoA.peerId);

    // Second seed: multiaddrs changed (new OS-assigned p2p port), so mint a
    // fresh one. With no CADRE_OWNER_KEYS this restart, acceptance proves the
    // anchor written by the first seed is what the node now trusts.
    const second = await deliverSeed(
      idA,
      info!,
      'restarted node A accepts a second seed',
      STARTUP_MS,
    );
    expect(second.peersAdded).toBeGreaterThanOrEqual(1);
    // Budget: anchor wait + restart + liveness poll + seed poll, each generous.
  }, OP_MS + STARTUP_MS * 2 + 10_000);
});
