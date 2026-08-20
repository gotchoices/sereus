/**
 * Scenario-level fixtures for standing up bare `CadreNode`s.
 *
 * Distinct from `test-network.ts` (the `TestCadreNetwork` party orchestrator): these
 * are the low-level building blocks a scenario uses when it constructs and wires
 * `CadreNode` instances itself — transports, sApp configs, node config, control-network
 * genesis/enrollment, and pairwise connection.
 */

import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { ConnectionGater, PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode, ed25519KeyPairFromLibp2p, signSchema } from '@serfab/cadre-core';
import type { CadreNodeConfig, SAppConfig } from '@serfab/cadre-core';
import { waitUntil } from './wait-utils.js';
import { readCohort } from './control-cohort.js';
import { signMessageEd25519 } from './test-network.js';

/** WebSocket + circuit-relay transports shared by every e2e/integration scenario. */
export function wsTransports(): Libp2pTransports {
  return [webSockets(), circuitRelayTransport()];
}

/**
 * A properly signed sApp config with a NON-realtime `latencyHint` (`'interactive'`) —
 * realtime strands never hibernate, so any wake/hibernation scenario requires this.
 */
export function createSignedSAppConfig(schema: string, version: string): SAppConfig {
  const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  const signature = signSchema(schema, version, authorPrivateKey);
  return { id: authorPublicKey, version, schema, signature, latencyHint: 'interactive' as const };
}

export interface ControlNodeOpts {
  partyId: string;
  privateKey?: PrivateKey;
  bootstrapNodes?: string[];
  profile?: 'storage' | 'transaction';
  enableRelay?: boolean;
  listenAddrs?: string[];
  /**
   * Relay servers to reserve a `/p2p-circuit` slot through — the fail-fast
   * configured-reservation route (`relay-addrs.ts` folds each entry into the
   * listen set as `<addr>/p2p-circuit`). Pair with `listenAddrs: []` to model a
   * node with no inbound reachability of its own.
   */
  relayAddrs?: string[];
  hibernation?: boolean;
  /** Which strands this node participates in (default `'all'`). */
  strandFilter?: 'all' | 'none';
  /** Override the proactive control-cohort reconcile cadence (ms). */
  reconcileMs?: number;
  /** Override the strand watcher poll cadence (ms; `CadreNode` default 5000). */
  strandWatchMs?: number;
  /** Owner keys pinned into the node-local trusted-owner anchor at start(). */
  pinnedOwnerKeys?: string[];
  /**
   * Test-supplied libp2p connection gater. On the control node it is composed
   * under the built-in membership admission gate, which preserves every hook
   * except `denyInboundEncryptedConnection` — so a test's outbound-deny hooks
   * (`denyDialPeer` etc.) are honored unchanged.
   */
  connectionGater?: ConnectionGater;
}

