/**
 * A PHONE-SHAPED requester rents a node from `@serfab/cadre-provider` without giving it any
 * address, seeds it, dials it and syncs with it: `docs/architecture.md` → Enrollment Flow:
 * Phone Adds Provider Drone, and row 4 of Which Side Dials, on the wire.
 *
 * Terms used below:
 *
 * - **Provider node** — a real `cadre-cli` child started the provider's way: an in-process
 *   `ContainerService` + `MemoryStore` driving `ProviderProcessOrchestrator`, whose child
 *   environment is the provider's own `buildNodeEnv` output, as in
 *   `provider-seed-accepted.integration.ts`. The orchestrator is given a public host, so the
 *   child is started with `CADRE_APPEND_ANNOUNCE_ADDRS` from the provider's `publicNodeAddrs`,
 *   as a `DockerOrchestrator` container with `docker.publicHost` is.
 * - **Phone-shaped requester** — an in-process `CadreNode` from `buildPhoneOwner`:
 *   `listenAddrs: []`, WebSocket and circuit-relay transports only, `profile: 'transaction'`,
 *   owner genesis run on itself. With no TCP transport it can reach the node only at a `/ws`
 *   address, so no address filtering happens in this file.
 *
 * What the steps pin, in order, each its own `it` so a failure names the step:
 *
 *   1. the requester is up and listens on nothing
 *   2. `ContainerService.createContainer` with `bootstrapNodes: []` and the requester's owner
 *      key pinned; the record reaches `running`
 *   3. `getPeerInfo` carries the announced public pair, `/tcp/<p2p>` and `/tcp/<ws>/ws`
 *   4. once the node has run 5 s, so its boot-time self-publish has found no row, the
 *      requester mints a seed with `addDrone` from the peer info's addresses, and the
 *      provider's `applySeed` delivers it; the node accepts it
 *   5. after `reconcileControlCohort()` the requester holds an OUTBOUND connection, the node a
 *      WebSocket one; the node admits the requester by the cold-start rule plus the seed, and
 *      the requester's row reaches the node: it is in the node's authorized member set. The
 *      other direction too: the node's self-published record, with a `/ws` address, resolves
 *      on the requester within about one of the node's reconcile passes
 *   6. `terminateContainer` stops the record and the child exits
 *
 * The public host is `localhost`, a name: the child binds `0.0.0.0`, which already lists
 * `127.0.0.1`, so a public host of `127.0.0.1` would announce addresses the node reports
 * anyway and step 3 would pass with `CADRE_APPEND_ANNOUNCE_ADDRS` never reaching it. A
 * `/dns4/localhost` address appears only by being announced.
 *
 * The child is given a loopback admin channel (`adminChannel`), which no provider sets: it is
 * the only window onto the node's authorized member set from outside the process.
 *
 * Out of scope: restarts of either side (the requester's reconnect is shared cadre-core code
 * that `cadre-host-join-by-qr` and `node-claim-by-phone` drive through a node respawn and
 * restart), the HTTP surface (`POST /containers` refusing an empty `bootstrapNodes` without
 * `docker.publicHost` is unit-tested in cadre-provider), Docker itself, and strands.
 *
 * Runs the real `cadre-cli` bin from `dist`, so `@serfab/cadre-core`, `@serfab/cadre-cli` and
 * `@serfab/cadre-provider` must be built.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CadreNode } from '@serfab/cadre-core';
import type { HealthStatus } from '@serfab/cadre-cli';
import { ContainerService, MemoryStore } from '@serfab/cadre-provider';

import {
  ProviderProcessOrchestrator,
  adminClient,
  buildPhoneOwner,
  hasOutboundTo,
  isChildUp,
  makeOwnOwner,
  requireContainerRunning,
  waitUntil,
  type ProviderProcessHandle,
} from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
const PUBLIC_HOST = 'localhost';
/**
 * How long the node runs before the requester adds it, so its boot-time self-publish (1 s after
 * `CadreNode.start()`) has already found no row, as on a rented node a phone seeds minutes later.
 *
 * The wait goes before `addDrone`, not between it and the seed: the requester dials a node it
 * added on its next 2 s reconcile pass, and a connection made before the seed lets the node's
 * row replicate in first. The seed then publishes the record by accident — it carries the node's
 * own addresses, and merging them into its own peer store fires the node's `self:peer:update`
 * republish — and step 5 would pass without the reconcile-pass publish it exists to check.
 */
