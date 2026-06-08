/**
 * Cross-package authority-node integration.
 *
 * Closes the loop the 6.7 delegation work left open: cadre-host's
 * `HostProcessOrchestrator` spawns the **real** `@serfab/cadre-cli` authority
 * node (`cadre-cli start --authority --admin-port … --identity-protobuf …`),
 * and `AuthorityNodeClient` drives it end-to-end over the loopback admin
 * channel. Unlike the cadre-host unit suites — which spawn a fake CLI binding
 * the admin port (`orchestrator-authority.test.ts`) or point the client at a
 * stub admin HTTP server (`host-authority.smoke.test.ts`) — this exercises the
 * genuine wire: real libp2p identity/multiaddrs, the real control DB, bearer
 * auth, and the cadre-provider envelope across a process boundary.
 *
 * The orchestrator resolves the real cadre-cli bin (no `spawn.entrypoint`
 * override), so this requires `@serfab/cadre-cli` and `@serfab/cadre-host` to
 * be built. Real libp2p + control-DB startup is slow, so the node is spawned
 * once for the whole happy-path suite with generous timeouts; no full-network
 * dial is performed (the node is the founding authority of its own party).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';

import {
  AUTHORITY_CONTAINER_ID,
  AuthorityNodeClient,
  AuthorityNodeUnavailableError,
  HostProcessOrchestrator,
  type AuthorityAdminEndpoint,
  type AuthoritySpawnConfig,
  type ManagedNodeInfo,
} from '@serfab/cadre-host';

import { waitUntil } from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for admin round-trips once the node is up. */
const OP_MS = 30_000;

/** Write the installer-style protobuf identity.key and return its peer id. */
async function writeIdentity(path: string): Promise<{ key: PrivateKey; peerId: string }> {
  const key = await generateKeyPair('Ed25519');
  writeFileSync(path, privateKeyToProtobuf(key));
  return { key, peerId: peerIdFromPrivateKey(key).toString() };
}

