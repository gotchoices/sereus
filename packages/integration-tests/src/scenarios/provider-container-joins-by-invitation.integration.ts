/**
 * A provider container joins a cadre BY ITSELF, redeeming an owner-minted invitation at a member
 * that is already online: `docs/architecture.md` → Enrollment Flow: Phone Adds Provider Drone,
 * "By invitation", on the wire (row 4 of Which Side Dials, the invitation arm).
 *
 * Machines:
 *
 * - **The owner node** — a real `cadre-cli` child started with `--owner` (`startOwnerCliNode`),
 *   the cadre's always-on member, listening on a loopback TCP port and a loopback `/ws` port and
 *   driven over its loopback admin channel: it mints the invitations and its member set says who
 *   a redemption admitted. It stands for the phone that minted the invitation and the always-on
 *   machine the container reaches; in the household this flow is for they are two machines, and
 *   nothing here depends on their being one.
 * - **Provider** — the real `@serfab/cadre-provider` HTTP API (`createProviderServer` over a
 *   `MemoryStore` and a `ProviderProcessOrchestrator`, driven in-process through Fastify's
 *   `inject`, auth mode `none`), with NO public host on either the server or the orchestrator: an
 *   invitation container dials out and need not be dialable, so it announces nothing.
 * - **Provider node** — the real `cadre-cli` child the orchestrator spawns from the provider's
 *   own `buildNodeEnv` output, `CADRE_INVITATION` carrying the bundle and the party the bundle
 *   names, no bootstrap peers.
 *
 * What the steps pin, in order, each its own `it` so a failure names the step:
 *
 *   1. the owner node is up with a `/ws` address and mints an untargeted single-use invitation
 *      (`grantsOwner: false`, 15-minute expiry) naming its own addresses
 *   2. `POST /containers { join: { kind: 'invitation', invitation } }` is answered with the
 *      bundle's party and `join: { kind }` only; the record reaches `running`, and the fold
 *      reaches `{ kind: 'invitation', state: 'accepted', memberPeerId: <owner node> }`
 *   3. the owner node lists the container as an authorized member, and the container's own
 *      signed record reaches it (the row the redemption wrote carried no signature; the one the
 *      container publishes itself does)
 *   4. a second container created with the same, now spent, invitation reaches `running` with
 *      `joinState` `failed`, `retryable: false` and `invite-spent` in `error` (a member's
 *      refusal, not "no member reached"), and the owner node holds nothing for it
 *   5. no response of the provider — create, read or list — and neither child's output carries
 *      the bundle text
 *   6. `DELETE /containers/:id` stops both records and both children
 *
 * The node redeems right after it is up and the provider folds the outcome on the next
 * `GET /containers/:id`; every read of the fold is a `waitUntil` on that route, never a read of
 * the child's log.
 *
 * Out of scope: Docker itself, strands, a retry route (there is none: the remedy for a spent
 * invitation is to delete the container and rent again), an owner that is offline when the
 * container starts (`cadre-host-join-by-invitation` covers `retryable: true`), and the claim
 * path (`provider-container-claimed-by-phone`).
 *
 * Runs the real `cadre-cli` bin from `dist`, so `@serfab/cadre-core`, `@serfab/cadre-cli` and
 * `@serfab/cadre-provider` must be built. Three child starts; budgets are generous on purpose.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ed25519PublicKeyB64FromPeerId, type CadreInvitation } from '@serfab/cadre-core';
import {
  DEFAULT_CONFIG,
  MemoryStore,
  createProviderServer,
  type ProviderServer,
  type RedactedContainer,
} from '@serfab/cadre-provider';

import {
  ProviderProcessOrchestrator,
  isChildUp,
  providerApi,
  requireContainerRunning,
  startOwnerCliNode,
  waitUntil,
  writeIdentity,
  type OwnerCliNode,
  type ProviderApi,
  type ProviderContainerRead,
  type ProviderContainerResponse,
  type ProviderDeleteResponse,
  type ProviderListResponse,
  type ProviderProcessHandle,
} from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
/** The invitation's lifetime: well past the two creates, and what an app would mint for a rented node. */
const INVITATION_TTL_MS = 15 * 60_000;

