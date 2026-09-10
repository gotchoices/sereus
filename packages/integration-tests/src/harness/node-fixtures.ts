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
import { CadreNode, ed25519KeyPairFromLibp2p, signSchema, MemoryEnrolledMachineStore } from '@serfab/cadre-core';
import type { CadreNodeConfig, EnrolledMachineStore, RawStorageProvider, SAppConfig } from '@serfab/cadre-core';
import { slowMemoryStorageProvider } from './slow-raw-storage.js';
import { waitUntil } from './wait-utils.js';
import { readCohort } from './control-cohort.js';
import { signMessageEd25519 } from './test-network.js';

/**
 * WebSocket + circuit-relay transports every control node gets. Since the last private
 * config copies folded onto {@link controlNodeConfig} no scenario calls this directly —
 * it stays exported so a scenario building a non-control libp2p node by hand (and
 * `control-node-config.spec.ts`) can name the same pair rather than re-listing it.
 */
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
  /**
   * Run the circuit-relay server? Left unset this is NOT off — `CadreNode`
   * defaults it to `profile === 'storage'`, so a storage node relays unless a
   * scenario says otherwise. Pass `false` explicitly to get a storage node whose
   * gate refuses an unplaceable peer outright, instead of admitting it for relay
   * and dropping it at the not-reserving deadline.
   */
  enableRelay?: boolean;
  listenAddrs?: string[];
  /**
   * Relay servers to reserve a `/p2p-circuit` slot through — the FAIL-FAST route:
   * `relay-addrs.ts` gives the control node a bare `/p2p-circuit` search listener
   * and `CadreNode.start()` drives the reservation after control-DB bring-up,
   * throwing when the first attempt lands nothing. Pair with `listenAddrs: []` to
   * model a node with no inbound reachability of its own. The fail-soft
   * alternative is to leave this unset and call `node.reserveRelays(...)`.
   */
  relayAddrs?: string[];
  /**
   * Cap on concurrent relay reservations granted to peers this node cannot (yet)
   * recognize as members (`network.unauthorizedRelayReservationCap`) — lets a
   * scenario prove the budget bounds without booting `MAX_UNAUTHORIZED_RELAY_RESERVATIONS`+1 nodes.
   */
  unauthorizedRelayReservationCap?: number;
  hibernation?: boolean;
  /** Which strands this node participates in (default `'all'`). */
  strandFilter?: 'all' | 'none';
  /**
   * Sleep this long before EVERY raw-storage operation, which multiplies the
   * duration of control-database bring-up by a known factor (`slow-raw-storage.ts`).
   * For scenarios that need bring-up to still be running when something else fires.
   * Mutually exclusive with {@link storageProvider}.
   */
  storageOpDelayMs?: number;
  /**
   * Becomes `storage.provider` verbatim — for scenarios that must observe or keep
   * the node's raw stores, e.g. a `captureRawStorage()` capture (`block-store-probe.ts`)
   * or a store reused across a stop/restart cycle. Left unset the default
   * `() => new MemoryRawStorage()` stands. Mutually exclusive with
   * {@link storageOpDelayMs}: both answer "what storage does this node get", so
   * `controlNodeConfig` throws rather than silently picking one.
   */
  storageProvider?: RawStorageProvider;
  /** Override the proactive control-cohort reconcile cadence (ms). */
  reconcileMs?: number;
  /** Override the strand watcher poll cadence (ms; `CadreNode` default 5000). */
  strandWatchMs?: number;
  /**
   * Override the CLOSED-strand revoked-peer deny-set refresh cadence (ms;
   * `DEFAULT_REVOCATION_POLL_INTERVAL_MS`, 30 s). Two uses, opposite ends:
   * a SHORT value exercises the interval-driven cut without an explicit
   * `CadreNode.refreshRevocationEnforcement` call, and a value longer than the
   * test suspends the node's refresh entirely, so every cut it makes is one the
   * test drove on purpose (the deterministic route).
   */
  revocationPollMs?: number;
  /**
   * The CLOSED-strand membership reconciler (the bring-up loop that redeems a
   * staged invitation and writes each machine's own `MemberPeer` binding).
   *
   * `false` disarms it — for scenarios that hand-drive the membership writers and
   * assert exact row sets, where the automatic loop would race and shift their
   * counts. `{ pollIntervalMs }` keeps it armed on an explicit cadence, which is
   * how a scenario gets a FAST reconciler while {@link revocationPollMs} stays
   * suspended: left unset the reconciler mirrors the revocation cadence, so
   * suspending one would otherwise suspend both.
   */
  membershipReconciliation?: false | { pollIntervalMs: number };
  /** Owner keys pinned into the node-local trusted-owner anchor at start(). */
  pinnedOwnerKeys?: string[];
  /**
   * Node-local enrolled-machine record this node declares its block-repair
   * yardstick from at bring-up. Build one with {@link enrolledMachineStoreWith}.
   *
   * Left unset the node behaves as production does on a first launch: nothing
   * recorded, so `controlClusterPolicy` hands back the frozen base policy and the
   * node declares no yardstick. Set it to model a node that has run before — the
   * only way to get a control node to declare a number, since the count is read in
   * `start()` and the record is what carries it across a restart.
   */
  enrolledMachines?: EnrolledMachineStore;
  /**
   * Test-supplied libp2p connection gater. On the control node it is composed
   * under the built-in membership admission gate: a deny from EITHER side wins on
   * `denyInboundEncryptedConnection`, `denyDialPeer` and
   * `denyInboundRelayReservation`, and every other hook passes through untouched.
   * So a test's own deny hooks are always honored; the built-in gate only ever
   * ADDS denials (membership, and the bring-up quiet period).
   */
  connectionGater?: ConnectionGater;
}

