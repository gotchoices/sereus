/**
 * A PHONE-SHAPED requester borrows a node from cadre-host — the dial-in direction.
 *
 * The sibling scenario `cadre-host-node-donation.integration.ts` proves the donation
 * lifecycle with a requester that can be dialed: a second real `cadre-cli` child that
 * listens on TCP and hands its addresses over as `bootstrapNodes`, so the LENT NODE is
 * the one that opens the connection. That is not the case node lending exists for. A
 * phone listens on nothing and carries no TCP transport, so it has no address to give
 * and must be the side that dials.
 *
 * Terms used below:
 *
 * - **Lent node** — a node cadre-host spawns as a real `cadre-cli` child process into
 *   someone else's cadre (`DonationService`; `docs/cadre-host.md` → Node donation).
 * - **Phone-shaped requester** — an in-process `CadreNode` with `listenAddrs: []`,
 *   WebSocket + circuit-relay transports only, `profile: 'transaction'`, a persistent
 *   identity key, and owner genesis run on itself. That is the shape
 *   `packages/reference-app-rn/src/phone-node-config.ts` builds, minus WebRTC (which
 *   Node tests do not load).
 * - **The phone's own client** — `requestHostNode` from
 *   `packages/reference-app-rn/src/host-node-request.ts`, the code the app's Settings →
 *   Host Node runs. It is imported below by relative SOURCE path: it imports nothing, so
 *   it runs in Node unchanged, and a package dependency in either direction would pull an
 *   Expo app or a Fastify server into the other's install (`docs/testing.md` → "App
 *   modules in a scenario").
 *
 * The borrowing goes through that client against the host's real `/grants` server
 * (`createLocalUiServer` on loopback), so the server's routing, bearer check, origin
 * guard, body parsing and error envelope all meet the phone's actual requests rather
 * than a hand-picked equivalent of them. What the steps below pin, in order, each as its
 * own `it` so a failure names the step it broke on:
 *
 *   1. the requester is up and genuinely undialable (`getMultiaddrs()` is empty)
 *   2. a wrong grant token is refused by the real server, reaches the phone as its
 *      grant-token message, and provisions nothing
 *   3. the phone's client borrows the node through all six of its stages, and on the
 *      host side: the record is `seeded` and keeps `bootstrapNodes: []` although the
 *      phone sent none, the node reports a real `/ws` listen address, and the requester
 *      DIALED IN — an outbound connection on its side, a live WEBSOCKET control
 *      connection in the requester's party on the node's side
 *   4. rows cross in BOTH directions (the node self-publishes and its signed record
 *      reaches the requester)
 *   5. the node respawns onto the SAME `/ws` port and the requester reconnects with no
 *      further donation call
 *   6. the REQUESTER restarts on its retained identity, storage and dial targets, and
 *      reconnects with no `provision` / `getPeer` / `applySeed` in between
 *   7. `terminate` releases the node
 *   8. a request cancelled after the host provisioned ends the loan through the phone's
 *      body-less `DELETE`, and the host's node goes away
 *
 * Steps 5–7 stay host-side: respawn, a stopped child and `terminate` have no phone-side
 * call to drive them.
 *
 * Out of scope, deliberately: strand replication onto the lent node. A `cadre-cli` node
 * launches a strand only when an app has registered that strand's sApp config, and
 * nothing registers one on a lent node; whether it should is the open question in
 * `tickets/blocked/always-on-nodes-host-strands-of-apps-they-do-not-run.md`. Also out of
 * scope: WAN reachability — everything here is loopback, and a green run says nothing
 * about a phone reaching the host across a home NAT (the NAT layer here is the
 * harness's offline one; the real one is `docs/cadre-host.md` → "NAT and DDNS"). And the origin guard's
 * refusal: Node's `fetch` sends `Host: 127.0.0.1:<port>` and no `Origin`, which the guard
 * accepts, so a phone addressing the host by its LAN address (`forbidden_origin`) is
 * covered only by `reference-app-rn/test/host-node-request.spec.ts`. Nothing here runs a
 * device or React Native's `fetch` either.
 *
 * The orchestrator resolves the real `cadre-cli` bin, so `@serfab/cadre-cli` and
 * `@serfab/cadre-host` must be built. Three real child spawns (provision, respawn, and
 * step 8's short-lived one) plus an in-process node make this slow; budgets are generous
 * on purpose.
 *
 * MEASURED TEETH. The requester has no TCP transport and reserves no relay, so a `/ws`
 * address is the only thing it can dial — which means dropping the child's WebSocket
 * listener should take this file down. Verified 2026-09-29 by editing
 * `childListenAddrs` in `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`
 * to return the TCP entry alone, rebuilding `@serfab/cadre-host`, and re-running: step 3
 * went RED at the client's `connecting` stage (the seed before it is accepted by a node
 * nobody can reach), and steps 4, 5 and 6 went red after it. Step 7 went red too, but
 * only because a failed step 3 never hands back the donation id — the client's own
 * cleanup has already ended that loan — so it is not a check on the address. Steps 1, 2
 * and 8 never need a connection and correctly stayed green. Restoring the line and
 * rebuilding returns 8/8. Re-run that recipe after changing either side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';

import { CadreNode, MemoryBootstrapPeerStore, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import type { BootstrapPeerStore } from '@serfab/cadre-core';
import {
  HostProcessOrchestrator,
  GrantService,
  GrantStore,
  DonationService,
  DonationStore,
  createLocalUiServer,
  type LocalUiServer,
  type NatService,
} from '@serfab/cadre-host';

import {
  captureRawStorage,
  connectionsTo,
  controlNodeConfig,
  hasOutboundTo,
  makeOwnOwner,
  startOfflineNatService,
  waitUntil,
  type RawStorageCapture,
} from '../harness/index.js';
// By source path, not a package: see "The phone's own client" in the header.
import {
  HostNodeRequestError,
  requestHostNode,
  type HostNodeRequestStage,
} from '../../../reference-app-rn/src/host-node-request.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
/**
 * The requester's control-cohort reconcile cadence. The reconnects in steps 5 and 6 are
 * driven by a timed pass, so this bounds how long each of those waits can take. (Step 3's
 * first connection is the client's own: it starts passes itself.)
 */
