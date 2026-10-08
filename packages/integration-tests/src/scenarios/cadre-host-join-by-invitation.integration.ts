/**
 * cadre-host's second way into a cadre, end to end: the host starts a real `cadre-cli` child
 * with a cadre invitation the owner minted, and the child redeems it at a member of the cadre
 * (docs/cadre-host.md → Join by invitation).
 *
 * Machines:
 *
 * - **A**, the owner: an in-process `CadreNode` that founds the cadre and listens on a loopback
 *   WebSocket port, as `cadre-invite-any-member.integration.ts` builds one. Its control storage
 *   and dial-target store are kept across a stop/start, and the restart binds the same port, so
 *   an invitation minted before the stop still names a live address after it. Once its
 *   invitations are spent or expired its connection gate admits a stranger only provisionally,
 *   which is long enough for a redemption to be answered and refused by name (the any-member
 *   scenario's withdrawal arm relies on the same).
 * - **The host**, `createTestCadreHost`: the real orchestrator spawning real `cadre-cli`
 *   children (so `@serfab/cadre-cli` and `@serfab/cadre-host` must be built), the hosted-node
 *   service with its watcher and supervisor, and the offline NAT layer.
 *
 * What the steps pin, each its own `it` so a failure names the step:
 *
 *   1. joined with an untargeted invitation (`grantsOwner: false`): the record goes `joined`
 *      naming A as the admitting member and A's key as the owner, and A lists the node as an
 *      authorized member
 *   2. A stops; a second invitation, minted before step 1 and so naming only A, ends `error`
 *      with `retryable: true` and a reason naming reachability; `POST …/retry` after A
 *      restarts makes it `joined`
 *   3. an invitation with a 1-second expiry, joined after it expired, ends `error` with
 *      `retryable: false` and `invite-spent` in the reason, and Retry is refused 409
 *
 * Throughout: no invitation text appears in `GET /api/hosted-nodes` or the SSE stream.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';

import { CadreNode, MemoryBootstrapPeerStore, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import type { HostedNodeView } from '@serfab/cadre-host';

import {
  captureRawStorage,
  connectionsTo,
  controlNodeConfig,
  createTestCadreHost,
  makeOwnOwner,
  waitUntil,
  type TestCadreHost,
  type TestEventStream,
} from '../harness/index.js';

/** Generous budget for a real `cadre-cli` child to start and settle its redemption. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
/** A dedicated band for the host's children, clear of the other child-process scenarios' (`harness/port-allocator.ts`). */
const PORT_RANGE = { start: 20200, end: 20359 };