const SEED_AFTER_RUNNING_S = 5;

describe('a phone-shaped requester rents a provider node it gives no address (real cadre-provider, real cadre-cli)', () => {
  const partyId = `provider-phone-${Math.random().toString(36).slice(2)}`;
  const customerId = 'cust-provider-phone';

  let tmpRoot: string;
  let orchestrator: ProviderProcessOrchestrator;
  let containers: ContainerService;

  let requester: CadreNode | undefined;
  let requesterPeerId: string;
  let requesterOwnerKey: string;

  // Threaded across the ordered steps below (vitest runs them in order).
  let containerId: string;
  let handle: ProviderProcessHandle;
  let nodePeerId: string;
  let nodeAddrs: string[];
  /** The node's `/status` uptime when its record first read `running` (step 2). */
  let uptimeWhenRunning: number;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'provider-phone-'));
    orchestrator = new ProviderProcessOrchestrator({
      rootDir: join(tmpRoot, 'provider-volumes'),
      publicHost: PUBLIC_HOST,
      adminChannel: true,
    });
    containers = new ContainerService({ store: new MemoryStore(), orchestrator });
  });

  afterAll(async () => {
    try { await requester?.stop(); } catch { /* ignore */ }
    for (const left of orchestrator?.listHandles() ?? []) {
      try { await orchestrator.stopContainer(left.dockerId); } catch { /* ignore */ }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  }, OP_MS);

  async function readStatus(): Promise<HealthStatus> {
    const res = await fetch(`http://127.0.0.1:${handle.ports.health}/status`);
    if (!res.ok) throw new Error(`/status answered ${res.status}`);
    return (await res.json()) as HealthStatus;
  }

  /** Is `peerId` in the node's AUTHORIZED member set, by its loopback admin channel. */
  async function isAuthorizedOnNode(peerId: string): Promise<boolean> {
    const admin = adminClient(`http://127.0.0.1:${handle.admin!.port}`, handle.admin!.token);
    return (await admin<{ member: boolean }>('GET', `/admin/authorized-members/${encodeURIComponent(peerId)}`)).member;
  }

  it('step 1: the requester is up and listens on nothing', async () => {
    const built = await buildPhoneOwner(partyId);
    requester = built.node;
    await requester.start();
    requesterPeerId = requester.peerId!.toString();
    requesterOwnerKey = await makeOwnOwner(requester, built.key);
    // The requester's own `CadrePeer` row is what step 5 looks for on the node. Published now
    // rather than left to the self-registration timer, which may fire before the owner key
    // above is in place and then wait for the next heartbeat.
    expect(await requester.registerSelf()).not.toBe('skipped');

    // The premise of the file: if the requester ever listened, every connection below could be
    // the node dialing it, and the steps would pass while proving the opposite direction.
    expect(requester.getMultiaddrs()).toEqual([]);
  }, STARTUP_MS);

  it('step 2: the provider provisions a node with no bootstrap peers, pinned to the requester\'s owner key', async () => {
    const created = await containers.createContainer({
      customerId,
      partyId,
      bootstrapNodes: [],
      profile: 'storage',
      pinnedOwnerKeys: [requesterOwnerKey],
    });
    containerId = created.id;
    await requireContainerRunning(containers, orchestrator, containerId, 'the provider node', STARTUP_MS);

    const record = (await containers.getContainer(containerId))!;
    handle = orchestrator.listHandles().find((h) => h.dockerId === record.dockerId)!;
    expect(handle).toBeDefined();
    expect(handle.admin).toBeDefined();
    // `uptime` counts from the health server's construction, before `CadreNode.start()`, so
    // step 4 measures from here rather than from zero.
    uptimeWhenRunning = (await readStatus()).uptime;
  }, STARTUP_MS + 10_000);

  it('step 3: the node\'s peer info carries the public pair it announces', async () => {
    let info: { peerId: string; multiaddrs: string[] } | undefined;
    await waitUntil(async () => {
      info = await containers.getPeerInfo(containerId);
      return !!info;
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the node\'s peer identity' });
    nodePeerId = info!.peerId;
    nodeAddrs = info!.multiaddrs;

    // Both of the pair a `DockerOrchestrator` container announces at `docker.publicHost`.
    expect(nodeAddrs).toEqual(expect.arrayContaining([
      `/dns4/${PUBLIC_HOST}/tcp/${handle.ports.p2p}/p2p/${nodePeerId}`,
      `/dns4/${PUBLIC_HOST}/tcp/${handle.ports.ws}/ws/p2p/${nodePeerId}`,
    ]));
  }, STARTUP_MS);

  it('step 4: the requester adds the node from its peer info, and the provider delivers the seed', async () => {
    await waitUntil(async () => (await readStatus()).uptime >= uptimeWhenRunning + SEED_AFTER_RUNNING_S, {
      timeoutMs: OP_MS,
      intervalMs: 500,
      description: `the node has run ${SEED_AFTER_RUNNING_S} s past reading running`,
    });
    const { encodedSeed } = await requester!.addDrone({ dronePeerId: nodePeerId, droneMultiaddrs: nodeAddrs });

    // The node's seed route can lag the `/status` readiness that marked the record `running`.
    let result: Awaited<ReturnType<ContainerService['applySeed']>> | undefined;
    try {
      await waitUntil(async () => {
        result = await containers.applySeed(containerId, encodedSeed);
        return result.success;
      }, { timeoutMs: OP_MS, intervalMs: 1_000, description: 'the node accepts the delivered seed' });
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nlast delivery result: ${JSON.stringify(result ?? null)}\n--- node.log ---\n${orchestrator.logTail(containerId)}`,
        { cause: err },
      );
    }
    // No assertion on `peersAdded`: it counts seed peers carrying addresses, and a requester
    // that listens on nothing contributes none.
  }, 2 * OP_MS + 10_000);

  it('step 5: the requester DIALS IN over /ws, the node admits it, and each one\'s record reaches the other', async () => {
    await requester!.reconcileControlCohort();
    await waitUntil(() => hasOutboundTo(requester!, nodePeerId), {
      timeoutMs: OP_MS,
      intervalMs: 250,
      description: 'the requester holds an OUTBOUND control connection to the node',
    });
    // `/status` carries counts by transport, not per-connection direction, so the node's side
    // of "the requester reached it" is a WebSocket connection: the requester has no other way in.
    await waitUntil(async () => ((await readStatus()).node.connectionPaths.byTransport.websocket ?? 0) >= 1, {
      timeoutMs: OP_MS,
      intervalMs: 500,
      description: 'the node reports a live WEBSOCKET control connection',
    });

    // Requester → node: its own row, vouched by the key the seed anchored, is authorized there.
    await waitUntil(() => isAuthorizedOnNode(requesterPeerId), {
      timeoutMs: STARTUP_MS,
      intervalMs: 1_000,
      description: 'the requester is in the node\'s authorized member set',
    });
    // Node → requester: the node found the row `addDrone` wrote for it, self-published a signed,
    // addressed record on its next reconcile pass (every 15 s), and that record replicated back.
    let resolved: string[] = [];
    await waitUntil(async () => {
      resolved = (await requester!.resolvePeerAddrs(nodePeerId)).map((ma) => ma.toString());
      return resolved.length > 0;
    }, { timeoutMs: OP_MS, intervalMs: 1_000, description: 'the node\'s signed record reaches the requester' });
    expect(resolved.some((a) => a.includes('/ws'))).toBe(true);

    expect(requester!.getMultiaddrs()).toEqual([]);
  }, STARTUP_MS + 3 * OP_MS);

  it('step 6: terminating the container stops the record and the child', async () => {
    expect(await containers.terminateContainer(containerId)).toBe(true);
    expect((await containers.getContainer(containerId))?.status).toBe('stopped');
    expect(isChildUp(handle.child)).toBe(false);
    expect(await orchestrator.inspectRunState(handle.dockerId)).toBeUndefined();
  }, OP_MS);
});
