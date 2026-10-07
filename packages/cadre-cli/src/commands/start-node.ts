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
  type EnrolledMachineStore,
  type NodeClaimRecord,
  type SeedTrustPolicy,
  type StrandNetworkStateStore,
  type TrustedOwnerStore,
} from '@serfab/cadre-core';
import { createPushNotifier } from '@serfab/cadre-core/push-node';
import { FileTrustedOwnerStore } from '@serfab/cadre-core/trusted-owner-store-file';
import { FileBootstrapPeerStore } from '@serfab/cadre-core/bootstrap-peer-store-file';
import { FileEnrolledMachineStore } from '@serfab/cadre-core/enrolled-machine-store-file';
import { FileStrandNetworkStateStore } from '@serfab/cadre-core/strand-network-state-file';
import type { ResolvedConfig } from '../config/index.js';
import { resolveStorageConfig } from './node-session.js';
import { writeClaimRecord, type ClaimRecord } from './claim-record.js';

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

/** The `CadreNodeConfig` for `partyId` over `stores`: everything in the resolved config, plus `trust`. */
function buildNodeConfig(config: ResolvedConfig, partyId: string, stores: NodeStores, trust: ColdStartTrust): CadreNodeConfig {
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
    storage: resolveStorageConfig(config.storage),
    network: config.network,
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
 *
 * NOTE: without `claim`, cadre-core's `publishSelfRecordOnceClaimed` does not run either, so a
 * claimed node restarted with the secret unset republishes its address record on the heartbeat
 * only (about 7.5 min), not on its first reconcile pass. Its owner retained its addresses and
 * dials in regardless. cadre-host keeps the secret set on respawn; if an embedder that drops it
 * ever needs the prompt publish, key that method on the anchor's `claim` source, not the config.
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
 * NOTE: the claim seed's peers were merged into the placeholder party's stores, so the restarted
 * node holds no dial target for its owner; it waits for the owner to dial in, which the owner's
 * `claimNode` retained the node's addresses for. If a claimed node ever needs to dial first (an
 * owner reachable only through a relay the node must initiate to), re-apply the claim seed
 * after the restart; `seed:applied` does not carry it today.
 */
export async function buildClaimedNode(config: ResolvedConfig, claim: NodeClaimRecord, claimConfig: CadreNodeConfig['claim']): Promise<CadreNode> {
  const stores = await openNodeStores(config.nodeStateDir, claim.partyId);
  await stores.trustedOwnerStore.trust(claim.ownerKey, 'claim');
  const node = new CadreNode(buildNodeConfig(config, claim.partyId, stores, {
    trustedOwners: { store: stores.trustedOwnerStore },
    claim: claimConfig,
  }));
  wireNodeEvents(node);
  return node;
}

/**
 * The node for the configured party: operator pins (source `operator`) and the pinned-key seed
 * policy when there are any, or, with `claimConfig`, a node waiting to be claimed under the
 * config's placeholder party.
 */
export async function buildConfiguredNode(
  config: ResolvedConfig,
  pinnedKeys: string[],
  seedTrustPolicy: SeedTrustPolicy | undefined,
  claimConfig: CadreNodeConfig['claim'],
): Promise<CadreNode> {
  const partyId = config.controlNetwork.partyId;
  const stores = await openNodeStores(config.nodeStateDir, partyId);
  const node = new CadreNode(buildNodeConfig(config, partyId, stores, {
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
 * Run `onSettled` once the seed that carried the claim has been handled end to end.
 * `claim:accepted` fires inside the node's trust decision, BEFORE the seed is acknowledged to
 * the claimant, its peers merged and its owners dialed; stopping the node there would drop
 * the acknowledgement, and the claimant would read its own claim as failed. That seed's
 * `seed:applied` — or `seed:error`, when its work after the acknowledgement failed — is the
 * first event after all of it. A seed for another party is some other claimant's, refused
 * `already-claimed` while this one was in flight, and is not waited for.
 *
 * NOTE: a second claimant of the SAME party whose refusal lands in that window settles this
 * early, and the restart may stop the node before the claim is acknowledged. The claimant then
 * retries and is accepted idempotently by the restarted node, whose anchor holds it. If that is
 * ever seen, carry the seed's digest on the two events and key the settle on it.
 */
export function afterClaimSeedSettles(node: CadreNode, claimedPartyId: string, onSettled: () => void): void {
  // The node's own party as well: a failure after the trust decision is reported under it.
  const ownParties = new Set([claimedPartyId, node.partyId]);
  const settle = ({ partyId }: { partyId: string }): void => {
    if (!ownParties.has(partyId)) return;
    node.off('seed:applied', settle);
    node.off('seed:error', settle);
    onSettled();
  };
  node.on('seed:applied', settle);
  node.on('seed:error', settle);
}