/** Build a `CadreNodeConfig` for one control-network test node. */
export function controlNodeConfig(opts: ControlNodeOpts): CadreNodeConfig {
  return {
    controlNetwork: { partyId: opts.partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
    profile: opts.profile ?? 'transaction',
    strandFilter: { mode: opts.strandFilter ?? 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    ...(opts.strandWatchMs !== undefined ? { strandWatchInterval: opts.strandWatchMs } : {}),
    ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
    network: {
      transports: wsTransports(),
      listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
      ...(opts.relayAddrs ? { relayAddrs: opts.relayAddrs } : {}),
      ...(opts.enableRelay ? { enableRelay: true } : {}),
      ...(opts.reconcileMs !== undefined ? { controlCohort: { reconcileMs: opts.reconcileMs } } : {}),
      ...(opts.connectionGater ? { connectionGater: opts.connectionGater } : {})
    },
    ...(opts.pinnedOwnerKeys ? { trustedOwners: { pinnedKeys: opts.pinnedOwnerKeys } } : {}),
    hibernation: { enabled: opts.hibernation ?? false },
  };
}

/**
 * Make a freshly-started node its own control owner (genesis): enroll its derived
 * public key in `OwnerKey` and wire seed-bootstrap with the matching private key, so
 * it can owner-sign `CadrePeer` inserts (and mint seeds). Returns the owner PUBLIC key
 * (base64url) — the key an enrollee pins into its node-local trusted-owner anchor
 * (`trustOwnerKeys`) so this owner's membership vouchers pass its authorized-member
 * predicate. Callers that don't need the anchor key (most current callers) simply
 * discard the return value.
 */
export async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<string> {
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
  const db = node.getControlDatabase();
  if (!db) throw new Error('control database missing after start');
  await db.insertOwnerKey(publicKeyB64);
  node.initializeSeedBootstrap(privateKeyB64);
  return publicKeyB64;
}

/** A real Ed25519 peer id for a peer that is NEVER started (a pure row subject). */
export async function randomPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** This node's live connections to `remotePeerId`, on the control network. */
export function connectionsTo(node: CadreNode, remotePeerId: string) {
  return (node.getControlNode()?.getConnections() ?? [])
    .filter((c) => c.remotePeer.toString() === remotePeerId);
}

/** Does this node hold an OPEN, OUTBOUND control connection to `remotePeerId`? */
export function hasOutboundTo(node: CadreNode, remotePeerId: string): boolean {
  return connectionsTo(node, remotePeerId)
    .some((c) => c.direction === 'outbound' && c.status === 'open');
}

/**
 * The libp2p peerStore multiaddrs this node holds for `remotePeerId` — the
 * cold-start fallback source `resolveControlDialAddrs` uses when the signed
 * `CadrePeer` record does not resolve. A missing entry is an empty list; any
 * other failure is rethrown rather than swallowed into a false "empty".
 */
export async function peerStoreAddrsFor(node: CadreNode, remotePeerId: string): Promise<string[]> {
  const controlNode = node.getControlNode();
  if (!controlNode) return [];
  try {
    const peer = await controlNode.peerStore.get(peerIdFromString(remotePeerId));
    return peer.addresses.map((a) => a.multiaddr.toString());
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFoundError') return [];
    throw error;
  }
}

/** The control node's currently-observed multiaddrs as strings. */
export function controlAddrs(node: CadreNode): string[] {
  return node.getControlNode()!.getMultiaddrs().map((ma) => ma.toString());
}

/** Wait until `node`'s control libp2p reports an open connection to `peerId`. */
export async function waitForControlConnection(node: CadreNode, peerId: string, description: string): Promise<void> {
  const controlNode = node.getControlNode()!;
  await waitUntil(() => controlNode.getConnections().some((c) => c.remotePeer.toString() === peerId), {
    timeoutMs: 15_000,
    intervalMs: 250,
    description,
  });
}

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and wait
 * until BOTH sides report it, SCOPED to this specific peer pair (so the recipe stays
 * correct when several readers attach to one writer, e.g. a 3-node full-mesh
 * scenario). This is the test-only stand-in for production control-cohort discovery.
 * Both-sides confirmation is a hard precondition of a replicating write: only once
 * each peer sees the connection can the control collection's cohort span them and a
 * commit be non-local-only.
 */
export async function connectControlNodes(reader: CadreNode, writer: CadreNode): Promise<void> {
  const writerAddrs = writer.getControlNode()!.getMultiaddrs();
  if (writerAddrs.length === 0) throw new Error('writer control node has no listen addresses');

  await reader.getControlNode()!.dial(writerAddrs[0]!);
  await waitForControlConnection(reader, writer.peerId!.toString(), 'reader control node connects to writer');
  await waitForControlConnection(writer, reader.peerId!.toString(), 'writer control node sees inbound connection from reader');
}

/**
 * Boot node A (owner + writer, storage profile so it holds the CadrePeer blocks) and
 * node B (a plain READER — deliberately NOT its own owner, so every row it observes
 * must have arrived over the wire) on a fresh party, DISCONNECTED. A vouches B
 * (`authorizePeer`) right after B starts, so A's inbound connection gate later admits
 * B's dial. Caller owns shutdown (`A.stop()` / `B.stop()`) and owns connecting them.
 *
 * `partyId` is built as `${partyIdPrefix}-${tag}-<timestamp>`; pass `partyIdPrefix` to
 * keep an existing scenario's party-id namespacing (default `'ctrl'`).
 *
 * `opts.strandWatchMs` overrides the strand watcher poll cadence on BOTH nodes —
 * scenarios asserting watcher-driven convergence need a cadence shorter than the
 * 5 s `CadreNode` default so their quiet-window assertions stay affordable.
 */
export async function bootPair(
  tag: string,
  partyIdPrefix = 'ctrl',
  opts: { strandWatchMs?: number } = {},
): Promise<{ A: CadreNode; B: CadreNode }> {
  const partyId = `${partyIdPrefix}-${tag}-${Date.now()}`;
  const { strandWatchMs } = opts;

  const aKey = await generateKeyPair('Ed25519');
  const A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandWatchMs }));
  await A.start();
  await makeOwnOwner(A, aKey);

  const bKey = await generateKeyPair('Ed25519');
  const B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction', strandWatchMs }));
  await B.start();

  // A vouches B so B's inbound pull streams pass A's per-stream control-DB gate
  // (A's snapshot is non-empty once it has an anchor + any member row). B still
  // pins nobody — row presence (`isMember`) is what these scenarios assert, not
  // trust.
  await A.authorizePeer(B.peerId!.toString());

  return { A, B };
}