describe('a provider container joins a cadre by invitation at an always-on member (real cadre-provider API, real cadre-cli)', () => {
  const partyId = `provider-invite-${Math.random().toString(36).slice(2)}`;

  let tmpRoot: string;
  let owner: OwnerCliNode;
  let ownerPeerId: string;
  let orchestrator: ProviderProcessOrchestrator;
  let server: ProviderServer;
  /** The provider's routes; `api.answered` is every body, and the bundle must be in none. */
  let api: ProviderApi;

  // Threaded across the ordered steps below (vitest runs them in order).
  let invitation: CadreInvitation;
  /** The bundle as the app would paste it: what `POST /containers` takes and the child is started with. */
  let encodedInvitation: string;
  let firstId: string;
  let firstPeerId: string;
  let secondId: string;
  let secondPeerId: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'provider-invite-'));

    const identityPath = join(tmpRoot, 'owner-identity.key');
    const { peerId } = await writeIdentity(identityPath);
    ownerPeerId = peerId;
    owner = await startOwnerCliNode({
      workdir: join(tmpRoot, 'owner'),
      identityPath,
      peerId: ownerPeerId,
      partyId,
      startupMs: STARTUP_MS,
      // A `/ws` listener beside the TCP one: the address a phone could reach this member at.
      listenAddrs: ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws'],
    });

    // No `publicHost` anywhere: an invitation container announces no public address.
    orchestrator = new ProviderProcessOrchestrator({ rootDir: join(tmpRoot, 'provider-volumes') });
    server = await createProviderServer({
      config: { ...DEFAULT_CONFIG, auth: { mode: 'none', allowInsecureNoAuth: true } },
      orchestrator,
      store: new MemoryStore(),
    });
    await server.app.ready();
    api = providerApi(server);
  }, STARTUP_MS + 15_000);

  afterAll(async () => {
    for (const left of orchestrator?.listHandles() ?? []) {
      try { await orchestrator.stopContainer(left.dockerId); } catch { /* ignore */ }
    }
    try { await server?.stop(); } catch { /* ignore */ }
    try { await owner?.stop(); } catch { /* ignore */ }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  }, OP_MS);

  /** `POST /containers` with the bundle, as the app sends it: no party, no bootstrap peers, no pins. */
  async function createInvitationContainer(): Promise<RedactedContainer> {
    const created = await api.request<ProviderContainerResponse>('POST', '/containers', {
      join: { kind: 'invitation', invitation: encodedInvitation },
      profile: 'storage',
    });
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error(`POST /containers refused: ${created.body.error.code}`);
    const record = created.body.data.container;
    expect(record.partyId).toBe(partyId);
    expect(record.join).toEqual({ kind: 'invitation' });
    expect(record).not.toHaveProperty('seedToken');
    return record;
  }

  /** Wait until the record's invitation has settled, `accepted` or `failed`; the failure carries the last read and the node's log. */
  async function waitForSettledJoin(id: string, label: string): Promise<ProviderContainerRead> {
    let last: ProviderContainerRead | undefined;
    try {
      await waitUntil(async () => {
        last = await api.readContainer(id);
        const state = last.container.joinState?.state;
        return state === 'accepted' || state === 'failed';
      }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: `${label}'s redemption settles` });
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nlast record: ${JSON.stringify(last?.container ?? null)}\n--- node.log ---\n${orchestrator.logTail(id)}\n--- owner.log ---\n${owner.logTail()}`,
        { cause: err },
      );
    }
    return last!;
  }

  function handleOf(container: RedactedContainer): ProviderProcessHandle {
    const handle = orchestrator.listHandles().find((h) => h.dockerId === container.dockerId);
    if (!handle) throw new Error(`no child handle for container ${container.id}`);
    return handle;
  }

  it('step 1: the owner node is up with a /ws address and mints an untargeted single-use invitation', async () => {
    expect(await owner.getPeerId()).toBe(ownerPeerId);
    const addrs = await owner.getMultiaddrs();
    expect(addrs.some((a) => a.includes('/ws/'))).toBe(true);
    expect(addrs.every((a) => a.endsWith(`/p2p/${ownerPeerId}`))).toBe(true);

    const minted = await owner.createInvitation({ grantsOwner: false, expiresInMs: INVITATION_TTL_MS });
    invitation = minted.invitation;
    encodedInvitation = minted.encoded;
    expect(invitation.partyId).toBe(partyId);
    expect(invitation.invite.peerId).toBeNull();
    expect(invitation.invite.grantsOwner).toBe(false);
    expect(invitation.invite.totalUses).toBe(1);
    // The only member there is: the owner node's own addresses, which is where the container dials.
    expect(invitation.members.length).toBeGreaterThan(0);
    expect(invitation.members.every((a) => a.endsWith(`/p2p/${ownerPeerId}`))).toBe(true);
    // The issuer and the one pinned owner key are the owner node's owner key file's key, not the
    // key behind its peer id.
    const ownerKey = await owner.getOwnerKey();
    expect(invitation.invite.issuerKey).toBe(ownerKey);
    expect(invitation.ownerKeys).toEqual([ownerKey]);
    expect(ownerKey).not.toBe(ed25519PublicKeyB64FromPeerId(ownerPeerId));
  }, OP_MS);

  it('step 2: an invitation container reaches running and the fold reaches accepted, naming the owner node', async () => {
    const created = await createInvitationContainer();
    firstId = created.id;

    await requireContainerRunning(server.containerService, orchestrator, firstId, 'the invitation container', STARTUP_MS);
    const settled = await waitForSettledJoin(firstId, 'the invitation container');
    expect(settled.container.joinState).toEqual({ kind: 'invitation', state: 'accepted', memberPeerId: ownerPeerId });
    expect(settled.container.partyId).toBe(partyId);
    // Nothing to fold onto the record's owner: the bundle's owner keys are the node's own business.
    expect(settled.container.ownerKey).toBeUndefined();
    expect(settled.health?.node?.invitation).toEqual({ state: 'accepted', memberPeerId: ownerPeerId });
    firstPeerId = settled.container.peerId!;
    expect(firstPeerId).toMatch(/^12D3Koo/);
    expect(firstPeerId).not.toBe(ownerPeerId);
  }, 2 * STARTUP_MS + 10_000);

  it('step 3: the owner node lists the container as an authorized member, and the container\'s own signed record reaches it', async () => {
    await waitUntil(() => owner.isAuthorizedMember(firstPeerId), {
      timeoutMs: OP_MS,
      intervalMs: 1_000,
      description: 'the container is in the owner node\'s authorized member set',
    });
    // The redemption wrote the row unsigned; the container's own publish, on a reconcile pass
    // once it holds its row, replaces it with a signed, addressed record.
    let row: { multiaddr: string | null; sig: string | null } | undefined;
    await waitUntil(async () => {
      row = (await owner.listMembers()).find((m) => m.peerId === firstPeerId);
      return row?.sig !== null && row?.sig !== undefined;
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'the container\'s signed record reaches the owner node' });
    expect(row!.multiaddr).toBeTruthy();
  }, STARTUP_MS + OP_MS);

  it('step 4: a container created with the spent invitation reaches running with the join failed as invite-spent, not retryable', async () => {
    const created = await createInvitationContainer();
    secondId = created.id;

    await requireContainerRunning(server.containerService, orchestrator, secondId, 'the second container', STARTUP_MS);
    const settled = await waitForSettledJoin(secondId, 'the second container');
    // A member answered and refused by name; "no member reachable" would be retryable.
    expect(settled.container.joinState).toEqual({
      kind: 'invitation',
      state: 'failed',
      error: expect.stringContaining('invite-spent'),
      retryable: false,
    });
    expect(settled.health?.node?.invitation).toMatchObject({ state: 'failed', retryable: false });
    expect(settled.container.partyId).toBe(partyId);
    secondPeerId = settled.container.peerId!;
    expect(secondPeerId).not.toBe(firstPeerId);

    // The member wrote nothing for it: neither an authorized member nor a row at all.
    expect(await owner.isAuthorizedMember(secondPeerId)).toBe(false);
    expect((await owner.listMembers()).some((m) => m.peerId === secondPeerId)).toBe(false);
    // The first container is unaffected.
    expect(await owner.isAuthorizedMember(firstPeerId)).toBe(true);
  }, 2 * STARTUP_MS + 10_000);

  it('step 5: no response and neither child\'s output carries the bundle', async () => {
    const listed = await api.request<ProviderListResponse>('GET', '/containers');
    expect(listed.body.data.containers.map((c) => c.id).sort()).toEqual([firstId, secondId].sort());
    for (const container of listed.body.data.containers) {
      expect(container.join).toEqual({ kind: 'invitation' });
    }
    await api.readContainer(firstId);
    await api.readContainer(secondId);

    // The bundle carries the invitation's private key; it went into two children's
    // environments and came back out nowhere.
    expect(api.answered.length).toBeGreaterThan(0);
    expect(api.answered.some((body) => body.includes(encodedInvitation))).toBe(false);
    for (const id of [firstId, secondId]) {
      const handle = handleOf((await api.readContainer(id)).container);
      expect(await orchestrator.getLogs(handle.dockerId, 10_000)).not.toContain(encodedInvitation);
    }
  }, OP_MS);

  it('step 6: deleting the containers stops both records and both children', async () => {
    for (const id of [firstId, secondId]) {
      const handle = handleOf((await api.readContainer(id)).container);
      const deleted = await api.request<ProviderDeleteResponse>('DELETE', `/containers/${id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.ok).toBe(true);
      expect((await api.readContainer(id)).container.status).toBe('stopped');
      expect(isChildUp(handle.child)).toBe(false);
      expect(await orchestrator.inspectRunState(handle.dockerId)).toBeUndefined();
    }
  }, 2 * OP_MS);
});