/** A shape-valid (but offline) peer id from a throwaway Ed25519 key. */
async function freshPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** Grab then immediately release a loopback port — guaranteed-closed for the moment. */
async function pickClosedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('cadre-host ↔ real cadre-cli authority node', () => {
  let tmpRoot: string;
  let orchestrator: HostProcessOrchestrator;
  let node: ManagedNodeInfo;
  let client: AuthorityNodeClient;
  let expectedPeerId: string;
  const partyId = `authority-int-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-authnode-'));
    const identityPath = join(tmpRoot, 'identity.key');
    ({ peerId: expectedPeerId } = await writeIdentity(identityPath));

    orchestrator = new HostProcessOrchestrator({
      rootDir: join(tmpRoot, 'orchestrator'),
      // Dedicated high range for health/metrics/admin so concurrent suites
      // don't collide. libp2p uses an ephemeral port (see config below).
      portRange: { start: 19600, end: 19899 },
      stopTimeoutMs: 5_000,
    });
    await orchestrator.init();

    const cfg: AuthoritySpawnConfig = {
      identityPath,
      partyId,
      // Ephemeral libp2p port — the OS assigns one and getMultiaddrs() reports
      // the real bound address. Avoids cross-suite TCP collisions.
      libp2pPort: 0,
      profile: 'storage',
    };
    node = await orchestrator.ensureAuthorityNode(cfg);
    expect(node.id).toBe(AUTHORITY_CONTAINER_ID);
    expect(node.authority).toBe(true);

    // Endpoint is read via a getter so a respawn's new bearer would be picked up.
    client = new AuthorityNodeClient(() => orchestrator.getAuthorityAdminEndpoint());

    // Readiness: the admin channel binds only after node.start() + authority
    // genesis + seed-bootstrap init, so a successful identity round-trip means
    // the whole stack is up. Transport errors during the bind window are
    // swallowed by waitUntil and retried (the "not-ready window" in practice).
    try {
      await waitUntil(
        async () => (await client.getPeerId()) === expectedPeerId,
        { timeoutMs: STARTUP_MS, intervalMs: 250, description: 'authority admin channel ready' },
      );
    } catch (err) {
      // Surface the child log to make a startup failure debuggable in CI.
      let log = '';
      try { log = await orchestrator.getLogs(node.dockerId, 200); } catch { /* ignore */ }
      throw new Error(`authority node never became ready: ${(err as Error).message}\n--- node.log ---\n${log}`, { cause: err });
    }
  }, STARTUP_MS + 10_000);

  afterAll(async () => {
    try { await orchestrator?.stopAuthorityNode(); } catch { /* ignore */ }
    if (orchestrator) {
      for (const n of orchestrator.listNodes()) {
        try { await orchestrator.removeContainer(n.dockerId); } catch { /* ignore */ }
      }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  });

  it('getPeerId() returns the real libp2p peer id derived from the host identity', async () => {
    const peerId = await client.getPeerId();
    expect(peerId).toBe(expectedPeerId);
    expect(peerId).toMatch(/^12D3Koo/); // Ed25519 libp2p peer id prefix
  }, OP_MS);

  it('getMultiaddrs() returns real, parseable listen addresses', async () => {
    const addrs = await client.getMultiaddrs();
    expect(Array.isArray(addrs)).toBe(true);
    expect(addrs.length).toBeGreaterThanOrEqual(1);
    for (const a of addrs) {
      expect(a.startsWith('/')).toBe(true);
      expect(a).toContain('/tcp/');
    }
  }, OP_MS);

  it('createInvite() mints an invite for this party with an encoded form', async () => {
    const { invite, encodedInvite } = await client.createInvite();
    expect(typeof encodedInvite).toBe('string');
    expect(encodedInvite.length).toBeGreaterThan(0);
    expect(invite.partyId).toBe(partyId);
    expect(Array.isArray(invite.authorityAddrs)).toBe(true);

    // encodedInvite is base64url(JSON) — it must round-trip back to the invite.
    const decoded = JSON.parse(Buffer.from(encodedInvite, 'base64url').toString('utf8'));
    expect(decoded.partyId).toBe(partyId);
    expect(decoded.token).toBe(invite.token);
  }, OP_MS);

  it('listMembers()/isMember() report an empty membership on a fresh party', async () => {
    expect(await client.listMembers()).toEqual([]);
    expect(await client.isMember(await freshPeerId())).toBe(false);
  }, OP_MS);

  it('accept-phone authorizes a peer, then removePeer deletes it (full add→remove cycle)', async () => {
    // This is the cycle the quereus-cadrepeer-delete-no-row-context fix
    // unblocked: the CadrePeer DELETE-with-context now succeeds end-to-end.
    const phonePeerId = await freshPeerId();
    const token = `int-tok-${Math.random().toString(36).slice(2)}`;

    const { invite } = await client.createInvite(token);
    await client.acceptPhone({ phonePeerId, token }, invite);

    expect(await client.isMember(phonePeerId)).toBe(true);
    const members = await client.listMembers();
    expect(members.map((m) => m.peerId)).toContain(phonePeerId);

    await client.removePeer(phonePeerId);

    expect(await client.isMember(phonePeerId)).toBe(false);
    expect((await client.listMembers()).map((m) => m.peerId)).not.toContain(phonePeerId);
  }, OP_MS);

  it('pushInviteAddresses() is reflected in subsequently minted invites', async () => {
    const pushed = [`/dns4/host.example.com/tcp/45678/p2p/${expectedPeerId}`];
    await client.pushInviteAddresses(pushed);

    const { invite } = await client.createInvite();
    expect(invite.authorityAddrs).toEqual(pushed);
  }, OP_MS);

  it('rejects a bad bearer token with not_authorized', async () => {
    const endpoint = orchestrator.getAuthorityAdminEndpoint();
    expect(endpoint).toBeDefined();
    const badClient = new AuthorityNodeClient({
      baseUrl: (endpoint as AuthorityAdminEndpoint).baseUrl,
      token: 'definitely-not-the-token',
    });

    // Single round-trip: assert both the error type and its node code.
    try {
      await badClient.getPeerId();
      expect.unreachable('bad bearer should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorityNodeUnavailableError);
      expect((err as AuthorityNodeUnavailableError).nodeCode).toBe('not_authorized');
    }
  }, OP_MS);
});

describe('authority-node client — not-ready / unavailable window', () => {
  it('surfaces AuthorityNodeUnavailableError when no node has been spawned', async () => {
    // getter returns undefined → the client cannot resolve an endpoint. This is
    // the pre-spawn state the trust-circle / NAT services translate to a 503.
    const client = new AuthorityNodeClient(() => undefined);
    await expect(client.getPeerId()).rejects.toBeInstanceOf(AuthorityNodeUnavailableError);
  });

  it('surfaces AuthorityNodeUnavailableError (not a hang) on connection refused', async () => {
    // Models the spawn→admin-bind window: the endpoint exists but the port is
    // not yet listening. The client must reject cleanly rather than hang.
    const port = await pickClosedPort();
    const client = new AuthorityNodeClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok' });
    await expect(client.getPeerId()).rejects.toBeInstanceOf(AuthorityNodeUnavailableError);
  }, 15_000);
});
