/**
 * The node `cadre start` runs: its file-backed stores, its `CadreNodeConfig`, the two ways it is
 * built (from the claim on record, or from the config), its console event lines, and the hook
 * that tells the start command when a freshly accepted claim can be restarted into.
 *
 * `start.ts` owns the command, its options and conflict checks, the servers and the restart
 * itself; this module owns how a node is built, so the first start and the in-process restart
 * into the claimed party build one the same way.
 */
import debug from 'debug';
import {
  CadreNode,
  type BootstrapPeerStore,
  type CadreNodeConfig,
  type CadreRemoval,
  type EnrolledMachineStore,
  type NodeClaimRecord,
  type SeedDialTarget,
  type SeedTrustPolicy,
  type StrandNetworkStateStore,
  type TrustedOwnerStore,
} from '@serfab/cadre-core';
import { createPushNotifier } from '@serfab/cadre-core/push-node';
import { nodeDefaultTransports } from '@serfab/cadre-core/node-default-transports';
import { FileTrustedOwnerStore } from '@serfab/cadre-core/trusted-owner-store-file';
import { FileBootstrapPeerStore } from '@serfab/cadre-core/bootstrap-peer-store-file';
import { FileEnrolledMachineStore } from '@serfab/cadre-core/enrolled-machine-store-file';
import { FileStrandNetworkStateStore } from '@serfab/cadre-core/strand-network-state-file';
import type { ResolvedConfig } from '../config/index.js';
import type { NodeStorage } from './node-session.js';
import { writeClaimRecord, type ClaimRecord } from './claim-record.js';
import { removalMarkerPath, writeRemovalMarker } from './removal-marker.js';

const log = debug('cadre:cli:start');

/** The node-local file stores a node keeps under one party in its state directory. */
interface NodeStores {
  trustedOwnerStore: TrustedOwnerStore;
  bootstrapPeerStore: BootstrapPeerStore;
  enrolledMachineStore: EnrolledMachineStore;
  strandNetworkStateStore: StrandNetworkStateStore;
}

/**
 * Open the four node-local stores for `partyId` in `nodeStateDir`, each file-backed so what it
 * holds survives a restart: the trusted-owner anchor (so anchored trust is not re-supplied),
 * the cold-start dial targets (a seed pushed at RUNTIME — the seed protocol, or cadre-host's
 * donation flow posting to `/seed` — gets no `--seed` argument on the next start, so its
 * addresses have to come off disk), the enrolled-machine count (the control node's block-repair
 * yardstick is declared at bring-up, before the database holding the membership rows exists;
 * an absent or unreadable file is a cold start, never a failed launch), and each strand node's
 * saved network state (the FRET routing table it re-imports, so a cross-party strand re-meshes
 * without a fresh invitation; dial hints only, verified at import).
 *
 * All four are keyed on the party, which is why a claimed node opens them under the party on
 * record and not the config's placeholder (`claim-record.ts`).
 */
async function openNodeStores(nodeStateDir: string, partyId: string): Promise<NodeStores> {
  return {
    trustedOwnerStore: await FileTrustedOwnerStore.open(nodeStateDir, partyId),
    bootstrapPeerStore: await FileBootstrapPeerStore.open(nodeStateDir, partyId),
    enrolledMachineStore: await FileEnrolledMachineStore.open(nodeStateDir, partyId),
    strandNetworkStateStore: await FileStrandNetworkStateStore.open(nodeStateDir, partyId),
  };
}

/** The cold-start trust a node is built with, chosen by the start path (`buildNodeConfig`). */
type ColdStartTrust = Pick<CadreNodeConfig, 'trustedOwners' | 'seedTrustPolicy' | 'claim'>;

/**
 * The `CadreNodeConfig` for `partyId` over `stores` and `storage`: everything in the resolved
 * config, plus `trust`.
 */