const RECONCILE_MS = 2_000;

/**
 * The WebSocket listen ports a multiaddr list names. A child binds ONE `/ws` port on
 * `0.0.0.0`, which libp2p reports once per interface (loopback + LAN), so a healthy set
 * has exactly one member. Relayed addresses are excluded: their `/ws` component belongs
 * to the relay, not to this node. (No lent node reserves a relay today; the filter is
 * here so this helper cannot silently start measuring the wrong port if one ever does.)
 */
function wsPortsOf(multiaddrs: readonly string[]): Set<string> {
  const ports = new Set<string>();
  for (const addr of multiaddrs) {
    if (addr.includes('/p2p-circuit')) continue;
    const match = /\/tcp\/(\d+)\/ws(?:\/|$)/.exec(addr);
    if (match) ports.add(match[1]!);
  }
  return ports;
}

/**
 * Await the phone's client, rethrowing a failure with its stage, host code and host
 * wording in the message. The borrowing is one `it`, so this is what still names the
 * part of it that broke.
 */
async function explainFailure<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (!(err instanceof HostNodeRequestError)) throw err;
    throw new Error(
      `requestHostNode failed at stage '${err.stage}' (code: ${err.code ?? 'none'}): ${err.message} `
      + `Detail: ${err.detail ?? 'none'}`,
      { cause: err },
    );
  }
}

