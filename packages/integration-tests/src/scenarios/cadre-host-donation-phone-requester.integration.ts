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
 *
 * What the nine steps below pin, in order, each as its own `it` so a failure names the
 * step it broke on:
 *
 *   1. the requester is up and genuinely undialable (`getMultiaddrs()` is empty)
 *   2. `provision` accepts `bootstrapNodes: []` and the record keeps it empty
 *   3. the spawned child reports a real `/ws` listen address from `GET .../peer`
 *   4. the requester vouches + seeds the node over the host's loopback channel
 *   5. the requester DIALS IN — an outbound connection on its side, a live WEBSOCKET
 *      control connection in the requester's party on the node's side
 *   6. rows cross in BOTH directions (the node self-publishes and its signed record
 *      reaches the requester)
 *   7. the node respawns onto the SAME `/ws` port and the requester reconnects with no
 *      further donation call
 *   8. the REQUESTER restarts on its retained identity, storage and dial targets, and
 *      reconnects with no `provision` / `getPeer` / `applySeed` in between
 *   9. `terminate` releases the node
 *
 * Out of scope, deliberately: strand replication onto the lent node. A `cadre-cli` node
 * launches a strand only when an app has registered that strand's sApp config, and
 * nothing registers one on a lent node; whether it should is the open question in
 * `tickets/blocked/always-on-nodes-host-strands-of-apps-they-do-not-run.md`. Also out of
 * scope: WAN reachability — everything here is loopback, and a green run says nothing
 * about a phone reaching the host across a home NAT
 * (`tickets/backlog/feat-cadre-host-wan-grant-reachability.md`).
 *
 * The orchestrator resolves the real `cadre-cli` bin, so `@serfab/cadre-cli` and
 * `@serfab/cadre-host` must be built. Two real child spawns (provision + respawn) plus
 * an in-process node make this slow; budgets are generous on purpose.
 *
 * MEASURED TEETH. The requester has no TCP transport and reserves no relay, so a `/ws`
 * address is the only thing it can dial — which means dropping the child's WebSocket
 * listener should take this file down. Verified 2026-09-15 by editing
 * `childListenAddrs` in `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`
 * to return the TCP entry alone, rebuilding `@serfab/cadre-host`, and re-running: RED at
 * steps 3, 5, 6, 7 and 8 (steps 1, 2, 4 and 9 do not touch the address, and correctly
 * stayed green — step 4's seed is accepted by a node nobody can reach). Restoring the
 * line and rebuilding returns 9/9. Re-run that recipe after changing either side.
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
  type DonationSeedResult,
} from '@serfab/cadre-host';