function buildNodeConfig(
  config: ResolvedConfig,
  partyId: string,
  stores: NodeStores,
  storage: NodeStorage,
  trust: ColdStartTrust,
): CadreNodeConfig {
  return {
    privateKey: config.privateKey,
    ...trust,
    bootstrapPeers: { store: stores.bootstrapPeerStore },
    enrolledMachines: { store: stores.enrolledMachineStore },
    strandNetworkState: { store: stores.strandNetworkStateStore },
    controlNetwork: { ...config.controlNetwork, partyId },
    profile: config.profile,
    // NOTE: `hostUnclaimedStrands` is left to cadre-core's default, so a storage-profile
    // CLI node (every cadre-host donated node included) hosts a replica of every strand its
    // party publishes; the only opt-out here is `strandFilter`. If an operator needs
    // announce-only on an always-on node, surface the field in the CLI config.
    strandFilter: config.strandFilter,
    strandReactivity: config.strandReactivity,
    storage: storage.config,
    // `defaultTransports` from the Node-only subpath: a node with `relayAddrs` is built from an
    // explicit transport list (libp2p's relay discovery off), and this keeps that list the one
    // db-p2p would build. See `NetworkConfig.defaultTransports`.
    network: { ...config.network, defaultTransports: nodeDefaultTransports },
    hibernation: config.hibernation,
    strandWatchInterval: config.strandWatchInterval,
    // Platform push credentials provisioned by the orchestrator (cadre-host
    // writes the `push` block into cadre.json; cadre-provider injects it via
    // CADRE_PUSH). This CLI is the Node host, so it constructs the
    // `PushNotifier` from the Node-only `@serfab/cadre-core/push-node`
    // subpath (keeping node:crypto/node:http2 out of the cross-platform core
    // graph) and injects the instance; CadreNode owns its lifecycle.
    push: config.push
      ? {
          notifier: createPushNotifier(config.push),
          cooldownMs: config.push.cooldownMs,
          debounceMs: config.push.debounceMs,
        }
      : undefined,
  };
}

/**
 * The `claim` block a node gets when `CADRE_CLAIM_SECRET` is set: the secret, and a `record`
 * that writes `claim.json` and reports what it wrote. Undefined without the secret — a claimed
 * node started without it is still honoured from its record, just with no claim policy, so a
 * rival's seed is refused as an untrusted seed rather than `already-claimed`.
 */
export function claimConfigFor(
  secret: string | undefined,
  nodeStateDir: string,
  onRecorded: (record: ClaimRecord) => void,
): CadreNodeConfig['claim'] {
  if (secret === undefined) return undefined;
  return {
    secret,
    record: async (claim) => onRecorded(await writeClaimRecord(nodeStateDir, claim)),
  };
}

/**
 * The node for a claim — this process's start from `claim.json`, or its restart after the claim
 * was accepted: stores under the claim's party, the claim's owner anchored under source `claim`
 * (idempotent; the restart's stores are fresh and hold nothing yet), no operator pins (refused
 * beside `claim` by cadre-core, and refused here by `refuseClaimConflicts` either way), and
 * `claim` only when the secret is still set.
 *
 * The files the placeholder party created while the node waited (`trusted-owners.unclaimed.json`
 * and the like) are left where they are; nothing opens them again.
 *
 * `dialTargets` are the claim seed's preferred peers (`seed:applied`), which the placeholder node
 * retained in the placeholder party's store; the restart carries them into the claimed party's,
 * so the restarted node dials its owner from its first reconcile pass (cadre-core's cold-start
 * dial, which runs while the control database has no siblings). The start from `claim.json`
 * passes none: the restart already wrote them to the claimed party's store.
 */
export async function buildClaimedNode(
  config: ResolvedConfig,
  storage: NodeStorage,
  claim: NodeClaimRecord,
  claimConfig: CadreNodeConfig['claim'],
  dialTargets: readonly SeedDialTarget[] = [],
): Promise<CadreNode> {
  const stores = await openNodeStores(config.nodeStateDir, claim.partyId);
  await stores.trustedOwnerStore.trust(claim.ownerKey, 'claim');
  retainDialTargets(stores.bootstrapPeerStore, dialTargets);
  const node = new CadreNode(buildNodeConfig(config, claim.partyId, stores, storage, {
    trustedOwners: { store: stores.trustedOwnerStore },
    claim: claimConfig,
  }));
  wireNodeEvents(node);
  return node;
}