/**
 * An in-memory {@link EnrolledMachineStore} already holding `count`, for
 * {@link ControlNodeOpts.enrolledMachines} — the stand-in for a node that recorded
 * that many machines on a previous run. `count` is the machine count, NOT the
 * yardstick: `controlClusterPolicy` clamps it to
 * `max(MIN_CLUSTER_SIZE, min(count, CONTROL_REPLICATION_BREADTH))`.
 */
export async function enrolledMachineStoreWith(partyId: string, count: number): Promise<EnrolledMachineStore> {
  const store = new MemoryEnrolledMachineStore(partyId);
  await store.record(count);
  return store;
}

/** Build a `CadreNodeConfig` for one control-network test node. */
export function controlNodeConfig(opts: ControlNodeOpts): CadreNodeConfig {
  if (opts.storageProvider !== undefined && opts.storageOpDelayMs !== undefined) {
    throw new Error('controlNodeConfig: storageProvider and storageOpDelayMs are mutually exclusive — both name the node\'s storage');
  }
  return {
    controlNetwork: { partyId: opts.partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
    profile: opts.profile ?? 'transaction',
    strandFilter: { mode: opts.strandFilter ?? 'all' },
    storage: {
      provider: opts.storageProvider
        ?? (opts.storageOpDelayMs === undefined
          ? () => new MemoryRawStorage()
          : slowMemoryStorageProvider(opts.storageOpDelayMs))
    },
    ...(opts.strandWatchMs !== undefined ? { strandWatchInterval: opts.strandWatchMs } : {}),
    ...(opts.revocationPollMs !== undefined
      ? { strandRevocationEnforcement: { pollIntervalMs: opts.revocationPollMs } } : {}),
    ...(opts.membershipReconciliation !== undefined
      ? {
        strandMembershipReconciliation: opts.membershipReconciliation === false
          ? { enabled: false }
          : { pollIntervalMs: opts.membershipReconciliation.pollIntervalMs }
      } : {}),
    ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
    ...(opts.enrolledMachines ? { enrolledMachines: { store: opts.enrolledMachines } } : {}),
    network: {
      transports: wsTransports(),
      listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
      ...(opts.relayAddrs ? { relayAddrs: opts.relayAddrs } : {}),
      // Forwarded on `!== undefined`, not on truthiness: `false` is a meaningful
      // value here (it overrides the storage-profile default), and a truthiness
      // test would silently drop it and leave the relay server on.
      ...(opts.enableRelay !== undefined ? { enableRelay: opts.enableRelay } : {}),
      ...(opts.unauthorizedRelayReservationCap !== undefined
        ? { unauthorizedRelayReservationCap: opts.unauthorizedRelayReservationCap } : {}),
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

/** The party id both pair fixtures build: prefix, tag, and a run-unique timestamp. */
function pairPartyId(tag: string, partyIdPrefix: string): string {
  return `${partyIdPrefix}-${tag}-${Date.now()}`;
}

/**
 * Where owner genesis lands relative to B's start — the one thing the two pair fixtures
 * disagree on, and the reason they exist as siblings.
 *
 * - `'genesis-before-b'`: A is made its own owner while it is still ALONE, so a scenario
 *   can prove write-while-alone convergence. {@link startPairNodes} performs the genesis
 *   and returns its public key.
 * - `'genesis-deferred'`: no genesis happens here at all. The caller connects the two
 *   nodes, waits for a two-machine control cohort, and only then calls
 *   {@link makeOwnOwner}, so every row — genesis included — is offered to a cohort that
 *   spans both machines and can be read back on B.
 */
export type PairGenesisOrdering = 'genesis-before-b' | 'genesis-deferred';

export interface StartedPairNodes {
  A: CadreNode;
  aKey: PrivateKey;
  B: CadreNode;
  bKey: PrivateKey;
  /** A's derived owner PUBLIC key — present only under `'genesis-before-b'`. */
  ownerPublicKey?: string;
}

/**
 * Build and start the A/B pair: A a relaying storage node (so it holds the CadrePeer
 * blocks), B a plain transaction node — deliberately NOT its own owner, so every row it
 * observes must have arrived over the wire.
 *
 * Pushes each node onto `opts.started` as it starts, so a caller that owns failure-path
 * teardown can hand in its own array and stop a half-built pair; pass nothing when the
 * caller owns shutdown itself.
 *
 * `opts.strandWatchMs` overrides the strand watcher poll cadence on BOTH nodes.
 */
export async function startPairNodes(
  partyId: string,
  ordering: PairGenesisOrdering,
  opts: { strandWatchMs?: number; started?: CadreNode[] } = {},
): Promise<StartedPairNodes> {
  const { strandWatchMs, started } = opts;

  const aKey = await generateKeyPair('Ed25519');
  const A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandWatchMs }));
  await A.start();
  started?.push(A);

  // Under 'genesis-before-b' this is the write-while-alone moment: A is its own owner
  // before B exists, so its owner-key row commits to a one-member cohort.
  const ownerPublicKey = ordering === 'genesis-before-b' ? await makeOwnOwner(A, aKey) : undefined;

  const bKey = await generateKeyPair('Ed25519');
  const B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction', strandWatchMs }));
  await B.start();
  started?.push(B);

  return { A, aKey, B, bKey, ...(ownerPublicKey !== undefined ? { ownerPublicKey } : {}) };
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
 *
 * Caller owns shutdown of a boot that RETURNS; a boot that THROWS hands back no node
 * handles, so it stops whatever it already started itself — same contract as
 * {@link bootConnectedPair}, and a leaked libp2p node outlives the run.
 */
export async function bootPair(
  tag: string,
  partyIdPrefix = 'ctrl',
  opts: { strandWatchMs?: number } = {},
): Promise<{ A: CadreNode; B: CadreNode }> {
  const started: CadreNode[] = [];

  try {
    const { A, B } = await startPairNodes(pairPartyId(tag, partyIdPrefix), 'genesis-before-b', {
      strandWatchMs: opts.strandWatchMs,
      started,
    });

    // A vouches B so B's inbound pull streams pass A's per-stream control-DB gate
    // (A's snapshot is non-empty once it has an anchor + any member row). B still
    // pins nobody — row presence (`isMember`) is what these scenarios assert, not
    // trust.
    await A.authorizePeer(B.peerId!.toString());

    return { A, B };
  } catch (error) {
    await stopStartedNodes(started);
    throw error;
  }
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
 * NOTE: the node construction the two fixtures once duplicated now lives in
 * {@link startPairNodes}, which takes the genesis ordering as a {@link PairGenesisOrdering}
 * argument — so the ordering difference is data, not two copies of the same eight lines.
 * Extracted under `harness-one-node-config-builder` once a third pair fixture came into
 * view; the earlier note here asked for exactly that on the third copy.
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
  const started: CadreNode[] = [];

  try {
    const { A, aKey, B } = await startPairNodes(pairPartyId(tag, partyIdPrefix), 'genesis-deferred', {
      strandWatchMs: opts.strandWatchMs,
      started,
    });

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
export async function stopStartedNodes(started: CadreNode[]): Promise<void> {
  for (const node of [...started].reverse()) {
    try {
      await node.stop();
    } catch (stopError) {
      console.error('[stopStartedNodes] cleanup of a partially booted node failed:', stopError);
    }
  }
}