export interface ConnectedPair {
  A: CadreNode;
  B: CadreNode;
  /** The party's enrolled owner PUBLIC key (A's derived key, base64url). */
  ownerPublicKey: string;
  /**
   * Sign control-row authorization bytes with the pair's owner key — pass as the
   * `signMessage` argument of `ControlDatabase.insertStrand` / `insertFormationInvite` /
   * `insertValidationKey` to publish owner-signed rows from a scenario.
   */
  ownerSign: (message: Uint8Array) => string;
}

/**
 * Boot the same A/B party as {@link bootPair} but with CONNECT-THEN-WRITE ordering: the
 * two nodes are connected and BOTH report a control cohort of >= 2 BEFORE the first
 * control write (owner-key genesis included), so every row is offered to the two-machine
 * cohort from the start. Use this when a scenario must read its own rows back on BOTH
 * nodes: `bootPair` writes A's owner key while A is still alone, and a row committed by a
 * one-member cohort cannot be read back once the cohort grows (tracked in
 * `control-db-cross-node-convergence-halted`).
 *
 * Deliberately a sibling of {@link bootPair}, not a change to it — existing scenarios
 * depend on bootPair's write-while-alone ordering (they assert pull-on-read convergence
 * of rows written by A, not cross-node read-back of genesis rows).
 *
 * NOTE: the ~8 lines of node construction here duplicate {@link bootPair}'s. Left duplicated
 * because factoring them out would move `B.start()` ahead of A's owner genesis in bootPair,
 * i.e. change the very ordering the two fixtures exist to keep apart, and the full
 * integration suite that would prove that safe exceeds the 10-minute agent run budget. If a
 * THIRD pair fixture lands, extract a shared node-construction helper that takes the
 * ordering as its argument rather than copying a third time.
 *
 * The cohort wait is also what makes a later concurrent-write assertion meaningful: a
 * write offered to a one-member cohort commits on the writer's own vote and proves
 * nothing about two machines (see `control-cohort.ts`).
 *
 * Caller owns shutdown (`A.stop()` / `B.stop()`) of a boot that RETURNS. A boot that throws
 * hands the caller no node handles, so it stops whatever it already started itself — the
 * cohort wait below is a 30 s failure window, and a leaked libp2p node outlives the run.
 */
export async function bootConnectedPair(
  tag: string,
  partyIdPrefix = 'ctrl',
  opts: { strandWatchMs?: number } = {},
): Promise<ConnectedPair> {
  const partyId = `${partyIdPrefix}-${tag}-${Date.now()}`;
  const { strandWatchMs } = opts;
  const started: CadreNode[] = [];

  try {
    const aKey = await generateKeyPair('Ed25519');
    const A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandWatchMs }));
    await A.start();
    started.push(A);

    const bKey = await generateKeyPair('Ed25519');
    const B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction', strandWatchMs }));
    await B.start();
    started.push(B);

    // B's dial is admitted by A's cold-start carve-out (no control rows exist yet, so the
    // membership gate has no basis to judge); the vouch that keeps B admitted once rows
    // exist lands right after genesis below.
    await connectControlNodes(B, A);
    for (const [node, label] of [[A, 'A'], [B, 'B']] as const) {
      await waitUntil(async () => (await readCohort(node.getControlNode()!, `pair ${label}`)).length >= 2, {
        timeoutMs: 30_000,
        intervalMs: 250,
        description: `pair node ${label} control cohort spans both machines`,
      });
    }

    const ownerPublicKey = await makeOwnOwner(A, aKey);
    await A.authorizePeer(B.peerId!.toString());

    const ownerPrivateKeyProtobuf = privateKeyToProtobuf(aKey);
    return {
      A,
      B,
      ownerPublicKey,
      ownerSign: (message) => signMessageEd25519(message, ownerPrivateKeyProtobuf),
    };
  } catch (error) {
    await stopStartedNodes(started);
    throw error;
  }
}

/** Stop nodes newest-first, reporting (never rethrowing) a stop that fails. */
async function stopStartedNodes(started: CadreNode[]): Promise<void> {
  for (const node of [...started].reverse()) {
    try {
      await node.stop();
    } catch (stopError) {
      console.error('[bootConnectedPair] cleanup of a partially booted node failed:', stopError);
    }
  }
}