/**
 * Record each of `targets` in `store`. `record` reflects an entry at once and its promise tracks
 * durability only, so a failed persist is logged, not fatal: the node about to be built still
 * dials the target, and only a later start from `claim.json` goes without it — the same choice
 * cadre-core's `CadreNode.retainDialTarget` makes.
 */
function retainDialTargets(store: BootstrapPeerStore, targets: readonly SeedDialTarget[]): void {
  for (const { peerId, multiaddrs } of targets) {
    void store.record(peerId, multiaddrs).catch((err: unknown) => {
      log('Persisting dial target %s for the claimed party failed (retained in memory): %o', peerId, err);
    });
  }
}

/**
 * The node for the configured party: operator pins (source `operator`) and the pinned-key seed
 * policy when there are any, or, with `claimConfig`, a node waiting to be claimed under the
 * config's placeholder party.
 */
export async function buildConfiguredNode(
  config: ResolvedConfig,
  storage: NodeStorage,
  pinnedKeys: string[],
  seedTrustPolicy: SeedTrustPolicy | undefined,
  claimConfig: CadreNodeConfig['claim'],
): Promise<CadreNode> {
  const partyId = config.controlNetwork.partyId;
  const stores = await openNodeStores(config.nodeStateDir, partyId);
  const node = new CadreNode(buildNodeConfig(config, partyId, stores, storage, {
    trustedOwners: { store: stores.trustedOwnerStore, pinnedKeys, pinnedSource: 'operator' },
    seedTrustPolicy,
    claim: claimConfig,
  }));
  wireNodeEvents(node);
  return node;
}

/** The console lines a node prints for its lifecycle, strand and seed events. */
function wireNodeEvents(node: CadreNode): void {
  node.on('control:connected', () => {
    console.log('✓ Connected to control network');
    console.log(`  Party ID: ${node.partyId}`);
    console.log(`  Peer ID:  ${node.peerId?.toString()}`);
  });

  node.on('control:disconnected', () => {
    console.log('✗ Disconnected from control network');
  });

  node.on('claim:accepted', ({ ownerKey, partyId }) => {
    console.log(`✓ Claimed by owner ${ownerKey.slice(0, 8)} into party ${partyId}`);
  });

  // A control write the retry funnel gave up on. This is a long-running headless
  // process, so it is the operator's only view of it: the node itself only escalates
  // the one case whose consequence it can measure (its own address record going
  // stale), and the funnel's own trace is a `debug` line nothing enables by default.
  // A BACKGROUND write — the self-address republish, the replication drains — has no
  // caller to reject to either, so without this line it is lost in silence.
  node.on('control:write-abandoned', ({ label, reason, attemptsMade, attemptsAllowed, error }) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`⚠ Control write abandoned [${label ?? 'unlabelled'}] `
      + `after ${attemptsMade}/${attemptsAllowed} attempt(s) (${reason}): ${detail}`);
  });

  node.on('strand:started', ({ strandId }) => {
    console.log(`✓ Strand started: ${strandId}`);
  });

  node.on('strand:stopped', ({ strandId }) => {
    console.log(`• Strand stopped: ${strandId}`);
  });

  node.on('strand:error', ({ strandId, error }) => {
    console.error(`✗ Strand error (${strandId}): ${error.message}`);
  });

  node.on('strand:idle', ({ strandId }) => {
    log('Strand idle: %s', strandId);
  });

  node.on('strand:hibernating', ({ strandId }) => {
    log('Strand hibernating: %s', strandId);
  });

  node.on('seed:received', ({ partyId, peerId }) => {
    console.log(`✓ Seed received from ${peerId} for party ${partyId}`);
  });

  node.on('seed:applied', ({ partyId, peersAdded }) => {
    console.log(`✓ Seed applied: ${peersAdded} peers added for party ${partyId}`);
  });

  node.on('seed:error', ({ partyId, error }) => {
    console.error(`✗ Seed error (${partyId}): ${error}`);
  });
}