describe('cadre-host joins a cadre by invitation (real cadre-host, real cadre-cli)', () => {
  const partyId = `join-by-invitation-${Math.random().toString(36).slice(2)}`;

  let host: TestCadreHost;
  let events: TestEventStream;

  let aKey: PrivateKey;
  let aPeerId: string;
  let aOwnerKey: string;
  /** A's WebSocket listen address, bound again by the restart in step 2. */
  let aListenAddr: string;
  const captureA = captureRawStorage();
  const aPeerStore = new MemoryBootstrapPeerStore(partyId);
  let A: CadreNode | undefined;

  /** Minted before step 1, so it names A alone: no other member exists yet. */
  let laterInvitation: string;
  /** Every invitation handed to the host, to check none leaks back out. */
  const invitations: string[] = [];
  /** Step 1's node, a member A must reconnect to after its restart. */
  let firstNode: HostedNodeView;

  function buildA(listenAddrs?: string[]): CadreNode {
    return new CadreNode(controlNodeConfig({
      partyId,
      privateKey: aKey,
      profile: 'transaction',
      strandFilter: 'none',
      enableRelay: true,
      storageProvider: captureA.provider,
      bootstrapPeerStore: aPeerStore,
      ...(listenAddrs ? { listenAddrs } : {}),
    }));
  }

  async function mint(options: { expiresInMs?: number } = {}): Promise<string> {
    const { encoded } = await A!.createCadreInvitation({ grantsOwner: false, ...options });
    invitations.push(encoded);
    return encoded;
  }

  async function getNode(id: string): Promise<HostedNodeView> {
    const res = await host.request({ method: 'GET', path: `/api/hosted-nodes/${encodeURIComponent(id)}` });
    if (res.status !== 200) throw new Error(`GET hosted node answered ${res.status}: ${res.raw}`);
    return (res.body as { data: { node: HostedNodeView } }).data.node;
  }

  async function joinWith(invitation: string): Promise<HostedNodeView> {
    const res = await host.request({ method: 'POST', path: '/api/hosted-nodes', body: { invitation } });
    if (res.status !== 201) throw new Error(`POST /api/hosted-nodes answered ${res.status}: ${res.raw}`);
    const node = (res.body as { data: { node: HostedNodeView } }).data.node;
    expect(node).toMatchObject({ status: 'joining', partyId, join: { kind: 'invitation' } });
    return node;
  }

  /** Wait until the node's redemption settles: `joined` or `error`. */
  async function settled(id: string): Promise<HostedNodeView> {
    let node: HostedNodeView | undefined;
    await waitUntil(async () => {
      node = await getNode(id);
      return node.status === 'joined' || node.status === 'error';
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: `hosted node ${id} joins or fails` });
    return node!;
  }

  beforeAll(async () => {
    aKey = await generateKeyPair('Ed25519');
    aPeerId = peerIdFromPrivateKey(aKey).toString();
    A = buildA();
    await A.start();
    aOwnerKey = await makeOwnOwner(A, aKey);
    aListenAddr = A.getMultiaddrs()[0]!.replace(/\/p2p\/[^/]+$/, '');
    laterInvitation = await mint();

    host = await createTestCadreHost({ portRange: PORT_RANGE });
    events = await host.openEventStream();
  }, STARTUP_MS);

  afterAll(async () => {
    try { events?.close(); } catch { /* ignore */ }
    // Through the service, which deletes the record before stopping the child, so the
    // supervisor cannot respawn what a failed step left behind.
    for (const left of host?.hostedNodes.list() ?? []) {
      try { await host.hostedNodes.remove(left.id); } catch { /* ignore */ }
    }
    try { await host?.stop(); } catch { /* ignore */ }
    try { await A?.stop(); } catch { /* ignore */ }
  }, OP_MS);

  it('step 1: a node joined with an untargeted invitation is admitted by A', async () => {
    const node = await joinWith(await mint());

    firstNode = await settled(node.id);
    expect(firstNode).toMatchObject({ status: 'joined', partyId, memberPeerId: aPeerId, ownerKey: aOwnerKey });
    expect(firstNode.peerId).toBeDefined();
    await events.next((e) => e.type === 'hosted-nodes-changed' && e.nodeId === node.id && e.kind === 'joined');
    expect(await A!.isAuthorizedMember(firstNode.peerId!)).toBe(true);
  }, STARTUP_MS + OP_MS);

  it('step 2: with A offline no member answers; Retry after A returns joins', async () => {
    await A!.stop();
    A = undefined;

    const node = await joinWith(laterInvitation);
    const failed = await settled(node.id);
    expect(failed).toMatchObject({ status: 'error', retryable: true });
    expect(failed.error).toMatch(/could be reached/);

    A = buildA([aListenAddr]);
    await A.start();
    await A.initializeSeedBootstrap(ed25519KeyPairFromLibp2p(aKey).privateKeyB64);
    expect(A.getMultiaddrs()[0]).toBe(`${aListenAddr}/p2p/${aPeerId}`);
    // The admission is a control write A's cohort agrees on, and step 1's node is in that
    // cohort: wait for the two to find each other again before asking.
    await A.reconcileControlCohort();
    await waitUntil(() => connectionsTo(A!, firstNode.peerId!).some((c) => c.status === 'open'), {
      timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the restarted A reconnects to step 1\'s node',
    });

    const retry = await host.request({ method: 'POST', path: `/api/hosted-nodes/${node.id}/retry` });
    expect(retry.status).toBe(200);
    expect((retry.body as { data: { node: HostedNodeView } }).data.node).toMatchObject({ status: 'joining' });

    const joined = await settled(node.id);
    expect(joined).toMatchObject({ status: 'joined', memberPeerId: aPeerId, ownerKey: aOwnerKey });
    expect(joined.retryable).toBeUndefined();
    expect(await A.isAuthorizedMember(joined.peerId!)).toBe(true);
  }, 3 * STARTUP_MS + OP_MS);

  it('step 3: an expired invitation is refused by name, and Retry is refused', async () => {
    const expiring = await mint({ expiresInMs: 1_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));

    const node = await joinWith(expiring);
    const refused = await settled(node.id);
    expect(refused).toMatchObject({ status: 'error', retryable: false });
    expect(refused.error).toContain('invite-spent');

    const retry = await host.request({ method: 'POST', path: `/api/hosted-nodes/${node.id}/retry` });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ ok: false, error: { code: 'invalid_state' } });

    // The bundles carry the invitations' private keys; the host sends them nowhere.
    const listed = await host.request({ method: 'GET', path: '/api/hosted-nodes' });
    for (const invitation of invitations) {
      expect(listed.raw).not.toContain(invitation);
      expect(JSON.stringify(events.received())).not.toContain(invitation);
    }
  }, STARTUP_MS + OP_MS);
});