describe('a phone-shaped requester borrows a cadre-host node (real cadre-cli)', () => {
  let tmpRoot: string;
  let hostOrch: HostProcessOrchestrator;
  let grants: GrantService;
  let donationService: DonationService;
  /** The host's real management server, carrying the `/grants` routes the phone calls. */
  let server: LocalUiServer | undefined;
  let nat: NatService | undefined;
  let hostUrl: string;

  /** The requester's durable identity — the same key both incarnations start on. */
  let requesterKey: PrivateKey;
  let requesterPeerId: string;
  /** The requester owner's base64url public key — pinned on the lent node. */
  let requesterOwnerKey: string;
  /**
   * The requester's control storage and its node-local dial-target store, BOTH held
   * outside the node so step 6's restart reaches the same durable state a phone's
   * file/IndexedDB-backed stores would.
   */
  let requesterStorage: RawStorageCapture;
  let requesterPeerStore: BootstrapPeerStore;
  /** Reassigned in step 6; `afterAll` stops whichever incarnation is current. */
  let requester: CadreNode | undefined;

  const partyId = `donation-phone-${Math.random().toString(36).slice(2)}`;

  // Threaded across the ordered step tests below (vitest runs them in order).
  let grantToken: string;
  let donationId: string;
  let dronePeerId: string;
  /** The `/ws` port set from step 3 — step 5 requires the respawn to come back on it. */
  let wsPortsBeforeRespawn: Set<string>;

  /** Build the phone-shaped requester on the durable state held above. */
  function buildRequester(): CadreNode {
    return new CadreNode(controlNodeConfig({
      partyId,
      privateKey: requesterKey,
      // A phone is a Ring Zulu participant, not a storage machine.
      profile: 'transaction',
      // The whole point: nothing can dial this node, ever.
      listenAddrs: [],
      reconcileMs: RECONCILE_MS,
      storageProvider: requesterStorage.provider,
      bootstrapPeerStore: requesterPeerStore,
    }));
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-donation-phone-'));

    requesterKey = await generateKeyPair('Ed25519');
    requesterOwnerKey = ed25519KeyPairFromLibp2p(requesterKey).publicKeyB64;
    requesterStorage = captureRawStorage();
    requesterPeerStore = new MemoryBootstrapPeerStore(partyId);

    // A port band no other scenario uses (19600–20339 are taken by the owner-node,
    // donation and provider scenarios — `grep -rn "portRange: { start" src`).
    hostOrch = new HostProcessOrchestrator({
      rootDir: join(tmpRoot, 'host-orchestrator'),
      portRange: { start: 20340, end: 20499 },
      stopTimeoutMs: 5_000,
    });
    await hostOrch.init();

    grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
    grantToken = grants.issue({ label: 'phone requester test cadre' }).token;
    donationService = new DonationService({
      orchestrator: hostOrch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });

    // Donor-only, like a host with `ownCadre` off. Not `createTestCadreHost`: that brings
    // up the founder role's strand service, which nothing here needs. The NAT layer
    // runs in every role; here it is the harness's offline one (no router, no probe).
    nat = await startOfflineNatService(join(tmpRoot, 'nat'), hostOrch);
    server = createLocalUiServer({
      uiPort: 0, // unused: `forcePort` binds whatever port the OS hands out
      dataDir: join(tmpRoot, 'ui'),
      orchestrator: hostOrch,
      nat,
      grants,
      donations: donationService,
      forcePort: 0,
    });
    hostUrl = (await server.start()).url;
  }, STARTUP_MS);

  afterAll(async () => {
    // The server first, so no request lands on a node mid-teardown.
    try { await server?.stop(); } catch { /* ignore */ }
    try { await nat?.stop(); } catch { /* ignore */ }
    try { await requester?.stop(); } catch { /* ignore */ }
    if (hostOrch) {
      for (const n of hostOrch.listNodes()) {
        try { await hostOrch.removeContainer(n.dockerId); } catch { /* ignore */ }
      }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  });

  it('step 1: the phone-shaped requester starts, owns its own party, and is undialable', async () => {
    requester = buildRequester();
    await requester.start();
    requesterPeerId = requester.peerId!.toString();

    // Owner genesis on itself, the same thing `runOwnerGenesis` does on the phone: enroll
    // the derived key in `OwnerKey` and bring up seed-bootstrap so the node can
    // owner-sign `CadrePeer` inserts and mint seeds.
    const ownerKey = await makeOwnOwner(requester, requesterKey);
    expect(ownerKey).toBe(requesterOwnerKey);

    // The premise of the whole scenario. If this ever becomes non-empty, every
    // connection assertion below could be satisfied by the lent node dialing the
    // requester, and the file would go green while proving the opposite thing.
    expect(requester.getMultiaddrs()).toEqual([]);
  }, STARTUP_MS);

  it('step 2: the real server refuses a wrong grant token, and the phone reports it as one', async () => {
    const failure = await requestHostNode(hostUrl, 'not-a-real-token', {
      fetch: globalThis.fetch,
      node: requester!,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(HostNodeRequestError);
    expect(failure).toMatchObject({
      stage: 'requesting',
      code: 'unauthorized',
      message: expect.stringContaining('does not recognise this grant token'),
    });
    // The grant is checked before a record is written, so nothing was spawned.
    expect(hostOrch.listNodes()).toEqual([]);
  }, OP_MS);

  it('step 3: the phone’s own client borrows the node over /grants, and the requester DIALS IN', async () => {
    const stages: HostNodeRequestStage[] = [];
    const borrowed = await explainFailure(requestHostNode(hostUrl, grantToken, {
      fetch: globalThis.fetch,
      node: requester!,
      onStage: (stage) => stages.push(stage),
      budgets: { nodeStartupMs: STARTUP_MS, seedRetryMs: OP_MS, connectMs: STARTUP_MS, pollIntervalMs: 500 },
    }));
    donationId = borrowed.donationId;
    dronePeerId = borrowed.peerId;

    expect(stages).toEqual(['requesting', 'waiting-for-node', 'authorizing', 'seeding', 'connecting', 'connected']);

    // `seeded` is the proof the trust wiring worked: a node WITHOUT the pinned owner key
    // answers `rejected`, which the client retries and then reports at `seeding`.
    // Deliberately NOT asserting the `PUT`'s `peersAdded >= 1`, as the sibling scenario
    // does: it counts only seed peers that carry multiaddrs, and a phone-shaped owner
    // contributes none, so here it measures nothing about the claim under test.
    const record = donationService.get(donationId);
    expect(record?.status).toBe('seeded');
    expect(record?.partyId).toBe(partyId);
    // The phone's POST leaves `bootstrapNodes` off, and the record must still hold it as
    // empty rather than dropped — `respawn` treats a MISSING `bootstrapNodes` as "record
    // predates spawn inputs" and refuses, so a field that round-trips as `undefined`
    // would fail step 5 rather than this assertion.
    expect(record?.bootstrapNodes).toEqual([]);
    // Registered with the HOST orchestrator, but joined the REQUESTER's party.
    expect(hostOrch.getNode(donationId)?.partyId).toBe(partyId);

    const peer = await donationService.getPeer(donationId);
    expect(peer.peerId).toBe(dronePeerId);
    expect(dronePeerId).toMatch(/^12D3Koo/); // Ed25519 libp2p peer id prefix
    // A phone carries no TCP transport, so a list of TCP-only addresses is unreachable
    // for it no matter how many entries it has.
    wsPortsBeforeRespawn = wsPortsOf(peer.multiaddrs);
    expect([...wsPortsBeforeRespawn]).toHaveLength(1);
    // The list is MIXED (TCP and `/ws`, loopback and LAN), and the client hands it to
    // `addDrone` unfiltered, to be dialed one address per `dial()` (`dialPeerAddrs`): a
    // TCP entry this node has no transport for is rejected at once and the next address
    // tried. A failure reading "no valid addresses" for EVERY candidate is a defect in
    // that path, NOT something to work around by filtering the list.
    expect(peer.multiaddrs.some((a) => !a.includes('/ws'))).toBe(true);

    // The client's own check accepts any open connection to the node; this pins that the
    // REQUESTER opened it. Waited for rather than read once only so a redial in between
    // cannot flake it: a requester with no listener has no inbound connection to wait for.
    await waitUntil(() => hasOutboundTo(requester!, dronePeerId), {
      timeoutMs: OP_MS,
      intervalMs: 250,
      description: 'requester holds an OUTBOUND control connection to the lent node',
    });

    // The node's own view: it is in the REQUESTER's party, and the connection it holds
    // is a WEBSOCKET one. The transport is the strongest complement to the requester-side
    // `direction === 'outbound'` that this surface can give — `/status` drops the
    // per-connection `paths[]` array to stay cheap (`cadre-cli/src/server/health.ts`), so
    // it exposes counts by transport but no per-connection direction. A bare
    // `total >= 1` would leave "the requester reached it over `/ws`" an inference from
    // the requester's transport list rather than something the node confirms.
    //
    // If the connection is admitted and then dropped, run with `DEBUG=sereus:*` and read
    // both nodes' gate decisions rather than adding sleeps.
    const health = hostOrch.getNode(donationId)!.ports.health;
    await waitUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${health}/status`);
      if (!res.ok) return false;
      const status = (await res.json()) as {
        node?: {
          partyId?: string;
          connectionPaths?: { total?: number; byTransport?: Partial<Record<string, number>> };
        };
      };
      const paths = status.node?.connectionPaths;
      return status.node?.partyId === partyId
        && (paths?.total ?? 0) >= 1
        && (paths?.byTransport?.['websocket'] ?? 0) >= 1;
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'lent node reports a live WEBSOCKET control connection in party P' });

    // Re-assert the premise AFTER the connection exists: a regression that silently gave
    // the requester a listener would otherwise let the lent node dial out and satisfy
    // everything above for the wrong reason.
    expect(requester!.getMultiaddrs()).toEqual([]);
  }, 3 * STARTUP_MS + 2 * OP_MS + 10_000); // the client's three budgets, then the outbound and `/status` waits

  it('step 4: rows cross both ways — the node self-publishes and its record reaches the requester', async () => {
    // Non-empty only if BOTH directions worked: the requester's rows had to reach the
    // lent node (so it could find its own owner-vouched row and self-publish a signed,
    // addressed one), and that signed row had to replicate back. The node self-publishes
    // off its own heartbeat after the first rows land, so the budget is generous.
    let resolved: string[] = [];
    await waitUntil(async () => {
      resolved = (await requester!.resolvePeerAddrs(dronePeerId)).map((ma) => ma.toString());
      return resolved.length > 0;
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'the lent node’s signed record reaches the requester' });

    // And it is dialable BY A PHONE — a signed record carrying only TCP addresses would
    // resolve fine and still strand the requester on the next reconnect.
    expect(resolved.some((a) => a.includes('/ws'))).toBe(true);
  }, STARTUP_MS);

  it('step 5: a respawned lent node keeps its WebSocket port and the requester reconnects', async () => {
    const before = hostOrch.getNode(donationId)!;
    // Capture the live connection ids first. The requester can hold the DEAD connection
    // `open` for several seconds after the child exits — until its connection monitor
    // notices (~9 s, measured in `control-cohort-cold-start-retry.integration.ts`) — so
    // "a connection exists" is satisfied by the corpse and proves nothing.
    const staleConnectionIds = new Set(connectionsTo(requester!, dronePeerId).map((c) => c.id));
    // The final wait below is only a proof of RECONNECTION while this set is non-empty:
    // an empty one would make "a connection whose id is new" true of the connection that
    // was already there, and the step would pass without the node ever going away.
    expect(staleConnectionIds.size).toBeGreaterThan(0);

    await hostOrch.stopContainer(before.dockerId);
    const respawn = await donationService.respawn(donationId);
    expect(respawn.outcome).toBe('respawned');

    // Same ports, because the requester knows this node only by the address it was
    // handed — nothing re-delivers a new one to a phone.
    let peerInfo: { peerId: string; multiaddrs: string[] } | undefined;
    await waitUntil(async () => {
      try {
        peerInfo = await donationService.getPeer(donationId);
        return !!peerInfo.peerId;
      } catch {
        return false;
      }
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'respawned lent node peer identity' });

    // Same node, not a stranger: the workdir (and its identity key) survived the respawn.
    expect(peerInfo!.peerId).toBe(dronePeerId);
    expect([...wsPortsOf(peerInfo!.multiaddrs)]).toEqual([...wsPortsBeforeRespawn]);

    // No `provision`, `getPeer`-driven re-add or `applySeed` re-run: the requester
    // reconnects off its own reconcile pass alone.
    await waitUntil(
      () => connectionsTo(requester!, dronePeerId)
        .some((c) => c.direction === 'outbound' && c.status === 'open' && !staleConnectionIds.has(c.id)),
      {
        timeoutMs: STARTUP_MS,
        intervalMs: 500,
        description: 'requester opens a NEW outbound connection to the respawned node',
      },
    );
  }, STARTUP_MS + 60_000);

  it('step 6: a restarted requester reconnects with no new donation request', async () => {
    await requester!.stop();
    requester = undefined;

    // Same identity key, same control storage, same node-local dial-target store — the
    // three things a phone carries across a process restart. Owner genesis is NOT re-run
    // and no seed is re-applied: the restarted node has to find the lent node from what
    // it already holds.
    requester = buildRequester();
    await requester.start();
    expect(requester.peerId!.toString()).toBe(requesterPeerId);
    expect(requester.getMultiaddrs()).toEqual([]);

    await waitUntil(() => hasOutboundTo(requester!, dronePeerId), {
      timeoutMs: STARTUP_MS,
      intervalMs: 500,
      description: 'restarted requester re-opens an outbound connection to the lent node',
    });

    // NOTE: this step does not pin WHICH dial source produced that connection. Both
    // survive the restart by construction — the lent node's signed `CadrePeer` record is
    // in the preserved control storage and is fresh, and its retained entry is in the
    // preserved dial-target store — so the cold-start branch and the steady-state branch
    // are both live. Distinguishing them would mean disabling one, the way
    // `control-cohort-cold-start-retry.integration.ts` strips a peerStore entry.
    // The assertion below at least pins that the RECORD path is available: a fresh,
    // signed, trust-gated record for the lent node resolves on the restarted node.
    let resolved: string[] = [];
    await waitUntil(async () => {
      resolved = (await requester!.resolvePeerAddrs(dronePeerId)).map((ma) => ma.toString());
      return resolved.length > 0;
    }, { timeoutMs: OP_MS, intervalMs: 500, description: 'restarted requester resolves the lent node’s signed record' });
    expect(resolved.some((a) => a.includes('/ws'))).toBe(true);
  }, STARTUP_MS + 60_000);

  it('step 7: terminate releases the lent node', async () => {
    await donationService.terminate(donationId);
    expect(donationService.get(donationId)?.status).toBe('terminated');
    expect(hostOrch.getNode(donationId)).toBeUndefined();
  }, OP_MS);

  it('step 8: a request cancelled after the host provisioned ends the loan through the phone’s DELETE', async () => {
    // A grant of its own, so this does not depend on step 7 having freed the first
    // grant's single node slot.
    const token = grants.issue({ label: 'phone requester cancelled request' }).token;

    // Cancelling as `waiting-for-node` begins lands before the first `GET .../peer` is
    // sent, so the failure is the same however fast the child boots. It is also the
    // device's path: `use-cadre.ts`'s `stop` aborts a running request.
    const controller = new AbortController();
    const failure = await requestHostNode(hostUrl, token, {
      fetch: globalThis.fetch,
      node: requester!,
      signal: controller.signal,
      onStage: (stage) => { if (stage === 'waiting-for-node') controller.abort(); },
      // The app's 10 s would do; this only keeps a slow child stop on a loaded machine
      // from timing the DELETE out before the host has finished answering it.
      budgets: { cleanupMs: OP_MS },
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(HostNodeRequestError);
    // The message too: any other failure at this stage (a 404 from `/peer`, say) would
    // also end the loan, and would pass on the stage alone.
    expect(failure).toMatchObject({ stage: 'waiting-for-node', message: 'The request was cancelled.' });

    // The phone's body-less `DELETE` once declared `content-type: application/json`, which
    // Fastify refused with 400, leaving the loan and its node running. The host now
    // tolerates that header too, so what this pins is that the loan really ends through
    // the real route.
    const loans = donationService.list(token);
    expect(loans).toHaveLength(1);
    expect(loans[0]!.status).toBe('terminated');
    expect(hostOrch.getNode(loans[0]!.id)).toBeUndefined();
  }, STARTUP_MS);
});
