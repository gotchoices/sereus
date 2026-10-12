/**
 * A PHONE-SHAPED owner rents a provider container that waits to be claimed and claims it with
 * the node code the provider hands out: `docs/architecture.md` → Enrollment Flow: Phone Adds
 * Provider Drone, "By claim", on the wire (row 4 of Which Side Dials, the claim arm).
 *
 * Terms used below:
 *
 * - **Provider** — the real `@serfab/cadre-provider` HTTP API: `createProviderServer` over a
 *   `MemoryStore` and a `ProviderProcessOrchestrator`, driven in-process through Fastify's
 *   `inject` (no port is bound) in auth mode `none`, so the scenario is the API's one customer.
 *   The routes, their validator and their redaction are the production ones; underneath them
 *   the same `ContainerService` enrollment loop `provider-drone-phone-requester` drives directly.
 * - **Provider node** — the real `cadre-cli` child the orchestrator spawns from the provider's
 *   own `buildNodeEnv` output: `CADRE_CLAIM_SECRET` from the join the service minted, the
 *   placeholder party `unclaimed`, no bootstrap peers, and `CADRE_APPEND_ANNOUNCE_ADDRS` from
 *   `publicNodeAddrs('localhost', …)`, as a Docker container with `docker.publicHost` gets. The
 *   host is a name on purpose: a `/dns4/localhost` address appears only by being announced
 *   (`provider-drone-phone-requester` says why).
 * - **Phone-shaped requester** — `buildPhoneOwner`: an in-process `CadreNode` with
 *   `listenAddrs: []`, WebSocket and circuit-relay transports only, `profile: 'transaction'`,
 *   owner genesis run on itself. It can reach the node only at a `/ws` address.
 *
 * What the steps pin, in order, each its own `it` so a failure names the step:
 *
 *   1. the requester is up and listens on nothing
 *   2. `POST /containers { join: { kind: 'claim' } }` is answered with the placeholder party
 *      and `join: { kind }` only; `GET …/code` answers 503 before the node is up; the record
 *      reaches `running` with `joinState` `awaiting`, and the node reports `claim: 'awaiting'`
 *   3. `GET …/code` answers a code whose addresses are exactly the one announced `/ws`
 *      address at the public host, `/p2p/<peerId>` appended, though the node reports the TCP
 *      and in-container addresses too; cadre-core's `decodeNodeClaimPayload` accepts it, and
 *      every refusal before it was 503
 *   4. a wrong secret is refused `claim-proof-invalid` and the record still reads `awaiting`
 *   5. the right secret claims it: the fold reaches `claimed` with the requester's party and
 *      owner key on the record and in the list; the requester DIALS IN (outbound on its side, a
 *      WebSocket connection on the node's) and is in the node's authorized member set; the
 *      node's signed record reaches the requester; `GET …/code` now answers 409
 *      `ALREADY_CLAIMED`; and no response so far carried the secret, the code aside
 *   6. an owner of another cadre presenting the same secret is refused `already-claimed`
 *   7. the container restarted on the same volume and environment (`restartContainer`, the
 *      harness's `docker restart`) reads `claimed` from `claim.json` with no further claim, the
 *      record never regressed, and the requester reconnects on a new connection; neither run's
 *      output contains the secret
 *   8. `DELETE /containers/:id` stops the record and the child
 *
 * The claimed node restarts in-process into the requester's party, and `/status` is briefly
 * `unhealthy` while it does; every read of the fold is a `waitUntil`, never a single read.
 *
 * The child is given a loopback admin channel (`adminChannel`), which no provider sets: it is
 * the only window onto the node's authorized member set from outside the process.
 *
 * Out of scope: Docker itself, strands, a requester behind a relay, and the invitation path
 * (`provider-container-joins-by-invitation`).
 *
 * Runs the real `cadre-cli` bin from `dist`, so `@serfab/cadre-core`, `@serfab/cadre-cli` and
 * `@serfab/cadre-provider` must be built.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaimRefusedError, decodeNodeClaimPayload, type CadreNode, type NodeClaimPayload } from '@serfab/cadre-core';
import type { HealthStatus } from '@serfab/cadre-cli';
import {
  DEFAULT_CONFIG,
  MemoryStore,
  UNCLAIMED_PARTY_ID,
  createProviderServer,
  type NodeCode,
  type ProviderServer,
  type RedactedContainer,
} from '@serfab/cadre-provider';

import {
  ProviderProcessOrchestrator,
  adminClient,
  buildPhoneOwner,
  connectionsTo,
  hasOutboundTo,
  isChildUp,
  makeOwnOwner,
  providerApi,
  requireContainerRunning,
  waitUntil,
  type ProviderApi,
  type ProviderCodeResponse,
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
const PUBLIC_HOST = 'localhost';
/** Where `cadre start` records the claim: the node-state directory, the container's volume here. */
const CLAIM_RECORD_FILE = 'claim.json';
/** The orchestrator's per-container log, two runs of the child appended. */
const LOG_FILE = 'node.log';