import {
  captureRawStorage,
  connectionsTo,
  controlNodeConfig,
  hasOutboundTo,
  makeOwnOwner,
  waitUntil,
  withPeerId,
  type RawStorageCapture,
} from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
/**
 * The requester's control-cohort reconcile cadence. Every reconnect in steps 5, 7 and 8
 * is driven by a timed pass, so this bounds how long each of those waits can take.
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

describe('a phone-shaped requester borrows a cadre-host node (real cadre-cli)', () => {
  let tmpRoot: string;
  let hostOrch: HostProcessOrchestrator;
  let donationService: DonationService;

  /** The requester's durable identity — the same key both incarnations start on. */
  let requesterKey: PrivateKey;
  let requesterPeerId: string;
  /** The requester owner's base64url public key — pinned on the lent node. */
  let requesterOwnerKey: string;
  /**
   * The requester's control storage and its node-local dial-target store, BOTH held
   * outside the node so step 8's restart reaches the same durable state a phone's
   * file/IndexedDB-backed stores would.
   */
  let requesterStorage: RawStorageCapture;
  let requesterPeerStore: BootstrapPeerStore;
  /** Reassigned in step 8; `afterAll` stops whichever incarnation is current. */
  let requester: CadreNode | undefined;

  const partyId = `donation-phone-${Math.random().toString(36).slice(2)}`;

  // Threaded across the ordered step tests below (vitest runs them in order).
  let grantToken: string;
  let donationId: string;
  let dronePeerId: string;
  let droneMultiaddrs: string[];
  /** The `/ws` port set from step 3 — step 7 requires the respawn to come back on it. */
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

    const grants = new GrantService({ store: new GrantStore(join(tmpRoot, 'grants')) });
    grantToken = grants.issue({ label: 'phone requester test cadre' }).token;
    donationService = new DonationService({
      orchestrator: hostOrch,
      grants,
      store: new DonationStore(join(tmpRoot, 'donations')),
    });
  }, STARTUP_MS);

  afterAll(async () => {
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

  it('step 2: the host provisions a lent node with NO bootstrap nodes', async () => {
    const donation = await donationService.provision({
      grantToken,
      partyId,
      // A phone has no address to hand over. Before `donated-node-reachable-by-phone`
      // this was rejected as a required non-empty list.
      bootstrapNodes: [],
      ownerKeys: [requesterOwnerKey],
      profile: 'storage',
    });
    donationId = donation.id;

    expect(donation.status).toBe('awaiting_seed');
    expect(donation.partyId).toBe(partyId);
    // Persisted as empty rather than dropped — `respawn` treats a MISSING
    // `bootstrapNodes` as "record predates spawn inputs" and refuses, so an empty list
    // that round-trips as `undefined` would fail step 7 rather than this assertion.
    expect(donationService.get(donationId)?.bootstrapNodes).toEqual([]);

    // Registered with the HOST orchestrator, but joined the REQUESTER's party.
    expect(hostOrch.getNode(donationId)?.partyId).toBe(partyId);
  }, STARTUP_MS);

  it('step 3: the lent node reports a WebSocket listen address', async () => {
    let peerInfo: { peerId: string; multiaddrs: string[] } | undefined;
    await waitUntil(async () => {
      try {
        peerInfo = await donationService.getPeer(donationId);
        return !!peerInfo.peerId;
      } catch {
        return false;
      }
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'lent node peer identity' });

    dronePeerId = peerInfo!.peerId;
    // Bind the peer id onto each address now: the requester dials this list, and a bare
    // address gives the dial nothing to authenticate the far side against.
    droneMultiaddrs = peerInfo!.multiaddrs.map((a) => withPeerId(a, dronePeerId));

    expect(dronePeerId).toMatch(/^12D3Koo/); // Ed25519 libp2p peer id prefix

    // The load-bearing assertion of this step: a phone carries no TCP transport, so a
    // list of TCP-only addresses is unreachable for it no matter how many entries it has.
    wsPortsBeforeRespawn = wsPortsOf(droneMultiaddrs);
    expect([...wsPortsBeforeRespawn]).toHaveLength(1);
    // The list is MIXED (TCP and `/ws`, loopback and LAN). Nothing filters it — see
    // step 5.
    expect(droneMultiaddrs.some((a) => !a.includes('/ws'))).toBe(true);
  }, STARTUP_MS);

  it('step 4: the requester vouches the lent node and seeds it', async () => {
    const drone = await requester!.addDrone({ dronePeerId, droneMultiaddrs });
    expect(drone.encodedSeed.length).toBeGreaterThan(0);

    // `applySeed` can briefly race the node's seed-route readiness — poll until it
    // reports `seeded`. A node WITHOUT the pinned owner key comes back `rejected`, so
    // this (correctly) times out if the pin wiring is broken.
    //
    // Deliberately NOT asserting `peersAdded >= 1`, which the sibling scenario does:
    // `applySeed` counts only seed peers that carry multiaddrs, and a phone-shaped owner
    // contributes none. Here that count measures nothing about the claim under test —
    // the proof that the trust wiring worked is `seeded`, and the proof that the two
    // nodes found each other is step 5.
    let result: DonationSeedResult | undefined;
    await waitUntil(async () => {
      result = await donationService.applySeed(donationId, drone.encodedSeed);
      return result.outcome === 'seeded';
    }, { timeoutMs: OP_MS, intervalMs: 1_000, description: 'lent node accepts seed' });

    expect(result?.outcome).toBe('seeded');
    expect(donationService.get(donationId)?.status).toBe('seeded');
  }, OP_MS + 10_000);

  it('step 5: the requester DIALS IN over WebSocket and the node joins its cadre', async () => {
    // Dial now rather than waiting out a timed pass. `addDrone` retained the handed-over
    // addresses as this sibling's dial target; the node's own `CadrePeer` row is still
    // unsigned (it has never had a connection to self-publish over), so the retained
    // entry is the only source `resolveControlDialAddrs` can answer from.
    //
    // The retained list is MIXED and is dialed unfiltered, one address per `dial()`
    // (`dialPeerAddrs`): a TCP entry this node has no transport for is rejected at once
    // and the next address tried. A failure here reading "no valid addresses" for EVERY
    // candidate is a defect in that path, NOT something to work around by filtering the
    // list in this test.
    await requester!.reconcileControlCohort();

    await waitUntil(() => hasOutboundTo(requester!, dronePeerId), {
      // Generous: `reconcileControlCohort` joins a pass already in flight rather than
      // restarting it, so the dial can land as late as one further timed pass.
      timeoutMs: STARTUP_MS,
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
  }, STARTUP_MS);

  it('step 6: rows cross both ways — the node self-publishes and its record reaches the requester', async () => {
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

  it('step 7: a respawned lent node keeps its WebSocket port and the requester reconnects', async () => {
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

  it('step 8: a restarted requester reconnects with no new donation request', async () => {
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

  it('step 9: terminate releases the lent node', async () => {
    await donationService.terminate(donationId);
    expect(donationService.get(donationId)?.status).toBe('terminated');
    expect(hostOrch.getNode(donationId)).toBeUndefined();
  }, OP_MS);
});
