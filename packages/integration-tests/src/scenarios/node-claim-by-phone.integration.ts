/**
 * A PHONE-SHAPED owner claims a `cadre-cli` node that was started waiting to be claimed:
 * row 8 of `docs/architecture.md` → Which Side Dials.
 *
 * Terms used below:
 *
 * - **Claimable node** — a real `cadre-cli` child process started with `CADRE_CLAIM_SECRET`
 *   (cadre-cli README → Waiting to be claimed). It belongs to nobody until a seed arrives
 *   with a proof of that one-time secret, and while it waits it admits a stranger's
 *   connection and nothing else on it.
 * - **Phone-shaped claimant** — an in-process `CadreNode` with `listenAddrs: []`, WebSocket
 *   and circuit-relay transports only, `profile: 'transaction'`, owner genesis run on
 *   itself: the claimant of `cadre-host-join-by-qr.integration.ts`.
 * - **The QR payload** — the node's peer id and addresses, read here from its `/status`, plus
 *   the secret. cadre-host's join flow will show these as a QR code
 *   (`cadre-host-hosted-nodes-join-by-qr`); here the test hands them over.
 *
 * What the steps pin, in order, each its own `it` so a failure names the step:
 *
 *   1. the node is up under the placeholder party and `/status` reports `claim: 'awaiting'`;
 *      the claimant is undialable
 *   2. a wrong secret is refused as `claim-proof-invalid`, the node is still unclaimed, and
 *      the claimant kept no `CadrePeer` row and no dial target for it
 *   3. the right secret claims it: `/status` says `claimed`, the node records the claim
 *      (`claim.json`, without the secret) and restarts in-process into the claimant's party,
 *      `/status` then names that party and the claimant as `claimedBy`, the claimant DIALS IN
 *      (outbound on its side, a WebSocket control connection on the node's), the node's
 *      signed record reaches the claimant, and the claimant's row is in the node's
 *      authorized set
 *   4. an owner of another cadre presenting the same secret is refused as `already-claimed`
 *   5. the first owner claiming again is accepted, leaving one row and one dial target
 *   6. the node restarted on the same workdir and environment reads `claimed` with no
 *      further claim, serves the claimant's party from the record, and the claimant
 *      reconnects with no further call
 *
 * The child is spawned directly, not through cadre-host's `HostProcessOrchestrator`: that
 * orchestrator has no way to hand a child a claim secret yet (`cadre-host-hosted-nodes-join-by-qr`
 * adds one). It runs the `storage` profile, as cadre-host's nodes do, binds `/ws` on loopback
 * only, and keeps its identity file, file storage and node-state directory in one workdir, so
 * step 6 restarts the same node. Its loopback admin channel (`--admin-port`) is the only window
 * onto its authorized set from outside the process.
 *
 * The child's config names the placeholder party `unclaimed`, as cadre-host's will: nobody
 * can know the party before the claim, so the claim seed carries it, the node records it
 * and restarts into it (cadre-cli README → Waiting to be claimed), and step 6's restart on
 * the same workdir starts from that record.
 *
 * Step 3's node-to-claimant half rests on the claimed node publishing its own address record
 * once the row its owner wrote after the claim reaches it by replication. It does that on its
 * next control-cohort reconcile pass (`publishSelfRecordOnceClaimed` in cadre-core), every
 * 15 s by default, which is most of step 3's running time. Without that method step 3 times
 * out here, the record waiting for the 7.5-minute heartbeat.
 *
 * Out of scope: reachability beyond loopback (`cadre-host-node-reachability`), strand
 * replication onto the claimed node, and a claimant behind a relay.
 *
 * Runs the real `cadre-cli` bin from `dist`, so `@serfab/cadre-core` and `@serfab/cadre-cli`
 * must be built. Two child starts plus two in-process nodes; budgets are generous on purpose.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';

import { CadreNode, ClaimRefusedError, MemoryBootstrapPeerStore } from '@serfab/cadre-core';
import type { ClaimState, CliConfigFile, HealthStatus } from '@serfab/cadre-cli';

import {
  allocFreePort,
  connectionsTo,
  controlNodeConfig,
  hasOutboundTo,
  isChildUp,
  makeOwnOwner,
  resolveCadreCliBin,
  scrubbedParentEnv,
  sleep,
  stopChildProcess,
  waitUntil,
  writeIdentity,
} from '../harness/index.js';

/** Generous startup budget — real libp2p + optimystic control DB in a child. */
const STARTUP_MS = 90_000;
/** Per-op budget for round-trips once a node is up. */
const OP_MS = 30_000;
/** The claimants' control-cohort reconcile cadence, which drives step 6's reconnect. */
const RECONCILE_MS = 2_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_FILE = 'node.log';
const LOG_TAIL_LINES = 40;
/** The party an unclaimed node's config names; the claim replaces it. */
const PLACEHOLDER_PARTY = 'unclaimed';
/** Where `cadre start` records the claim, in the node-state directory (the workdir here). */
const CLAIM_RECORD_FILE = 'claim.json';