/**
 * Stop `node` for good once an owner removes it from its cadre: write the removal marker
 * (`removal-marker.ts`), report the removal through `onRemoved`, warn, and stop the node. The
 * process and its servers stay up: `/status` goes on reporting the removal, and a supervisor
 * that read an exit as a crash would respawn the node. Checks `removedFromCadre()` as well as
 * subscribing, so a removal detected before this call is acted on too; acts once.
 */
export function stopWhenRemoved(node: CadreNode, nodeStateDir: string, onRemoved: (removal: CadreRemoval) => void): void {
  let acted = false;
  const act = (removal: CadreRemoval): void => {
    if (acted) return;
    acted = true;
    node.off('cadre:removed', act);
    recordRemoval(nodeStateDir, removal);
    onRemoved(removal);
    warnRemoved(removal, nodeStateDir);
    node.stop().then(
      () => { console.log('• Removed node stopped'); },
      (err: unknown) => { console.error('✗ Failed to stop the removed node:', err instanceof Error ? err.message : err); },
    );
  };
  node.on('cadre:removed', act);
  const removal = node.removedFromCadre();
  if (removal) act(removal);
}

/**
 * Write the marker, or say it could not be written: the node is stopped either way, but without
 * the marker the next start runs it against a cadre that refuses it.
 */
function recordRemoval(nodeStateDir: string, removal: CadreRemoval): void {
  try {
    const path = writeRemovalMarker(nodeStateDir, removal);
    log('Wrote removal marker %s', path);
  } catch (err) {
    console.error(`✗ Failed to record the removal in ${removalMarkerPath(nodeStateDir, removal.partyId)}; the next start will run the node again:`,
      err instanceof Error ? err.message : err);
  }
}

/** The one line a removed node prints, when it learns of the removal and on every later start. */
export function warnRemoved(removal: CadreRemoval, nodeStateDir: string): void {
  const by = removal.signerKey ? `owner ${removal.signerKey.slice(0, 8)}` : 'an owner';
  console.warn(`⚠ This node was removed from cadre ${removal.partyId} by ${by} and has stopped. It stays stopped for that cadre `
    + `while ${removalMarkerPath(nodeStateDir, removal.partyId)} exists. To use this machine again, delete the node-state directory `
    + `(${nodeStateDir}) to start fresh, or delete only that file once an owner has added the machine back.`);
}

/**
 * Run `onSettled` once the seed that carried the claim has been acknowledged to the claimant.
 * `claim:accepted` fires inside the node's trust decision, BEFORE the seed is acknowledged and
 * its peers merged; stopping the node there would drop the acknowledgement, and the claimant
 * would read its own claim as failed. That seed's `seed:applied` — or `seed:error`, when its
 * work after the acknowledgement failed — is the first event after both, and comes before the
 * node dials the seed's preferred peers, which a restart makes pointless. `onSettled` gets
 * the seed's dial targets from `seed:applied`, and none from `seed:error`. A seed for another
 * party is some other claimant's, refused `already-claimed` while this one was in flight, and
 * is not waited for.
 *
 * NOTE: a second claimant of the SAME party whose refusal lands in that window settles this
 * early, and the restart may stop the node before the claim is acknowledged. The claimant then
 * retries and is accepted idempotently by the restarted node, whose anchor holds it. If that is
 * ever seen, carry the seed's digest on the two events and key the settle on it.
 */
export function afterClaimSeedSettles(
  node: CadreNode,
  claimedPartyId: string,
  onSettled: (dialTargets: SeedDialTarget[]) => void,
): void {
  // The node's own party as well: a failure after the trust decision is reported under it.
  const ownParties = new Set([claimedPartyId, node.partyId]);
  const settle = ({ partyId, dialTargets }: { partyId: string; dialTargets?: SeedDialTarget[] }): void => {
    if (!ownParties.has(partyId)) return;
    node.off('seed:applied', settle);
    node.off('seed:error', settle);
    onSettled(dialTargets ?? []);
  };
  node.on('seed:applied', settle);
  node.on('seed:error', settle);
}