describe('a phone-shaped requester claims a provider container from its node code (real cadre-provider API, real cadre-cli)', () => {
  const partyId = `provider-claim-${Math.random().toString(36).slice(2)}`;

  let tmpRoot: string;
  let orchestrator: ProviderProcessOrchestrator;
  let server: ProviderServer;
  /** The provider's routes; `api.answered` is every body but a code answer, and the secret must be in none. */
  let api: ProviderApi;

  let requester: CadreNode | undefined;
  let requesterPeerId: string;
  let requesterOwnerKey: string;
  /** The step 6 owner of another cadre; stopped within its step. */
  let rival: CadreNode | undefined;

  // Threaded across the ordered steps below (vitest runs them in order).
  let containerId: string;
  let handle: ProviderProcessHandle;
  let nodePeerId: string;
  /** The decoded node code: what the phone hands `claimNode`. */
  let claimPayload: NodeClaimPayload;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'provider-claim-'));
    orchestrator = new ProviderProcessOrchestrator({
      rootDir: join(tmpRoot, 'provider-volumes'),
      publicHost: PUBLIC_HOST,
      adminChannel: true,
    });
    server = await createProviderServer({
      config: {
        ...DEFAULT_CONFIG,
        auth: { mode: 'none', allowInsecureNoAuth: true },
        // The host a node code's addresses must carry, and what makes `join.kind: 'claim'` creatable.
        docker: { ...DEFAULT_CONFIG.docker, publicHost: PUBLIC_HOST },
      },
      orchestrator,
      store: new MemoryStore(),
    });
    await server.app.ready();
    api = providerApi(server);
  });

  afterAll(async () => {
    try { await rival?.stop(); } catch { /* ignore */ }
    try { await requester?.stop(); } catch { /* ignore */ }
    for (const left of orchestrator?.listHandles() ?? []) {
      try { await orchestrator.stopContainer(left.dockerId); } catch { /* ignore */ }
    }
    try { await server?.stop(); } catch { /* ignore */ }
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  }, OP_MS);

  function readContainer(): Promise<ProviderContainerRead> {
    return api.readContainer(containerId);
  }

  /** `GET /containers/:id/code`: the code, or the refusal's code. A code answer is not recorded: it carries the secret by design. */
  async function readCode(): Promise<{ status: number; code?: NodeCode; refusal?: string }> {
    const { status, body } = await api.request<ProviderCodeResponse>('GET', `/containers/${containerId}/code`, undefined, { record: false });
    if (body.ok) return { status, code: body.data };
    api.answered.push(JSON.stringify(body));
    return { status, refusal: body.error.code };
  }

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

  /** Wait until the record's `joinState` is `claimed`; the failure carries the last record read and the node's log. */
  async function waitForClaimedRecord(description: string): Promise<RedactedContainer> {
    let last: RedactedContainer | undefined;
    try {
      await waitUntil(async () => {
        last = (await readContainer()).container;
        return last.joinState?.state === 'claimed';
      }, { timeoutMs: STARTUP_MS, intervalMs: 500, description });
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nlast record: ${JSON.stringify(last ?? null)}\n--- node.log ---\n${orchestrator.logTail(containerId)}`,
        { cause: err },
      );
    }
    return last!;
  }

  function nodeLog(): string {
    const path = join(handle.volumeDir, LOG_FILE);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
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

  it('step 2: a claim container is created under the placeholder party and reaches running, awaiting its claim', async () => {
    const created = await api.request<ProviderContainerResponse>('POST', '/containers', { join: { kind: 'claim' }, profile: 'storage' });
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error(`POST /containers refused: ${created.body.error.code}`);
    const record = created.body.data.container;
    containerId = record.id;
    expect(record.partyId).toBe(UNCLAIMED_PARTY_ID);
    expect(record.join).toEqual({ kind: 'claim' });
    expect(record).not.toHaveProperty('seedToken');

    // No health endpoint yet (the orchestrator is still minting the child's identity), so the
    // code is not ready: the 503 a client polls through.
    expect(await readCode()).toEqual({ status: 503, refusal: 'NOT_AVAILABLE' });

    await requireContainerRunning(server.containerService, orchestrator, containerId, 'the claim container', STARTUP_MS);
    const running = await readContainer();
    expect(running.container.partyId).toBe(UNCLAIMED_PARTY_ID);
    expect(running.container.joinState).toEqual({ kind: 'claim', state: 'awaiting' });
    expect(running.container.ownerKey).toBeUndefined();
    expect(running.health?.node?.claim).toBe('awaiting');
    expect(running.health?.node?.partyId).toBe(UNCLAIMED_PARTY_ID);
    nodePeerId = running.container.peerId!;
    expect(nodePeerId).toMatch(/^12D3Koo/);

    handle = orchestrator.listHandles().find((h) => h.dockerId === running.container.dockerId)!;
    expect(handle).toBeDefined();
    expect(handle.admin).toBeDefined();
    expect(existsSync(join(handle.volumeDir, CLAIM_RECORD_FILE))).toBe(false);
  }, STARTUP_MS + 10_000);

  it('step 3: the node code carries exactly the announced /ws address at the public host, and decodes', async () => {
    const refusals = new Set<string>();
    let code: NodeCode | undefined;
    await waitUntil(async () => {
      const answer = await readCode();
      if (answer.refusal) refusals.add(`${answer.status} ${answer.refusal}`);
      code = answer.code;
      return !!code;
    }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the node code is ready' });
    // Not ready is the only answer before the code; anything else would be a wrong refusal.
    expect([...refusals].every((r) => r === '503 NOT_AVAILABLE')).toBe(true);

    expect(code!.peerId).toBe(nodePeerId);
    expect(code!.multiaddrs).toEqual([`/dns4/${PUBLIC_HOST}/tcp/${handle.ports.ws}/ws/p2p/${nodePeerId}`]);
    // The node reports more than the code carries: the announced TCP address and the bound
    // loopback ones, none of which a phone can dial.
    const reported = (await readStatus()).multiaddrs;
    expect(reported).toContain(`/dns4/${PUBLIC_HOST}/tcp/${handle.ports.p2p}/p2p/${nodePeerId}`);
    expect(reported.length).toBeGreaterThan(code!.multiaddrs.length);

    // The contract: what the phone decodes is what the provider encoded.
    claimPayload = decodeNodeClaimPayload(code!.code);
    expect(claimPayload.peerId).toBe(code!.peerId);
    expect(claimPayload.multiaddrs).toEqual(code!.multiaddrs);
    // 32 random bytes, base64url, as cadre-core's `parseClaimSecret` wants them.
    expect(Buffer.from(claimPayload.secret, 'base64url')).toHaveLength(32);
  }, STARTUP_MS);

  it('step 4: a wrong secret is refused as claim-proof-invalid and the record still awaits its claim', async () => {
    const wrongSecret = randomBytes(32).toString('base64url');
    const failure = await requester!.claimNode({ ...claimPayload, secret: wrongSecret }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ClaimRefusedError);
    expect(failure).toMatchObject({ code: 'claim-proof-invalid', nodePeerId });
    const record = await readContainer();
    expect(record.container.joinState).toEqual({ kind: 'claim', state: 'awaiting' });
    expect(record.container.partyId).toBe(UNCLAIMED_PARTY_ID);
    expect(record.health?.node?.claim).toBe('awaiting');
  }, OP_MS);

  it('step 5: the right secret claims the node, the provider folds the claim, the requester DIALS IN, and the code is withdrawn', async () => {
    await requester!.claimNode(claimPayload);

    // The node records the claim before it acknowledges the seed, then restarts in-process
    // into the requester's party; the provider folds `claimed` only once the node reports
    // that party too, so the record never names the placeholder as the container's cadre.
    const claimed = await waitForClaimedRecord('the record folds the claim with the requester\'s party');
    expect(claimed.joinState).toEqual({ kind: 'claim', state: 'claimed', ownerKey: requesterOwnerKey, partyId });
    expect(claimed.partyId).toBe(partyId);
    expect(claimed.ownerKey).toBe(requesterOwnerKey);
    // The list carries the folded party and join state with no live read per row.
    const listed = (await api.request<ProviderListResponse>('GET', '/containers')).body.data.containers.find((c) => c.id === containerId)!;
    expect(listed).toMatchObject({ partyId, ownerKey: requesterOwnerKey, joinState: { state: 'claimed' } });

    const status = await readStatus();
    expect(status.node.claim).toBe('claimed');
    expect(status.node.claimedBy).toBe(requesterOwnerKey);
    expect(status.node.partyId).toBe(partyId);
    // The record names the party and the owner, never the secret.
    const record = readFileSync(join(handle.volumeDir, CLAIM_RECORD_FILE), 'utf8');
    expect(JSON.parse(record)).toMatchObject({ version: 1, partyId, ownerKey: requesterOwnerKey });
    expect(record).not.toContain(claimPayload.secret);

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

    // Requester → node: its own row, vouched by the key the claim anchored, is authorized there.
    await waitUntil(() => isAuthorizedOnNode(requesterPeerId), {
      timeoutMs: STARTUP_MS,
      intervalMs: 1_000,
      description: 'the requester is in the node\'s authorized member set',
    });
    // Node → requester: the node found the row the claim wrote for it, self-published a signed,
    // addressed record on a reconcile pass, and that record replicated back.
    let resolved: string[] = [];
    await waitUntil(async () => {
      resolved = (await requester!.resolvePeerAddrs(nodePeerId)).map((ma) => ma.toString());
      return resolved.length > 0;
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'the node\'s signed record reaches the requester' });
    expect(resolved.some((a) => a.includes('/ws'))).toBe(true);

    // Judged on a live read: a second device asking now is told so, not handed a code the node would refuse.
    expect(await readCode()).toEqual({ status: 409, refusal: 'ALREADY_CLAIMED' });

    // Every create, read, list and refusal so far: the secret left the provider in the code alone.
    expect(api.answered.length).toBeGreaterThan(0);
    expect(api.answered.some((body) => body.includes(claimPayload.secret))).toBe(false);
    expect(requester!.getMultiaddrs()).toEqual([]);
  }, 3 * STARTUP_MS + 2 * OP_MS);

  it('step 6: an owner of another cadre presenting the same secret is refused as already-claimed', async () => {
    const built = await buildPhoneOwner(`provider-claim-rival-${Math.random().toString(36).slice(2)}`);
    rival = built.node;
    await rival.start();
    await makeOwnOwner(rival, built.key);

    // The rival is no member, so the claimed node's connection gate admits it provisionally, and
    // the seed stream completes well inside the provisional deadline.
    const failure = await rival.claimNode(claimPayload).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ClaimRefusedError);
    expect(failure).toMatchObject({ code: 'already-claimed' });
    expect((await readStatus()).node.claim).toBe('claimed');
    expect((await readContainer()).container.ownerKey).toBe(requesterOwnerKey);

    await rival.stop();
    rival = undefined;
  }, STARTUP_MS);

  it('step 7: the container restarted on its volume is still claimed with no further claim, and the requester reconnects', async () => {
    // The requester can hold the dead connection `open` for seconds after the child exits, so
    // "a connection exists" would be satisfied by it; only a connection with a new id counts.
    const staleConnectionIds = new Set(connectionsTo(requester!, nodePeerId).map((c) => c.id));
    expect(staleConnectionIds.size).toBeGreaterThan(0);

    await orchestrator.restartContainer(handle.dockerId);
    // The restarted process reads `claim.json` first: the requester's party, not the
    // environment's placeholder, and the requester as owner, with no further claim.
    let last: HealthStatus | undefined;
    try {
      await waitUntil(async () => {
        last = await readStatus();
        return last.status === 'healthy' && last.node.claim === 'claimed' && last.node.partyId === partyId;
      }, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the restarted node serves the claimed party' });
    } catch (err) {
      throw new Error(`${(err as Error).message}\nlast /status: ${JSON.stringify(last ?? null)}\n--- node.log ---\n${orchestrator.logTail(containerId)}`, { cause: err });
    }
    expect(last!.node.peerId).toBe(nodePeerId);
    expect(last!.node.claimedBy).toBe(requesterOwnerKey);
    expect(nodeLog()).toContain('• Already claimed; CADRE_CLAIM_SECRET is ignored');

    // The record never went back to `awaiting`: a `claimed` record is never regressed, and the
    // restarted node reports the claim anyway.
    const record = await readContainer();
    expect(record.container.joinState).toEqual({ kind: 'claim', state: 'claimed', ownerKey: requesterOwnerKey, partyId });
    expect(record.health?.node?.claim).toBe('claimed');
    expect(await readCode()).toEqual({ status: 409, refusal: 'ALREADY_CLAIMED' });

    // NOTE: does not pin WHICH dial source the requester used: the dial target `claimNode`
    // retained and the node's signed record both survive into this step, as in
    // `node-claim-by-phone`. Telling them apart would mean disabling one.
    await waitUntil(
      () => connectionsTo(requester!, nodePeerId)
        .some((c) => c.direction === 'outbound' && c.status === 'open' && !staleConnectionIds.has(c.id)),
      { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'the requester opens a NEW outbound connection to the restarted node' },
    );

    // Two runs' worth of output, including the `claim:accepted` line: the secret is never in it.
    expect(nodeLog()).not.toContain(claimPayload.secret);
    expect(api.answered.some((body) => body.includes(claimPayload.secret))).toBe(false);
  }, 2 * STARTUP_MS);

  it('step 8: deleting the container stops the record and the child', async () => {
    const deleted = await api.request<ProviderDeleteResponse>('DELETE', `/containers/${containerId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
    expect((await readContainer()).container.status).toBe('stopped');
    expect(isChildUp(handle.child)).toBe(false);
    expect(await orchestrator.inspectRunState(handle.dockerId)).toBeUndefined();
  }, OP_MS);
});
