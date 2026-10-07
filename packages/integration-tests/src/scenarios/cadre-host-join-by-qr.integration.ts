/**
 * A PHONE-SHAPED owner claims a node that cadre-host started waiting to be claimed —
 * the host's "Join a cadre" flow end to end, over the host's real HTTP and SSE surface.
 *
 * Terms used below:
 *
 * - **Hosted node** — a real `cadre-cli` child the host's `HostProcessOrchestrator` spawns
 *   with `CADRE_CLAIM_SECRET` (`HostedNodeService.join`); it belongs to nobody until a
 *   phone claims it (docs/cadre-host.md → Hosted nodes: Join a cadre).
 * - **Phone-shaped claimant** — an in-process `CadreNode` with `listenAddrs: []`, WebSocket
 *   and circuit-relay transports only, `profile: 'transaction'`, owner genesis run on
 *   itself: the claimant of `node-claim-by-phone.integration.ts`.
 * - **The QR payload** — `GET /api/hosted-nodes/:id/claim`, decoded with cadre-core's
 *   `decodeNodeClaimPayload`: the node's peer id, the addresses the phone dials, and the
 *   claim secret. The host builds it; here the test hands it to the claimant.
 *
 * What the steps pin, in order, each its own `it` so a failure names the step:
 *
 *   1. `POST /api/hosted-nodes` answers 201 and the record reads `unclaimed`
 *   2. `GET …/claim` answers a payload the decoder accepts, naming the child's peer id and a
 *      non-loopback `/ws` address, with the NAT layer's verdict beside it
 *   3. the claimant claims with the decoded payload: the record becomes `joined` with the
 *      claimant's party and owner key (seen on the SSE stream and on `GET`), the claimant
 *      holds an OUTBOUND connection, and the watcher reports the node `connected`
 *   4. the child is killed out from under the host; the supervisor respawns it on the same
 *      ports as the same peer, and the claimant reconnects on a NEW connection
 *   5. `GET …/claim` on the joined node answers 409
 *   6. `DELETE` removes the record, the child and the workdir
 *
 * Throughout: the claim secret appears in the claim response alone — never in
 * `GET /api/hosted-nodes`, the SSE stream, or the host's own log lines (the `cadre:host:*`
 * debug namespaces, captured for the run).
 *
 * The host is `createTestCadreHost` — the real orchestrator (resolving the real `cadre-cli`
 * bin, so `@serfab/cadre-cli` and `@serfab/cadre-host` must be built), the real hosted-node
 * service with its watcher and supervisor, and the offline NAT layer (no router, no probe),
 * so every node reads `unreachable` and the payload carries LAN addresses only.
 *
 * Out of scope: reachability beyond the LAN, strand replication onto the node, a claimant
 * behind a relay, and the wrong-secret and rival-owner refusals (`node-claim-by-phone`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { format } from 'node:util';

import debug from 'debug';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';

import { CadreNode, MemoryBootstrapPeerStore, decodeNodeClaimPayload, type NodeClaimPayload } from '@serfab/cadre-core';
import type { ClaimDetails, HostedNodeView, LocalUiEvent } from '@serfab/cadre-host';
import type { HealthStatus } from '@serfab/cadre-cli';

import {
  connectionsTo,
  controlNodeConfig,
  createTestCadreHost,
  hasOutboundTo,
  makeOwnOwner,
  waitUntil,
  type TestCadreHost,
  type TestEventStream,
} from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
/** The claimant's control-cohort reconcile cadence, which drives the reconnect in step 4. */
const RECONCILE_MS = 2_000;
/** A dedicated band for the host's children, clear of the other child-process scenarios' (`harness/port-allocator.ts`). */
const PORT_RANGE = { start: 20040, end: 20199 };

type HostedNodesChanged = Extract<LocalUiEvent, { type: 'hosted-nodes-changed' }>;

function isHostedNodesChanged(e: LocalUiEvent, nodeId: string, kind: HostedNodesChanged['kind']): boolean {
  return e.type === 'hosted-nodes-changed' && e.nodeId === nodeId && e.kind === kind;
}

/** A phone-shaped owner node of its own party, not yet started. */
async function buildPhoneOwner(partyId: string, bootstrapPeerStore: MemoryBootstrapPeerStore): Promise<{ node: CadreNode; key: PrivateKey }> {
  const key = await generateKeyPair('Ed25519');
  const node = new CadreNode(controlNodeConfig({
    partyId,
    privateKey: key,
    profile: 'transaction',
    // Nothing can dial a phone: whatever connects the two, the phone opened it.
    listenAddrs: [],
    reconcileMs: RECONCILE_MS,
    bootstrapPeerStore,
  }));
  return { node, key };
}

/**
 * Capture every `cadre:host:*` debug line for the run. The host runs in-process here, so
 * its log is the `debug` output; enabling the namespaces makes every log site execute,
 * which is what lets the final step assert that none of them formats the secret.
 */
function captureHostLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const previousLog = debug.log;
  const previousNamespaces = debug.disable();
  debug.enable('cadre:host:*');
  debug.log = (...args: unknown[]) => { lines.push(format(...args)); };
  return {
    lines,
    restore: () => {
      debug.log = previousLog;
      debug.disable();
      if (previousNamespaces) debug.enable(previousNamespaces);
    },
  };
}

describe('a phone claims a cadre-host node from its QR payload (real cadre-host, real cadre-cli)', () => {
  const partyId = `join-by-qr-${Math.random().toString(36).slice(2)}`;

  let host: TestCadreHost;
  let events: TestEventStream;
  let hostLog: ReturnType<typeof captureHostLog>;

  let node: HostedNodeView;
  let claim: ClaimDetails;
  let payload: NodeClaimPayload;
  /** The `/status` port of the child, from the orchestrator handle; the same across the respawn. */
  let healthPort: number;

  let claimant: CadreNode | undefined;
  let claimantOwnerKey: string;
  const claimantPeerStore = new MemoryBootstrapPeerStore(partyId);

  beforeAll(async () => {
    hostLog = captureHostLog();
    host = await createTestCadreHost({ portRange: PORT_RANGE });
    events = await host.openEventStream();
  }, STARTUP_MS);

  afterAll(async () => {
    try { events?.close(); } catch { /* ignore */ }
    try { await claimant?.stop(); } catch { /* ignore */ }
    // Through the service, which deletes the record before stopping the child, so the
    // supervisor cannot respawn what a failed step left behind.
    for (const left of host?.hostedNodes.list() ?? []) {
      try { await host.hostedNodes.remove(left.id); } catch { /* ignore */ }
    }
    try { await host?.stop(); } catch { /* ignore */ }
    hostLog?.restore();
  }, OP_MS);

  async function readStatus(): Promise<HealthStatus> {
    const res = await fetch(`http://127.0.0.1:${healthPort}/status`);
    if (!res.ok) throw new Error(`/status answered ${res.status}`);
    return (await res.json()) as HealthStatus;
  }

  async function getNode(id: string): Promise<HostedNodeView> {
    const res = await host.request({ method: 'GET', path: `/api/hosted-nodes/${encodeURIComponent(id)}` });
    if (res.status !== 200) throw new Error(`GET hosted node answered ${res.status}: ${res.raw}`);
    return (res.body as { data: { node: HostedNodeView } }).data.node;
  }

  it('step 1: POST /api/hosted-nodes starts a node waiting to be claimed', async () => {
    const res = await host.request({ method: 'POST', path: '/api/hosted-nodes' });
    expect(res.status).toBe(201);
    node = (res.body as { ok: boolean; data: { node: HostedNodeView } }).data.node;
    expect(node).toMatchObject({ status: 'unclaimed', partyId: 'unclaimed', profile: 'storage', join: { kind: 'claim' } });
    expect(node.id).toMatch(/^hn_/);
    expect(res.raw).not.toContain('secret');

    const handle = host.orchestrator.getNode(node.id);
    expect(handle?.status).toBe('running');
    healthPort = handle!.ports.health;

    const listed = await host.request({ method: 'GET', path: '/api/hosted-nodes' });
    expect((listed.body as { data: { nodes: HostedNodeView[] } }).data.nodes.map((n) => n.id)).toEqual([node.id]);
    await events.next((e) => isHostedNodesChanged(e, node.id, 'added'));
  }, STARTUP_MS);

  it('step 2: GET …/claim answers the payload once the child reports its addresses', async () => {
    // 503 until the child's /status answers with a peer identity; the CLI and UI poll the same way.
    let last = 0;
    await waitUntil(async () => {
      const res = await host.request({ method: 'GET', path: `/api/hosted-nodes/${node.id}/claim` });
      last = res.status;
      if (res.status === 503) return false;
      if (res.status !== 200) throw new Error(`claim answered ${res.status}: ${res.raw}`);
      claim = (res.body as { data: ClaimDetails }).data;
      return true;
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: `claim details (last status ${last})` });

    payload = decodeNodeClaimPayload(claim.payload);
    expect(payload.peerId).toBe(claim.peerId);
    expect(payload.multiaddrs).toEqual(claim.multiaddrs);
    expect((await readStatus()).peerId).toBe(claim.peerId);
    // A phone carries no TCP transport, so a `/ws` address is the one it can dial; and
    // loopback is dropped, since nothing off this machine could use it.
    expect(payload.multiaddrs.some((a) => a.includes('/ws/'))).toBe(true);
    expect(payload.multiaddrs.every((a) => a.endsWith(`/p2p/${claim.peerId}`))).toBe(true);
    expect(payload.multiaddrs.some((a) => a.startsWith('/ip4/127.') || a.includes('/ip6/::1/'))).toBe(false);
    // The offline NAT layer maps nothing: the verdict rides along so a caller can warn.
    expect(claim.reachability?.verdict).toBe('unreachable');
    // The record now carries the peer id, never the secret.
    const stored = await getNode(node.id);
    expect(stored.peerId).toBe(claim.peerId);
    expect(JSON.stringify(stored)).not.toContain(payload.secret);
  }, STARTUP_MS);

  it('step 3: the claimant claims it; the record goes joined with the claimant\'s party and owner, and the claimant DIALS IN', async () => {
    const built = await buildPhoneOwner(partyId, claimantPeerStore);
    claimant = built.node;
    await claimant.start();
    claimantOwnerKey = await makeOwnOwner(claimant, built.key);
    expect(await claimant.registerSelf()).not.toBe('skipped');
    // The premise: every connection below is one the claimant opened.
    expect(claimant.getMultiaddrs()).toEqual([]);

    await claimant.claimNode(payload);

    // The node records the claim, restarts into the party, and the host's watcher (polling
    // /status every 2 s) writes `joined` once the node is in that party.
    await events.next((e) => isHostedNodesChanged(e, node.id, 'claimed'), { timeoutMs: STARTUP_MS });
    const joined = await getNode(node.id);
    expect(joined).toMatchObject({ status: 'joined', partyId, ownerKey: claimantOwnerKey, peerId: claim.peerId });
    expect((await readStatus()).node).toMatchObject({ claim: 'claimed', partyId, claimedBy: claimantOwnerKey });

    await waitUntil(() => hasOutboundTo(claimant!, claim.peerId), {
      timeoutMs: OP_MS,
      intervalMs: 250,
      description: 'claimant holds an OUTBOUND control connection to the node',
    });
    // The watcher's liveness poll (every 15 s for a joined node) reports the connection.
    await waitUntil(async () => (await getNode(node.id)).connected === true, {
      timeoutMs: OP_MS,
      intervalMs: 1_000,
      description: 'the record reads connected',
    });
    expect(claimant.getMultiaddrs()).toEqual([]);
  }, 3 * STARTUP_MS + 2 * OP_MS);

  it('step 4: the supervisor respawns a killed child on the same ports, and the claimant reconnects', async () => {
    // NOTE: the respawn decision (backoff, give-up, the record's secret and the previous
    // handle's ports) is unit-tested against the fake orchestrator in
    // `cadre-host/src/hosted/__tests__/hosted-node-supervisor.test.ts`; this step pins that
    // a real respawned child is the same peer at the same address to its cadre.
    const before = host.orchestrator.getNode(node.id)!;
    // The claimant can hold the dead connection `open` for seconds after the child exits, so
    // only a connection with a new id counts as a reconnect.
    const staleConnectionIds = new Set(connectionsTo(claimant!, claim.peerId).map((c) => c.id));
    expect(staleConnectionIds.size).toBeGreaterThan(0);

    process.kill(Number(before.dockerId.split(':')[0]), 'SIGKILL');

    // The exit event queues a reconcile pass; a record with no attempt history is respawned at once.
    await waitUntil(() => {
      const current = host.orchestrator.getNode(node.id);
      return current !== undefined && current.dockerId !== before.dockerId && current.status === 'running';
    }, { timeoutMs: OP_MS, intervalMs: 250, description: 'the supervisor spawns a new child' });
    const after = host.orchestrator.getNode(node.id)!;
    expect(after.ports).toEqual(before.ports);
    expect((await getNode(node.id)).respawn?.attempts).toBe(1);

    // The same node: identity key and claim.json survived in the workdir.
    await waitUntil(async () => {
      try {
        const status = await readStatus();
        return status.status === 'healthy' && status.node.claim === 'claimed' && status.node.partyId === partyId;
      } catch {
        return false;
      }
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the respawned child serves the claimed party' });
    expect((await readStatus()).peerId).toBe(claim.peerId);

    await waitUntil(
      () => connectionsTo(claimant!, claim.peerId)
        .some((c) => c.direction === 'outbound' && c.status === 'open' && !staleConnectionIds.has(c.id)),
      { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'claimant opens a NEW outbound connection to the respawned node' },
    );
  }, 2 * STARTUP_MS + OP_MS);

  it('step 5: GET …/claim on the joined node answers 409', async () => {
    const res = await host.request({ method: 'GET', path: `/api/hosted-nodes/${node.id}/claim` });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
  }, OP_MS);

  it('step 6: DELETE removes the record, the child and the workdir, and nothing carried the secret', async () => {
    const workdir = host.orchestrator.getNode(node.id)!.workdir;
    const res = await host.request({ method: 'DELETE', path: `/api/hosted-nodes/${node.id}` });
    expect(res.status).toBe(204);
    await events.next((e) => isHostedNodesChanged(e, node.id, 'removed'));

    expect((await host.request({ method: 'GET', path: `/api/hosted-nodes/${node.id}` })).status).toBe(404);
    expect(host.orchestrator.getNode(node.id)).toBeUndefined();
    expect(existsSync(workdir)).toBe(false);
    const listed = await host.request({ method: 'GET', path: '/api/hosted-nodes' });
    expect((listed.body as { data: { nodes: HostedNodeView[] } }).data.nodes).toEqual([]);

    // The secret left the host exactly once, in step 2's claim response.
    expect(JSON.stringify(events.received())).not.toContain(payload.secret);
    expect(hostLog.lines.length).toBeGreaterThan(0);
    expect(hostLog.lines.join('\n')).not.toContain(payload.secret);
  }, OP_MS);
});