/** One claimable `cadre-cli` node: everything a restart reuses, plus its current process. */
interface ClaimableNode {
  workdir: string;
  peerId: string;
  ports: { health: number; metrics: number; admin: number; ws: number };
  /** `CADRE_STARTUP_TOKEN`, which the loopback admin channel takes as its bearer. */
  adminToken: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  process?: ChildProcess;
}

/** Write the node's identity and config into `workdir` and fix its ports and environment. */
async function prepareClaimableNode(workdir: string, partyId: string, claimSecret: string): Promise<ClaimableNode> {
  mkdirSync(join(workdir, 'storage'), { recursive: true });
  const keyFile = join(workdir, 'identity.key');
  const { peerId } = await writeIdentity(keyFile);
  const ports = {
    health: await allocFreePort(),
    metrics: await allocFreePort(),
    admin: await allocFreePort(),
    ws: await allocFreePort(),
  };
  const configPath = join(workdir, 'cadre.json');
  const config: CliConfigFile = {
    controlNetwork: { partyId, bootstrapNodes: [] },
    profile: 'storage',
    storage: { type: 'file', path: join(workdir, 'storage') },
    network: { listenAddrs: [`/ip4/127.0.0.1/tcp/${ports.ws}/ws`] },
    hibernation: { enabled: false },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  const adminToken = randomBytes(16).toString('hex');
  return {
    workdir,
    peerId,
    ports,
    adminToken,
    args: [
      resolveCadreCliBin(), 'start',
      '-c', configPath,
      '--identity-file', keyFile,
      '--health-port', String(ports.health),
      '--metrics-port', String(ports.metrics),
      '--admin-port', String(ports.admin),
    ],
    env: {
      ...scrubbedParentEnv(),
      CADRE_CLAIM_SECRET: claimSecret,
      CADRE_STARTUP_TOKEN: adminToken,
      CADRE_NODE_STATE_DIR: workdir,
    },
  };
}

function launch(node: ClaimableNode): void {
  // Appended, not truncated, so a failing step 6 still has the first run's lines.
  const logFd = openSync(join(node.workdir, LOG_FILE), 'a');
  try {
    node.process = spawn(process.execPath, node.args, { cwd: node.workdir, stdio: ['ignore', logFd, logFd], env: node.env });
  } finally {
    closeSync(logFd);
  }
}

function readLog(node: ClaimableNode): string {
  const path = join(node.workdir, LOG_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function logTail(node: ClaimableNode): string {
  return readLog(node).split('\n').slice(-LOG_TAIL_LINES).join('\n');
}

async function readStatus(node: ClaimableNode): Promise<HealthStatus> {
  const res = await fetch(`http://127.0.0.1:${node.ports.health}/status`);
  if (!res.ok) throw new Error(`/status answered ${res.status}`);
  return (await res.json()) as HealthStatus;
}

/**
 * Wait until the node is running and `/status` reports `claim` and `partyId`. A child that
 * exits first (a refused start, an unknown `CADRE_*` name) fails at once with the tail of its
 * log, rather than after the whole budget with only a timeout to show for it.
 */
async function waitForStatus(node: ClaimableNode, want: { claim: ClaimState; partyId: string }): Promise<HealthStatus> {
  const wanted = `claim '${want.claim}', party '${want.partyId}'`;
  const deadline = Date.now() + STARTUP_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (!node.process || !isChildUp(node.process)) {
      throw new Error(`cadre-cli exited (code ${node.process?.exitCode}) before /status reported ${wanted}:\n${logTail(node)}`);
    }
    try {
      const status = await readStatus(node);
      if (status.status === 'healthy' && status.node.claim === want.claim && status.node.partyId === want.partyId) return status;
      last = `status '${status.status}', claim '${status.node.claim}', party '${status.node.partyId}'`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for /status to report ${wanted} (last: ${last}):\n${logTail(node)}`);
}

/** Is `peerId` in the node's AUTHORIZED member set, by its loopback admin channel. */
async function isAuthorizedOnNode(node: ClaimableNode, peerId: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${node.ports.admin}/admin/authorized-members/${encodeURIComponent(peerId)}`, {
    headers: { authorization: `Bearer ${node.adminToken}` },
  });
  const body = (await res.json()) as { ok: boolean; data?: { member: boolean }; error?: { message: string } };
  if (!body.ok || !body.data) throw new Error(`admin channel refused: ${body.error?.message ?? res.status}`);
  return body.data.member;
}

/** A phone-shaped owner node of its own party, not yet started. */
async function buildPhoneOwner(partyId: string, bootstrapPeerStore?: MemoryBootstrapPeerStore): Promise<{ node: CadreNode; key: PrivateKey }> {
  const key = await generateKeyPair('Ed25519');
  const node = new CadreNode(controlNodeConfig({
    partyId,
    privateKey: key,
    profile: 'transaction',
    // Nothing can dial a phone: whatever connects the two, the phone opened it.
    listenAddrs: [],
    reconcileMs: RECONCILE_MS,
    ...(bootstrapPeerStore ? { bootstrapPeerStore } : {}),
  }));
  return { node, key };
}

describe('a phone-shaped owner claims a cadre-cli node started with a claim secret', () => {
  const partyId = `node-claim-${Math.random().toString(36).slice(2)}`;
  const claimSecret = randomBytes(32).toString('base64url');

  let tmpRoot: string;
  let node: ClaimableNode;
  /** What the QR code would carry beside the peer id: the node's own `/status` addresses. */
  let nodeAddrs: string[];

  let claimant: CadreNode | undefined;
  let claimantPeerId: string;
  let claimantOwnerKey: string;
  /** Held outside the claimant so the steps can read what `claimNode` retained. */
  const claimantPeerStore = new MemoryBootstrapPeerStore(partyId);
  /** The step 4 owner of another cadre; stopped within its step. */
  let rival: CadreNode | undefined;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'node-claim-by-phone-'));
    node = await prepareClaimableNode(join(tmpRoot, 'node'), PLACEHOLDER_PARTY, claimSecret);
  });

  afterAll(async () => {
    try { await rival?.stop(); } catch { /* ignore */ }
    try { await claimant?.stop(); } catch { /* ignore */ }
    if (node?.process) await stopChildProcess(node.process, STOP_TIMEOUT_MS);
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* ignore — Windows can lag on workdir release */ }
  });

  it('step 1: the node starts waiting to be claimed, and the claimant is undialable', async () => {
    launch(node);
    const status = await waitForStatus(node, { claim: 'awaiting', partyId: PLACEHOLDER_PARTY });
    expect(status.node.peerId).toBe(node.peerId);
    expect(status.node.claimedBy).toBeUndefined();
    expect(existsSync(join(node.workdir, CLAIM_RECORD_FILE))).toBe(false);
    nodeAddrs = status.multiaddrs;
    expect(nodeAddrs.some((a) => a.includes('/ws'))).toBe(true);

    const built = await buildPhoneOwner(partyId, claimantPeerStore);
    claimant = built.node;
    await claimant.start();
    claimantPeerId = claimant.peerId!.toString();
    claimantOwnerKey = await makeOwnOwner(claimant, built.key);
    // The claimant's own `CadrePeer` row is what step 3 looks for in the node's authorized
    // set. Published now rather than left to the self-registration timer, which may fire
    // before the owner key above is in place and then wait for the next heartbeat.
    expect(await claimant.registerSelf()).not.toBe('skipped');

    // The premise of the file: if the claimant ever listened, every connection below could be
    // the node dialing it, and the steps would pass while proving the opposite direction.
    expect(claimant.getMultiaddrs()).toEqual([]);
  }, 2 * STARTUP_MS);

  it('step 2: a wrong secret is refused as claim-proof-invalid and leaves nothing behind', async () => {
    const wrongSecret = randomBytes(32).toString('base64url');
    const failure = await claimant!.claimNode({ peerId: node.peerId, multiaddrs: nodeAddrs, secret: wrongSecret })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ClaimRefusedError);
    expect(failure).toMatchObject({ code: 'claim-proof-invalid', nodePeerId: node.peerId });
    expect((await readStatus(node)).node.claim).toBe('awaiting');
    expect((await claimant!.listMembers()).map((m) => m.peerId)).not.toContain(node.peerId);
    expect(claimantPeerStore.all().has(node.peerId)).toBe(false);
  }, OP_MS);

  it('step 3: the right secret claims the node, which restarts into the claimant\'s party, the claimant DIALS IN, and rows cross both ways', async () => {
    await claimant!.claimNode({ peerId: node.peerId, multiaddrs: nodeAddrs, secret: claimSecret });
    // The node records the claim before it acknowledges the seed, so `claimed` needs no wait
    // and never flips back while the node restarts into the party. The party itself does
    // need one: the restart waits for the seed to be handled, then rebuilds the node.
    expect((await readStatus(node)).node.claim).toBe('claimed');
    const claimed = await waitForStatus(node, { claim: 'claimed', partyId });
    expect(claimed.node.claimedBy).toBe(claimantOwnerKey);
    expect(claimed.node.peerId).toBe(node.peerId);

    // The record names the party and the owner, never the secret.
    const record = readFileSync(join(node.workdir, CLAIM_RECORD_FILE), 'utf8');
    expect(JSON.parse(record)).toMatchObject({ version: 1, partyId, ownerKey: claimantOwnerKey });
    expect(record).not.toContain(claimSecret);
    expect(readLog(node)).toContain(`✓ Claimed by owner ${claimantOwnerKey.slice(0, 8)} into party ${partyId}`);
    expect(readLog(node)).toContain(`✓ Restarted into party ${partyId} as a node claimed by owner ${claimantOwnerKey.slice(0, 8)}`);

    await waitUntil(() => hasOutboundTo(claimant!, node.peerId), {
      timeoutMs: OP_MS,
      intervalMs: 250,
      description: 'claimant holds an OUTBOUND control connection to the node',
    });
    // `/status` carries counts by transport, not per-connection direction, so the node's side
    // of "the claimant reached it" is a WebSocket connection: the claimant has no other way in.
    await waitUntil(async () => ((await readStatus(node)).node.connectionPaths.byTransport.websocket ?? 0) >= 1, {
      timeoutMs: OP_MS,
      intervalMs: 500,
      description: 'node reports a live WEBSOCKET control connection',
    });

    // Claimant → node: its own row, vouched by the key the claim anchored, is authorized there.
    await waitUntil(() => isAuthorizedOnNode(node, claimantPeerId), {
      timeoutMs: STARTUP_MS,
      intervalMs: 1_000,
      description: 'the claimant is in the node’s authorized member set',
    });
    // Node → claimant: the node found the row the claim wrote for it, self-published a signed,
    // addressed record, and that record replicated back.
    let resolved: string[] = [];
    await waitUntil(async () => {
      resolved = (await claimant!.resolvePeerAddrs(node.peerId)).map((ma) => ma.toString());
      return resolved.length > 0;
    }, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'the node’s signed record reaches the claimant' });
    expect(resolved.some((a) => a.includes('/ws'))).toBe(true);

    expect(claimant!.getMultiaddrs()).toEqual([]);
  }, 3 * STARTUP_MS + 2 * OP_MS);

  it('step 4: an owner of another cadre presenting the same secret is refused as already-claimed', async () => {
    const built = await buildPhoneOwner(`node-claim-rival-${Math.random().toString(36).slice(2)}`);
    rival = built.node;
    await rival.start();
    await makeOwnOwner(rival, built.key);

    // The rival is no member, so the claimed node's connection gate lets it in only because a
    // storage-profile node runs the relay server: the verdict is 'admit-for-relay' rather than
    // 'deny', and the seed stream completes inside that admission's reserve deadline.
    // NOTE: with the relay off (`CADRE_ENABLE_RELAY=false`) the rival is refused at the
    // connection and `claimNode` throws a dial error, not `already-claimed`. Fine while hosted
    // nodes run the storage default; if one ever runs without the relay, the "already claimed"
    // answer cadre-host's join flow shows needs the gate to admit a stranger for the seed.
    const failure = await rival.claimNode({ peerId: node.peerId, multiaddrs: nodeAddrs, secret: claimSecret })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ClaimRefusedError);
    expect(failure).toMatchObject({ code: 'already-claimed' });
    expect((await readStatus(node)).node.claim).toBe('claimed');

    await rival.stop();
    rival = undefined;
  }, STARTUP_MS);

  it('step 5: the same owner claiming again is accepted, with one row and one dial target', async () => {
    await claimant!.claimNode({ peerId: node.peerId, multiaddrs: nodeAddrs, secret: claimSecret });

    expect((await claimant!.listMembers()).filter((m) => m.peerId === node.peerId)).toHaveLength(1);
    expect([...claimantPeerStore.all().keys()]).toEqual([node.peerId]);
  }, OP_MS);

  it('step 6: a restarted node is still claimed, and the claimant reconnects with no further call', async () => {
    // The claimant can hold the dead connection `open` for seconds after the child exits, so
    // "a connection exists" would be satisfied by it; only a connection with a new id counts.
    const staleConnectionIds = new Set(connectionsTo(claimant!, node.peerId).map((c) => c.id));
    expect(staleConnectionIds.size).toBeGreaterThan(0);

    await stopChildProcess(node.process!, STOP_TIMEOUT_MS);
    launch(node);
    // The restarted process reads `claim.json` first: the claimant's party, not the config's
    // placeholder, and the claimant as owner, with no further claim.
    const restarted = await waitForStatus(node, { claim: 'claimed', partyId });
    expect(restarted.node.claimedBy).toBe(claimantOwnerKey);
    expect(readLog(node)).toContain(`• Claimed by owner ${claimantOwnerKey.slice(0, 8)} into party ${partyId} `
      + `(controlNetwork.partyId '${PLACEHOLDER_PARTY}' is a placeholder and is ignored)`);
    expect(readLog(node)).toContain('• Already claimed; CADRE_CLAIM_SECRET is ignored');

    // NOTE: does not pin WHICH dial source the claimant used: the dial target `claimNode`
    // retained and the node's fresh signed record both survive into this step, as in the
    // join-by-qr scenario's respawn step. Telling them apart would mean disabling one.
    await waitUntil(
      () => connectionsTo(claimant!, node.peerId)
        .some((c) => c.direction === 'outbound' && c.status === 'open' && !staleConnectionIds.has(c.id)),
      { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'claimant opens a NEW outbound connection to the restarted node' },
    );

    // Two runs' worth of output, including each `claim:accepted` line: the secret is never in it.
    expect(readLog(node)).not.toContain(claimSecret);
  }, 2 * STARTUP_MS);
});
