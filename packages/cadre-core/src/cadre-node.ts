import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { createLibp2pNode, type IRawStorage } from '@optimystic/db-p2p';
import { wrapStorageWithCache, disposeStorageCache } from '@serfab/quereus-plugin-sereus';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
import type {
  CadreNodeConfig,
  StrandInstance,
  StrandRow,
  StrandConfig,
  FoundStrandConfig,
  FoundStrandResult,
  SAppConfig,
  CadreNodeEvents,
  ControlNetworkSeed,
  ApplySeedResult,
  AddDroneOptions,
  DroneInitResult,
  OpenInvitation,
  FormStrandResult,
  StrandFormationDisclosure,
  StrandMembershipInvite,
  ResolveOpts,
  SelfRegistrationOutcome,
  ServiceWakeResult,
  Libp2pNodeWithRepo,
  PushPlatform,
  DeviceTokenRecord,
  CadrePeerVoucherFields,
  CadrePeerRow,
  CadreInviteRow,
  CadreInviteUsageRow,
  CadreInviteStatus,
  CreateCadreInvitationOptions,
  CreateCadreInvitationResult,
  RedeemCadreInvitationResult,
  PeerAddressRecord,
  ResolveDeviceTokenOpts,
  PendingJoin,
  PendingJoinStatus
} from './types.js';
import { controlClusterPolicy, CONTROL_REPLICATION_BREADTH, DEFAULT_CHECKIN_WINDOW_MS, DEFAULT_CONNECTION_MONITOR } from './types.js';
import { generatePrivateKey, sign } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate, requireEd25519PublicKeyB64, type Ed25519KeyPair } from './ed25519-key.js';
import { strandTransportKey } from './strand-transport-key.js';
import {
  assertScopeKeyCharset,
  assertStrandScopeKey,
  controlStorageScope,
  InvalidStrandIdError,
  isValidStrandScopeKey
} from './storage-scope.js';
import { generateStrandMemberKey, strandMemberKeyPair } from './strand-member-key.js';
import { assertNotPreSplitStrand, issueInvite, PreSplitStrandIdentityError, readStrandHeaderSAppId } from './strand-membership-writer.js';
import { MEMBERSHIP_INVITE_TTL_MS } from './strand-formation-manager.js';
import { DEFAULT_IDENTITY_KEY_ID } from './key-store.js';
import { loadOrCreateIdentityKey } from './identity-key.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore, type TrustSource } from './trusted-owner-store.js';
import { MemoryBootstrapPeerStore, type BootstrapPeerStore } from './bootstrap-peer-store.js';
import { MemoryStrandNetworkStateStore, type StrandNetworkStateStore } from './strand-network-state.js';
import { MemoryEnrolledMachineStore, type EnrolledMachineStore } from './enrolled-machine-store.js';
import {
  JoinedStrandSession,
  KeyStoreJoinedStrandStore,
  MemoryJoinedStrandStore,
  type JoinedStrandStore,
  type PartyJoinedStrandLedger
} from './joined-strand-store.js';
import { mergePeerAddrs, groupAddrsByPeerId, type MergeAddrsResult } from './peer-addr-book.js';
import { strandFretPeerAddrs } from './strand-fret-addrs.js';
import { verifyCadrePeerVoucher, verifyInvitationAdmission } from './peer-authorization.js';
import { ed25519PublicKeyB64FromPeerId } from './ed25519-key.js';
import {
  signPeerRecord,
  verifyPeerRecordSignature,
  isPeerRecordFresh,
  orderSignalingFirst,
  isSignalingAddr,
  trailingPeerId,
  withTrailingPeerId,
  currentMemberTrustPolicy,
  DEFAULT_PEER_RECORD_MAX_AGE_MS,
  DEFAULT_PEER_RECORD_HEARTBEAT_MS
} from './peer-record.js';
import {
  signDeviceTokenRecord,
  verifyDeviceTokenSignature,
  isPushPlatform
} from './device-token.js';
import { StrandWatcher, type StrandQueryable, type SAppIdLookup } from './strand-watcher.js';
import { StrandInstanceManager, liveStrandStatus } from './strand-instance-manager.js';
import { PeerJoinBackfill } from './peer-join-backfill.js';
import { deriveCohortMembers } from './strand-cohort.js';
import type { CohortPeerRow } from './strand-cohort.js';
import {
  selectControlCohortDials,
  DEFAULT_CONTROL_COHORT_RECONCILE_MS,
  DEFAULT_CONTROL_COHORT_TARGET_DEGREE,
  type ControlCohortReconcileResult
} from './control-cohort.js';
import {
  dialPeerAddrs,
  SelfRelayOnlyError,
  CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS,
  type PeerDialBudget
} from './peer-dial.js';
import { ADMISSION_DECISION_TIMEOUT_MS, declaredCohortReadDeadlineMs, optimysticDialLimits, peerJoinPushBudget, relayAdmissionReserveDeadlineMs, relayReservationBudgetMs, relayedDialBudgetMs, resolveLinkRoundTripMs } from './link-budget.js';
import { EnrollmentService } from './enrollment.js';
import { HibernationManager, type HibernationCallbacks } from './hibernation-manager.js';
import { ControlDatabase, generateStampId, isPendingJoinConflict, isStrandIdConflict, pendingJoinId, type JoinRequestFields, type RevokedRowRef } from './control-database.js';
import {
  CadreInviteHandler,
  encodeCadreInvitation,
  redeemAtMembers,
  signRedeemRequest,
  type CadreInvitation
} from './cadre-invite-protocol.js';
import { FormationPostApprovalError } from './strand-formation-rejection.js';
import {
  PendingJoinRunner,
  membershipInvitesToStage,
  parseStoredDisclosure,
  requestedPendingJoin
} from './pending-join-runner.js';
import type { ControlRetryAbandonment } from './control-retry.js';
import { SeedBootstrapService, mergeSeedPeers, type SeedEventCallbacks, type SeedBootstrapConfig } from './seed-bootstrap.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import {
  StrandSolicitationService,
  type StrandSolicitationServiceOptions
} from './strand-solicitation.js';
import { ControlFormationUsageRecorder } from './control-formation-recorder.js';
import { selectInvitationSiblingAddrs, type InvitationSibling } from './invitation-bootstrap.js';
import {
  createMembershipConnectionGater,
  UnauthorizedReservationBudget,
  type InboundConnectionVerdict
} from './membership-connection-gater.js';
import { StrandWakeService, dialWake } from './strand-wake-protocol.js';
import { StrandAddrService, collectStrandAddrs, type StrandAddrPeer, type StrandAddrOutcome, type StrandAddrCollection } from './strand-addr-protocol.js';
import {
  DelegateAdmissionStore,
  extractCircuitRelayTargets,
  dueRelayAnnounces,
  prunePeerStrandKeys,
  peerStrandKey,
  type CircuitRelayTarget
} from './delegate-admission.js';
import { relayCircuitAddrs, resolveListenAddrs, resolveTransportOptions, RelayReservationFailedError } from './relay-addrs.js';
import { resolveRelayServer, type ResolvedRelayServer } from './relay-server.js';
import { replacesAdvertisedAddrs, resolveAnnounceAddrs } from './announce-addrs.js';
import {
  superviseRelayReservation,
  resolveRelayReservationState,
  type RelayReservationState,
  type RelayReservationSupervisor,
  type RelayReservationSupervisorOptions
} from './relay-reservation.js';
import { PushFanoutService } from './push-fanout.js';
import type { WakeAck, WakeRequest } from './types.js';
import {
  summarizeConnectionPaths,
  type ConnectionPathSummary
} from './diagnostics/connection-path.js';
import { timedStep } from './timed-step.js';

const log = debug('sereus:cadre:node');
const timing = debug('sereus:cadre:timing');

/**
 * How often a running strand re-asks each connected sibling that last ANSWERED
 * (even with nothing) for its strand-network addresses, and re-merges them into
 * its own libp2p address book ({@link CadreNode.refreshStrandPeerAddrs}).
 * Overridable per node via `network.controlCohort.strandAddrRefreshMs`.
 *
 * Ten minutes sits comfortably inside the peerStore's one-hour address expiry
 * (`MAX_ADDRESS_AGE`, see `peer-addr-book.ts`) with headroom for several missed
 * passes, and far above the 15 s reconcile cadence the refresh rides on, so the
 * strand-addr RPC fan-out stays cheap.
 */
export const STRAND_PEER_ADDR_REFRESH_MS = 10 * 60 * 1000;

/**
 * How soon {@link CadreNode.refreshStrandPeerAddrs} re-asks a sibling that did NOT
 * answer — unreachable, `unavailable`, or `refused`. A refusal matters most: a
 * phone asking before its `CadrePeer` row has replicated to the sibling is refused
 * and its delegate grant goes unrecorded, and waiting the full
 * {@link STRAND_PEER_ADDR_REFRESH_MS} for the next try is the delay this bounds.
 * Four reconcile ticks, so a sibling that keeps failing costs one timed-out RPC a
 * minute rather than one a tick.
 */
export const STRAND_PEER_ADDR_RETRY_MS = 60 * 1000;

/**
 * Default lifetime of an UNTARGETED, OWNER-GRANTING cadre invitation
 * ({@link CadreNode.createCadreInvitation}): whoever holds the bundle becomes an owner, so
 * it is a bearer credential for admin rights and lives only long enough to be pasted or
 * scanned by the device it was minted for.
 */
export const OWNER_INVITATION_DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Default lifetime of every other cadre invitation: targeted, or granting membership only. */
export const CADRE_INVITATION_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type EventHandler<T> = (data: T) => void;

/**
 * A circuit relay as a strand-addr RPC target: dialed by peerId, with its
 * direct addr riding along as the fallback for a relay we hold no connection to.
 */
function relayStrandAddrPeer(relay: CircuitRelayTarget): StrandAddrPeer {
  return { peerId: relay.relayPeerId, addrs: [multiaddr(relay.relayAddr)] };
}

/**
 * Whether a sibling actually answered a strand-addr RPC — with addresses or
 * without — as opposed to being unreachable, unavailable, or refusing us. Decides
 * which of the refresh and retry intervals it waits before the next ask.
 */
function siblingAnswered(outcome: StrandAddrOutcome): boolean {
  return outcome === 'answered' || outcome === 'empty';
}

/**
 * `primary` followed by the entries of `extra` it does not already contain, de-duplicated
 * and order-preserving.
 *
 * Used where a strand's discovery seed unions two sources of address strings — the
 * freshly-RPC'd sibling answers and the addresses the strand's formation carried. The
 * caller passes the FRESHER source as `primary`, so a stale entry can only ever be
 * appended, never promoted ahead of a current one, and each source keeps whatever
 * signaling-first ordering it arrived with.
 */
function unionAddrs(primary: readonly string[], extra: readonly string[]): string[] {
  if (extra.length === 0) {
    return [...primary];
  }
  const out = [...primary];
  const seen = new Set(primary);
  for (const addr of extra) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/**
 * Build the signing callback the `ControlDatabase` writers expect: they hand it the
 * canonical row-bound message BYTES (see `buildAuthorizationMessage`), and it ed25519-signs
 * them directly (no pre-hash) with the owner private key, returning a base64url signature.
 */
/**
 * The usage and invitation rows an invitation-admitted `CadrePeer` row is verified through
 * (`CadreNode.hasAnchoredProof`), keyed by `UsageStampId` and `CadreInvite.Key`.
 */
interface InvitationChain {
  usages: Map<string, CadreInviteUsageRow>;
  invites: Map<string, CadreInviteRow>;
}

/** Whether a `CadrePeer` row's proof is an invitation admission rather than an owner voucher (`types.ts` → `CadrePeerRow`). */
function isInvitationAdmitted(row: CadrePeerVoucherFields): boolean {
  return row.vouchSig === null && row.vouchUsage !== null;
}

function signMessageWith(privateKeyB64: string): (message: Uint8Array) => string {
  return (message: Uint8Array): string =>
    sign(message, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/**
 * Reject a blank identifier before it reaches the control database, where it would fail an
 * authorization CHECK as an opaque constraint error rather than an actionable message.
 * Returns the trimmed value so callers write the same bytes they validated.
 */
function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`A ${label} is required (received an empty or whitespace-only value)`);
  }
  return trimmed;
}

/**
 * Is the live `Strand` row the one a publish of `desired` would have produced?
 *
 * "Identical content" means `(Type, MemberPrivateKey)` and deliberately NOT
 * `FounderOwnerKey`: that column is provenance (WHICH machine published the row), not
 * content. Two machines of one party racing to found the same id must keep resolving as
 * "the winner's row stands" — the loser adopts the row and, since the winner's key is on
 * it, correctly comes up as a joiner (see `launchStrand`'s founder derivation). Comparing
 * it here would turn that benign race into a hard throw. `Id` is the lookup key and
 * `StampId` is a single-use nonce, so the two compared columns are all the content there
 * is. A live row matching on both is, by construction, the state a repeat publish would
 * have reached, whichever branch of `Strand.AuthorizedInsert` seated it (owner-signed, or
 * the unsigned consent branch an invite redemption uses).
 *
 * Returns the mismatching column names, empty when the row matches. The KEY's value is
 * deliberately never returned or logged — it is the closed strand's read-gating secret.
 */
function strandRowMismatches(live: StrandRow, desired: StrandRow): string[] {
  const mismatches: string[] = [];
  if (live.Type !== desired.Type) {
    mismatches.push(`Type is '${live.Type}', not the requested '${desired.Type}'`);
  }
  if ((live.MemberPrivateKey ?? null) !== (desired.MemberPrivateKey ?? null)) {
    mismatches.push('MemberPrivateKey differs from the one supplied');
  }
  return mismatches;
}

/**
 * The live row when it matches `desired` ({@link strandRowMismatches}); otherwise throw
 * naming the columns that differ.
 *
 * A mismatch must stay a hard error: accepting one would let a retry reopen a strand the
 * party closed, or swap the key that gates its reads — so the two cases the raw
 * `UNIQUE constraint failed: Strand.Id` could not distinguish ("already done, carry on"
 * vs. "genuine conflict, stop") are separated here rather than left to the caller.
 *
 * @param situation - How the row came to be there, as a verb phrase completing
 *   `Strand <id> …`, e.g. `'is already published'`.
 */
function requireMatchingStrandRow(live: StrandRow, desired: StrandRow, situation: string): StrandRow {
  const mismatches = strandRowMismatches(live, desired);
  if (mismatches.length > 0) {
    throw new Error(
      `Strand ${desired.Id} ${situation} with DIFFERENT content, so this publish is a ` +
      `conflict, not a repeat: ${mismatches.join('; ')}. Reconcile deliberately — attach ` +
      'the existing strand with addStrand/foundStrand to keep it, or unpublishStrand first ' +
      'to re-seat it (destructive for a closed strand: its MemberPrivateKey is stored ' +
      'nowhere else).'
    );
  }
  return live;
}

/**
 * Await `work` unless `signal` aborts first: `true` once `work` resolves, `false` when the
 * signal aborted before it did (already at the call, or during the wait). A rejection of
 * `work` that lands before the abort propagates. `work` is NOT cancelled — a caller that
 * gets `false` owns its late settlement. The abort listener is detached on both endings, so
 * a long-lived signal does not collect listeners.
 */
async function resolvesBeforeAbort(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<boolean> {
  if (!signal) {
    await work;
    return true;
  }
  if (signal.aborted) {
    return false;
  }
  let detach = (): void => { /* replaced once the listener is attached */ };
  const abortedFirst = new Promise<false>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([work.then(() => true), abortedFirst]);
  } finally {
    detach();
  }
}

/**
 * CadreNode is the main entry point for a cadre member.
 * It manages:
 * - Connection to the control network
 * - Watching for strand changes
 * - Starting/stopping strand instances
 * - Strand hibernation lifecycle
 * - Peer enrollment
 */
export class CadreNode implements SAppIdLookup {
  private readonly config: CadreNodeConfig;
  /**
   * The resolved node identity key, set once by {@link resolveIdentityKey}
   * during {@link start} (from `config.keyStore`, else `config.privateKey`).
   * Left undefined when neither is configured — libp2p then generates an
   * ephemeral key internally and there is no exposed owner key. Every
   * identity-dependent path (control node creation, self-record signing, strand
   * launch) reads this resolved field, never `config.privateKey` directly.
   */
  private identityKey: PrivateKey | undefined;
  /**
   * Node-local, NON-replicated trusted-owner anchor (see
   * `trusted-owner-store.ts`). Constructed (or adopted from
   * `config.trustedOwners.store`) by {@link initializeTrustedOwnerStore} during
   * {@link start}; deliberately NOT cleared by {@link cleanup}, so an in-memory
   * anchor survives a stop()→start() cycle of the same node instance. Never
   * sourced from replicated control state.
   */
  private trustedOwnerStore: TrustedOwnerStore | null = null;
  private controlNode: Libp2p | null = null;
  private controlDatabase: ControlDatabase | null = null;
  /**
   * The CONTROL network's peer-join block catch-up — same module as the
   * per-strand ones, but membership-gated (see {@link startControlBackfill}).
   * Created in {@link start} after the control node and database are up, stopped
   * and dropped in {@link cleanup} before either is torn down, so a stop()→
   * start() cycle rebuilds it with a fresh caught-up-peer memo.
   */
  private controlBackfill: PeerJoinBackfill | null = null;
  /**
   * Devices whose invitation redemption this member has verified and is admitting right now,
   * each with its count of overlapping redemptions. The control backfill's gate admits them
   * as it admits a member, for that window only ({@link catchUpRedeemingDevice}).
   */
  private readonly admittingDevices = new Map<string, number>();
  private strandWatcher: StrandWatcher | null = null;
  private strandManager: StrandInstanceManager;
  private hibernationManager: HibernationManager;
  private enrollmentService: EnrollmentService;
  private seedBootstrapService: SeedBootstrapService | null = null;
  private strandSolicitationService: StrandSolicitationService | null = null;
  /**
   * The service whose formation handler is registered on the control node. Trails
   * {@link strandSolicitationService} while {@link initializeStrandSolicitation} swaps a new
   * one in: the field is set at once so concurrent callers reuse it, the handler only when
   * its queued swap runs.
   */
  private registeredSolicitation: StrandSolicitationService | null = null;
  /** Tail of the queued formation-handler swaps ({@link swapFormationResponder}). */
  private solicitationSwaps: Promise<void> = Promise.resolve();
  private strandWakeService: StrandWakeService | null = null;
  /**
   * Control-network strand-address responder. Answers a co-cadre sibling's
   * on-demand request for this node's live strand-network multiaddrs so the
   * sibling can seed a strand mesh from us — the read side of the seed path that
   * stops conflating control addresses with strand seeding.
   */
  private strandAddrService: StrandAddrService | null = null;
  /**
   * Cadre invitation redemption handler (`/sereus/cadre-invite/1.0.0`): a device holding an
   * invitation dials this machine and proves possession; the handler seats the row and
   * admits the device against this node's control database. Registered by {@link start}
   * once that database is up, on every node.
   */
  private cadreInviteHandler: CadreInviteHandler | null = null;
  /**
   * Server-side push-wake fan-out. Constructed by {@link start} only when
   * `config.push` (an injected `PushNotifier` + policy) is present — without it
   * the node behaves exactly as before (no notifier, no fan-out). Owns who/when
   * to wake hibernating mobile peers on strand activity.
   */
  private pushFanoutService: PushFanoutService | null = null;
  /** Backing field for the {@link running} / {@link isRunning} getters. */
  private _running = false;
  /**
   * The control database's own raw storage (cache-wrapped), resolved once per
   * `start()` and released in {@link cleanup}. Owning it is what keeps the
   * provider call for the control scope — `controlStorageScope(partyId)`, see
   * `storage-scope.ts` — a once-per-runtime call: a `stop()` then `start()` cycle
   * on this object re-resolves against a live cache, and never orphans the
   * previous wrapper's registration in the shared cache pool.
   */
  private controlStorage: IRawStorage | null = null;
  /**
   * In-flight {@link serviceWake} operations keyed by strandId. Coalesces
   * concurrent on-demand wakes for the same strand into one runtime build + one
   * window + one re-hibernate decision (a second caller joins the first's
   * promise), complementing {@link HibernationManager}'s wake coalescing.
   */
  private serviceWakePromises: Map<string, Promise<ServiceWakeResult>> = new Map();
  /**
   * Live wake-window waiters (see {@link holdWakeWindow}). Tracked so
   * {@link cleanup} can clear the timer AND resolve the promise on teardown — a
   * window must never fire (or hang an in-flight serviceWake) after stop().
   */
  private windowWaiters: Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }> = new Set();
  private eventHandlers: Map<keyof CadreNodeEvents, Set<EventHandler<never>>> = new Map();

  /**
   * Relay multiaddrs the caller asked {@link reserveRelays} to reserve through —
   * or, on a node that names `network.relayAddrs`, the ones
   * {@link driveControlRelayReservation} asked for at the end of {@link start}.
   * Empty (the default) means neither happened, so {@link getRelayReservationState}
   * reports `none`.
   */
  private relayReserveAddrs: string[] = [];
  /**
   * The running retry loop for {@link relayReserveAddrs}, or `null` when nobody
   * asked for a reservation / there was no control node to supervise. It owns the
   * in-flight flag, the last failure and the next-attempt time; this class only
   * starts it, stops it and reads it.
   */
  private relayReserveSupervisor: RelayReservationSupervisor | null = null;
  /**
   * Reason {@link reserveRelays} produced no reservation when there is no
   * supervisor to hold one — i.e. the pre-start `control node unavailable` case.
   */
  private relayReserveError: string | null = null;

  /**
   * True from just before the control libp2p node is created until
   * {@link ControlDatabase.initialize} has settled — the connection gate's
   * BRING-UP QUIET PERIOD (`membership-connection-gater.ts`), during which this
   * node refuses every control connection in both directions.
   *
   * The invariant: the control database is built while this node holds zero
   * control connections. Every same-party sibling connected in that window joins
   * the Optimystic cohort the bring-up's block probes consult, and a sibling that
   * has not yet replicated this node's `CadrePeer` row refuses them all — which
   * fails `start()` outright and cannot be retried into convergence (writing the
   * row that would clear the refusal needs the database being built).
   *
   * Cleared on FAILURE as well as success ({@link cleanup} clears it), so
   * teardown is never gated.
   */
  private controlBringUpInFlight = false;

  /** Map of strandId -> sAppConfig for sAppId filtering and management */
  private sAppConfigs: Map<string, SAppConfig> = new Map();

  /**
   * Strands the control network advertises that no local sAppConfig claims — the
   * backlog behind `strand:discovered`. Maintained in {@link handleStrandAdded}
   * (added), {@link addStrand} (claimed), {@link detachStrand} (stopped or its
   * control row vanished) and {@link cleanup}. Read through
   * {@link getDiscoveredStrands}.
   */
  private discoveredStrands: Map<string, StrandRow> = new Map();

  /**
   * Whether an unclaimed strand the filter admits is launched as a storage replica
   * ({@link CadreNodeConfig.hostUnclaimedStrands}), resolved once from the config.
   *
   * NOTE: a replica host stores every admitted strand of its party with no quota (Arachnode
   * quotas are unimplemented). Fine at a party's handful of strands; if always-on nodes come
   * to host strands by the hundred, per-strand quotas or a narrower default filter is the lever.
   */
  private readonly hostUnclaimedStrands: boolean;

  /**
   * The sApp id each storage replica read from its own `Strand.Header` — {@link getSAppId}'s
   * answer for a strand no local config claims, so an `sAppId` strand filter can reject a
   * replica of some other app instead of admitting it provisionally forever.
   *
   * Cleared by {@link cleanup} only, deliberately NOT by {@link detachStrand}: the watcher's
   * filter rejection stops a replica through that very method, and forgetting the id there
   * would have the next poll find it unknown again, re-admit the strand provisionally and
   * relaunch the replica — once every other poll, forever. A strand id's sApp never changes,
   * and the map is bounded by the strands this party has published, like
   * {@link discoveredStrands}.
   */
  private replicaSAppIds: Map<string, string> = new Map();

  /**
   * Most-recently pushed invite addresses (see {@link setInviteAddresses}).
   * When non-null these take priority over `libp2pNode.getMultiaddrs()` when
   * minting cadre invitations — the host pushes NAT-resolved addresses here so
   * the control-network node never needs to dial back to the manager.
   */
  private latestInviteAddresses: string[] | null = null;

  /**
   * Lazily-parsed PeerIds of `controlNetwork.bootstrapNodes` (see
   * {@link getBootstrapPeerIds}) — infrastructure the inbound gate always admits.
   */
  private bootstrapPeerIds: Set<string> | null = null;

  /**
   * Materialized in-memory snapshot of the AUTHORIZED member peer ids (the
   * {@link listAuthorizedMembers} result), consulted by the per-stream
   * control-DB gate ({@link authorizeInboundControlStream}). That predicate
   * runs on EVERY inbound Optimystic control-DB stream and must never await a
   * control-DB read: those reads pull blocks over the very protocols the
   * predicate gates, which closes a circular wait that ends in mutual denial
   * (the upstream gate is fail-closed on timeout, unlike the fail-open
   * connection gater). So the set is refreshed OUT OF BAND instead — after
   * start, on every {@link reconcileControlCohort} pass (15s cadence), and
   * immediately after every LOCAL membership mutation so a just-vouched peer
   * is admitted without waiting for the timer. That last refresh is AUTOMATIC:
   * the control database notifies {@link refreshMembershipGate} after every
   * committed `CadrePeer` write (see `ControlDatabase.mutateCadrePeer`), so no
   * writer has to remember. A change that arrives by REPLICATION is picked up
   * on the next timed refresh — bounded staleness, acceptable because this gate
   * is defense in depth: rows an unadmitted peer manages to write are still
   * disbelieved at read time by the voucher-anchored predicate.
   */
  private authorizedControlPeers: Set<string> = new Set();

  /**
   * Coalescing state for {@link refreshMembershipGate}: a pending "the snapshot
   * is stale" flag, the single in-flight drain that consumes it, and the depth
   * of open {@link deferMembershipGateRefresh} scopes (a burst of writes inside
   * one scope collapses to a single refresh at scope exit).
   */
  private membershipGateDirty = false;
  private membershipGateDrain: Promise<void> | null = null;
  private membershipGateDeferDepth = 0;

  /**
   * In-memory delegate admission grants (see `delegate-admission.ts`): the
   * strand-node transport peerIds this party's members have announced over the
   * strand-addr RPC, admitted at the CONNECTION and RESERVATION levels so a
   * member's NAT'd strand node can hold a circuit-relay reservation on this
   * node (without spending the unauthorized-reservation budget). Consulted
   * ONLY by {@link admitInboundControlConnection} and
   * {@link admitControlRelayReservation}; the fail-closed per-stream gate
   * ({@link authorizeInboundControlStream}) never honors it.
   */
  private readonly delegateAdmission = new DelegateAdmissionStore();

  /**
   * Bounded budget of concurrent circuit-relay reservations granted to peers
   * this node cannot (yet) place as members — the boot-ordering window where a
   * genuine sibling reserves before its `CadrePeer` row has replicated here.
   * Consulted only by {@link admitControlRelayReservation} (the gater's
   * `denyInboundRelayReservation` policy); authorized members and announced
   * delegates are admitted before it and never counted. Cap from
   * `network.unauthorizedRelayReservationCap` (default
   * `MAX_UNAUTHORIZED_RELAY_RESERVATIONS`); entries expire on the relay
   * server's own resolved `reservationTtl` ({@link relayServer}).
   */
  private readonly unauthorizedRelayReservations: UnauthorizedReservationBudget;

  /**
   * Does this node's CONTROL libp2p run the circuit-relay server, and with which
   * init? Resolved once from `network` and `profile` by the same function every
   * strand node's build uses (`relay-server.ts`). Read by
   * {@link buildControlNodeOptions} (which configures the server from it),
   * {@link admitInboundControlConnection} (whose deny/admit-for-relay branch must
   * agree with whether a reservation is even servable here), and the
   * unauthorized budget above (whose TTL is the server's).
   */
  private readonly relayServer: ResolvedRelayServer;

  /**
   * When this node last ANNOUNCED a delegate, keyed `<targetPeerId>\n<strandId>`
   * (the peer announced TO, not the delegate). Throttles
   * {@link refreshDelegateGrants} to once per `DELEGATE_GRANT_TTL_MS / 2` per
   * (relay, strand) so the 15 s reconcile tick never becomes per-tick RPC
   * chatter; the launch/resume announce passes record here too. Keys whose
   * strand is no longer running are pruned on each reconcile pass.
   */
  private readonly delegateAnnounceAt = new Map<string, number>();

  /**
   * When each connected sibling is next due a strand-addr RPC for each running
   * strand, keyed `peerStrandKey(siblingControlPeerId, strandId)` → epoch ms; a
   * missing key is due. Bounds {@link refreshStrandPeerAddrs}'s fan-out per
   * (sibling, strand) rather than per strand, so a sibling that connects after a
   * pass is asked on the next 15 s tick instead of waiting out a stamp another
   * sibling's answer set. An answer (even an empty one) makes the sibling due again
   * in {@link STRAND_PEER_ADDR_REFRESH_MS}; no answer, in
   * {@link STRAND_PEER_ADDR_RETRY_MS}. Keys whose strand stopped running or whose
   * sibling is no longer connected are pruned every pass, so a resumed strand and a
   * reconnected sibling are both asked at once.
   */
  private readonly strandAddrAskDueAt = new Map<string, number>();

  /**
   * The strand-network addresses a formation carried back
   * (`FormationResultMessage.strandAddrs`), by strand id: the responder's live strand
   * node addresses, kept so the strand's first attach has something to dial. Written by
   * {@link recordFormationStrandAddrs}, read by {@link resolveCohortSeed} (launch and
   * hibernation resume) and by every refresh pass for the peers the strand node's FRET
   * table holds no record for yet ({@link remergeUnrecordedFormationAddrs}).
   *
   * This is the only cross-party input a FIRST attach has. The strand-addr RPC that
   * resolves a strand's addresses is membership-gated and answers own-party siblings
   * only, so without it a joiner's seed for a two-party strand is empty and the mesh
   * never forms. Every later launch has the strand node's saved network state as well
   * ({@link strandNetworkStateStore}), which is what a restart re-finds the other party
   * from (gotchoices/sereus#18).
   *
   * A re-formation replaces the strand's list. An entry survives a {@link stopStrand}
   * and a stop()→start() of this node instance ({@link cleanup} leaves the map alone),
   * and is dropped where the saved network state is: {@link unpublishStrand},
   * {@link forgetJoinedStrand} and self-revocation.
   *
   * NOTE: accepted tradeoff — in memory only, so a process restart between `formStrand`
   * and the strand's first launch loses the carried addresses, and the strand then
   * launches with no cross-party seed until it is re-formed. Persisting the list on the
   * joined-strand record was weighed and declined: it mixes address state into the join
   * record, and needs an "only until the first run" rule to stop dead addresses being
   * dialled on every launch. Every embedder launches straight after forming, and once
   * the strand has run the saved network state covers every later restart. Revisit if an
   * embedder forms and launches in separate sessions.
   */
  private readonly formationStrandAddrs = new Map<string, string[]>();

  /**
   * Node-local strand network state (see `strand-network-state.ts`): per strand, the
   * state db-p2p saves for the strand's libp2p node — its FRET routing table with each
   * peer's signed address record. Handed to every strand launch as
   * `StartStrandConfig.networkState`; the strand node saves into it on every connection
   * and re-imports it when it is next built, which is what gives a restarted strand
   * node addresses for the peers it was talking to.
   *
   * Constructed (or adopted from `config.strandNetworkState.store`) by
   * {@link initializeStrandNetworkStateStore} during {@link start}, deliberately NOT
   * cleared by {@link cleanup}, so it survives a stop()→start() cycle of the same node
   * instance — same lifecycle as {@link bootstrapPeerStore}.
   *
   * A strand's state survives a {@link stopStrand} and a hibernation quiesce, and is
   * forgotten by {@link unpublishStrand}, {@link forgetJoinedStrand} and
   * self-revocation. A strand detached because the watcher saw its row gone keeps its
   * state (`NOTE:` on `PersistentStrandNetworkStateStore`).
   */
  private strandNetworkStateStore: StrandNetworkStateStore | null = null;

  /**
   * PENDING strand membership invitations learned at formation, keyed by strandId — the
   * single-use `Strand.Invite` credential a closed-strand formation result carried back
   * ({@link FormStrandResult.membershipInvite}), waiting for this node's strand bring-up
   * to redeem (`consumeInvite` seats the `Strand.Member` row under this party's own key
   * — the `strand-node-binds-member-peer` half of the party-identity chain).
   *
   * IN-MEMORY, deliberately: an invitation is single-use and short-lived, a restarted
   * joiner that never redeemed it re-forms from scratch, and re-forming issues a fresh
   * one. A re-formation against the same strand REPLACES the entry — the
   * fresh invitation supersedes one that may have expired. The party key the invitation
   * admits, by contrast, IS persisted (`StrandPartyKey`, seated by
   * {@link adoptFormationMembershipInvite} before the entry lands here), so a lost
   * invitation never orphans an identity.
   *
   * INVALIDATION is owned by the strand's bring-up membership reconciler
   * (`strand-membership-reconciler.ts`, wired via `StartStrandConfig.pendingMembershipInvite`
   * in {@link launchStrand}): it deletes the entry once the invitation is redeemed, burned
   * against an already-seated member, or found dead (expired / cancelled / consumed
   * elsewhere / the strand sealed) — naming the invitation it settled, so a re-formation
   * that replaced the entry meanwhile keeps its fresh one
   * ({@link unstageMembershipInvite}). Until the strand is actually launched here the entry
   * just waits; once launched, staging notifies the manager, which re-arms a finished loop.
   *
   * NOTE: entries live for the node's lifetime (one small pair per formed closed
   * strand); the number of keys is bounded only by the strands this node has ever
   * formed, not by time — if a node ever forms strands at scale, evict on
   * `unpublishStrand` / `forgetJoinedStrand` as {@link formationStrandAddrs} is.
   */
  private readonly pendingMembershipInvites = new Map<string, StrandMembershipInvite>();

  /**
   * Invite keys of the membership invitations this process has staged, by
   * {@link adoptFormationMembershipInvite} or from a `JoinSuccess` row
   * ({@link stageMembershipInvitesFromPendingJoins}), so one the reconciler has settled is not
   * staged again by the next pending-join pass. Same lifetime as
   * {@link pendingMembershipInvites}: a restarted process stages each live one once more, and the
   * reconciler settles it again (spent, or the party already seated).
   */
  private readonly stagedMembershipInviteKeys = new Set<string>();

  /**
   * The pending-join retry loop (`pending-join-runner.ts`): built by {@link start}, stopped by
   * {@link cleanup}. It acts only while this machine is an enrolled owner.
   */
  private pendingJoinRunner: PendingJoinRunner | null = null;

  /**
   * Founder launches refused because the strand was founded before the per-party
   * identity split (`PreSplitStrandIdentityError`), keyed by strandId. Read by
   * {@link issueStrandMembershipInvite}, which rethrows the recorded error so a bound
   * redemption against the strand is rejected as "must be recreated" — not told to retry
   * because the runtime is not live (a refused fresh launch leaves none) or failed by the
   * `Strand.Invite` gate (a refused in-place founding leaves a joiner instance up whose
   * party key is no manager).
   *
   * Written and cleared by {@link launchStrand}; also cleared by {@link detachStrand},
   * {@link unpublishStrand} and {@link cleanup}, so a recreated id starts clean.
   * In-memory: after a restart the next founder launch of the strand records it again;
   * until then issuance still reads the fingerprint off the live rows whenever a runtime
   * is up — only a strand with no runtime at all answers retryably meanwhile.
   */
  private readonly strandLaunchRefusals = new Map<string, PreSplitStrandIdentityError>();

  /**
   * Dial targets learned out of band, keyed by peer id, valued by the multiaddr
   * strings this node was handed (parsed lazily, at dial time). Two writers:
   * {@link recordSeedBootstrapPeers} retains the owner-flagged peers of every seed
   * this node applies, and {@link addDrone} retains the addresses of every node
   * this node adds. Two readers: {@link dialColdStartBootstrap} dials every entry
   * while the control database still has no siblings, and
   * {@link resolveControlDialAddrs} falls back to a sibling's entry when neither
   * its signed record nor the address book yields an address.
   *
   * A STORE rather than a plain map (see `bootstrap-peer-store.ts`), because the
   * targets must outlive the process: a node seeded into a party it could not
   * reach has nothing else on disk naming that party's addresses (`applySeed`
   * writes no control row, and `CadrePeer` fills in only after a connection
   * succeeds), so an in-memory-only set left it stranded permanently across a
   * restart. An owner that added a node it cannot be dialed by is in the same
   * position: the added node's row stays unsigned, so unresolvable, until that
   * node self-publishes over a connection only the owner can open. Constructed (or
   * adopted from `config.bootstrapPeers.store`) by
   * {@link initializeBootstrapPeerStore} during {@link start}; deliberately NOT
   * cleared by {@link cleanup}, so it survives a stop()→start() cycle of the same
   * node instance — same lifecycle as {@link trustedOwnerStore}. Durability
   * depends on the injected backend; the default is in-memory.
   *
   * Deliberately NOT the libp2p peer store, which {@link peerStoreAddrs} already
   * reads for the steady-state path. The peer store is shared with everything
   * libp2p discovers, so "dial every entry" would grow into dialing arbitrary
   * discovered peers as the node lives longer; this store holds exactly the peers
   * an owner-signed, trust-anchored seed nominated as owners, and the nodes this
   * node chose to add. `applySeed` also merges a seed's addresses into the peer
   * store, where they age out; an added node's addresses are never merged there,
   * because only verified addresses go into the address book (see
   * {@link warmSiblingAddrBook}).
   *
   * A later record OVERWRITES an entry rather than merging, so a re-seed after an
   * owner's address changes replaces the stale address instead of accumulating
   * dead ones, and {@link warmSiblingAddrBook} replaces an entry with the addresses
   * the sibling's signed record resolves to when they differ. Only this node's own
   * {@link removePeer} evicts an entry: otherwise they are the node's only way back
   * to those peers if it is ever stranded again.
   */
  private bootstrapPeerStore: BootstrapPeerStore | null = null;

  /**
   * Node-local record of the party's enrolled-machine count (see
   * `enrolled-machine-store.ts`), kept so the CONTROL node can declare a
   * block-repair yardstick at bring-up. Constructed (or adopted from
   * `config.enrolledMachines.store`) by {@link initializeEnrolledMachineStore};
   * written by {@link refreshAuthorizedControlPeers}. Like
   * {@link bootstrapPeerStore} it is deliberately NOT cleared by {@link cleanup},
   * so it survives a stop()→start() cycle of the same node instance.
   */
  private enrolledMachineStore: EnrolledMachineStore | null = null;

  /**
   * Node-local record of the strands this node joined from ANOTHER party and has not yet
   * published party-wide (see `joined-strand-store.ts`). Written by {@link formStrand}
   * and by an {@link addStrand} of a foreign row; drained once the party-wide
   * `JoinedStrand` row is visible. Adopted from `config.joinedStrands.store`, else built over
   * `config.keyStore`, else in-memory, by {@link initializeJoinedStrandStore}. Like
   * {@link bootstrapPeerStore} it is deliberately NOT cleared by {@link cleanup}.
   */
  private joinedStrandStore: JoinedStrandStore | null = null;

  /**
   * This session's joined strands: {@link joinedStrandStore} and the party-wide
   * `JoinedStrand` table, unioned with the control rows each watcher poll, published and
   * removed by the reconcile pass. Per SESSION, unlike the store — rebuilt at every
   * {@link start}, which is what ends a revoked join's "keep offering until this session
   * ends" (see `JoinedStrandSession.forgetAfterThisSession`).
   */
  private joinedStrands: JoinedStrandSession | null = null;

  /**
   * The enrolled-machine count this node's CONTROL libp2p node was (or will be)
   * built with — read out of {@link enrolledMachineStore} during {@link start},
   * before {@link createControlNode}, and consumed by
   * {@link buildControlNodeOptions}.
   *
   * A captured FIELD rather than a live `store.count()` read, deliberately: the
   * store moves as membership changes, but Optimystic froze the policy when the
   * node was built, so this field is the honest answer to "what did this node
   * actually declare?" and does not drift away from the running node. It is
   * re-read on each {@link start}, which is what makes a stop()→start() cycle pick
   * up a count recorded during the previous run.
   *
   * `undefined` — a brand-new node, an unreadable slot, or the ephemeral default
   * store — means "this node does not know", which `controlClusterPolicy` answers
   * with the frozen base policy itself.
   */
  private declaredEnrolledMachines: number | undefined;

  /** Initial self-registration timer (see {@link scheduleSelfRegistration}). */
  private selfRegistrationTimer: ReturnType<typeof setTimeout> | null = null;
  /** TTL heartbeat that re-publishes the self record before it goes stale. */
  private recordRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Listener that re-publishes the self record when reachable addresses change. */
  private selfPeerUpdateHandler: (() => void) | null = null;
  /**
   * Recurring proactive control-cohort dial cadence (see
   * {@link reconcileControlCohort}). Wired alongside {@link recordRefreshTimer}
   * in {@link startRecordRefresh} and torn down symmetrically in
   * {@link stopRecordRefresh}; `.unref()`'d so it never keeps the loop alive.
   */
  private controlCohortReconcileTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Single-flight guard for {@link reconcileControlCohort}. The eager start pass,
   * the recurring interval, and the `self:peer:update` trigger can fire close
   * together; collapsing concurrent passes into one in-flight run prevents two
   * passes from double-dialing the same siblings (mirrors {@link registerSelfInFlight}).
   */
  private reconcileControlCohortInFlight: Promise<ControlCohortReconcileResult> | null = null;
  /**
   * Single-flight guard for {@link registerSelf}. Concurrent callers (the explicit
   * CLI `--owner` publish, the 1s startup timer, the TTL heartbeat, and the
   * address-change listener) share one in-flight publish so two of them can never
   * both read "no row yet" and race a duplicate INSERT (a `CadrePeer` PK conflict).
   */
  private registerSelfInFlight: Promise<SelfRegistrationOutcome> | null = null;
  /**
   * When this node last PUBLISHED its own `CadrePeer` address record (inserted or
   * refreshed), or null if it never has in this session. Stamped by
   * {@link noteSelfRecordPublished} on every successful publish, wherever it was driven
   * from — the boot pass, the heartbeat, an address change, a drain or an explicit call.
   *
   * Read by {@link escalateIfSelfRecordStale} for the one consequence worth an operator's
   * attention: once this gap exceeds {@link DEFAULT_PEER_RECORD_MAX_AGE_MS}, every other
   * machine in the party is already discarding this node's address as stale.
   */
  private lastSelfRecordPublishAt: number | null = null;
  /** Say-once latch for {@link escalateIfSelfRecordStale}; re-armed by the next publish. */
  private selfRecordStaleWarned = false;

  // ── Write-while-alone re-replication (control-write-ensure-replicated) ──────
  /**
   * Re-replication queue for owner `authorizePeer` writes that committed while
   * this node was alone — `controlNode.getConnections().length === 0` at write
   * time means the Optimystic commit was local-only (the block's cluster was ≤1)
   * and never broadcast. Maps the affected subject peerId → 'authorize', to
   * re-issue once the cohort grows. Removals are NOT tracked here — a delete
   * leaves a `Revocation` tombstone, tracked by {@link pendingRevocations}; a
   * removePeer also clears any queued authorize for the same subject (the row is
   * gone, so re-issuing the insert would be wrong). Drained on the 0→≥1
   * control-connection transition by {@link drainPendingControlReplication}.
   */
  private pendingPeerWrites: Map<string, 'authorize'> = new Map();
  /**
   * Re-replication queue for `Revocation` tombstones that committed while this
   * node was alone, keyed on the retired `StampId`. Fed by the control DB's
   * committed-delete seam ({@link noteGuardedDelete}), so one queue covers all
   * four guarded tables (`CadrePeer` / `DeviceToken` / `Strand` /
   * `ValidationKey`). Drained (owner-signed `ReissuedAt` bump, which re-broadcasts
   * the tombstone) by {@link drainPendingRevocations}. Cleared on stop alongside
   * {@link pendingPeerWrites} — the tombstone rows are durable, so the next
   * lifetime's first-growth sweep re-covers anything dropped here.
   */
  private pendingRevocations: Map<string, RevokedRowRef> = new Map();
  /**
   * Guards the once-per-lifetime first-growth revocation sweep (re-issue EVERY
   * locally-held tombstone, covering removals from before this node started).
   * Deliberately separate from {@link reconstructedLocalOnlyWrites} and set only
   * after a sweep pass SUCCEEDS (including the nothing-held case) — a throwing
   * sweep retries on the next growth edge instead of being lost for the lifetime.
   * Reset on stop, so a stop()→start() cycle sweeps again (that second start is
   * exactly a "removals from before this lifetime" case).
   */
  private reissuedHeldRevocations = false;
  /**
   * Whether this process has seen the singleton `Revocation` ledger marker filed — its own
   * `'opened'` or an `'already-open'` answer, in {@link openRevocationLedgerIfDue}. A
   * record of work done, not a cached authorization answer: the marker can never be
   * deleted (`NoDelete`), so this can only go stale if the database itself is replaced,
   * which is why stop() clears it with the other per-process replication state.
   */
  private revocationLedgerOpened = false;
  /** This node's own `CadrePeer` self-write committed local-only (re-touched on growth). */
  private pendingSelfPeerWrite = false;
  /** This node's own `DeviceToken` self-write committed local-only (re-touched on growth). */
  private pendingSelfDeviceWrite = false;
  /**
   * Guards the one-shot, first-cohort-growth reconstruction: an owner re-touches
   * every membership row it may have authored that could be unreplicated (covering
   * writes made before this process started, which the in-memory queue cannot know).
   * Set true after the first drain so later passes only drain the in-memory queue.
   */
  private reconstructedLocalOnlyWrites = false;
  /** Single-flight guard for the re-replication drain (mirrors {@link registerSelfInFlight}). */
  private drainControlReplicationInFlight: Promise<void> | null = null;
  /**
   * Tracks the control-connection presence edge so the drain fires only on the
   * 0→≥1 transition (the earliest point a re-issue can broadcast), not on every
   * subsequent `connection:open`. Re-armed to false once connections return to 0.
   */
  private hasControlConnection = false;
  /** `connection:open` listener driving the growth-triggered drain (teardown in {@link stopRecordRefresh}). */
  private controlConnectionOpenHandler: (() => void) | null = null;
  /** `connection:close` listener re-arming the growth edge (teardown in {@link stopRecordRefresh}). */
  private controlConnectionCloseHandler: (() => void) | null = null;

  constructor(config: CadreNodeConfig) {
    this.config = config;
    this.hostUnclaimedStrands = config.hostUnclaimedStrands ?? config.profile === 'storage';
    this.strandManager = new StrandInstanceManager();
    this.enrollmentService = new EnrollmentService();
    this.relayServer = resolveRelayServer(config.network, config.profile);
    this.unauthorizedRelayReservations = new UnauthorizedReservationBudget(
      config.network?.unauthorizedRelayReservationCap,
      this.relayServer.init.reservations.reservationTtl
    );

    // Create hibernation manager with callbacks
    const hibernationCallbacks: HibernationCallbacks = {
      onIdle: async (strandId) => this.handleStrandIdle(strandId),
      onHibernate: async (strandId) => this.handleStrandHibernate(strandId),
      onWake: async (strandId) => this.handleStrandWake(strandId),
      onCheckIn: async (strandId) => this.handleStrandCheckIn(strandId),
      isQuiescing: (strandId) => this.strandManager.isQuiescing(strandId)
    };
    this.hibernationManager = new HibernationManager(
      config.hibernation ?? { enabled: false },
      hibernationCallbacks
    );

    log('CadreNode created for party: %s', config.controlNetwork.partyId);
  }

  /**
   * SAppIdLookup implementation - get sAppId for a strand: the claiming config's, else
   * the one a storage replica read from the strand's own `Strand.Header`.
   */
  getSAppId(strandId: string): string | undefined {
    return this.sAppConfigs.get(strandId)?.id ?? this.replicaSAppIds.get(strandId);
  }

  /**
   * Get the peer ID of this node (available after start)
   */
  get peerId(): PeerId | undefined {
    return this.controlNode?.peerId;
  }

  /**
   * The party ID this node serves (control-network identity).
   */
  get partyId(): string {
    return this.config.controlNetwork.partyId;
  }

  /**
   * Get the multiaddrs of this node (available after start)
   */
  getMultiaddrs(): string[] {
    if (!this.controlNode) return [];
    return this.controlNode.getMultiaddrs().map(ma => ma.toString());
  }

  /**
   * Check if the node is running
   */
  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Synchronous lifecycle snapshot for headless callers (a mobile
   * `BackgroundRunner` that boots in a background task and must *query* state
   * rather than subscribe to `control:connected`/`control:disconnected`).
   * Equivalent to {@link isRunning}.
   */
  get running(): boolean {
    return this._running;
  }

  /**
   * Synchronous readiness snapshot: whether the control network is currently
   * connected (the node is running and its control-network libp2p node is up).
   * Tracks the same edge the `control:connected`/`control:disconnected` events
   * announce, but pollable.
   */
  get controlConnected(): boolean {
    return this._running && this.controlNode !== null;
  }

  /**
   * Classify every open control-network connection as relayed
   * (`/p2p-circuit`) vs direct, tag its transport, and summarise counts plus a
   * stuck-on-relay condition. Pure, read-only snapshot over
   * `controlNode.getConnections()`. Returns an empty (all-zero) summary when
   * the node has not been started.
   *
   * @param settleWindowMs - grace period before a relayed connection with no
   *   direct sibling is considered stuck (default 10_000ms)
   */
  getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
    return summarizeConnectionPaths(this.controlNode?.getConnections(), settleWindowMs);
  }

  /**
   * Get all strand instances
   */
  getStrands(): Map<string, StrandInstance> {
    return this.strandManager.getInstances();
  }

  /**
   * Strands the control network advertises that no local sAppConfig claims —
   * the backlog behind `strand:discovered`.
   *
   * The event fires once per strand, and it can fire before the app has
   * subscribed (the watcher's first poll runs inside `start()`). So an app that
   * auto-joins discovered strands must subscribe FIRST and then drain this map,
   * not rely on the event alone. Entries leave the map when the strand is
   * claimed ({@link addStrand}) or its control row disappears.
   *
   * Bounded by the number of strands this party has that this node does not run
   * — the control database holds only this party's rows — so there is no cap and
   * no eviction policy to reason about.
   *
   * Returns a snapshot; mutating it does not affect the node.
   */
  getDiscoveredStrands(): Map<string, StrandRow> {
    return new Map(this.discoveredStrands);
  }

  /**
   * Get a specific strand instance
   */
  getStrand(strandId: string): StrandInstance | undefined {
    return this.strandManager.getInstance(strandId);
  }

  /**
   * Get the enrollment service for adding new peers
   */
  getEnrollmentService(): EnrollmentService {
    return this.enrollmentService;
  }

  /**
   * Start the cadre node
   */
  async start(): Promise<void> {
    if (this._running) {
      log('CadreNode already running');
      return;
    }

    log('Starting CadreNode for party: %s', this.config.controlNetwork.partyId);
    this.logRelayServerSettings();

    try {
      const tTotal = performance.now();

      // Config pre-flight, inside the guarded region: resolving the listen addrs it reads
      // throws on a malformed `relayAddrs` entry, and that failure belongs on the same
      // logged-and-cleaned-up path as every other one in start().
      this.warnIfAnnounceAddrsDiscardRelay();
      // Refuse a bad `linkRoundTripMs` HERE rather than wherever a budget is first derived
      // from it: every consumer of it is conditional (no control storage, no relays, no dial
      // yet), so a node with a zero or NaN declaration would otherwise boot and fail later
      // inside a best-effort path that logs and carries on. `link-budget.ts`.
      resolveLinkRoundTripMs(this.config.network?.linkRoundTripMs);

      // Resolve the node identity (keyStore | privateKey | ephemeral) BEFORE any
      // libp2p/network bring-up, so a misconfiguration or an access-denied secure
      // store fails closed before a node is created.
      await this.resolveIdentityKey();

      // Bring up the node-local trusted-owner anchor (and seed config pins)
      // before any network bring-up: a mis-scoped injected store fails closed
      // here, and out-of-band pins are anchored before the first seed/peer
      // interaction could consult them.
      await this.initializeTrustedOwnerStore();

      // Bring up the node-local cold-start bootstrap-peer store alongside the
      // anchor, and for the same two reasons: a mis-scoped injected store fails
      // closed before any network bring-up, and the retained dial targets are
      // loaded before the first reconcile pass could consult them.
      this.initializeBootstrapPeerStore();

      // The remembered cross-party joins, which the strand watcher built below polls
      // beside the control rows. Before network bring-up, so a mis-scoped injected store
      // fails closed like the two above.
      this.initializeJoinedStrandStore();

      // Each strand node's saved network state, which those joins are dialed from after
      // a restart. Same placement, same reason.
      this.initializeStrandNetworkStateStore();

      // Read the party's enrolled-machine count out of its node-local record and
      // capture it for buildControlNodeOptions below. This MUST precede
      // createControlNode: Optimystic freezes the cluster policy when the node is
      // built, and the ControlDatabase that could answer the question live does not
      // exist until after that. Remembering the number across the restart is the
      // only way to declare it at all — see `enrolled-machine-store.ts`.
      this.initializeEnrolledMachineStore();

      // Arm the connection gate's BRING-UP QUIET PERIOD before the libp2p node
      // exists, so no connection can form ahead of it: the node is built without
      // its bootstrap peers (dialed after bring-up), but a peer it already knows
      // from a previous run, or one that dials in, could otherwise connect inside
      // createControlNode below.
      // The invariant being protected is "zero control connections during
      // control-database bring-up" — see the field's doc and
      // `membership-connection-gater.ts` → "The bring-up quiet period".
      //
      // NOTE: the gate, not the ordering, is what holds the invariant. Bring-up
      // duration is (raw-storage operations) × per-operation latency; the cold-start
      // operation count and the 50-90 ms/op figure a loaded phone sees live in
      // `control-database.ts`'s `loadSchema` note (pinned by
      // `control-start-storage-op-budget.spec.ts`), so bring-up can take 9-15 s —
      // ample time for a remembered or inbound peer to connect without the gate.
      this.controlBringUpInFlight = true;

      // Create the control network libp2p node
      let t0 = performance.now();
      this.controlNode = await this.createControlNode();
      timing('[start] createControlNode: %dms', Math.round(performance.now() - t0));
      log('Control node started with ID: %s', this.controlNode.peerId.toString());

      // Extract coordinatedRepo from the node (attached by createLibp2pNode)
      const coordinatedRepo = (this.controlNode as Libp2pNodeWithRepo).coordinatedRepo;
      if (!coordinatedRepo) {
        throw new Error('coordinatedRepo not available on control node');
      }

      // Initialize the control database with the libp2p node
      t0 = performance.now();
      this.controlDatabase = new ControlDatabase({
        partyId: this.config.controlNetwork.partyId,
        libp2pNode: this.controlNode,
        coordinatedRepo,
        schemaPath: this.config.controlNetwork.schemaPath,
      });
      await this.controlDatabase.initialize();
      timing('[start] controlDatabase.initialize: %dms', Math.round(performance.now() - t0));
      // The database exists locally now, so the quiet period has done its job and
      // this node can be in the conversation. A failure above never reaches here —
      // `cleanup()` on the catch path opens the gate instead, so teardown (and a
      // retry by the embedder) is not gated.
      //
      // NOTE: the window ends HERE, not at the end of start(), so the awaited control-DB
      // work that follows — `strandWatcher.start()`'s first poll — can run against a
      // cohort a connection just joined. Fine now: every block that poll reads was
      // created locally by the initialize() above, so a refusing sibling has nothing to
      // refuse. If a boot ever fails with `BlockUnavailableError` from BELOW this line,
      // that assumption broke. Do not simply move this clear later without measuring:
      // `handleStrandAdded` runs inside `strandWatcher.start()` and seeds each strand
      // node from CONNECTED siblings (`resolveCohortSeed`), so a longer window trades a
      // bring-up hazard for boot-time strand seeds that are always empty.
      this.controlBringUpInFlight = false;
      log('Control database initialized');
      // Now that the gate is open, make contact with the configured bootstrap peers the
      // node was built without (see buildControlNodeOptions). Not awaited: an unreachable
      // relay must not hold up start().
      void this.dialControlBootstrapPeers();

      // Attach the per-stream gate to the control DB's membership hub, so every
      // committed `CadrePeer` write re-materializes the authorized snapshot on its
      // own. Wired before anything can write. `_running` is still false for the
      // rest of start() and the refresh early-returns while it is — a write in that
      // window is covered by start's own pass below.
      this.controlDatabase.setMembershipChangeListener((reason) => this.refreshMembershipGate(reason));
      // Committed-delete seam → write-while-alone revocation queue. Same wiring
      // window argument as the membership listener above.
      this.controlDatabase.setGuardedDeleteListener((revocation) => this.noteGuardedDelete(revocation));
      // Abandoned-write seam. Wired here, before the first control write can run, so a
      // write lost during the rest of bring-up is reported like any other.
      this.controlDatabase.setControlWriteAbandonedListener(
        (abandonment) => this.noteControlWriteAbandoned(abandonment));

      // Create strand queryable using the control database
      const queryable = this.createStrandQueryable();

      // Create and start the strand watcher with sAppId lookup
      this.strandWatcher = new StrandWatcher(
        queryable,
        {
          onStrandAdded: async (strand) => this.handleStrandAdded(strand),
          onStrandRemoved: async (strandId) => this.handleStrandRemoved(strandId)
        },
        this.config.strandFilter ?? { mode: 'all' },
        this.config.strandWatchInterval ?? 5000,
        this // CadreNode implements SAppIdLookup
      );

      t0 = performance.now();
      await this.strandWatcher.start();
      timing('[start] strandWatcher.start: %dms', Math.round(performance.now() - t0));

      // Start hibernation manager
      this.hibernationManager.start();

      // Register the control-network push-wake receiver: a same-cadre peer can
      // signal us to bring a hibernating strand online. Gated on AUTHORIZED
      // membership (not the addressable surface); the wake routes through the same
      // path as a local wake.
      this.strandWakeService = new StrandWakeService({
        isMember: (peerId) => this.isAuthorizedMember(peerId),
        getStrand: (strandId) => this.strandManager.getInstance(strandId),
        wake: (strandId) => this.wakeStrand(strandId),
      });
      await this.strandWakeService.initialize(this.controlNode);

      // Register the control-network strand-address responder: a same-cadre peer
      // resolving a strand's bootstrap seed asks us for our live strand-network
      // multiaddrs (its CadrePeer row only knows our *control* address). Gated on
      // AUTHORIZED membership; answers only for strands we are actively meshing.
      // The same RPC doubles as the delegate-announce channel: a member's request
      // may carry the derived peerId its strand node runs as, and we record an
      // admission grant so our connection gate (and thus our relay server, when
      // enabled) admits it — see delegate-admission.ts.
      this.strandAddrService = new StrandAddrService({
        isMember: (peerId) => this.isAuthorizedMember(peerId),
        getStrandMultiaddrs: (strandId) => this.getStrandMultiaddrs(strandId),
        onDelegateAnnounce: (announcer, strandId, delegate) =>
          this.grantDelegateAdmission(announcer, strandId, delegate),
      });
      await this.strandAddrService.initialize(this.controlNode);

      // Answer strand formation for this party from now on. Every machine of a party
      // holds the replicated FormationInvite/FormationUsage rows, so an always-on one can
      // check a token for an inviter that is offline. After the control database is up,
      // so the responder never reads a database that cannot answer yet.
      await this.installDefaultFormationResponder();

      // Answer cadre invitation redemptions from now on: a device holding an invitation
      // dials any member machine, this one included, and proves possession in-protocol.
      // After the control database is up, since the handler seats and redeems against it.
      this.cadreInviteHandler = new CadreInviteHandler({
        partyId: this.config.controlNetwork.partyId,
        store: this.controlDatabase,
        catchUpDevice: (peerId) => this.catchUpRedeemingDevice(peerId),
      });
      await this.cadreInviteHandler.register(this.controlNode);

      // Server-side push-wake fan-out: only when push is configured.
      if (this.config.push) {
        this.pushFanoutService = this.buildPushFanout(this.config.push);
        log('Push-wake fan-out enabled (injected notifier)');
      }

      this._running = true;
      this.emit('control:connected', undefined);
      timing('[start] total: %dms', Math.round(performance.now() - tTotal));
      log('CadreNode started successfully');

      // Wire the control-connection growth listeners immediately (not via the
      // delayed refresh path) so no early `connection:open` is missed — the
      // write-while-alone re-replication drain must fire on the first 0→≥1 edge.
      this.wireControlConnectionListeners();

      // Arm the control network's peer-join block catch-up now that the control
      // DB (which the push-time membership gate reads) is up. Armed even when
      // this node is alone — like the strand one, it only does work when the
      // control libp2p node reports a peer connection, and arming it at start is
      // what closes the "genesised alone, headers never replicate" hole.
      this.startControlBackfill();

      // Seed the per-stream gate's materialized authorized set now that the
      // control DB is up (non-blocking; the helper never rejects). Until it
      // lands the snapshot is empty, which the stream gate treats as cold
      // start and admits.
      void this.refreshMembershipGate('start');

      // Reserve the configured relays LAST, so every step above ran against a
      // cohort of one (see driveControlRelayReservation). Ahead of
      // scheduleSelfRegistration, so this node's first published `CadrePeer` row
      // already carries the `/p2p-circuit` address the reservation earns it.
      // Throws on a relay that will not have us — start() is fail-fast for a node
      // whose operator named a relay, unless network.requireRelay is false.
      await this.driveControlRelayReservation();

      // Schedule self-registration in background
      this.scheduleSelfRegistration();

      // Last: its first pass may dial another party's machines.
      this.startPendingJoinRunner();

    } catch (error) {
      log('Failed to start CadreNode: %o', error);
      // `driveControlRelayReservation` throws AFTER `control:connected` was emitted,
      // so a subscriber can have seen this node come up. Balance the edge rather than
      // leaving it dangling — `cleanup()` has torn the node down either way, and the
      // events are what an embedder drives its "am I connected" UI from.
      const wasConnected = this._running;
      await this.cleanup();
      if (wasConnected) {
        this.emit('control:disconnected', undefined);
      }
      throw error;
    }
  }

  /**
   * Build the server-side push-wake fan-out over an injected {@link PushNotifier}.
   *
   * The notifier reaches for `node:http2`/`node:crypto`, so the cross-platform
   * core never constructs it — the Node host builds it from
   * `@serfab/cadre-core/push-node` and passes the instance in
   * `CadreNodeConfig.push`. This node owns that instance's lifecycle from here:
   * {@link cleanup} closes the fan-out, which closes the notifier (freeing the
   * APNs HTTP/2 session). Every other primitive the fan-out needs (member
   * enumeration, participation, direct dial, token resolve/expire) is an
   * import-clean closure over this node.
   */
  private buildPushFanout(push: NonNullable<CadreNodeConfig['push']>): PushFanoutService {
    return new PushFanoutService({
      listMembers: () => this.listMembers(),
      getStrand: (strandId) => this.strandManager.getInstance(strandId),
      selfPeerId: () => this.controlNode?.peerId.toString(),
      pushWake: (peerId, strandId, reason) => this.pushWake(peerId, strandId, reason),
      resolveDeviceToken: (peerId) => this.resolveDeviceToken(peerId),
      expireDeviceToken: (peerId) => this.expireDeviceToken(peerId),
      notifier: push.notifier,
      cooldownMs: push.cooldownMs,
      debounceMs: push.debounceMs,
    });
  }

  /**
   * Stop the cadre node
   */
  async stop(): Promise<void> {
    if (!this._running) {
      log('CadreNode not running');
      return;
    }

    log('Stopping CadreNode');
    await this.cleanup();
    this.emit('control:disconnected', undefined);
    log('CadreNode stopped');
  }

  /**
   * Subscribe to events
   */
  on<K extends keyof CadreNodeEvents>(
    event: K, 
    handler: EventHandler<CadreNodeEvents[K]>
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from events
   */
  off<K extends keyof CadreNodeEvents>(
    event: K, 
    handler: EventHandler<CadreNodeEvents[K]>
  ): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit<K extends keyof CadreNodeEvents>(
    event: K, 
    data: CadreNodeEvents[K]
  ): void {
    this.eventHandlers.get(event)?.forEach(handler => {
      try {
        (handler as EventHandler<CadreNodeEvents[K]>)(data);
      } catch (e) { log('Event handler error: %o', e); }
    });
  }

  /**
   * Resolve the node identity into {@link identityKey} exactly once, fail-closed,
   * before any network bring-up. Resolution order:
   *
   * 1. Both `keyStore` and `privateKey` set ⇒ configuration error (throws).
   * 2. `keyStore` set ⇒ {@link loadOrCreateIdentityKey} against `identityKeyId`
   *    (default {@link DEFAULT_IDENTITY_KEY_ID}): load when the slot is present,
   *    generate + persist when it is empty. A rejected `get` (access denied /
   *    backend failure) PROPAGATES — we never generate a new key on a read error,
   *    which would silently orphan the real identity.
   * 3. `privateKey` set ⇒ use it directly.
   * 4. Neither ⇒ leave undefined; libp2p generates an ephemeral key.
   *
   * Idempotent: a second call (or a stop()→start() cycle) reuses the already
   * resolved key rather than regenerating or re-persisting.
   */
  private async resolveIdentityKey(): Promise<void> {
    if (this.identityKey) {
      return;
    }
    const { keyStore, privateKey, identityKeyId } = this.config;

    if (keyStore && privateKey) {
      throw new Error(
        'CadreNodeConfig: `keyStore` and `privateKey` are mutually exclusive — ' +
        'configure at most one source for the node identity'
      );
    }

    if (keyStore) {
      // Shared with the embedding app: `reference-app-rn` resolves the very same
      // key before constructing this node so it can sign its ICE-manifest request
      // with it (identity-key.ts). One copy of the rule, so neither side can
      // drift into generating a second identity.
      this.identityKey = await loadOrCreateIdentityKey(keyStore, identityKeyId ?? DEFAULT_IDENTITY_KEY_ID);
      return;
    }

    if (privateKey) {
      this.identityKey = privateKey;
      return;
    }
    // Neither configured: libp2p generates an ephemeral key internally.
  }

  /**
   * Construct (or adopt) the node-local trusted-owner anchor and seed the
   * out-of-band pinned keys from `config.trustedOwners`. The store is NEVER
   * sourced from the replicated control DB — its entries come only from
   * genesis self-trust ({@link initializeSeedBootstrap}), config pins (here),
   * or runtime enrollment pins ({@link trustOwnerKeys}).
   *
   * Idempotent across stop()→start(): the store instance is kept, and
   * re-seeding config pins is a no-op ({@link TrustedOwnerStore.trust} is
   * idempotent). An injected store scoped to a different party is a
   * configuration error (fail closed before any network bring-up).
   */
  private async initializeTrustedOwnerStore(): Promise<void> {
    const { trustedOwners } = this.config;
    const partyId = this.config.controlNetwork.partyId;
    if (!this.trustedOwnerStore) {
      const store = trustedOwners?.store ?? new MemoryTrustedOwnerStore(partyId);
      if (store.partyId !== partyId) {
        throw new Error(
          `CadreNodeConfig: trustedOwners.store is scoped to party ${store.partyId}, ` +
          `but this node serves party ${partyId} — refusing to mix trust anchors`
        );
      }
      this.trustedOwnerStore = store;
    }
    // Validate every pin before trusting any: a malformed entry must not leave
    // earlier, valid pins anchored while start() then fails on a later one —
    // config pins land all-or-nothing, same as the runtime seam below.
    const pinnedKeys = (trustedOwners?.pinnedKeys ?? []).map(key => requireEd25519PublicKeyB64(key, 'pinned owner key'));
    for (const key of pinnedKeys) {
      await this.trustedOwnerStore.trust(key, trustedOwners?.pinnedSource ?? 'operator');
    }
  }

  /**
   * Construct (or adopt) the node-local cold-start bootstrap-peer store (see
   * {@link bootstrapPeerStore}). Synchronous: an injected store has already
   * loaded its persisted targets by the time it is handed in (its `open` is the
   * async part), and the in-memory fallback has nothing to load.
   *
   * Idempotent across stop()→start(): the store instance is kept, so retained
   * targets survive a restart of the same node instance even with the ephemeral
   * default. An injected store scoped to a different party is a configuration
   * error (fail closed before any network bring-up) — a foreign party's addresses
   * must never enter this node's dial loop.
   */
  private initializeBootstrapPeerStore(): void {
    const partyId = this.config.controlNetwork.partyId;
    if (this.bootstrapPeerStore) {
      return;
    }
    const store = this.config.bootstrapPeers?.store ?? new MemoryBootstrapPeerStore(partyId);
    if (store.partyId !== partyId) {
      throw new Error(
        `CadreNodeConfig: bootstrapPeers.store is scoped to party ${store.partyId}, ` +
        `but this node serves party ${partyId} — refusing to mix cold-start dial targets`
      );
    }
    this.bootstrapPeerStore = store;
  }

  /**
   * Construct (or adopt) the node-local enrolled-machine store and capture the
   * count this run will declare into {@link declaredEnrolledMachines}.
   *
   * Synchronous for the same reason {@link initializeBootstrapPeerStore} is: an
   * injected store has already loaded its persisted count by the time it is handed
   * in (its `open` is the async part), and the in-memory default has nothing to
   * load. Must run BEFORE {@link createControlNode} — that is the whole point of
   * the record; see `enrolled-machine-store.ts`.
   *
   * The store instance is kept across stop()→start() (so a count recorded during
   * the previous run is not lost with the ephemeral default), but the DECLARED
   * count is re-read every time — which is how a restart applies a number the
   * previous run learned.
   *
   * A store scoped to a different party is a configuration error, fail closed. It
   * is only a repair hint, but a hint sized by a foreign party's membership is a
   * number nobody chose, and the mismatch always means a miswired embedder.
   */
  private initializeEnrolledMachineStore(): void {
    const partyId = this.config.controlNetwork.partyId;
    const store = this.enrolledMachineStore
      ?? this.config.enrolledMachines?.store
      ?? new MemoryEnrolledMachineStore(partyId);
    if (store.partyId !== partyId) {
      throw new Error(
        `CadreNodeConfig: enrolledMachines.store is scoped to party ${store.partyId}, ` +
        `but this node serves party ${partyId} — refusing to size a repair yardstick from a foreign party`
      );
    }
    this.enrolledMachineStore = store;
    this.declaredEnrolledMachines = store.count();
    log('control repair yardstick will be declared from %o enrolled machine(s)', this.declaredEnrolledMachines);
  }

  /**
   * Construct (or adopt) the node-local joined-strand store (see
   * {@link joinedStrandStore}) and this session's {@link joinedStrands} over it.
   *
   * The store instance is kept across stop()→start(); the view is rebuilt. A store
   * scoped to a different party is a configuration error, fail closed: its joins
   * would be offered to this party's app as if this party had made them.
   */
  private initializeJoinedStrandStore(): void {
    const partyId = this.config.controlNetwork.partyId;
    const { keyStore } = this.config;
    const store = this.joinedStrandStore
      ?? this.config.joinedStrands?.store
      ?? (keyStore ? new KeyStoreJoinedStrandStore(keyStore, partyId) : new MemoryJoinedStrandStore(partyId));
    if (store.partyId !== partyId) {
      throw new Error(
        `CadreNodeConfig: joinedStrands.store is scoped to party ${store.partyId}, ` +
        `but this node serves party ${partyId} — refusing to offer another party's joined strands`
      );
    }
    this.joinedStrandStore = store;
    this.joinedStrands = new JoinedStrandSession(store, this.createPartyJoinedStrandLedger());
  }

  /**
   * Construct (or adopt) the node-local strand network state (see
   * {@link strandNetworkStateStore}). Synchronous for the reason
   * {@link initializeBootstrapPeerStore} is: an injected store has already loaded its
   * persisted entries by the time it is handed in, and the in-memory fallback has
   * nothing to load. The instance is kept across stop()→start(). A store scoped to a
   * different party is a configuration error, fail closed: another party's routing
   * tables must never be imported into this node's strands.
   */
  private initializeStrandNetworkStateStore(): void {
    const partyId = this.config.controlNetwork.partyId;
    if (this.strandNetworkStateStore) {
      return;
    }
    const store = this.config.strandNetworkState?.store ?? new MemoryStrandNetworkStateStore(partyId);
    if (store.partyId !== partyId) {
      throw new Error(
        `CadreNodeConfig: strandNetworkState.store is scoped to party ${store.partyId}, ` +
        `but this node serves party ${partyId} — refusing to mix strand network state`
      );
    }
    this.strandNetworkStateStore = store;
  }

  /**
   * The node-local enrolled-machine store (null before {@link start}) — what this
   * node last knew about its party's size. Exposed for diagnostics and for a host
   * that wants to show which repair yardstick the next launch will declare.
   */
  getEnrolledMachineStore(): EnrolledMachineStore | null {
    return this.enrolledMachineStore;
  }

  /**
   * The node-local bootstrap-peer store (null before {@link start}) — the dial
   * targets learned out of band that {@link reconcileControlCohort} falls back to.
   * Exposed for diagnostics and for a host that wants to show "what would this
   * node dial if it is stranded?".
   */
  getBootstrapPeerStore(): BootstrapPeerStore | null {
    return this.bootstrapPeerStore;
  }

  /**
   * The node-local strand network state (null before {@link start}) — per strand, the
   * state its strand node last saved and will re-import when next built. Exposed for
   * diagnostics and for a host that wants to show "what routing table would this
   * strand restart with?".
   */
  getStrandNetworkStateStore(): StrandNetworkStateStore | null {
    return this.strandNetworkStateStore;
  }

  /**
   * The node-local trusted-owner anchor (null before {@link start}). This is
   * the set the authorized-membership predicate and seed-trust anchor consult —
   * never the replicated `OwnerKey` table, which any stranger can pollute.
   */
  getTrustedOwnerStore(): TrustedOwnerStore | null {
    return this.trustedOwnerStore;
  }

  /**
   * Persist out-of-band-established owner keys into the node-local anchor —
   * the runtime enrollment seam: {@link redeemCadreInvitation} calls it with the
   * cadre invitation's `ownerKeys` BEFORE dialing a member (so the anchor already
   * holds the pins when the reply and the rows that follow are judged), and an
   * embedder calls it with an operator-supplied pin. Idempotent. ('genesis'
   * provenance is reserved for the node's own founding key, seeded internally by
   * {@link initializeSeedBootstrap}.)
   *
   * Validates every key's shape before trusting any of them (all-or-nothing):
   * a malformed entry anywhere in `keys` rejects the whole call before a
   * single key is anchored. For the invitation route this means a bundle
   * carrying one malformed `ownerKeys` entry fails the redemption outright —
   * consistent with the anchor's existing whole-record-or-nothing policy for
   * a corrupt persisted entry (see `trusted-owner-store.ts`'s
   * `unusableEntry: 'discard-all'`) — rather than silently anchoring a subset
   * and leaving the caller to notice a key went missing.
   */
  async trustOwnerKeys(keys: Iterable<string>, source: Exclude<TrustSource, 'genesis'>): Promise<void> {
    if (!this.trustedOwnerStore) {
      throw new Error('CadreNode must be started before trusting owner keys');
    }
    const validated = Array.from(keys, key => requireEd25519PublicKeyB64(key, 'pinned owner key'));
    for (const key of validated) {
      await this.trustedOwnerStore.trust(key, source);
    }
  }

  private async createControlNode(): Promise<Libp2p> {
    return await createLibp2pNode(this.buildControlNodeOptions());
  }

  /**
   * The control libp2p node's Optimystic network name — ONE binding for every
   * derivation from it (`db-p2p` namespaces all of the node's protocol ids as
   * `/optimystic/<networkName>/...`), so the node options and the block-transfer
   * protocol prefix the control backfill dials can never drift apart.
   *
   * NOTE: the party id goes in UNENCODED here, unlike in `controlStorageScope`. Safe
   * today because a party id is locally configured rather than replicated in, and both
   * ends of a connection derive this string identically — an odd party id yields an odd
   * but consistent protocol id, not a mismatch or an escaped name. If a party id ever
   * arrives from the network, encode it here as the storage scope key already does.
   */
  private controlNetworkName(): string {
    return `control-${this.config.controlNetwork.partyId}`;
  }

  /**
   * Arm the CONTROL network's peer-join block catch-up: push every block in the
   * control database's own raw store to each newly connected AUTHORIZED member
   * this runtime has not yet caught up. This is what physically replicates
   * control blocks committed while the writer was alone — the named
   * collection-header blocks written once at genesis above all, whose revision
   * never moves again, so no later commit ever carries them to a member that
   * joined after them. Without it, such a member that restarts offline reads
   * the affected control tables as EMPTY, silently (`isMember()` answers false
   * for peers it knew about before the restart).
   *
   * Unlike the per-strand instances (see `strand-instance-manager.ts`), pushes
   * are gated on {@link isAuthorizedMember}, judged at push time: the control
   * network's inbound connection gate deliberately admits non-members in
   * several states (seed delivery to an un-enrolled node, an open enrollment
   * window, an outstanding invitation, configured bootstrap/relay peers), and
   * pushing the whole control store to such a peer would hand a stranger the
   * party's entire membership, addresses and strand list. The receiving side
   * needs no work of its own: `createLibp2pNode` registers the block-transfer
   * handler on every node it builds, control node included, and this node's
   * per-stream gate (`authorizeInboundControlStream`) covers the inbound
   * direction. A denied peer is retried on its next `peer:identify` (a
   * reconnect re-runs identify), and — because the production join order is
   * connect-then-authorize — on every committed membership change via
   * {@link refreshAuthorizedControlPeers}'s `scheduleConnectedPeers()` call.
   * The one non-member the gate admits is a device whose invitation
   * redemption this member is admitting ({@link catchUpRedeemingDevice}).
   *
   * No-ops (logged) when the embedder configured no control storage or the
   * node exposes no key network — the backfill would have nothing to read or
   * no way to dial.
   */
  private startControlBackfill(): void {
    if (this.config.controlBackfill?.enabled === false || !this.controlNode) {
      return;
    }
    // Through the resolver, not the {@link controlStorage} memo field: the resolver is
    // idempotent (it returns the same wrapped store `buildControlNodeOptions` already
    // resolved), so the catch-up cannot be silently disarmed by a future reordering that
    // moves this call ahead of the one that populated the field.
    const storage = this.resolveControlStorage();
    const keyNetwork = (this.controlNode as Libp2pNodeWithRepo).keyNetwork;
    if (!storage || !keyNetwork) {
      log('Control peer-join block catch-up is inert: %s',
        !storage ? 'no control storage configured' : 'control node exposes no keyNetwork');
      return;
    }
    const networkName = this.controlNetworkName();
    this.controlBackfill = new PeerJoinBackfill({
      label: networkName,
      libp2p: this.controlNode,
      peerNetwork: keyNetwork,
      storage,
      // The same prefix the receiver registered its block-transfer handler
      // under — derived from the same networkName binding the node options
      // used, never re-spelled here.
      protocolPrefix: `/optimystic/${networkName}`,
      authorizePeer: async (peerId) => this.admittingDevices.has(peerId) || await this.isAuthorizedMember(peerId)
    }, {
      // A shorter settle window than the strand default (1000 ms): the control
      // store is small (a party's membership — dozens of blocks), a re-push is
      // idempotent, and the window a joiner is connected before going offline
      // can be short (converge one row, then stop) — a slow debounce is the
      // difference between that joiner holding the collection headers and
      // reading its own membership as empty after an offline restart.
      //
      // NOTE: 250 is reasoned, not swept — the delete-while-alone scenario's
      // phases 1-3 finish in about a second, so the 1000 ms strand default left
      // the push racing the joiner's stop, and 250 gives margin. Nobody measured
      // the shape of the curve either side of it. If the control gates start
      // flaking on a joiner that stopped before being caught up, lower this
      // before looking anywhere else; if catch-up pushes start showing up as
      // connection-churn noise, raise it.
      debounceMs: 250,
      // Dial and response deadlines counted in link round trips, not fixed milliseconds — a
      // relayed dial that cannot finish inside the budget fails identically on every retry.
      // See `link-budget.ts`. Spread BEFORE the host's own config so an explicit
      // `controlBackfill.dialTimeoutMs` still wins.
      ...peerJoinPushBudget(this.config.network?.linkRoundTripMs),
      ...this.config.controlBackfill
    });
    this.controlBackfill.start();
  }

  /**
   * Push this member's control store to a device whose invitation redemption has verified,
   * and wait for the push, before the redemption writes the device's rows (the handler's
   * `catchUpDevice`; `CadreInviteHandler.catchUpDeviceIfLive` says why the write needs it).
   * The device is admitted at the backfill's gate for the length of the push only.
   *
   * Through {@link PeerJoinBackfill.forceCatchUpPeer}, not `catchUpPeer`: the device's own
   * `peer:identify` scheduled a run a moment earlier, which was denied if it passed the gate
   * before the device was added here, and `catchUpPeer` would answer that run's in-flight
   * status with an empty result.
   */
  private async catchUpRedeemingDevice(peerId: string): Promise<void> {
    const backfill = this.controlBackfill;
    if (!backfill) {
      log('No control backfill on this node; device %s is not caught up before its admission', peerId);
      return;
    }
    this.admittingDevices.set(peerId, (this.admittingDevices.get(peerId) ?? 0) + 1);
    try {
      const result = await backfill.forceCatchUpPeer(peerIdFromString(peerId));
      log('Device %s caught up before its admission: offered=%d accepted=%d rejected=%d',
        peerId, result.offered, result.accepted, result.rejected.length);
    } finally {
      const remaining = (this.admittingDevices.get(peerId) ?? 1) - 1;
      if (remaining > 0) {
        this.admittingDevices.set(peerId, remaining);
      } else {
        this.admittingDevices.delete(peerId);
      }
    }
  }

  /**
   * The control database's cache-wrapped raw storage, resolved from
   * `config.storage.provider` on first use and then held in {@link controlStorage}
   * for the rest of this runtime.
   *
   * Resolving once is the contract `RawStorageProvider` (types.ts) states: a provider is
   * called once per scope per runtime lifetime. Re-entering it per call would mint a
   * second store over one backend — a fresh, cold cache, with the previous wrapper's
   * registration orphaned in the process-wide pool.
   *
   * Lazy rather than eager in `start()` so the pure-unit call path
   * (`cadre-node-control-node-options.spec.ts` calls `buildControlNodeOptions` on a
   * bare `new CadreNode`) still resolves — and, on that path too, only once.
   *
   * Wrapped in the write-through raw-storage cache (quereus-plugin-sereus's
   * `cached-storage.ts`) because a control start's cost is its raw-storage
   * operation count.
   */
  private resolveControlStorage(): IRawStorage | undefined {
    if (this.controlStorage) {
      return this.controlStorage;
    }
    const provider = this.config.storage?.provider;
    if (!provider) {
      return undefined;
    }
    // Party-scoped, not the bare literal 'control': the control database holds THIS
    // party's records, so two parties on one device must not land in one store.
    // Same key as the cache label, which also makes the shared pool's `stats()` readable.
    const scope = controlStorageScope(this.config.controlNetwork.partyId);
    // The second seam that hands a scope key to an embedder's provider; the first
    // (`StrandInstanceManager.startStrand`) asserts the stricter strand rule. Holds by
    // construction today — lowercase hex is inside the charset — so this guards a future
    // edit to `controlStorageScope`, not a reachable input.
    assertScopeKeyCharset(scope);
    const resolved = typeof provider === 'function' ? provider(scope) : provider;
    this.controlStorage = wrapStorageWithCache(resolved, scope);
    return this.controlStorage;
  }

  /**
   * Warn the operator when `network.announceAddrs` will silently cost this node the
   * relay reachability it also configured.
   *
   * A non-empty announce set REPLACES everything libp2p advertises, so the
   * `/p2p-circuit` address earned by a relay reservation is dropped from the node's
   * advertised addresses even though the reservation itself is still held — peers
   * behind NAT stop being able to reach it through that relay. Not an error: an
   * operator whose relay slot is decorative may genuinely want only the announced
   * address, so this reports and proceeds.
   *
   * Keyed off `relayAddrs` AND `listenAddrs`, so a hand-written `/p2p-circuit` entry
   * in `listenAddrs` — a reservation by the longer route — is caught too.
   *
   * NOTE: the only direct `console.*` in this library — a boot-time operator warning, not a
   * diagnostic trace (those use `debug`, which an operator never sees without `DEBUG=`). If a
   * second such warning ever appears here, route both through a `CadreNodeEvents` entry the
   * embedder surfaces instead of growing a console surface inside a library.
   */
  private warnIfAnnounceAddrsDiscardRelay(): void {
    const network = this.config.network;
    if (!replacesAdvertisedAddrs(network)) {
      return;
    }
    // Read off the raw config, not the resolved listen set: the question is only
    // "does this config name a relay", and the resolution throws on a hand-written
    // `<relay>/p2p-circuit` listen entry — which still warrants this warning, and
    // gets its own refusal a few lines later in `buildControlNodeOptions`.
    const namesRelay = (network?.relayAddrs?.length ?? 0) > 0
      || (network?.listenAddrs ?? []).some((addr) => addr.includes('/p2p-circuit'));
    if (!namesRelay) {
      return;
    }
    console.warn(
      'network.announceAddrs is set alongside a circuit-relay listener (from network.relayAddrs, ' +
      'or a /p2p-circuit entry in network.listenAddrs). A non-empty announce set REPLACES every ' +
      'address this node advertises, so the /p2p-circuit address earned from the relay reservation ' +
      'will not be advertised and peers will stop reaching this node through that relay. ' +
      'Use network.appendAnnounceAddrs instead to advertise an extra address without discarding the rest.'
    );
  }

  /**
   * Map this node's config onto the control network's libp2p node options.
   *
   * Split out of {@link createControlNode} purely so the mapping is assertable without
   * standing up a real libp2p node — `packages/cadre-core/test/cadre-node-control-node-options.spec.ts`
   * calls it on a bare `new CadreNode(config)`. Read nothing else into the split; the
   * only caller in production is `createControlNode`.
   */
  private buildControlNodeOptions(): Parameters<typeof createLibp2pNode>[0] {
    const { network, profile } = this.config;
    const identityKey = this.identityKey;
    // `network.relayAddrs` contributes the bare `/p2p-circuit` SEARCH entry, which
    // opens no connection — the reservation is driven explicitly at the END of
    // `start()`, so the control database is built while this node holds zero
    // control connections. See `relay-addrs.ts` and `start()`.
    const listenAddrs = resolveListenAddrs(network);
    // The transports those listen entries imply. A `/ws` entry switches db-p2p's
    // WebSocket transport on (without it the entry binds nothing and libp2p reports
    // nothing); anything outside {tcp, ws/wss, p2p-circuit} throws here rather than
    // being silently dropped at bring-up. See `relay-addrs.ts`.
    const transportOptions = resolveTransportOptions(network, listenAddrs);

    // The control node's own storage, resolved once per runtime (see
    // {@link resolveControlStorage}) rather than per call.
    const controlStorageProvider = this.resolveControlStorage();

    const nodeOptions: Parameters<typeof createLibp2pNode>[0] = {
      port: 0,
      // Empty on purpose: Optimystic refuses to treat a block as never-created until it has
      // heard from every `bootstrapNodes` peer, and the bring-up quiet period refuses those
      // dials, so a non-empty list fails start() with `cohort-unreachable`. The configured
      // peers are dialed once bring-up ends ({@link dialControlBootstrapPeers}).
      bootstrapNodes: [],
      networkName: this.controlNetworkName(),
      storage: controlStorageProvider,
      fretProfile: profile === 'storage' ? 'core' : 'edge',
      relay: this.relayServer.enabled,
      // Merged party-run defaults: no per-connection data/duration cap, a store sized for
      // one party's NAT'd machines. Strand nodes get the same init (`relay-server.ts`).
      ...(this.relayServer.enabled && { relayServerInit: this.relayServer.init }),
      // Fixed, and deliberately above any party's node count: every member reads the
      // whole control database, so a cohort that excludes a member leaves it dependent
      // on read repair — which cannot converge at a two-member cohort. Not a knob;
      // see CONTROL_REPLICATION_BREADTH. `assumedClusterSize: 2` is declared explicitly in
      // CONTROL_CLUSTER_POLICY: only the admission gate defaults to 2, while the read-repair
      // corroboration floor would otherwise fall back to this clusterSize of 16.
      clusterSize: CONTROL_REPLICATION_BREADTH,
      // The base control policy with the block-repair corroboration yardstick declared
      // from the machines this party had enrolled at this node's last look
      // ({@link declaredEnrolledMachines}, read in start() before this runs). Handed
      // `undefined` — a brand-new node, an unreadable record, or an embedder that
      // injected no store — this returns the frozen CONTROL_CLUSTER_POLICY object
      // itself, so the unknown case is provably byte-for-byte the old behaviour.
      // The yardstick moves ALONE: `assumedClusterSize` stays pinned at 2, because a
      // party of phones cannot promise three quarters of its machines are awake.
      // The read deadline is the host's own, else two link round trips at the declared
      // `linkRoundTripMs`, else nothing — the frozen constant already carries the same
      // derivation at the default declaration (`link-budget.ts`). With neither declared this
      // is still the frozen constant by identity, which is the production path. A degenerate
      // deadline is Optimystic's to refuse, in createControlNode below.
      clusterPolicy: controlClusterPolicy({
        enrolledMachines: this.declaredEnrolledMachines,
        cohortQueryTimeoutMs: declaredCohortReadDeadlineMs(network)
      }),
      arachnode: { enableRingZulu: profile === 'storage' },
      ...(identityKey && { privateKey: identityKey }),
      ...(network?.transports && { transports: network.transports }),
      ...(network?.noiseCrypto && { noiseCrypto: network.noiseCrypto }),
      // Always present, unlike the conditional spreads around it: an absent
      // `connectionMonitor` would leave libp2p's 5s ping deadline, which drops a peer
      // whose event loop is saturated by pure-JS Noise crypto. A configured value
      // replaces the default whole (see DEFAULT_CONNECTION_MONITOR).
      connectionMonitor: network?.connectionMonitor ?? DEFAULT_CONNECTION_MONITOR,
      // The declared link every cadre budget is derived from, stated to Optimystic too so it
      // derives its own deadlines from the same number: its request responses, its block
      // pushes, and libp2p's `inboundUpgradeTimeout`. Always stated, default included:
      // undeclared, Optimystic keeps LAN deadlines that cannot open a relayed connection at the
      // link sereus supports (`link-budget.ts`).
      linkRoundTripMs: resolveLinkRoundTripMs(network?.linkRoundTripMs),
      // The three limits on opening a connection (libp2p's per-address and whole-dial limits,
      // and Optimystic's request dial): Optimystic's derivation from the same link plus the
      // relay's and the called machine's admission decisions, which run on this dial's clock.
      ...optimysticDialLimits(network?.linkRoundTripMs),
      // `{ wsPort }` when a listen entry names WebSocket, otherwise `{}` — and always
      // `{}` when `network.transports` is set, since the embedder owns transport policy
      // then. Spread NEXT to `transports` because the two answer the same question.
      ...transportOptions,
      // Configured `listenAddrs`, plus the bare `/p2p-circuit` search listener when
      // `network.relayAddrs` is set — that listener registers the pending reservation
      // `driveControlRelayReservation` fills after bring-up.
      ...(listenAddrs && { listenAddrs }),
      // What this node ADVERTISES, which is not the same question as what it binds.
      // Either field is present only when configured non-empty; a non-empty
      // `announceAddrs` replaces the advertised set (see warnIfAnnounceAddrsDiscardRelay).
      ...resolveAnnounceAddrs(network),
      // The CONTROL node composes the membership admission gate onto any
      // caller-supplied gater (deny from either wins on the inbound-encrypted
      // and relay-reservation hooks; all other hooks pass through). Strand
      // cohort nodes keep the raw configured gater (see
      // strand-instance-manager.ts) — their peers are legitimately
      // cross-party, so cadre membership must not gate them.
      connectionGater: createMembershipConnectionGater(
        {
          admitInbound: (remotePeerId) => this.admitInboundControlConnection(remotePeerId),
          admitRelayReservation: (remotePeerId) => this.admitControlRelayReservation(remotePeerId),
          bringUpInFlight: () => this.controlBringUpInFlight
        },
        network?.connectionGater,
        ADMISSION_DECISION_TIMEOUT_MS,
        relayAdmissionReserveDeadlineMs(network?.linkRoundTripMs)
      ),
      // Fail-closed per-stream authorization for the four Optimystic control-DB
      // protocols — the members-only layer the connection gater's stranger
      // carve-outs cannot express (see authorizeInboundControlStream). Control
      // node only: strand cohort nodes serve cross-party peers.
      authorizeInboundStream: (remotePeerId, protocol) =>
        this.authorizeInboundControlStream(remotePeerId, protocol)
    };

    return nodeOptions;
  }

  /**
   * One debug line naming what this machine's relay server forwards and holds —
   * the same fields the dedicated relay container prints at boot
   * (`ops/docker/libp2p-infra/src/main.ts`). Once per start, not per strand:
   * strand nodes resolve the same settings from the same config.
   */
  private logRelayServerSettings(): void {
    if (!this.relayServer.enabled) {
      return;
    }
    const { applyDefaultLimit, maxReservations, reservationTtl } = this.relayServer.init.reservations;
    log('Relay server on: applyDefaultLimit=%s maxReservations=%d reservationTtl=%dms unauthorizedCap=%d',
      applyDefaultLimit, maxReservations, reservationTtl, this.unauthorizedRelayReservations.cap);
  }

  /**
   * Decide whether an inbound CONTROL-network connection from `remotePeerId`
   * should be admitted — the policy behind the connection gater wired in
   * {@link createControlNode}. Deny only on a positive "unauthorized outsider
   * while no stranger path is open" determination; everything ambiguous admits
   * and defers to the fail-closed per-stream gates (see
   * `membership-connection-gater.ts` for the layer's rationale and the
   * stranger-open protocol allowlist).
   *
   * Returns `'admit'` when ANY of:
   *  1. a shared-baseline check admits ({@link admitControlPeerUnconditionally}
   *     — not running / DB torn down, absent-or-empty trusted-owner anchor, or
   *     configured bootstrap/relay infrastructure);
   *  2. the peer holds a live DELEGATE ADMISSION GRANT — an authorized member
   *     announced it (over the strand-addr RPC) as the transport peerId of its
   *     own strand node, so a NAT'd member's strand node can hold a
   *     circuit-relay reservation here (see `delegate-admission.ts`).
   *     Connection only: the per-stream gate below never honors a grant;
   *  3. the authorized-member set is empty — cold start: the rows that would
   *     authorize anyone arrive by replication over these very connections;
   *  4. the peer IS an authorized member; or
   *  5. an open invitation is OUTSTANDING — at least one unexpired,
   *     not-fully-consumed invitation this node minted or persisted (see
   *     `StrandSolicitationService.hasOutstandingInvitation`). A formation
   *     initiator is another party's peer by design and its token is only
   *     checkable inside the protocol, so the gate asks the coarser question
   *     "does this node expect a stranger at all?". REGISTERING the responder
   *     does not suspend stranger denial: every node registers one at
   *     {@link start}, and registering mints no invitation; or
   *  6. a LIVE cadre invitation exists — a `CadreInvite` row this node holds
   *     that is not withdrawn, unexpired, has uses left and whose issuer is
   *     still an owner (`ControlDatabase.hasLiveCadreInvite`). The device that
   *     redeems it is a stranger until the redemption writes its row, and its
   *     proof of possession is only checkable inside `/sereus/cadre-invite/1.0.0`;
   *     same reasoning as check 5, and the same expectation-of-a-stranger key.
   *     NOTE: keyed on the row being HELD here, so a member that has not yet
   *     received the row by replication denies the device although the bundle
   *     carries the row (`createCadreInvitation`); the device's dial fails and it
   *     tries the next address. Whether the gate should admit such a device is
   *     the blocked ticket `decide-cadre-invite-redeemed-before-the-row-replicates`.
   *
   * Ordering is semantically free (the checks are OR'd) but decides who pays:
   * checks 1-2 are in-memory, 3/4 share one control-DB read, and only a peer
   * already on the deny path reaches check 5's and 6's invitation lookups.
   *
   * Caveats of check 5, both self-healing:
   *  - the in-memory mint registry dies with the process, so after a restart
   *    only invitations persisted as `FormationInvite` rows still hold the
   *    exemption open (re-mint otherwise);
   *  - a peer holding a token whose `FormationInvite` row has not replicated to
   *    this node yet is denied even though the formation handler would have
   *    accepted it, exactly like the unreplicated-membership-row case below.
   *
   * When every check falls through, the verdict depends on whether this node
   * runs the circuit-relay server ({@link relayServer}): without one,
   * `'deny'`; with one, `'admit-for-relay'` — a circuit-relay reservation is
   * established by the reserving peer DIALING the relay, so a connection deny
   * here kills the reservation, and that deny is NOT self-healing: an outbound
   * reconcile re-dial re-establishes a data link, but no outbound dial can
   * grant the remote peer a reservation, and a relay-only peer has no address
   * of its own to dial back — the reservation IS its address. The gater admits
   * such a connection, decides the reservation via
   * {@link admitControlRelayReservation}, and drops the connection if no
   * reservation is admitted in time (see `membership-connection-gater.ts` →
   * "The relay-reservation seam").
   *
   * NOTE: check 3/4 runs a control-DB read per inbound connection
   * (`listAuthorizedMembers`); connections are rare and cadres small, and this
   * layer is fail-open behind `ADMISSION_DECISION_TIMEOUT_MS`, so the live
   * read is safe here — unlike the per-stream gate, which must consult the
   * materialized {@link authorizedControlPeers} snapshot instead.
   * NOTE: checks 5 and 6 add two more control reads (`hasOutstandingFormationInvite`,
   * `hasLiveCadreInvite`) for a stranger with no locally minted invitation in play, on
   * every node now that every node runs both responders — a relay-enabled storage node
   * included. If stranger connections to such a node ever arrive fast enough for those
   * reads to show, cache the answers for a few seconds.
   * NOTE: on a relay-DISABLED node, a sibling whose membership row has not yet
   * replicated here is denied until the row converges (typically via the
   * owner); either side's next outbound reconcile dial (outbound is never
   * gated) re-establishes the DATA link — self-healing for data, visible as a
   * transient deny. That self-healing story never covered a reservation, which
   * is exactly why the relay-enabled path above exists.
   */
  private async admitInboundControlConnection(remotePeerId: string): Promise<InboundConnectionVerdict> {
    if (this.admitControlPeerUnconditionally(remotePeerId)) {
      return 'admit';
    }
    if (this.delegateAdmission.has(remotePeerId)) {
      return 'admit';
    }
    const authorized = await this.listAuthorizedMembers();
    if (authorized.length === 0) {
      return 'admit';
    }
    if (authorized.some((m) => m.peerId === remotePeerId)) {
      return 'admit';
    }
    try {
      if (await this.strandSolicitationService?.hasOutstandingInvitation()) {
        return 'admit';
      }
      if (await this.controlDatabase?.hasLiveCadreInvite()) {
        return 'admit';
      }
    } catch (error) {
      log('admitInboundControlConnection: outstanding-invitation check threw for %s — admitting (fail-open): %o', remotePeerId, error);
      return 'admit';
    }
    if (this.relayServer.enabled) {
      log('admitInboundControlConnection: admitting %s FOR RELAY ONLY — not an authorized member and no enrollment path open; the gater drops the connection unless a reservation is admitted', remotePeerId);
      return 'admit-for-relay';
    }
    log('admitInboundControlConnection: DENYING inbound from %s — not an authorized member and no enrollment path open', remotePeerId);
    return 'deny';
  }

  /**
   * Should `remotePeerId` be granted a circuit-relay reservation slot on this
   * node's relay server? The policy behind the gater's
   * `denyInboundRelayReservation` hook (see `membership-connection-gater.ts` →
   * "The relay-reservation seam"); the circuit-relay server consults it per
   * RESERVE request, so it is never called on a node whose relay server is off.
   *
   * Admits when ANY of:
   *  1. a shared-baseline check admits ({@link admitControlPeerUnconditionally}
   *     — not running / DB torn down, absent-or-empty trusted-owner anchor, or
   *     configured bootstrap/relay infrastructure);
   *  2. the peer holds a live delegate admission grant — a member's strand
   *     node reserving here (see `delegate-admission.ts`); never counted
   *     against the unauthorized budget;
   *  3. the authorized-member set is empty (cold start) or the peer IS an
   *     authorized member — members are never counted against the budget; or
   *  4. the peer takes (or already holds) a slot in the bounded
   *     unauthorized-reservation budget — the boot-ordering window where a
   *     genuine member reserves before its `CadrePeer` row replicates here.
   *     Cap via `network.unauthorizedRelayReservationCap` (0 = refuse every
   *     unauthorized reservation).
   *
   * Every uncounted admission also RELEASES the budget slot the peer may hold
   * from an earlier reservation taken while it was still unplaceable — a member
   * that boots, reserves, and only then has its row replicate here would
   * otherwise keep that slot spent for the rest of the entry's TTL.
   *
   * The connection gate's stranger carve-outs (an outstanding formation
   * invitation, a live cadre invitation) deliberately do NOT extend here: they
   * exist so a stranger's FORMATION or CADRE-INVITE stream can ride a connection,
   * and neither needs relay capacity. A genuine invitee that does need a relay
   * slot takes one from the budget like any other unplaced peer, so a live
   * invitation never becomes an unbounded grant of this node's forwarding capacity.
   */
  private async admitControlRelayReservation(remotePeerId: string): Promise<boolean> {
    if (this.admitControlPeerUnconditionally(remotePeerId)) {
      return this.admitReservationUncounted(remotePeerId);
    }
    if (this.delegateAdmission.has(remotePeerId)) {
      return this.admitReservationUncounted(remotePeerId);
    }
    const authorized = await this.listAuthorizedMembers();
    if (authorized.length === 0 || authorized.some((m) => m.peerId === remotePeerId)) {
      return this.admitReservationUncounted(remotePeerId);
    }
    const admitted = this.unauthorizedRelayReservations.tryAdmit(remotePeerId);
    log('admitControlRelayReservation: %s %s under the unauthorized-reservation budget',
      admitted ? 'admitting' : 'REFUSING', remotePeerId);
    return admitted;
  }

  /** Admit a reservation on the peer's own merits, giving back any budget slot it still holds. */
  private admitReservationUncounted(remotePeerId: string): true {
    this.unauthorizedRelayReservations.release(remotePeerId);
    return true;
  }

  /**
   * Record (or refresh) a delegate admission grant: `delegatePeerId` is the
   * transport peerId of `announcerPeerId`'s strand-`strandId` node, admitted
   * at the CONNECTION and RESERVATION levels (all a circuit-relay reservation
   * needs, without spending the unauthorized-reservation budget) for
   * `DELEGATE_GRANT_TTL_MS`. Called by the strand-addr responder after its
   * authorized-membership gate has passed; public so tests can drive the
   * admission policy without a full strand launch. A re-announce for the same
   * (announcer, strand) REPLACES the previous delegate rather than
   * accumulating. Never honored by {@link authorizeInboundControlStream}.
   */
  grantDelegateAdmission(announcerPeerId: string, strandId: string, delegatePeerId: string): void {
    this.delegateAdmission.grant(announcerPeerId, strandId, delegatePeerId);
  }

  /** Is `remotePeerId` covered by a live delegate admission grant? */
  hasDelegateAdmission(remotePeerId: string): boolean {
    return this.delegateAdmission.has(remotePeerId);
  }

  /**
   * The admission checks SHARED by the connection gate
   * ({@link admitInboundControlConnection}) and the per-stream control-DB gate
   * ({@link authorizeInboundControlStream}) — factored so the two layers cannot
   * drift. All in-memory and cheap (the stream gate runs this per inbound
   * stream). Returns true when the peer must be admitted BEFORE any membership
   * source is consulted:
   *  - the node is not fully up (`start()` in progress / DB torn down) — both
   *    gates exist from libp2p bring-up, before the control DB does;
   *  - the trusted-owner anchor is absent or empty — an un-enrolled node has
   *    no basis to judge anyone and MUST accept its enrollment seed;
   *  - the peer is one of the configured control bootstrap/relay nodes —
   *    operator-configured infrastructure, not cadre members.
   * False only means "no unconditional admit": the caller then judges the peer
   * against its own membership source (a live DB read for the fail-open
   * connection gate; the materialized snapshot for the fail-closed stream gate).
   */
  private admitControlPeerUnconditionally(remotePeerId: string): boolean {
    if (!this._running || !this.controlDatabase) {
      return true;
    }
    if (!this.trustedOwnerStore || this.trustedOwnerStore.all().size === 0) {
      return true;
    }
    return this.getBootstrapPeerIds().has(remotePeerId);
  }

  /**
   * Per-stream authorization for the four Optimystic control-DB protocols
   * (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`),
   * wired as `authorizeInboundStream` in {@link createControlNode} — the
   * fail-closed layer behind the fail-open connection gater. Control node
   * ONLY: strand cohort nodes legitimately serve cross-party peers.
   *
   * The STRICT SUBSET of {@link admitInboundControlConnection}: the same
   * "no basis to judge" admissions (shared via
   * {@link admitControlPeerUnconditionally}), minus the stranger carve-outs
   * (outstanding open invitation, live cadre invitation, delegate admission
   * grant). The first two exist so a stranger can reach `/sereus/formation/1.0.0`
   * and `/sereus/cadre-invite/1.0.0` — neither is gated here, and admitting a
   * stranger to `repo` while an invitation is live is exactly the hole this
   * gate closes. A DELEGATE-admitted connection (a member's strand node
   * holding a circuit-relay reservation, see `delegate-admission.ts`) is
   * likewise exactly a case this gate must still refuse: the delegate gets
   * the connection and never the control DB.
   *
   * Admits when ANY of:
   *  1. a shared-baseline check admits (not running / no DB, empty anchor,
   *     configured bootstrap infra);
   *  2. the materialized authorized set is empty — cold start, before the
   *     rows that would authorize anyone have replicated in;
   *  3. the peer IS in the materialized authorized set.
   *
   * Deliberately SYNCHRONOUS and pure in-memory — see
   * {@link authorizedControlPeers} for why a control-DB read here would
   * deadlock into mutual denial. With a sync predicate the upstream deadline
   * (`authorizeInboundStreamTimeoutMs`) never trips, so it stays at its
   * default.
   *
   * NOTE: the snapshot keys on PEER ID, so a node with no persistent identity
   * key never lands a `CadrePeer` row ({@link registerSelf} skips) and its
   * siblings deny its control-DB streams once their own snapshot is non-empty —
   * owner status is a KEY, not a peer id, so being the owner does not exempt it.
   * Harmless today (a real deployment persists its identity; the ephemeral-owner
   * case appears only in tests, which configure the owner as bootstrap infra —
   * `push-wake-e2e.integration.ts` design note 3). If an ephemeral-identity node
   * ever becomes a supported deployment, this gate needs a key-based admission.
   */
  private authorizeInboundControlStream(remotePeerId: string, protocol: string): boolean {
    if (this.admitControlPeerUnconditionally(remotePeerId)) {
      return true;
    }
    if (this.authorizedControlPeers.size === 0) {
      return true;
    }
    if (this.authorizedControlPeers.has(remotePeerId)) {
      return true;
    }
    // Upstream logs its own denial line; this one carries the WHY.
    log('authorizeInboundControlStream: DENYING %s on %s — not in the materialized authorized set (%d member(s))',
      remotePeerId, protocol, this.authorizedControlPeers.size);
    return false;
  }

  /**
   * Refresh {@link authorizedControlPeers} from the control DB, best-effort: a
   * failed read keeps the previous snapshot (never clears it), so a transient
   * DB error can neither flip the stream gate's cold-start carve-out back open
   * nor drop a legitimate member mid-flight. Never rejects.
   *
   * The SOLE caller is {@link drainMembershipGate}, which serializes refreshes —
   * so two reads can no longer settle out of order.
   *
   * Reads WITHOUT the transient-failure retry, deliberately: `ControlDatabase` drives
   * this listener with its write lock HELD (`notifyMembershipChanged`), so a retrying
   * read here would sleep its backoff holding the lock and stall every other local
   * writer. Nothing is lost — this refresh already keeps the previous snapshot on
   * failure and is re-driven by the next membership write and by the timed reconcile.
   */
  private async refreshAuthorizedControlPeers(reason: string): Promise<void> {
    if (!this._running || !this.controlDatabase) {
      return;
    }
    try {
      const members = await this.listAuthorizedMembers(false);
      this.authorizedControlPeers = new Set(members.map((m) => m.peerId));
      log('refreshAuthorizedControlPeers(%s): %d authorized peer(s)', reason, this.authorizedControlPeers.size);
      // Remember the party's size for the NEXT launch's control-node repair yardstick
      // (see `enrolled-machine-store.ts`): this is the only place the count is known,
      // and the control node that needs it was built long before this ran. Recorded
      // from the snapshot just materialized — no second membership query.
      //
      // CONTROL-NETWORK ONLY, and that scope is load-bearing. Every enrolled machine
      // runs the control node by construction, so here the party's machine count IS
      // the count of machines serving the network — the quantity
      // `resolveRepairYardstick` asks for. It is NOT that quantity for a strand, which
      // launches only on machines whose embedder registered its sApp config (see
      // {@link addStrand}) plus storage-profile machines hosting it as a storage replica
      // ({@link CadreNodeConfig.hostUnclaimedStrands}) whose filter admits it — phones
      // serve only what their app claims — so this number must never be routed to a strand node:
      // over-declaring pins Optimystic's repair corroboration floor at two peers and a
      // strand that can field only one can then never repair. `launchStrand` therefore
      // declares nothing; see the NOTE there.
      //
      // `+ 1` for this node, which is not in its own authorized set. An EMPTY snapshot
      // is recorded as 1 rather than skipped. That is deliberate, and the reason
      // is a party that genuinely SHRANK: if empty meant "record nothing", a party
      // whose other machines were all revoked would keep declaring its old, larger
      // number forever, and over-declaring is the unsafe direction — at a yardstick of
      // 3 or more Optimystic pins the repair corroboration floor at two peers, so a
      // cohort that can only field one peer could never repair at all. Recording 1
      // lets the number come back down; the floor then turns it into 2, which is
      // exactly what declaring nothing resolves to.
      //
      // NOTE: the cost of that choice is that a TRANSIENT empty read overwrites a good
      // remembered count with 1 — a membership snapshot is legitimately empty early in
      // a run on a node whose rows have not replicated yet or whose trusted-owner
      // anchor is still unseeded (`listAuthorizedMembers` authorizes no one without an
      // anchor). Bounded and safe: the next refresh once rows land re-records the real
      // count, and the only node that loses anything is one stopped inside that window,
      // which then declares 2 — today's behaviour — on its next launch. If a node ever
      // needs to declare the right number on its FIRST post-restart launch, the fix is
      // to distinguish "no rows yet" from "no members" at this site, not to skip empty.
      //
      // A removed peer stops counting at REVOCATION, not at reap: `queryCadrePeers`
      // drops rows whose `StampId` is retired, and `listAuthorizedMembers` reads
      // through it. That is why there is no reap hook writing this record.
      //
      // `void`: the store never rejects and logs its own persist failures, and this
      // method's contract is never-rejects. A failed write leaves the in-memory count
      // correct for this session and re-lands on the next refresh.
      void this.enrolledMachineStore?.record(this.authorizedControlPeers.size + 1);
      // Membership moved: give the control backfill another look at every
      // connected peer. The production join order is connect-then-authorize, so
      // a joiner's first catch-up pass was denied at the gate while its
      // connection stays up — without this re-arm it would wait for a
      // reconnect. Cheap and idempotent: caught-up peers are skipped before any
      // timer is set, a peer whose pass is in flight is deferred to the end of
      // that pass (the pass may already be past its gate check — this very
      // commit is what would authorize it), and the gate re-judges at push time.
      //
      // NOTE: every refresh re-arms every connected peer that is not yet caught
      // up, and each re-armed pass costs one `CadrePeer` query at the gate. A
      // connection that is admitted but never authorized — a configured
      // bootstrap or relay peer, the steady state for a NAT'd node — is
      // therefore re-judged on every membership write and every timed reconcile
      // tick, forever. Negligible at a cadre's handful of connections; if a node
      // ever holds many such connections, or refreshes get frequent, skip
      // re-arming peers whose last pass was denied under the SAME membership
      // snapshot instead of re-arming unconditionally.
      void this.controlBackfill?.scheduleConnectedPeers();
    } catch (error) {
      log('refreshAuthorizedControlPeers(%s) failed — keeping previous snapshot: %o', reason, error);
    }
  }

  /**
   * Add the configured `controlNetwork.bootstrapNodes` to the control node's address book
   * and dial each peer once — what `@libp2p/bootstrap` would have done had the node been
   * built with them. Best-effort: a failed dial is logged, and the connection manager and
   * FRET reconnect from the address book as they do for any known peer.
   */
  private async dialControlBootstrapPeers(): Promise<void> {
    const node = this.controlNode;
    if (!node) {
      return;
    }
    const groups = groupAddrsByPeerId(this.config.controlNetwork.bootstrapNodes);
    await Promise.all([...groups].map(async ([peerId, addrs]) => {
      if (peerId === node.peerId.toString()) {
        return;
      }
      await mergePeerAddrs(node, peerId, addrs);
      try {
        await node.dial(peerIdFromString(peerId));
      } catch (error) {
        log('dialControlBootstrapPeers: dial to bootstrap peer %s failed: %o', peerId, error);
      }
    }));
  }

  /**
   * PeerIds of the configured control bootstrap nodes (relay/bootstrap
   * infrastructure — always admitted inbound). Parsed once, lazily; an
   * address without a `/p2p/<id>` component contributes nothing.
   */
  private getBootstrapPeerIds(): Set<string> {
    if (!this.bootstrapPeerIds) {
      const ids = new Set<string>();
      for (const addr of this.config.controlNetwork.bootstrapNodes) {
        try {
          // Last `/p2p/<id>` component: on a plain bootstrap addr the node's own
          // id; on a circuit addr the dial target (which is what gets admitted).
          let id: string | undefined;
          for (const component of multiaddr(addr).getComponents()) {
            if (component.name === 'p2p' && component.value) {
              id = component.value;
            }
          }
          if (id) {
            ids.add(id);
          }
        } catch (error) {
          log('getBootstrapPeerIds: skipping unparsable bootstrap addr %s: %o', addr, error);
        }
      }
      this.bootstrapPeerIds = ids;
    }
    return this.bootstrapPeerIds;
  }

  /**
   * What the strand watcher polls: this party's control rows plus a row per cross-party
   * join (see {@link joinedStrands}), so a joined strand is offered and relaunched on
   * the same path as the party's own.
   */
  private createStrandQueryable(): StrandQueryable {
    return {
      queryStrands: async (): Promise<StrandRow[]> => {
        if (!this.controlDatabase) {
          log('Control database not initialized, returning empty strands');
          return [];
        }
        log('Querying strands from control database');
        const control = await this.controlDatabase.queryStrands();
        return this.joinedStrands ? await this.joinedStrands.withControlRows(control) : control;
      }
    };
  }

  /**
   * The party-wide `JoinedStrand` table as {@link joinedStrands} reads and writes it.
   * Reads {@link controlDatabase} at call time, so start-up order does not matter.
   */
  private createPartyJoinedStrandLedger(): PartyJoinedStrandLedger {
    const database = (): ControlDatabase => {
      if (!this.controlDatabase) {
        throw new Error('CadreNode must be started before using the party-wide joined-strand table');
      }
      return this.controlDatabase;
    };
    return {
      // NOTE: one more control read per watcher poll (5 s), and for a party that never
      // joined anything it reads a never-written block, which consults the cohort. If poll
      // cost shows up in a device profile, cache the list and re-read it on the reconcile
      // cadence.
      list: () => database().queryJoinedStrands(),
      names: async (strandId) => (await database().queryStrand(strandId)) !== null
        || (await database().queryJoinedStrand(strandId)) !== null,
      canSign: async () => (await this.enrolledOwnerSigningKey()) !== null,
      publish: async (record) => {
        const signingKey = await this.enrolledOwnerSigningKey();
        if (!signingKey) {
          throw new Error(`Cannot publish joined strand ${record.Id}: this machine is not an enrolled owner`);
        }
        try {
          await database().insertJoinedStrand(record, signingKey.publicKeyB64, signMessageWith(signingKey.privateKeyB64));
        } catch (error) {
          // Another machine of the party published this join first; its row wins.
          if (!isStrandIdConflict(error, 'JoinedStrand')) {
            throw error;
          }
        }
      },
      remove: async (strandId) => {
        const signingKey = await this.enrolledOwnerSigningKey();
        if (signingKey) {
          return database().deleteJoinedStrand(strandId, signingKey.publicKeyB64, signMessageWith(signingKey.privateKeyB64));
        }
        if (await database().queryJoinedStrand(strandId)) {
          throw new Error(
            `Cannot leave strand ${strandId} for the whole party: the join is recorded party-wide, and ` +
            `removing it takes an owner machine, which this one is not. stopStrand('${strandId}') stops ` +
            'it on this machine only.'
          );
        }
        return false;
      }
    };
  }

  /**
   * This machine's owner signing key when it can make owner-gated control writes: its seed
   * bootstrap holds an owner key (`SeedBootstrapService.canAuthorize`) and the party's
   * `OwnerKey` table enrolls it. A phone that ran self-genesis after another machine
   * founded the party passes the first test and not the second (`runOwnerGenesis` in the
   * reference apps), and a write it signed would only be refused.
   */
  private async enrolledOwnerSigningKey(): Promise<{ privateKeyB64: string; publicKeyB64: string } | null> {
    const signingKey = this.seedBootstrapService?.canAuthorize() ? this.getSelfSigningKey() : null;
    if (!signingKey || !this.controlDatabase) {
      return null;
    }
    return (await this.controlDatabase.getOwnerKeys()).has(signingKey.publicKeyB64) ? signingKey : null;
  }

  /**
   * Schedule the node's initial self-record publish + ongoing refresh shortly
   * after start (non-blocking). {@link registerSelf} is idempotent and safely
   * no-ops when it cannot yet sign/insert (e.g. owner key not installed),
   * so the timer is harmless even when registration only becomes possible later.
   */
  private scheduleSelfRegistration(): void {
    this.selfRegistrationTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.registerSelf();
        } catch (error) {
          // Background task — a failed publish must not crash the node.
          // NOTE: a restarted machine whose own CadrePeer row replicates in while this update
          // runs fails here with ConcurrentModificationError (seen on the owner's restart in
          // every traced run of cadre-invite-any-member), leaving its record unrefreshed until
          // the next heartbeat. If a restarted machine's changed addresses must publish sooner,
          // retry once here.
          log('Self-registration failed: %o', error);
        }
        // Wire the ongoing refresh + control-cohort reconcile cadence, then run
        // an eager reconcile pass once the node has settled (the recurring
        // interval was just armed inside startRecordRefresh).
        this.startRecordRefresh();
        void this.reconcileControlCohort().catch((error) =>
          log('Control-cohort reconcile (start) failed: %o', error));
      })();
    }, 1000); // Small delay to ensure node is fully started
    // Node-only: don't keep the event loop alive solely for this timer.
    (this.selfRegistrationTimer as { unref?: () => void } | null)?.unref?.();
  }

  /**
   * Publish (or refresh) this node's own signed `CadrePeer` address record so
   * other members can resolve its current signaling/relay multiaddrs from its
   * PeerId alone. Public, awaitable, and idempotent.
   *
   * - Builds a `PeerAddressRecord` from the node's current dialable addrs
   *   (signaling/`p2p-circuit` first), signed with the ed25519 key behind its
   *   PeerId (the resolved node identity from `keyStore`/`config.privateKey`).
   * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt`.
   * - If not, and the node is its own owner: an owner-signed INSERT that
   *   also carries the self-signature. That INSERT is idempotent, so if an owner
   *   {@link authorizePeer} of this node's own id seated the row inside the
   *   read-then-insert window it no-ops — the publish then falls through to the
   *   UPDATE path (re-reading and re-signing against the row that landed) rather
   *   than leaving the authorize's null `Sig` in place, and reports `refreshed`.
   * - Otherwise: logs and returns (a non-owner node with no row yet must
   *   wait for an owner to insert it; it can then self-refresh).
   *
   * Safe to call repeatedly (heartbeat / address-change driven); each successful
   * publish strictly increases `UpdatedAt`. Concurrent calls are collapsed into a
   * single in-flight publish (see {@link registerSelfInFlight}) so the explicit
   * startup publish and the background timers can never race a duplicate INSERT.
   *
   * @returns what the publish did — `inserted`, `refreshed`, or `skipped`.
   */
  async registerSelf(): Promise<SelfRegistrationOutcome> {
    // Join an in-flight publish rather than starting a second one. Without this,
    // the explicit CLI call and the 1s timer could both observe "no row yet" and
    // both attempt the INSERT — the loser hits a CadrePeer PK conflict.
    if (this.registerSelfInFlight) {
      return this.registerSelfInFlight;
    }
    const op = this.publishSelfRecord();
    this.registerSelfInFlight = op;
    try {
      return await op;
    } finally {
      this.registerSelfInFlight = null;
    }
  }

  /** The body of {@link registerSelf}; serialised by its single-flight guard. */
  private async publishSelfRecord(): Promise<SelfRegistrationOutcome> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      log('Cannot register self - node or database not initialized');
      return 'skipped';
    }

    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      log('registerSelf: no self-signing key available (node identity unavailable or not matching peerId); skipping');
      return 'skipped';
    }

    const peerId = this.controlNode.peerId.toString();
    const addrs = await this.collectSelfAddrs();
    const existing = await this.controlDatabase.queryPeerRecord(peerId);

    if (!existing) {
      if (!this.seedBootstrapService) {
        // "No row" also covers "revoked": queryPeerRecord reads a row whose StampId is
        // retired in Revocation as absent, so a removed node lands here every heartbeat
        // and stops refreshing its own record — correct, but say so, or the message reads
        // as "never added" for a node that was removed.
        log('registerSelf: no readable CadrePeer row for self (never added, or removed and its stamp retired) and no owner service to self-insert; skipping');
        return 'skipped';
      }
      // First-time row: requires an owner signature (the node is its own
      // owner). insertSelfPeerRecord throws if no owner key is present.
      const record = this.signSelfRecord(peerId, signingKey, addrs, null);
      if (await this.seedBootstrapService.insertSelfPeerRecord(record)) {
        if (this.committedAlone()) this.pendingSelfPeerWrite = true;
        this.noteSelfRecordPublished();
        log('registerSelf: inserted own CadrePeer record (owner-signed, updatedAt=%d, %d addrs, sig=%s…)', record.updatedAt, addrs.length, record.sig.slice(0, 16));
        return 'inserted';
      }
      // An owner authorize of this node's OWN peer id seated the row (null `Sig`)
      // inside the read-then-insert window, so the idempotent insert no-op'd. Fall
      // through to the self-update path, which re-signs against the row that landed.
      //
      // NOTE: this path reports 'refreshed' — honest about the write, which really was
      // an UPDATE, though the caller's intent was a first publish. No caller branches on
      // 'inserted' today (the CLI only logs it); if one ever needs "this was the row's
      // first publish", add a fourth SelfRegistrationOutcome rather than re-labelling.
      log('registerSelf: own CadrePeer row appeared mid-publish (concurrent authorize); self-updating to carry the signature');
    }

    // Reached on the fall-through above, where the pre-race read missed the row a
    // concurrent authorize then seated — so re-read to get that row's `UpdatedAt`, which
    // the strictly-greater self-update rule is measured against. The re-read can still
    // come back null (see the branch below).
    //
    // NOTE: when `existing` is set it predates this publish, so a removePeer(self) racing
    // in would leave the UPDATE below matching no rows while still reporting 'refreshed'.
    // Closing that needs updateSelfPeerRecord to report rows-affected — only worth doing
    // if removing self ever becomes something that happens concurrently in practice.
    const current = existing ?? await this.controlDatabase.queryPeerRecord(peerId);
    if (!current) {
      // Two causes, and the second is a steady state rather than a race: the row really
      // vanished mid-publish (next refresh re-inserts), or this node was REVOKED — its row
      // is physically present, so insertCadrePeer's in-lock existence check no-op'd above,
      // but queryPeerRecord reads it as absent because its stamp is retired. The revoked
      // case repeats every heartbeat and never re-inserts; that is intended (a revoked node
      // has nothing to publish), so this stays a skip, not an error.
      log('registerSelf: own CadrePeer row not readable (vanished mid-publish, or this node is revoked and its stamp retired); skipping');
      return 'skipped';
    }
    const record = this.signSelfRecord(peerId, signingKey, addrs, current);
    await this.controlDatabase.updateSelfPeerRecord(record);
    if (this.committedAlone()) this.pendingSelfPeerWrite = true;
    this.noteSelfRecordPublished();
    log('registerSelf: refreshed own CadrePeer record (updatedAt=%d, %d addrs, sig=%s…)', record.updatedAt, addrs.length, record.sig.slice(0, 16));
    return 'refreshed';
  }

  /**
   * Record that this node's own address record just landed, and re-arm the stale-record
   * warning. Called from BOTH publishing paths of {@link publishSelfRecord} and nowhere
   * else — a `skipped` publish wrote nothing, so it must not refresh the stamp.
   */
  private noteSelfRecordPublished(): void {
    this.lastSelfRecordPublishAt = Date.now();
    this.selfRecordStaleWarned = false;
  }

  /**
   * Report an abandoned control write to the embedding app.
   *
   * Every control write funnels through `ControlDatabase.lockedWithRetry`, which now tells
   * this node when it gives one up. Foreground writes ALSO reject to their caller; the
   * background ones ({@link startRecordRefresh}'s republish and the two replication
   * drains) are fired unawaited with a `debug`-only catch, so this event is the only thing
   * that reaches an app at all.
   *
   * Reporting only — the one operator-visible escalation lives on the republish path
   * ({@link escalateIfSelfRecordStale}), where the consequence is measurable.
   */
  private noteControlWriteAbandoned(abandonment: ControlRetryAbandonment): void {
    log('Control write abandoned [%s] after %d/%d attempt(s) in %dms (%s): %o',
      abandonment.label ?? 'unlabelled', abandonment.attemptsMade, abandonment.attemptsAllowed,
      abandonment.elapsedMs, abandonment.reason, abandonment.error);
    this.emit('control:write-abandoned', abandonment);
  }

  /**
   * Escalate ONE failed self-address republish to the operator — once — when the node has
   * not published its own record for longer than a record stays fresh.
   *
   * The bar is the CONSEQUENCE, not a failure count: a resolver discards a `CadrePeer`
   * record older than {@link DEFAULT_PEER_RECORD_MAX_AGE_MS} (15 minutes) and the heartbeat
   * re-stamps at half that, so by the time this gap opens every other machine in the party
   * has already stopped accepting this node's address. A count would fire far too early —
   * one failed heartbeat is already half the budget, and a single miss costs nothing.
   *
   * Say-once, re-armed by the next successful publish ({@link noteSelfRecordPublished}), so
   * a node that stays broken warns once rather than every 7.5 minutes.
   *
   * A node that has never published in this session is skipped: it has no record out there
   * to go stale, and the reason it has none (not a member yet, no signing key, revoked) is
   * already logged by `registerSelf` itself.
   *
   * Only a FAILED republish is checked. A heartbeat whose publish reports `skipped` neither
   * stamps nor warns, so a node that stops being able to publish without erroring — revoked,
   * or its row removed — goes quiet here. That is the intended reading: a revoked node has
   * nothing to publish and its unreachability is the point, not a fault to report.
   *
   * NOTE: the second `console.*` in this library, and the reason
   * {@link warnIfAnnounceAddrsDiscardRelay}'s note says a third should not simply be added:
   * both are operator warnings about a configuration/health condition an embedder cannot
   * see otherwise, and both have an event beside them (`control:write-abandoned` carries
   * the underlying write failure). A third such condition should surface through
   * {@link CadreNodeEvents} alone unless it likewise degrades the whole party in silence.
   */
  private escalateIfSelfRecordStale(reason: string, error: unknown): void {
    const publishedAt = this.lastSelfRecordPublishAt;
    if (publishedAt === null || this.selfRecordStaleWarned) {
      return;
    }
    const staleForMs = Date.now() - publishedAt;
    if (staleForMs < DEFAULT_PEER_RECORD_MAX_AGE_MS) {
      return;
    }
    this.selfRecordStaleWarned = true;
    console.warn(
      `[sereus] this machine has not published its own address record for ${Math.round(staleForMs / 60_000)} `
      + `minutes. The latest attempt (${reason}) failed with: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'Other machines in the party discard an address record older than '
      + `${Math.round(DEFAULT_PEER_RECORD_MAX_AGE_MS / 60_000)} minutes, so any of them not already `
      + 'connected to this one can no longer reach it. Publishing keeps retrying; this is reported once.'
    );
  }

  /**
   * Sign this node's address record for publication, stamped strictly later than
   * `existing` (the row it is about to replace, or null for a first insert) so a
   * same-millisecond re-publish still satisfies the monotonic `UpdatedAt` rule the
   * `CadrePeer.AuthorizedUpdate` self-branch enforces.
   */
  private signSelfRecord(
    peerId: string,
    signingKey: { privateKeyB64: string; publicKeyB64: string },
    addrs: string[],
    existing: PeerAddressRecord | null
  ): PeerAddressRecord {
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    return signPeerRecord(
      { peerId, publicKey: signingKey.publicKeyB64, addrs, updatedAt },
      signingKey.privateKeyB64
    );
  }

  /**
   * The ed25519 keypair (base64url) the node signs its own record with — the key
   * behind its libp2p PeerId. Sourced from the resolved {@link identityKey}
   * (which a `keyStore` or `config.privateKey` supplies); returns null when
   * absent (ephemeral identity) or (defensively) when it does not match the
   * control node's PeerId, in which case self-publish is skipped rather than
   * producing an unresolvable row.
   */
  private getSelfSigningKey(): { privateKeyB64: string; publicKeyB64: string } | null {
    const peerId = this.controlNode?.peerId.toString();
    if (!peerId || !this.identityKey) {
      return null;
    }
    try {
      const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(this.identityKey);
      if (publicKeyB64 === ed25519PublicKeyB64FromPeerId(peerId)) {
        return { privateKeyB64, publicKeyB64 };
      }
      log('getSelfSigningKey: resolved identity key does not match control node peerId; cannot self-sign');
    } catch (error) {
      // Logs the error shape only; ed25519KeyPairFromLibp2p never embeds key material.
      log('getSelfSigningKey: failed to derive ed25519 key from identity key: %o', error);
    }
    return null;
  }

  /**
   * Does the `Strand` row name THIS machine as its founder — i.e. is its
   * `FounderOwnerKey` this node's own owner key (the key behind its PeerId)?
   * A null/absent column (a consent-seated strand, or a hand-built row) and a
   * node with no owner key both derive `false`: without a positive match this
   * machine must attach, never bootstrap. Pure key derivation, no I/O — cheap
   * enough for {@link launchStrand}'s tracked-instance early return.
   *
   * NOTE: reads "one owner key per machine" — the reference model, where the owner
   * key IS the key behind the PeerId. Two machines running the SAME identity key
   * would both derive `true` and each bootstrap on its own replica, which is the
   * double-`Header` hazard this derivation exists to avoid. Unreachable today: that
   * configuration also gives both machines one PeerId, which already breaks control
   * networking well before any strand launches. Revisit if machines ever share an
   * owner key while holding distinct transport identities — the derivation would
   * then need a per-machine discriminator (the `CadrePeer` PeerId) on the row.
   */
  private isSelfFoundedRow(strand: StrandRow): boolean {
    if (strand.FounderOwnerKey == null) {
      return false;
    }
    return strand.FounderOwnerKey === this.getSelfSigningKey()?.publicKeyB64;
  }

  /**
   * The owner keypair (base64url Ed25519) derived from this node's resolved
   * identity key. In the single-key reference model the owner signing key is
   * *derived from* the node identity (see {@link ed25519KeyPairFromLibp2p}), so the
   * same key material protected in a secure enclave backs both.
   *
   * Exposed so the hosting app retains control of owner genesis: cadre-core
   * resolves + protects the identity, then the app sources this pair to drive
   * `ensureOwnerKey(pub)` + `initializeSeedBootstrap(priv)` itself — cadre-core
   * never silently runs genesis. A future separate-owner slot would return a
   * distinct key here instead of the identity-derived one.
   *
   * @returns The base64url seed/public-key owner pair.
   * @throws If called before {@link start} has resolved the identity, or when the
   *   node runs on an ephemeral libp2p key (no `keyStore`/`privateKey` configured),
   *   since that key is internal to libp2p and not exposed.
   */
  getIdentityOwnerKey(): Ed25519KeyPair {
    if (!this.identityKey) {
      throw new Error(
        'getIdentityOwnerKey: node identity not resolved — call start() first, and ' +
        'configure `keyStore` or `privateKey` (an ephemeral libp2p identity exposes no owner key)'
      );
    }
    return ed25519KeyPairFromLibp2p(this.identityKey);
  }

  /**
   * Collect this node's current dialable addresses for publication, signaling
   * (`/p2p-circuit`) first. Prefers the best invite/NAT-resolved set and folds
   * in the relay/signaling address (the WebRTC dial input) when not already
   * present.
   */
  private async collectSelfAddrs(): Promise<string[]> {
    const resolved = await this.resolveInviteAddresses();
    const relay = await this.getRelayAddress();
    const merged = relay && !resolved.includes(relay) ? [...resolved, relay] : resolved;
    return orderSignalingFirst([...new Set(merged)]);
  }

  /**
   * Wire the ongoing self-record refresh: re-publish whenever libp2p reports an
   * address change (relay reservation rotation, NAT change) and on a TTL
   * heartbeat at half the freshness ceiling. Idempotent — repeated calls do not
   * stack listeners/timers.
   */
  private startRecordRefresh(): void {
    if (!this.controlNode || this.recordRefreshTimer) {
      return;
    }

    const republish = (reason: string) => {
      void this.registerSelf().catch((error) => {
        log('Record refresh (%s) failed: %o', reason, error);
        // The only failure in this file that degrades the whole party on its own, so it is
        // the only one that escalates past `debug`. See escalateIfSelfRecordStale.
        this.escalateIfSelfRecordStale(reason, error);
      });
    };
    const reconcile = (reason: string) => {
      void this.reconcileControlCohort().catch((error) =>
        log('Control-cohort reconcile (%s) failed: %o', reason, error));
    };

    // Address churn re-publishes the self record AND re-checks the control cohort:
    // a relay-reservation rotation / NAT change can drop a sibling connection, so
    // the next pass should re-observe and re-dial it.
    this.selfPeerUpdateHandler = () => {
      republish('self:peer:update');
      reconcile('self:peer:update');
    };
    this.controlNode.addEventListener('self:peer:update', this.selfPeerUpdateHandler);

    // NOTE: a node AUTHORIZED AFTER IT BOOTED can wait a whole heartbeat (7.5 min)
    // to publish its address. `registerSelf` no-ops while a node has no readable
    // `CadrePeer` row, so its boot-time publish does nothing, and the two triggers
    // wired here are the only ones after that: `self:peer:update` needs an ADDRESS
    // CHANGE, and a relay-only node's addresses stop changing the moment its
    // reservation lands — inside `start()`, before this listener exists (on the
    // `network.requireRelay: false` posture the reservation may instead land LATER,
    // from the retry supervisor, and then this listener is what publishes the
    // `/p2p-circuit` address the boot-time publish could not carry). Harmless
    // where a late-authorized node's addresses keep churning (NAT/relay rotation
    // fire the event anyway), and invisible while parties authorize members before
    // they boot. If late enrollment becomes the normal path — an invited phone is
    // exactly that — republish on the membership-change seam that already exists
    // (`ControlDatabase.setMembershipChangeListener`) rather than lengthening this
    // list of triggers. Measured while writing
    // `relay-only-control-addr.integration.ts` case 4, which drives `registerSelf()`
    // explicitly because neither trigger is dependable there.
    this.recordRefreshTimer = setInterval(() => republish('heartbeat'), DEFAULT_PEER_RECORD_HEARTBEAT_MS);
    (this.recordRefreshTimer as { unref?: () => void } | null)?.unref?.();

    const reconcileMs = this.config.network?.controlCohort?.reconcileMs ?? DEFAULT_CONTROL_COHORT_RECONCILE_MS;
    this.controlCohortReconcileTimer = setInterval(() => reconcile('interval'), reconcileMs);
    (this.controlCohortReconcileTimer as { unref?: () => void } | null)?.unref?.();

    log('Record refresh wired (heartbeat=%dms, cohortReconcile=%dms)',
      DEFAULT_PEER_RECORD_HEARTBEAT_MS, reconcileMs);
  }

  /** Tear down the self-record refresh timers + listener (see {@link cleanup}). */
  private stopRecordRefresh(): void {
    if (this.selfRegistrationTimer) {
      clearTimeout(this.selfRegistrationTimer);
      this.selfRegistrationTimer = null;
    }
    if (this.recordRefreshTimer) {
      clearInterval(this.recordRefreshTimer);
      this.recordRefreshTimer = null;
    }
    if (this.controlCohortReconcileTimer) {
      clearInterval(this.controlCohortReconcileTimer);
      this.controlCohortReconcileTimer = null;
    }
    if (this.controlNode) {
      if (this.selfPeerUpdateHandler) {
        this.controlNode.removeEventListener('self:peer:update', this.selfPeerUpdateHandler);
      }
      if (this.controlConnectionOpenHandler) {
        this.controlNode.removeEventListener('connection:open', this.controlConnectionOpenHandler);
      }
      if (this.controlConnectionCloseHandler) {
        this.controlNode.removeEventListener('connection:close', this.controlConnectionCloseHandler);
      }
    }
    this.selfPeerUpdateHandler = null;
    this.controlConnectionOpenHandler = null;
    this.controlConnectionCloseHandler = null;

    // Reset the write-while-alone re-replication state so a stop()→start() cycle
    // re-arms the growth edge and re-runs BOTH one-shot passes. Any queued
    // local-only writes are moot once the node is torn down: owner inserts are
    // re-covered by the next start's reconstruction, and delete tombstones by its
    // first-growth revocation sweep — which is why the sweep flag must reset too,
    // or the second lifetime would skip the sweep and strand exactly the
    // committed-alone tombstones it exists to carry.
    this.hasControlConnection = false;
    this.reconstructedLocalOnlyWrites = false;
    this.reissuedHeldRevocations = false;
    this.revocationLedgerOpened = false;
    this.pendingPeerWrites.clear();
    this.pendingRevocations.clear();
    this.pendingSelfPeerWrite = false;
    this.pendingSelfDeviceWrite = false;
    // Self-record publication history is per-session too: a restarted node re-publishes
    // from scratch, and carrying the previous lifetime's stamp forward would either
    // suppress the stale-record warning or fire it on a node that just came up.
    this.lastSelfRecordPublishAt = null;
    this.selfRecordStaleWarned = false;
  }

  /**
   * Resolve a peer's current, signed, trust-checkable multiaddrs from only its
   * PeerId — the transport-agnostic input a NAT-to-NAT WebRTC (or any) dial path
   * consumes, with no copy/paste of a relayed dial string.
   *
   * Reads the peer's `CadrePeer` record and gates it through, in order:
   *   1. record present (else `[]`),
   *   2. `publicKey <-> peerId` binding (the stored key's libp2p identity must be
   *      the requested peerId),
   *   3. self-signature verifies against `publicKey`,
   *   4. freshness — rejected once older than `maxAgeMs` (never a dead relay
   *      reservation),
   *   5. the pluggable trust gate (`opts.trustPolicy`).
   * Survivors are returned signaling (`/p2p-circuit`) first, filtered to
   * signaling-only when requested, as parsed `Multiaddr`s (unparsable addrs
   * dropped). Any gate failure yields an empty array rather than throwing.
   *
   * Every returned address is normalized to terminate in `/p2p/<peerId>` — see
   * {@link normalizeDialAddrs} for why that invariant, not each dial site's own
   * handling, is what keeps a mixed list from taking a whole peer offline.
   */
  async resolvePeerAddrs(peerId: string, opts: ResolveOpts = {}): Promise<Multiaddr[]> {
    return (await this.resolvePeerRecord(peerId, opts))?.addrs ?? [];
  }

  /**
   * {@link resolvePeerAddrs} with the record's `UpdatedAt` kept beside the addresses, for a
   * caller that ranks peers by how recently they published. `null` wherever that returns `[]`
   * for a failed gate.
   */
  private async resolvePeerRecord(peerId: string, opts: ResolveOpts): Promise<{ addrs: Multiaddr[]; updatedAt: number } | null> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before resolving peer addrs');
    }

    const record = await this.controlDatabase.queryPeerRecord(peerId);
    if (!record) {
      log('resolvePeerAddrs: no record for %s', peerId);
      return null;
    }

    // publicKey <-> peerId binding: the stored key must be the one embedded in
    // the requested Ed25519 peer id (also rejects a non-Ed25519 / missing key).
    if (!record.publicKey || ed25519PublicKeyB64FromPeerId(peerId) !== record.publicKey) {
      log('resolvePeerAddrs: publicKey does not match peerId for %s', peerId);
      return null;
    }

    // Self-signature over (peerId, addrs, updatedAt).
    if (!verifyPeerRecordSignature(record)) {
      // Field detail distinguishes "holding the owner-vouch revision (Sig null,
      // no addrs — a not-yet-self-published row)" from a genuinely corrupt or
      // mixed-revision row. Sig/addrs are public replicated data.
      log('resolvePeerAddrs: signature verification failed for %s (updatedAt=%d, addrs=%o, sig=%s)',
        peerId, record.updatedAt, record.addrs,
        record.sig ? `${record.sig.slice(0, 16)}…` : '(empty)');
      return null;
    }

    // Freshness: never hand back a dead relay reservation.
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PEER_RECORD_MAX_AGE_MS;
    if (!isPeerRecordFresh(record.updatedAt, maxAgeMs, Date.now())) {
      log('resolvePeerAddrs: record for %s is stale (updatedAt=%d, maxAgeMs=%d)', peerId, record.updatedAt, maxAgeMs);
      return null;
    }

    // Pluggable trust gate (defaults to current-member).
    const trustPolicy = opts.trustPolicy ?? currentMemberTrustPolicy();
    const trusted = await trustPolicy.evaluate({
      peerId,
      publicKey: record.publicKey,
      partyId: this.partyId,
      record,
    });
    if (!trusted) {
      log('resolvePeerAddrs: trust policy rejected %s', peerId);
      return null;
    }

    // Order signaling-first (the on-record order was what we verified above),
    // optionally restrict to signaling addrs, then parse — dropping any addr
    // that does not parse as a multiaddr — and finally normalize every survivor
    // onto `/p2p/<peerId>` so no caller ever sees a mixed list.
    let addrs = orderSignalingFirst(record.addrs);
    if (opts.signalingOnly) {
      addrs = addrs.filter(isSignalingAddr);
    }
    return { addrs: this.normalizeDialAddrs(this.parseMultiaddrs(addrs), peerId), updatedAt: record.updatedAt };
  }

  /**
   * Guarantee every address handed to a control-network dial terminates in
   * `/p2p/<peerId>`, with no duplicates — the invariant every dial path
   * downstream relies on.
   *
   * `libp2p.dial(addrs)` requires that the addresses in ONE dial either all name
   * a peer id or none do; a list mixing a circuit address (which ends in
   * `/p2p/<target>`) with a bare direct one (which ends in `/tcp/…`) makes that
   * call throw, and the whole peer is then silently skipped rather than one bad
   * address.
   *
   * Applied by ALL THREE sources of control-dial candidates, so no call site
   * invents its own rule and none can produce a mixed list: the signed record
   * ({@link resolvePeerAddrs}), the libp2p address book
   * ({@link peerStoreAddrs}), and a retained out-of-band dial target
   * ({@link bootstrapDialAddrs}).
   *
   * An address naming a DIFFERENT trailing peer id is dropped: it does not reach
   * `peerId`, so it does not belong in this peer's candidate list (libp2p's own
   * dial queue filters the same shape out one layer lower).
   */
  private normalizeDialAddrs(addrs: Multiaddr[], peerId: string): Multiaddr[] {
    // Keyed by the NORMALIZED string, so two entries differing only by the suffix
    // (`/ip4/…/tcp/4001` and `/ip4/…/tcp/4001/p2p/<peerId>`) collapse into one.
    // Normalization is what makes them equal; a surviving duplicate would cost a
    // real dial attempt — a whole slice of `dialWake`'s budget — on an address
    // already being tried.
    const out = new Map<string, Multiaddr>();
    for (const addr of addrs) {
      const bound = this.bindAddrToPeer(addr, peerId);
      if (bound) {
        out.set(bound.toString(), bound);
      }
    }
    return [...out.values()];
  }

  /**
   * One address bound to `peerId`, or `null` when it cannot be — logged either
   * way, never thrown, so every caller's list-shaping stays total.
   *
   * Used both to normalize addresses this node DIALS (a `CadrePeer` row, a
   * retained bootstrap addr) and to normalize the ones it ANNOUNCES
   * ({@link getStrandMultiaddrs}); the rule is the same either way — an address
   * that does not reach `peerId` is not an address for `peerId`.
   *
   * `withTrailingPeerId` encapsulates `/p2p/<peerId>`, which throws on a peer id
   * that does not parse. Unreachable for a `CadrePeer` row (the binding gate
   * above parsed it already) and for our own node's id, reachable for a
   * retained one ({@link bootstrapDialAddrs}).
   */
  private bindAddrToPeer(addr: Multiaddr, peerId: string): Multiaddr | null {
    try {
      const bound = withTrailingPeerId(addr, peerId);
      if (!bound) {
        log('bindAddrToPeer: dropping addr %s — it names a peer other than %s', addr.toString(), peerId);
      }
      return bound;
    } catch (error) {
      log('bindAddrToPeer: cannot bind %s to %s: %o', addr.toString(), peerId, error);
      return null;
    }
  }

  /** Parse multiaddr strings, dropping (and logging) any that fail to parse. */
  private parseMultiaddrs(addrs: string[]): Multiaddr[] {
    const out: Multiaddr[] = [];
    for (const addr of addrs) {
      try {
        out.push(multiaddr(addr));
      } catch (error) {
        log('resolvePeerAddrs: dropping unparsable multiaddr %s: %o', addr, error);
      }
    }
    return out;
  }

  // ============================================================================
  // Proactive control-cohort dial
  //
  // The control collections only replicate once a party's nodes are
  // transport-connected (so FRET seats each peer in the others' keyspace cohort)
  // AND a write happens while that cohort has ≥2 members. There is no production
  // mechanism that makes a party's control nodes actively connect to each other;
  // the convergence test does it by hand with a manual dial(). reconcileControlCohort
  // productionizes that: each node resolves its known siblings' control addresses
  // and proactively dials a bounded, backbone-preferential set, re-observing and
  // re-dialing dropped connections on each pass. See docs/architecture.md (Control
  // Network) and control-cohort.ts for the selection policy.
  // ============================================================================

  /**
   * Run one proactive control-cohort dial pass to keep this node connected to its
   * cadre siblings (so the `CadreControl` collections form a replicating cohort).
   * Public so the cohort-growth-driven re-replication path
   * (`control-write-ensure-replicated`) and tests can trigger a pass on demand;
   * normally driven by the eager start pass, the recurring interval, and
   * `self:peer:update` (all wired in {@link startRecordRefresh}).
   *
   * Concurrent triggers collapse into a single in-flight pass
   * (see {@link reconcileControlCohortInFlight}) so two passes never double-dial;
   * a call that joins an in-flight pass resolves to THAT pass's result.
   * Best-effort throughout: a failure to resolve/dial any one sibling is logged
   * and the pass continues; the whole pass is a no-op when the node is alone.
   *
   * Resolves to the peers the pass dialled ({@link ControlCohortReconcileResult}),
   * so a caller can tell a link this pass opened from one something else opened —
   * the pass skips a peer that is already connected. The timer and event triggers
   * discard it.
   */
  async reconcileControlCohort(): Promise<ControlCohortReconcileResult> {
    if (this.reconcileControlCohortInFlight) {
      return this.reconcileControlCohortInFlight;
    }
    const op = this.runReconcileControlCohort();
    this.reconcileControlCohortInFlight = op;
    try {
      return await op;
    } finally {
      this.reconcileControlCohortInFlight = null;
    }
  }

  /** Body of {@link reconcileControlCohort}; serialised by its single-flight guard. */
  private async runReconcileControlCohort(): Promise<ControlCohortReconcileResult> {
    // Shutdown / not-yet-started guard (mirrors publishSelfRecord). A pass that
    // fires after stop() began must early-return rather than touch a torn-down node.
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return { dialed: [] };
    }
    // Ride this pass's cadence to refresh the per-stream gate's materialized
    // authorized set — membership changes that ARRIVED BY REPLICATION (rather
    // than a local write) are picked up here, bounding the snapshot's staleness
    // to the time between pass starts: the reconcile interval, or the previous
    // pass's length when that is longer (passes are single-flight, and one
    // unreachable sibling's dial alone can take `controlDialBudget().totalMs`).
    // NOTE: this refresh and the sibling enumeration below each run their own
    // CadrePeer query (two reads per pass), plus a third from
    // `refreshStrandPeerAddrs` on every pass where a strand is running AND this
    // node holds a control connection (one read for the whole pass, not one per
    // strand; it runs even when no sibling is due, because pruning departed
    // siblings needs the current target set). Each also reads Revocation first.
    // Before the Revocation ledger marker exists (filed below, once connected)
    // that block is missing, so every one of those reads consults the cohort
    // about it; once the marker exists every
    // block they touch is held and none of them does (both states pinned in
    // control-founding-consult-budget.spec.ts). If those reads ever get costly,
    // share one row-set across all three.
    await this.refreshMembershipGate('reconcile');
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return { dialed: [] };
    }
    // Refresh relay delegate grants BEFORE the sibling enumeration below: a
    // solo cadre with a party relay has no siblings to dial but must still keep
    // its running strands' grants alive (a dropped relay connection re-dials
    // the reservation and faces the connection gate again).
    await this.refreshDelegateGrants();
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return { dialed: [] };
    }
    // Then re-warm each running strand's own address book from its FRET address
    // records and from whichever siblings are due an ask. Same reasoning as
    // warmSiblingAddrBook below, one layer down: replication runs on the STRAND
    // network, and every layer under cadre-core dials strand peers by bare peer id.
    await this.refreshStrandPeerAddrs();
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return { dialed: [] };
    }
    const selfPeerId = this.controlNode.peerId.toString();

    // Reap guarded rows this node still holds for incarnations an already-committed
    // Revocation tombstone retires — the half of a removal replication cannot carry
    // (a delete of an already-absent row replays as nothing). Connected-only: a reap
    // is a write, and a write committed alone is local-only and forks this node's own
    // history, which is the condition this work exists to stop creating
    // (tickets/blocked/forked-control-collection-sync-livelocks.md). Nothing is urgent
    // here — the stale row already reads as absent everywhere — so waiting for
    // connectivity costs nothing and keeps the reap fork-CLOSING rather than
    // fork-creating.
    //
    // BEFORE step 1, not after: the pass early-returns when it finds no siblings, and a
    // cadre whose only sibling row is the tombstoned one lands in exactly that branch
    // (listMembers() filters retired stamps, so the row needing the reap is invisible to
    // the sibling count). Placed after step 1 it would never run for the smallest and
    // most likely case.
    //
    // Shares no mutable state with drainPendingRevocations, which re-issues tombstones
    // while this consumes them: different tables (Revocation update vs guarded-row
    // delete) and both take the write lock per statement. The two can overlap freely —
    // do not add a mutex.
    //
    // NOTE: the gate is sampled ONCE for the whole sweep, so a disconnect landing
    // mid-sweep lets the remaining rows commit alone — the fork this gate exists to
    // avoid. Bounded by how long a sweep runs, which is bounded by the backlog of
    // unreaped rows (0 in steady state). If that backlog can ever be large, move the
    // check inside reapRevokedRows' loop via an injected predicate.
    if (this.getControlConnectionCount() > 0) {
      try {
        const reaped = await this.controlDatabase.reapRevokedRows(selfPeerId);
        if (reaped > 0) {
          log('reconcileControlCohort: reaped %d revoked control row(s)', reaped);
        }
      } catch (error) {
        // Best-effort like every other step in this pass: reconnecting siblings
        // outranks garbage collection, so a reap failure never aborts the reconcile.
        log('reconcileControlCohort: reap pass failed (continuing): %o', error);
      }
      if (!this._running || !this.controlNode || !this.controlDatabase) {
        return { dialed: [] };
      }

      // File the Revocation ledger marker once, so that table stops being a never-written
      // block, which the storage layer re-checks with the cohort on every read (and every
      // membership lookup and guarded insert reads it). Connected-only for the reap's
      // reason above: a marker committed alone is local-only, and one filed by a
      // disconnected owner while another machine creates the same collection is exactly
      // that fork. Owner-only, and at most once per process — see openRevocationLedgerIfDue.
      //
      // NOTE: accepted tradeoff — a solo founder does not file the marker until it holds a
      // control connection (normally its first sibling; a relay or bootstrap connection also
      // counts — see getControlConnectionCount — and is the reap's same residual), so until
      // then it keeps paying one local findCluster per read of
      // the missing Revocation block (0.009 ms each, measured upstream; no network work on
      // a cohort of one). Fork safety weighed over that and kept; revisit if findCluster
      // ever shows up as material in a device profile, or if a solo-founding marker can be
      // made fork-safe (e.g. filed inside the genesis transaction, before any other machine
      // can hold the party's collections).
      await this.openRevocationLedgerIfDue();
      if (!this._running || !this.controlNode || !this.controlDatabase) {
        return { dialed: [] };
      }

      // Publish this machine's unpublished cross-party joins party-wide and remove the rows a
      // self-revocation queued (JoinedStrandSession.syncWithParty). Connected-only for the
      // reap's reason above; owner-only by the session's own signer check. Nothing is urgent:
      // a join reaches the party within one pass of this machine being connected.
      try {
        await this.joinedStrands?.syncWithParty();
      } catch (error) {
        log('reconcileControlCohort: joined-strand sync failed (retrying next pass): %o', error);
      }
      if (!this._running || !this.controlNode || !this.controlDatabase) {
        return { dialed: [] };
      }
    }

    // 1. Enumerate known siblings. This membership read is itself a pull-on-read
    //    that helps the CadrePeer table converge — a reader-only node converges
    //    purely by these reads.
    const members = await this.listMembers();
    const siblings = members.filter((m) => m.peerId !== selfPeerId);
    if (siblings.length === 0) {
      // No rows to dial from. Either a solo cadre (nothing to do) or a COLD
      // START whose seed dial never landed — and those look identical from here,
      // because filling this table needs a connection and getting a connection
      // needs this table. Fall back to the seed's bootstrap addresses; a solo
      // cadre has none and this is a no-op. Must not throw or busy-loop.
      return { dialed: await this.dialColdStartBootstrap() };
    }
    // Re-guard after the await: a stop() may have raced the membership read.
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return { dialed: [] };
    }

    // 2. Classify backbone (owner) members and select a bounded dial set.
    // NOTE: deliberately the REPLICATED table, not the node-local anchor — this
    // only *prefers* owner peers as dial targets, so pollution costs a wasted
    // dial while anchoring would drop legitimate co-owners this node never
    // pinned. Same call as `SeedPeer.isOwner` in seed-bootstrap.ts. Move it to
    // the anchor if owner status here ever gates something trusted.
    const ownerKeys = await this.controlDatabase.getOwnerKeys();
    if (!this._running || !this.controlNode) {
      return { dialed: [] };
    }
    const targetDegree = this.config.network?.controlCohort?.targetDegree
      ?? DEFAULT_CONTROL_COHORT_TARGET_DEGREE;
    const { dials, cappedNonOwner } = selectControlCohortDials(siblings, ownerKeys, targetDegree);
    if (cappedNonOwner > 0) {
      // Don't silently bound coverage — surface what the out-degree cap dropped.
      log('reconcileControlCohort: capped %d non-owner sibling(s) at targetDegree=%d',
        cappedNonOwner, targetDegree);
    }

    // 3. Warm the libp2p address book with EVERY sibling's verified addresses,
    //    keeping what resolved for the dial loop below.
    const resolved = await this.warmSiblingAddrBook(siblings);
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return { dialed: [] };
    }

    // 4. Skip already-connected peers (no re-dial / churn for live connections).
    const connected = new Set(this.controlNode.getConnections().map((c) => c.remotePeer.toString()));

    // 5. Dial each selected, not-yet-connected sibling, best-effort, from the
    //    addresses step 3 already resolved for it.
    const dialed: string[] = [];
    for (const sibling of dials) {
      if (!this._running || !this.controlNode) {
        return { dialed };
      }
      if (connected.has(sibling.peerId)) {
        continue;
      }
      if (await this.dialControlSibling(sibling, resolved.get(sibling.peerId) ?? [])) {
        dialed.push(sibling.peerId);
      }
    }
    log('reconcileControlCohort: pass complete (siblings=%d, selected=%d, dialed=%d)',
      siblings.length, dials.length, dialed.length);
    return { dialed };
  }

  /**
   * The owner-only half of the reconcile pass's ledger-marker step: file the singleton
   * `Revocation` marker ({@link SeedBootstrapService.openRevocationLedger}) unless this
   * process has already seen it filed. The connectivity gate is the caller's
   * ({@link runReconcileControlCohort}); why the marker exists is on
   * {@link ControlDatabase.openRevocationLedger}.
   *
   * Sets {@link revocationLedgerOpened} on `'opened'` or `'already-open'`. A node that
   * cannot sign as an owner does nothing: it picks the owner's marker up the first time it
   * reads the table, like any other replicated row. Best-effort like every step of the
   * pass — a failure is logged and leaves the flag clear, so the next connected pass retries.
   */
  private async openRevocationLedgerIfDue(): Promise<void> {
    if (this.revocationLedgerOpened || !this.seedBootstrapService?.canAuthorize()) {
      return;
    }
    try {
      const outcome = await this.seedBootstrapService.openRevocationLedger();
      this.revocationLedgerOpened = true;
      log('reconcileControlCohort: revocation ledger marker %s', outcome);
    } catch (error) {
      log('reconcileControlCohort: filing the revocation ledger marker failed (retrying next pass): %o', error);
    }
  }

  /**
   * Resolve every sibling's signed address record once and merge what resolves
   * into the control node's libp2p **address book** (peerStore). Returns the
   * resolved addresses per sibling so the dial loop reuses them rather than
   * re-resolving — one `queryPeerRecord` per sibling per pass, not two.
   *
   * Deliberately every sibling, not the {@link selectControlCohortDials} subset,
   * and deliberately including already-connected ones: everything below
   * cadre-core dials by bare peer id (Optimystic's cluster/repo clients, FRET
   * ping/announce), so the address book has to be warm BEFORE a live connection
   * drops, and a sibling the out-degree cap declines to dial is still one those
   * layers may need to reach.
   *
   * Only `resolvePeerAddrs` output is merged — never the cold-start
   * `peerStoreAddrs` fallback, which came out of the address book to begin with
   * and would restamp unverified seed addresses indefinitely. A sibling that
   * resolves to nothing (revoked, stale, untrusted) is not written at all, so its
   * existing entry ages out on its own.
   *
   * The same resolution also keeps a sibling's retained out-of-band dial target
   * current ({@link refreshDialHint}).
   *
   * NOTE: this resolves EVERY sibling serially before the dial loop below runs,
   * so it costs one record query per sibling per reconcile pass (~15s) and each
   * one delays the pass's first dial. A cadre is a handful of devices, so today
   * that is a few extra local reads; if cadres ever grow large, batch the records
   * into one query, merge only on change, or move the warm pass after the dials.
   */
  private async warmSiblingAddrBook(siblings: CohortPeerRow[]): Promise<Map<string, Multiaddr[]>> {
    const resolved = new Map<string, Multiaddr[]>();
    const counts: Record<MergeAddrsResult, number> = { merged: 0, restamped: 0, skipped: 0, failed: 0 };
    // One copy of the store's map for the whole loop; a refresh replaces an entry
    // rather than mutating it, so the copy stays a consistent "before" view.
    const hints = this.bootstrapPeerStore?.all();
    for (const sibling of siblings) {
      if (!this._running || !this.controlNode) {
        break;
      }
      const addrs = await this.resolveSiblingAddrs(sibling.peerId);
      resolved.set(sibling.peerId, addrs);
      // Re-guarded after the resolve await as well as before it: the write is
      // the half that matters, and a torn-down node must never be written to.
      const controlNode = this.controlNode;
      if (!this._running || !controlNode) {
        break;
      }
      this.refreshDialHint(sibling.peerId, addrs, hints?.get(sibling.peerId)?.addrs);
      // `mergePeerAddrs` owns the whole best-effort contract — including parsing
      // a malformed `CadrePeer.PeerId` — so one bad row cannot abort the pass.
      counts[await mergePeerAddrs(controlNode, sibling.peerId, addrs)]++;
    }
    log('reconcileControlCohort: address book warmed (siblings=%d, merged=%d, restamped=%d, skipped=%d, failed=%d)',
      resolved.size, counts.merged, counts.restamped, counts.skipped, counts.failed);
    return resolved;
  }

  /**
   * Replace a sibling's retained out-of-band dial target (see
   * {@link bootstrapPeerStore}) with the addresses its signed record just resolved
   * to, when the two differ — so an address change this node saw while the record
   * was fresh (a new port, a new LAN address) is what it dials after a relaunch
   * that outlives the record's freshness window.
   *
   * Only a sibling that already HAS an entry (`retained`) is refreshed: the store
   * holds peers learned out of band and must not grow into a copy of every
   * sibling's addresses. An empty resolution leaves the entry alone — a stale or
   * not-yet-signed record is exactly when the entry is needed. The comparison is
   * order-insensitive and runs on the retained addresses after binding them to the
   * peer id, so an entry recorded without `/p2p/` suffixes is not rewritten merely
   * for lacking them.
   *
   * NOTE: replaces rather than merges, so the entry becomes exactly what the
   * sibling announces. If a node's signed record ever lists fewer addresses this
   * node can reach than it was added with (say an announce override naming only a
   * public address, for a node added by its LAN address), a relaunch dials the
   * worse set; merge the two lists here if that shows up.
   */
  private refreshDialHint(peerId: string, resolved: Multiaddr[], retained: string[] | undefined): void {
    if (!retained || resolved.length === 0) {
      return;
    }
    // Both lists are de-duplicated by `normalizeDialAddrs`, so equal size plus
    // containment is set equality.
    const current = resolved.map((addr) => addr.toString());
    const previous = new Set(this.bootstrapDialAddrs(peerId, retained).map((addr) => addr.toString()));
    if (current.length === previous.size && current.every((addr) => previous.has(addr))) {
      return;
    }
    this.retainDialTarget(peerId, current, 'refreshDialHint');
  }

  /**
   * {@link resolvePeerAddrs} for one sibling, best-effort: a control-DB read
   * failure yields `[]` (and the cold-start fallback then gets its turn) rather
   * than aborting the whole pass, like every other step here.
   */
  private async resolveSiblingAddrs(peerId: string): Promise<Multiaddr[]> {
    try {
      return await this.resolvePeerAddrs(peerId);
    } catch (error) {
      log('reconcileControlCohort: resolving addrs for %s failed (continuing): %o', peerId, error);
      return [];
    }
  }

  /**
   * Time limits for dialing ONE control-network peer from its candidate
   * addresses ({@link dialPeerAddrs}): the reconcile pass's steady-state sibling
   * ({@link dialControlSibling}) and cold-start bootstrap peer
   * ({@link dialBootstrapPeer}) dials, and — handed to every
   * {@link SeedBootstrapService} this node builds — `applySeed`'s owner dials.
   *
   * See `peer-dial.ts`'s `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` for why a peer's dial is
   * bounded as a whole, and `DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS` for why each
   * address is bounded as well.
   *
   * Both are DERIVED from `network.linkRoundTripMs` rather than fixed, because the slowest
   * address either has to cover is a relayed dial and that costs a fixed number of exchanges —
   * `link-budget.ts` has the counts. A host's explicit `controlCohort` values still win, so a
   * test that drives dead addresses on purpose keeps the duration it chose.
   */
  private controlDialBudget(): PeerDialBudget {
    const cohort = this.config.network?.controlCohort;
    const perAddressMs = cohort?.perAddressDialTimeoutMs
      ?? relayedDialBudgetMs(this.config.network?.linkRoundTripMs);
    return {
      perAddressMs,
      totalMs: cohort?.dialTimeoutMs ?? CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS * perAddressMs,
    };
  }

  /**
   * The link-derived limits shared by every {@link SeedBootstrapService} this node builds: its
   * owner and invite dials ({@link controlDialBudget}) and its seed delivery deadline, derived
   * from `network.linkRoundTripMs`. One helper so the four construction sites cannot drift.
   */
  private seedServiceBudgets(): Pick<SeedBootstrapConfig, 'dialBudget' | 'linkRoundTripMs'> {
    return {
      dialBudget: this.controlDialBudget(),
      linkRoundTripMs: this.config.network?.linkRoundTripMs,
    };
  }

  /**
   * {@link collectStrandAddrs} at this node's declared `network.linkRoundTripMs`, so each ask's
   * deadline derives from it. One helper so the four call sites cannot drift.
   */
  private async collectSiblingStrandAddrs(
    controlNode: Libp2p,
    peers: StrandAddrPeer[],
    strandId: string,
    delegatePeerId?: string
  ): Promise<StrandAddrCollection> {
    return await collectStrandAddrs(controlNode, peers, strandId, {
      delegatePeerId,
      linkRoundTripMs: this.config.network?.linkRoundTripMs,
    });
  }

  /**
   * Dial one sibling from its already-resolved addresses, best-effort. Returns
   * whether the dial resolved (false when no address resolves or the dial fails).
   *
   * A per-peer failure (NAT, offline, relay down, connection-gater denial, or
   * the {@link controlDialBudget} expiring) is logged and swallowed so one
   * unreachable sibling never aborts the pass — exactly like
   * {@link SeedBootstrapService.applySeed}'s owner-dial loop. A failed dial is
   * simply retried on the next pass. A sibling whose every address relays
   * through this node ({@link SelfRelayOnlyError}) is not dialed at all and gets
   * a one-line log instead: only the sibling can reconnect.
   */
  private async dialControlSibling(sibling: CohortPeerRow, resolved: Multiaddr[]): Promise<boolean> {
    const controlNode = this.controlNode;
    if (!controlNode) {
      return false;
    }
    const addrs = await this.resolveControlDialAddrs(sibling.peerId, resolved);
    if (addrs.length === 0) {
      log('reconcileControlCohort: no dialable control address for sibling %s; skipping', sibling.peerId);
      return false;
    }
    try {
      log('reconcileControlCohort: dialing sibling %s (%d addr(s))', sibling.peerId, addrs.length);
      await dialPeerAddrs(
        controlNode,
        addrs,
        this.controlDialBudget(),
        `reconcileControlCohort dial of sibling ${sibling.peerId}`
      );
      return true;
    } catch (error) {
      if (error instanceof SelfRelayOnlyError) {
        log('reconcileControlCohort: sibling %s is reachable only by relaying through this node; waiting for it to reconnect', sibling.peerId);
      } else {
        log('reconcileControlCohort: dial of sibling %s failed (continuing): %o', sibling.peerId, error);
      }
      return false;
    }
  }

  /**
   * A sibling's control-network dial addresses for the reconcile pass, from the
   * first of three sources that yields any:
   *
   *  1. the signed, fresh, trust-gated control addresses `resolved` for it by
   *     {@link warmSiblingAddrBook} — passed in rather than re-resolved, so the
   *     pass makes one record query per sibling;
   *  2. the libp2p address book ({@link peerStoreAddrs}) — the entries `applySeed`
   *     and identify put there, until they age out;
   *  3. the sibling's retained out-of-band dial target ({@link retainedDialAddrs}).
   *     For a node that cannot listen, this is the only source for a sibling it
   *     added but has not yet connected to: the added node's row stays unsigned
   *     until it self-publishes, which needs the connection this dial opens. It is
   *     also what a relaunch that outlived the record's freshness window uses.
   *
   * Returns `[]` (never throws) when none yields an address — that sibling is
   * skipped this pass.
   *
   * The list may name transports this node cannot dial (a lent node reports TCP
   * and `/ws` addresses to a phone that dials WebSockets only). That needs no
   * filtering here: libp2p's dial queue (`calculateMultiaddrs`, libp2p 3.3.11)
   * rejects an address no transport can dial before touching the network, so
   * such an address costs a log line.
   *
   * The list is NOT handed to one `dial()`. libp2p tries a multi-address dial's
   * addresses one after another under a single deadline, and sorts loopback
   * addresses last — so one or two addresses that never answer use up most of
   * the deadline before the address that works is tried. libp2p 3.3's
   * per-address `addressDialTimeout` does not prevent that: cadre sizes it for a
   * cold relayed open through two admission decisions (`optimysticDialLimits`,
   * 39 s at the default declared link).
   * {@link dialPeerAddrs} dials each address on its own time limit instead.
   */
  private async resolveControlDialAddrs(peerId: string, resolved: Multiaddr[]): Promise<Multiaddr[]> {
    if (resolved.length > 0) {
      return resolved;
    }
    const booked = await this.peerStoreAddrs(peerId);
    if (booked.length > 0) {
      return booked;
    }
    return this.retainedDialAddrs(peerId);
  }

  /**
   * A sibling's retained out-of-band dial target (see {@link bootstrapPeerStore}),
   * bound to its peer id through {@link bootstrapDialAddrs}; `[]` when it has none.
   *
   * These addresses are never merged into the libp2p address book: they are
   * unverified, and the address book takes only verified ones (see
   * `mergePeerAddrs`). Layers that dial by bare peer id use the connection this
   * dial opens, and after it drops the next reconcile pass dials again.
   *
   * NOTE: an entry is consulted here only for a current sibling, so a peer revoked
   * by another owner is not dialed from it, even though the entry stays (only this
   * node's own {@link removePeer} forgets one). The cold-start branch
   * ({@link dialColdStartBootstrap}) still dials every entry while there are no
   * siblings at all; if entries for revoked peers ever cause dial churn there,
   * prune entries whose peer has a retired `CadrePeer` row during the membership
   * refresh.
   */
  private retainedDialAddrs(peerId: string): Multiaddr[] {
    const entry = this.bootstrapPeerStore?.all().get(peerId);
    return entry ? this.bootstrapDialAddrs(peerId, entry.addrs) : [];
  }

  /**
   * Cold-start fallback: the libp2p peerStore multiaddrs for `peerId` (seeded by
   * {@link SeedBootstrapService.applySeed}). Returns `[]` on a missing entry or any
   * parse/lookup failure — never throws.
   *
   * Normalized through {@link normalizeDialAddrs} for the same reason
   * {@link resolvePeerAddrs} is, and with more cause: the address book hands back
   * a list that is inherently MIXED. `@libp2p/peer-store`'s
   * `dedupeFilterAndSortAddresses` strips a trailing `/p2p/<peerId>` only when
   * that id is the address's FIRST `/p2p/` component, so a direct address
   * round-trips bare while a relayed one — whose first `/p2p/` names the relay —
   * keeps its suffix (the same asymmetry `peer-addr-book.ts`'s `addrKey` exists
   * to absorb). Feeding both to one `dial()` is exactly the
   * `InvalidParametersError` that skipped the whole peer.
   */
  private async peerStoreAddrs(peerId: string): Promise<Multiaddr[]> {
    if (!this.controlNode) {
      return [];
    }
    try {
      const peer = await this.controlNode.peerStore.get(peerIdFromString(peerId));
      // Re-parse through the top-level multiaddr parser so the returned type matches
      // resolvePeerAddrs (the peerStore bundles its own @multiformats/multiaddr copy).
      return this.normalizeDialAddrs(
        this.parseMultiaddrs(peer.addresses.map((a) => a.multiaddr.toString())),
        peerId
      );
    } catch (error) {
      log('reconcileControlCohort: peerStore lookup for %s failed: %o', peerId, error);
      return [];
    }
  }

  /**
   * Retain a just-applied seed's owner-flagged peers as cold-start bootstrap
   * dial targets (see {@link bootstrapPeerStore}).
   *
   * Called for every seed this node accepts, on BOTH intake paths — the
   * {@link applySeed} wrapper (which may run on a throwaway service, so the
   * service itself is the wrong place to keep this) and the inbound
   * `/sereus/seed/1.0.0` handler via `onSeedApplied`. Peers with no address are
   * skipped: there is nothing to dial.
   *
   * `isOwner` is the seed's own claim about its peers, exactly as
   * `SeedBootstrapService.applySeed` uses it to choose its dial targets. That is
   * sound here for the same reason it is sound there — the whole seed is
   * signature-checked against a trust-anchored signer before this runs, and the
   * flag only *selects a dial target*; a dial grants no authority.
   *
   * Addressless peers and self are skipped by {@link retainDialTarget}.
   */
  private recordSeedBootstrapPeers(seed: ControlNetworkSeed): void {
    for (const peer of seed.peers) {
      if (peer.isOwner) {
        this.retainDialTarget(peer.peerId, peer.multiaddrs, 'recordSeedBootstrapPeers');
      }
    }
  }

  /**
   * Retain (or replace) one peer's out-of-band dial target in
   * {@link bootstrapPeerStore}. Shared by every writer: seed intake, {@link addDrone}
   * and {@link refreshDialHint}.
   *
   * Fire-and-log: the entry is visible synchronously by the store's contract, and
   * the promise tracks durability only. A persist failure costs restart survival,
   * never this session's dial set — the same trade
   * `SeedBootstrapService.anchorAcceptedSigner` makes — so it is logged rather than
   * failing a seed or an add that has already been accepted.
   *
   * Two peers are never retained. One with no address: there is nothing to dial.
   * And self: `createSeed` projects EVERY `CadrePeer` row, so an owner that applies
   * a seed minted after it joined finds itself in the owner list, and `addDrone`
   * could be handed this node's own id. Retaining self would make the cold-start
   * pass dial this node forever (the steady-state pass filters self out of its
   * sibling list for the same reason).
   */
  private retainDialTarget(peerId: string, addrs: readonly string[], caller: string): void {
    const store = this.bootstrapPeerStore;
    if (!store) {
      // Unreachable in production: start() builds the store before any network
      // bring-up, and every caller needs a started node (an uninitialized
      // SeedBootstrapService rejects a seed or an add, and the reconcile pass
      // needs a running one).
      log('%s: no bootstrap-peer store yet; not retaining %s', caller, peerId);
      return;
    }
    if (addrs.length === 0 || peerId === this.controlNode?.peerId.toString()) {
      return;
    }
    void store.record(peerId, addrs).catch((error: unknown) => {
      log('%s: persisting dial target %s failed (retained in memory): %o', caller, peerId, error);
    });
  }

  /**
   * Cold-start branch of the reconcile pass: re-dial every retained out-of-band
   * dial target (see {@link bootstrapPeerStore}) — in practice the owner peers of
   * the seeds this node applied — while the control database still has no
   * siblings to dial.
   *
   * `SeedBootstrapService.applySeed` dials those owners exactly ONCE, best-effort.
   * When that single dial fails — owner momentarily down, relay reservation not
   * up yet, NAT traversal lost the race — the joining node has an empty
   * `CadrePeer` table and no connection, and the steady-state pass above cannot
   * help: it dials only siblings enumerated from that very table. Retrying here
   * is the only way back in.
   *
   * Unbounded, at the reconcile cadence, with no backoff: the branch is already
   * gated by "the control database has no siblings", so it stops the moment the
   * node is actually in the party, and a node that is stranded MUST keep trying —
   * a give-up rule would turn a transient outage into a permanent one. The steady
   * cost is one dial per bootstrap peer per pass (seeds nominate one or a few
   * owners), each failing fast against an unreachable address.
   * NOTE: if seeds ever carry many owner peers, or the reconcile cadence tightens
   * well below its 15 s default, add per-peer backoff here.
   *
   * Best-effort per peer, exactly like {@link dialControlSibling}: one dead
   * address never aborts the pass.
   */
  private async dialColdStartBootstrap(): Promise<string[]> {
    const controlNode = this.controlNode;
    // Snapshot up front: the store hands back a copy, so a seed applied mid-pass
    // cannot mutate what we are iterating.
    const targets = this.bootstrapPeerStore?.all();
    if (!controlNode || !targets || targets.size === 0) {
      return [];
    }
    // Same skip rule as step 3 of the steady-state pass: no churn on live links.
    const connected = new Set(controlNode.getConnections().map((c) => c.remotePeer.toString()));
    const dialed: string[] = [];
    for (const [peerId, entry] of targets) {
      if (!this._running || !this.controlNode) {
        return dialed;
      }
      // NOTE: a connection this node still holds in `status: 'open'` after the remote
      // has already aborted it counts as connected here, so the cold-start retry stays
      // suppressed for that peer until the connection monitor's next ping notices the
      // abort — measured at ~9 s in `control-cohort-cold-start-retry.integration.ts`.
      // Bounded and self-healing today; it would start to matter if the connection
      // monitor's ping interval were lengthened, or if recovery ever had to meet a
      // deadline tighter than one ping interval.
      if (connected.has(peerId)) {
        continue;
      }
      if (await this.dialBootstrapPeer(peerId, entry.addrs)) {
        dialed.push(peerId);
      }
    }
    log('reconcileControlCohort: cold-start pass complete (bootstrap=%d, connected=%d, dialed=%d)',
      targets.size, connected.size, dialed.length);
    return dialed;
  }

  /**
   * Bind a retained dial target's addresses (see {@link bootstrapPeerStore}) to
   * its peer id, so the dial authenticates the peer it is aiming at rather than
   * trusting whoever answers.
   *
   * The same {@link normalizeDialAddrs} rule the resolved and address-book paths
   * use, on the third and last source of control-dial candidates: an address that
   * already terminates in `/p2p/<id>` must carry THIS peer's id or it is dropped
   * (an entry that disagrees with itself is not a dial target); one that does not —
   * a bare listen addr, or a relay hop with the destination missing — gets the id
   * encapsulated; an unencapsulatable one is dropped rather than dialed bare.
   */
  private bootstrapDialAddrs(peerId: string, addrs: string[]): Multiaddr[] {
    return this.normalizeDialAddrs(this.parseMultiaddrs(addrs), peerId);
  }

  /** Dial one cold-start bootstrap peer, best-effort. Returns whether it connected. */
  private async dialBootstrapPeer(peerId: string, addrs: string[]): Promise<boolean> {
    const controlNode = this.controlNode;
    if (!controlNode) {
      return false;
    }
    const parsed = this.bootstrapDialAddrs(peerId, addrs);
    if (parsed.length === 0) {
      log('reconcileControlCohort(cold-start): no dialable address for bootstrap peer %s; skipping', peerId);
      return false;
    }
    try {
      log('reconcileControlCohort(cold-start): dialing bootstrap peer %s (%d addr(s))', peerId, parsed.length);
      await dialPeerAddrs(
        controlNode,
        parsed,
        this.controlDialBudget(),
        `reconcileControlCohort cold-start dial of bootstrap peer ${peerId}`
      );
      return true;
    } catch (error) {
      if (error instanceof SelfRelayOnlyError) {
        log('reconcileControlCohort(cold-start): bootstrap peer %s is reachable only by relaying through this node; waiting for it to reconnect', peerId);
      } else {
        log('reconcileControlCohort(cold-start): dial of bootstrap peer %s failed (continuing): %o', peerId, error);
      }
      return false;
    }
  }

  // ============================================================================
  // Write-while-alone re-replication (control-write-ensure-replicated)
  //
  // Optimystic's coordinator commits a control write WITHOUT broadcasting when the
  // block's cluster has ≤1 member. An owner that authorizes/removes a peer or
  // (re)publishes its own record while no sibling is connected therefore writes a
  // row that exists ONLY in its local control DB — a sibling that connects later
  // never observes it (pull-on-read routes to the block's cluster, which never
  // learned of the write). reconcileControlCohort shrinks the alone window but
  // cannot close it (a write in the instant before any sibling connects is still
  // local-only). The remedy: detect "wrote while alone" (0 connections is a sound
  // lower bound), queue the affected row, and RE-ISSUE the write once the cohort
  // grows (0→≥1 connection), as an idempotent monotonic update that now broadcasts.
  // See docs/architecture.md (Control Network Convergence → "Writes made while alone").
  // ============================================================================

  /**
   * Whether a control write happening now would commit local-only. A sound lower
   * bound is "no connected control peers": 0 connections ⇒ the block's cluster is
   * ≤1 ⇒ Optimystic commits without broadcasting. This is the pragmatic proxy for
   * the precise signal (the block's `getClusterSize`); it over-approximates safely
   * — a connected-but-not-in-this-block's-cluster write may still be local-only and
   * is caught by the cohort's periodic pull-on-read instead. Re-issuing an already-
   * replicated row is harmless (an idempotent monotonic bump), so the coarse proxy
   * is acceptable as the agreed first cut.
   *
   * Reads {@link getControlConnectionCount} — the public, embedder-facing form of
   * the same sample — so the two cannot drift.
   */
  private committedAlone(): boolean {
    return this.getControlConnectionCount() === 0;
  }

  /**
   * Record (or clear) a just-committed owner membership write in the
   * write-while-alone re-replication queue. If the control node had no connections
   * at commit, the Optimystic write was local-only and must be re-issued once the
   * cohort grows; otherwise the write replicated and any stale queue entry for this
   * subject is dropped.
   *
   * A `remove` never queues here — a delete's re-replicable half is its
   * `Revocation` tombstone, which the committed-delete seam routes into
   * {@link pendingRevocations} ({@link noteGuardedDelete}). The `remove` arm only
   * drops any queued authorize for the subject (the row is gone; re-issuing the
   * insert would resurrect it) and, when the commit was alone, logs the
   * security-relevant window loudly.
   */
  private noteControlWrite(peerId: string, kind: 'authorize' | 'remove'): void {
    if (kind === 'remove') {
      this.pendingPeerWrites.delete(peerId);
      if (this.committedAlone()) {
        log('removePeer(%s) committed while ALONE (0 control connections): the deletion is ' +
          'local-only, so a revoked peer may persist in the cohort until the queued ' +
          'Revocation tombstone is re-issued on cohort growth (drainPendingRevocations).', peerId);
      }
      return;
    }
    if (!this.committedAlone()) {
      this.pendingPeerWrites.delete(peerId);
      return;
    }
    this.pendingPeerWrites.set(peerId, 'authorize');
    log('authorizePeer(%s) committed while alone (0 control connections); queued for ' +
      're-replication on cohort growth', peerId);
  }

  /**
   * Committed-delete seam handler ({@link GuardedDeleteListener}, wired in
   * {@link start}): a guarded-table delete and its `Revocation` tombstone
   * committed. If the node was alone the tombstone is local-only — queue it for
   * an owner-signed re-issue on cohort growth; otherwise it broadcast, so drop
   * any stale queue entry for the stamp. Synchronous by contract — bookkeeping
   * only, never throws into the delete path.
   */
  private noteGuardedDelete(revocation: RevokedRowRef): void {
    if (!this.committedAlone()) {
      this.pendingRevocations.delete(revocation.stampId);
      return;
    }
    this.pendingRevocations.set(revocation.stampId, revocation);
    log('%s tombstone for %s committed while alone (0 control connections); Revocation tombstone ' +
      '(stamp %s) queued for re-issue on cohort growth', revocation.tableName, revocation.rowKey, revocation.stampId);
  }

  /**
   * Drain the write-while-alone re-replication queue: re-issue the writes that
   * committed local-only now that the cohort can broadcast them. Public so the
   * 0→≥1 growth trigger ({@link handleControlConnectionChange}) and tests can drive
   * it; concurrent calls collapse into one in-flight drain
   * ({@link drainControlReplicationInFlight}) so two growth signals never
   * double-issue. Best-effort throughout — a per-row failure leaves that entry
   * queued for the next growth rather than aborting the drain.
   */
  async drainPendingControlReplication(reason: string): Promise<void> {
    if (this.drainControlReplicationInFlight) {
      return this.drainControlReplicationInFlight;
    }
    const op = this.runDrainControlReplication(reason);
    this.drainControlReplicationInFlight = op;
    try {
      await op;
    } finally {
      this.drainControlReplicationInFlight = null;
    }
  }

  /** Body of {@link drainPendingControlReplication}; serialised by its single-flight guard. */
  private async runDrainControlReplication(reason: string): Promise<void> {
    // Shutdown / not-yet-started guard (mirrors runReconcileControlCohort).
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    const firstGrowth = !this.reconstructedLocalOnlyWrites;
    log('Draining control re-replication (reason=%s, firstGrowth=%s, pendingPeers=%d, pendingRevocations=%d, self=%s, deviceToken=%s)',
      reason, firstGrowth, this.pendingPeerWrites.size, this.pendingRevocations.size,
      this.pendingSelfPeerWrite, this.pendingSelfDeviceWrite);

    // 1. Revocation tombstones FIRST: a removal that never reached the cohort
    //    leaves a revoked peer live elsewhere, which outranks every re-touch
    //    below. Ordering is not cosmetic — every `CadrePeer` write here (self row
    //    included) can burn tens of seconds in upstream retry livelock after a
    //    collection fork, while the tombstone lives in a different collection
    //    that is merely behind, not forked. No membership-gate refresh around
    //    this step: a re-issue only bumps `ReissuedAt` — LOCAL membership
    //    visibility changed at delete time (deleteCadrePeer already notified),
    //    and receiving-node staleness is the pre-existing pull-on-read /
    //    periodic-refresh property.
    await this.drainPendingRevocations();

    // 2. Self rows. On the first growth always re-touch (covers a self row carried
    //    over from a prior process that committed local-only before this start);
    //    afterwards only when a self-write-while-alone was recorded this session.
    //    registerSelf is idempotent + single-flight, so this never races a
    //    duplicate publish with the heartbeat republish.
    if (firstGrowth || this.pendingSelfPeerWrite) {
      await this.registerSelf().catch((error) => log('drain: registerSelf failed: %o', error));
      this.pendingSelfPeerWrite = false;
    }
    if (firstGrowth || this.pendingSelfDeviceWrite) {
      await this.retouchSelfDeviceToken();
      this.pendingSelfDeviceWrite = false;
    }

    // 3. First growth: an owner reconstructs membership rows it may have
    //    authored that never replicated (covers writes from before this process
    //    started). Rows already tracked in the in-memory queue are handled by
    //    step 4 — skipped here to avoid a double re-touch.
    if (firstGrowth) {
      this.reconstructedLocalOnlyWrites = true;
      await this.reconstructAuthoredMembership();
    }

    // 4. In-session pending owner authorize writes.
    await this.drainPendingPeerWrites();

    // 5. Pending joins this process wrote while alone. Their tombstones went out in step 1.
    await this.pendingJoinRunner?.reissueWritesMadeAlone();
  }

  /**
   * Re-touch this node's own `DeviceToken` row (re-sign + bump `UpdatedAt` via
   * {@link registerDeviceToken}) so a self device-token that committed local-only
   * re-broadcasts on cohort growth. No-op when no row exists (nothing to
   * re-replicate) or the stored platform is unknown. Best-effort — never throws to
   * the drain.
   */
  private async retouchSelfDeviceToken(): Promise<void> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    const peerId = this.controlNode.peerId.toString();
    try {
      const existing = await this.controlDatabase.queryDeviceToken(peerId);
      if (!existing || !isPushPlatform(existing.platform)) {
        return;
      }
      await this.registerDeviceToken(existing.platform, existing.token);
    } catch (error) {
      log('drain: retouch self DeviceToken failed: %o', error);
    }
  }

  /**
   * Re-issue `Revocation` tombstones so a removal that committed while alone
   * still reaches the cohort. Two regimes, one method:
   *
   * - **First successful pass per process** ({@link reissuedHeldRevocations}
   *   false): sweep EVERY locally-held tombstone from `queryRevocations()` — the
   *   only cover for a removal made before this process started, since the
   *   in-memory queue does not survive a restart. Queued stamps are part of that
   *   same batch (exactly once — one transaction, no double bump).
   * - **Later passes**: only the tombstones queued in-session by
   *   {@link noteGuardedDelete}.
   *
   * Owner-gated: a node with no owner key cannot sign a re-issue, so stray queue
   * entries are dropped (mirrors {@link drainPendingPeerWrites}). Best-effort — a
   * failure is logged and leaves the queue (and the sweep flag) untouched for the
   * next growth edge. A successful `reissueRevocations` exec is NOT proof of
   * broadcast (the connection that fired the growth edge may not be in the
   * affected block's cluster — see
   * tickets/backlog/control-rereplication-broadcast-confirmation); the drain
   * inherits that known gap, and a full disconnect→reconnect (or the next
   * process's sweep) re-covers it.
   *
   * NOTE: the sweep is O(all tombstones ever) row-updates — plus one owner
   * signature each — in one transaction, once per lifetime. `Revocation` is
   * append-only and unbounded growth is declared acceptable for a cadre-sized
   * party. If the tombstone table ever gets large, bound the sweep (e.g. persist
   * a node-local high-water mark of what has been re-issued while connected)
   * instead of re-touching everything; note the `Math.max(...)` spread below also
   * caps out around 10^5 rows (V8 argument limit) before the size becomes merely
   * a latency problem.
   */
  private async drainPendingRevocations(): Promise<void> {
    const sweep = !this.reissuedHeldRevocations;
    if (!sweep && this.pendingRevocations.size === 0) {
      return;
    }
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      return;
    }
    if (!this.seedBootstrapService?.canAuthorize()) {
      // A non-owner node cannot sign a re-issue; drop any stray entries.
      this.pendingRevocations.clear();
      return;
    }
    try {
      const held = await this.controlDatabase.queryRevocations();
      const rows = sweep ? held : held.filter((r) => this.pendingRevocations.has(r.stampId));
      if (rows.length > 0) {
        const reissuedAt = Math.max(Date.now(), Math.max(...rows.map((r) => r.reissuedAt)) + 1);
        await this.seedBootstrapService.reissueRevocations(rows, reissuedAt);
        log('drain: re-issued %d revocation tombstone(s)%s', rows.length, sweep ? ' (first-growth sweep)' : '');
      }
      this.reissuedHeldRevocations = true;
      // Per-stamp clear (not clear()) so an entry queued concurrently mid-drain
      // survives for the next growth edge.
      for (const row of rows) {
        this.pendingRevocations.delete(row.stampId);
      }
    } catch (error) {
      log('drain: revocation re-issue failed; leaving queued for next growth: %o', error);
    }
  }

  /**
   * One-shot, first-cohort-growth reconstruction of the write-while-alone queue for
   * an OWNER node: re-touch every membership row that may be an unreplicated
   * owner insert. A row is a candidate iff it is not self (handled by
   * {@link registerSelf}), is not already tracked in the in-memory queue (handled by
   * {@link drainPendingPeerWrites}), and carries no self-`Sig` yet (an
   * owner-authored row the peer has not self-published — the only kind safe to
   * bump without invalidating a self-signature). O(rows) on the small control
   * tables; safe to over-apply (a monotonic owner bump on an already-replicated
   * row is a no-op-equivalent).
   *
   * A node with no owner private key skips this entirely — it cannot re-sign
   * rows for other peers, and rows it merely holds are not its to re-issue.
   * DELETEs are not reconstructed here — the `Revocation` tombstone sweep in
   * {@link drainPendingRevocations} covers them (a removed row leaves no
   * `CadrePeer` trace, but its tombstone is re-issuable).
   */
  private async reconstructAuthoredMembership(): Promise<void> {
    if (!this.controlDatabase || !this.controlNode) {
      return;
    }
    if (!this.seedBootstrapService?.canAuthorize()) {
      return;
    }
    const selfPeerId = this.controlNode.peerId.toString();
    const members = await this.controlDatabase.queryCadrePeers();
    // One gate refresh for the whole sweep: every re-touch is a notifying
    // `CadrePeer` write, and these rows are already in the local snapshot (they
    // committed here, just local-only), so per-row refreshes would be O(rows)
    // membership reads for a snapshot that does not change.
    const touched = await this.deferMembershipGateRefresh(
      'drain-reconstruct',
      () => this.reissueAuthoredMembershipRows(selfPeerId, members)
    );
    if (touched > 0) {
      log('drain: reconstructed %d owner-authored membership row(s) on first cohort growth', touched);
    }
  }

  /**
   * Body of {@link reconstructAuthoredMembership}'s sweep: re-issue each candidate
   * owner-authored row, returning how many were re-touched. A per-row failure is
   * logged and skipped; a teardown mid-sweep stops it.
   */
  private async reissueAuthoredMembershipRows(selfPeerId: string, members: CadrePeerRow[]): Promise<number> {
    let touched = 0;
    for (const member of members) {
      if (!this._running || !this.controlNode || !this.controlDatabase) {
        return touched;
      }
      if (member.peerId === selfPeerId || this.pendingPeerWrites.has(member.peerId)) {
        continue;
      }
      try {
        const record = await this.controlDatabase.queryPeerRecord(member.peerId);
        // Missing (raced a delete) or peer-owned (self-Sig present) → not ours to bump.
        if (!record || record.sig) {
          continue;
        }
        await this.reissuePeerAuthorize(member.peerId, record.updatedAt);
        touched++;
      } catch (error) {
        log('drain: reconstruction re-touch of %s failed (continuing): %o', member.peerId, error);
      }
    }
    return touched;
  }

  /**
   * Drain the in-session write-while-alone queue: re-issue each pending owner
   * authorize as an idempotent monotonic owner UPDATE
   * ({@link reissuePeerAuthorize}) now that the cohort can broadcast it.
   * Sequential (no fan-out) to avoid a thundering re-touch; an entry is cleared
   * only on success, so a failure (or a still-alone re-commit) leaves it queued
   * for the next growth. An entry is skipped (and cleared) if the row vanished
   * (raced a delete) or now carries a self-`Sig` (the peer self-published and owns
   * its republish). Removals are drained by {@link drainPendingRevocations}, not
   * here.
   */
  private async drainPendingPeerWrites(): Promise<void> {
    if (this.pendingPeerWrites.size === 0) {
      return;
    }
    if (!this.seedBootstrapService?.canAuthorize()) {
      // A non-owner node cannot have authored these writes; drop any stray entries.
      this.pendingPeerWrites.clear();
      return;
    }
    // One gate refresh for the whole drain, not one per entry: these re-issues
    // replay writes this node already applied locally (and already refreshed
    // for), so the snapshot only has to be correct once the drain settles.
    await this.deferMembershipGateRefresh('drain-reissue', () => this.reissuePendingPeerWrites());
  }

  /**
   * Body of {@link drainPendingPeerWrites}' loop. An entry is cleared only on
   * success (or when there is nothing left to re-issue); a failure is logged and
   * the entry stays queued for the next cohort growth.
   */
  private async reissuePendingPeerWrites(): Promise<void> {
    for (const peerId of [...this.pendingPeerWrites.keys()]) {
      if (!this._running || !this.controlNode || !this.controlDatabase || !this.seedBootstrapService) {
        return;
      }
      try {
        const record = await this.controlDatabase.queryPeerRecord(peerId);
        if (!record || record.sig) {
          // Removed since, or peer self-published — nothing for the owner to re-issue.
          this.pendingPeerWrites.delete(peerId);
          continue;
        }
        await this.reissuePeerAuthorize(peerId, record.updatedAt);
        this.pendingPeerWrites.delete(peerId);
      } catch (error) {
        log('drain: re-issue of %s (authorize) failed; leaving queued for next growth: %o', peerId, error);
      }
    }
  }

  /**
   * Re-issue an owner membership row as a monotonic owner UPDATE: bump
   * `UpdatedAt` strictly above the stored value (and the wall clock) and re-sign via
   * the owner branch of `CadrePeer.AuthorizedUpdate`. The row already exists
   * locally (it committed there, just local-only), so this is an UPDATE, not the
   * original INSERT.
   */
  private async reissuePeerAuthorize(peerId: string, currentUpdatedAt: number): Promise<void> {
    if (!this.seedBootstrapService) {
      return;
    }
    const updatedAt = Math.max(Date.now(), (currentUpdatedAt ?? 0) + 1);
    await this.seedBootstrapService.reauthorizePeer(peerId, updatedAt);
  }

  /**
   * On a control connection opening, detect the 0→≥1 transition and drain the
   * write-while-alone re-replication queue (single-flight; fires only on the edge,
   * not on every subsequent `connection:open`). Best-effort — a drain failure is
   * logged, not thrown.
   */
  private handleControlConnectionChange(): void {
    if (!this._running || !this.controlNode) {
      return;
    }
    const connected = this.controlNode.getConnections().length > 0;
    if (!connected || this.hasControlConnection) {
      return;
    }
    this.hasControlConnection = true;
    log('Control cohort grew (0 → ≥1 connection); draining write-while-alone re-replication queue');
    void this.drainPendingControlReplication('connection:open')
      .catch((error) => log('Control re-replication drain (connection:open) failed: %o', error));
  }

  /** Re-arm the growth edge once all control connections drop, so a later reconnect re-drains. */
  private handleControlConnectionClose(): void {
    if (!this.controlNode) {
      return;
    }
    if (this.controlNode.getConnections().length === 0) {
      this.hasControlConnection = false;
    }
  }

  /**
   * Wire the control-connection growth listeners that drive write-while-alone
   * re-replication. Wired in {@link start} (not the delayed refresh path) so no
   * early `connection:open` is missed; torn down in {@link stopRecordRefresh}.
   * Idempotent.
   */
  private wireControlConnectionListeners(): void {
    if (!this.controlNode || this.controlConnectionOpenHandler) {
      return;
    }
    this.controlConnectionOpenHandler = () => this.handleControlConnectionChange();
    this.controlConnectionCloseHandler = () => this.handleControlConnectionClose();
    this.controlNode.addEventListener('connection:open', this.controlConnectionOpenHandler);
    this.controlNode.addEventListener('connection:close', this.controlConnectionCloseHandler);
  }

  // ============================================================================
  // Device-token registry (control-network push-token publish + resolve)
  //
  // The control network is the only network a hibernating peer keeps connected,
  // so it is where a mobile peer self-publishes its FCM/APNs push token and where
  // a server peer resolves it to deliver a push-wake to a suspended app. The write
  // + gate paths mirror registerSelf / resolvePeerAddrs (see DeviceToken in
  // control-schema.ts and device-token.ts).
  // ============================================================================

  /**
   * Publish (or refresh) this node's own self-signed `DeviceToken` row so a server
   * peer can resolve its FCM/APNs push token from its PeerId alone. Mirrors
   * {@link registerSelf}:
   *
   * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt` (works
   *   for any member — the `AuthorizedUpdate` self-branch verifies the new `Sig`
   *   against the bound `CadrePeer.PublicKey`). Platform/Token may change here
   *   (rotation / platform switch / reinstall are all normal self-updates).
   * - If not, and the node holds an owner service: an owner-signed INSERT
   *   that also carries the self-signature.
   * - Otherwise: throws. Like `CadrePeer`, the first `DeviceToken` row requires an
   *   owner signature; a non-owner peer (e.g. a phone) must have its row
   *   seeded by an owner — typically the server it enrolled with — before it
   *   can self-refresh. (Establishing that phone→server registration handshake is
   *   the downstream "RN registration" ticket; this node only owns the cadre-core
   *   write path.)
   *
   * `UpdatedAt` strictly increases on every publish (even a same-millisecond
   * re-publish), so a replayed older record is rejected by the schema.
   *
   * @param platform - `'fcm'` (Android/Firebase) or `'apns'` (Apple).
   * @param token - the opaque platform device/registration token.
   * @throws if the node is not started, exposes no self-signing key, or has no
   *   existing row and no owner service to self-insert.
   */
  async registerDeviceToken(platform: PushPlatform, token: string): Promise<void> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before registering a device token');
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        'Cannot register device token: no self-signing key available ' +
        '(node identity unavailable or not matching the node PeerId).'
      );
    }

    const peerId = this.controlNode.peerId.toString();
    const existing = await this.controlDatabase.queryDeviceToken(peerId);
    // Strictly increase UpdatedAt even on a same-millisecond re-publish (rotation).
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const record = signDeviceTokenRecord(
      { peerId, platform, token, updatedAt },
      signingKey.privateKeyB64
    );

    if (existing) {
      await this.controlDatabase.updateSelfDeviceToken(record);
      if (this.committedAlone()) this.pendingSelfDeviceWrite = true;
      log('registerDeviceToken: refreshed own DeviceToken (platform=%s, updatedAt=%d)', platform, updatedAt);
      return;
    }
    if (this.seedBootstrapService) {
      // NOTE: the `CadrePeer` twin of this read-then-insert needed race recovery because an
      // owner `authorizePeer` can seat a peer's row for it. Nothing seats a `DeviceToken`
      // row on a peer's behalf, and this insert has no in-lock existence check, so a lost
      // race would THROW rather than silently drop the record. If an owner-driven
      // device-token seeding path is ever added, or two first-publishes can run
      // concurrently (this method has no single-flight guard, unlike `registerSelf`),
      // revisit — see `publishSelfRecord`'s fall-through.
      await this.seedBootstrapService.insertSelfDeviceToken(record);
      if (this.committedAlone()) this.pendingSelfDeviceWrite = true;
      log('registerDeviceToken: inserted own DeviceToken (owner-signed, platform=%s, updatedAt=%d)', platform, updatedAt);
      return;
    }
    throw new Error(
      `Cannot register device token for ${peerId}: no existing row to self-update and no ` +
      'owner service to self-insert. An owner must seed this peer\'s DeviceToken ' +
      'row first (mirrors CadrePeer enrollment).'
    );
  }

  /**
   * Resolve a cadre peer's FCM/APNs push token from only its PeerId — the input a
   * server's push-wake fan-out consumes to deliver a platform push to a suspended
   * app. Applies the same gating shape as {@link resolvePeerAddrs}, returning
   * `null` (never throwing) on any failure:
   *
   *   1. membership — the peer has a `CadrePeer` row with a `PublicKey`,
   *   2. `publicKey <-> peerId` binding — the stored key's libp2p identity is the
   *      requested peerId,
   *   3. a `DeviceToken` row exists with a known {@link PushPlatform},
   *   4. the row's `StampId` is NOT retired in `CadreControl.Revocation` — the
   *      read-side half of the clear (see below),
   *   5. self-signature verifies against the bound `CadrePeer.PublicKey`,
   *   6. freshness — `updatedAt` is positive and within `opts.maxAgeMs` (default:
   *      no ceiling, since a push token is valid until it rotates).
   *
   * A peer that is not a current member, or whose token has no backing `CadrePeer`
   * record, resolves to `null` — a server must not attempt to push to a non-cadre
   * peer.
   */
  async resolveDeviceToken(peerId: string, opts: ResolveDeviceTokenOpts = {}): Promise<DeviceTokenRecord | null> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before resolving a device token');
    }

    // Membership + publicKey<->peerId binding: read the peer's CadrePeer row and
    // confirm the stored key is the one embedded in the requested Ed25519 peer id.
    const peerRecord = await this.controlDatabase.queryPeerRecord(peerId);
    if (!peerRecord || !peerRecord.publicKey) {
      log('resolveDeviceToken: no CadrePeer/PublicKey for %s', peerId);
      return null;
    }
    if (ed25519PublicKeyB64FromPeerId(peerId) !== peerRecord.publicKey) {
      log('resolveDeviceToken: publicKey does not match peerId for %s', peerId);
      return null;
    }

    const record = await this.controlDatabase.queryDeviceToken(peerId);
    if (!record) {
      log('resolveDeviceToken: no device token for %s', peerId);
      return null;
    }
    if (!isPushPlatform(record.platform)) {
      log('resolveDeviceToken: unknown platform %s for %s', record.platform, peerId);
      return null;
    }

    // Retired stamp: the read-side mitigation for the write-time race, mirroring what
    // listAuthorizedMembers does for CadrePeer. Clearing a token retires its StampId
    // into Revocation, but the schema's NotRevoked CHECK only sees LOCALLY visible
    // tombstones — a node that converged on a replayed insert before the tombstone can
    // hold both rows, so the reader must drop the resurrected one.
    //
    // NOTE: the freshness ceiling below defaults to INFINITE by design (a suspended
    // phone must stay push-reachable long after it published), so unlike a peer address
    // record a stale token never ages out. Stamp retirement is the ONLY thing that
    // retires a cleared token — do not weaken this check on the assumption that
    // staleness will eventually cover it.
    const revokedStamps = await this.controlDatabase.queryRevokedStamps('DeviceToken');
    if (revokedStamps.has(record.stampId)) {
      log('resolveDeviceToken: StampId for %s is retired (cleared token, resurrected row)', peerId);
      return null;
    }

    // Self-signature over (peerId, platform, token, updatedAt), verified against the
    // CadrePeer.PublicKey bound to this peerId.
    if (!verifyDeviceTokenSignature(record, peerRecord.publicKey)) {
      log('resolveDeviceToken: signature verification failed for %s', peerId);
      return null;
    }

    // Freshness: a positive stamp, optionally bounded. No ceiling by default — a
    // suspended phone's token must stay resolvable for push-wake long after publish.
    const maxAgeMs = opts.maxAgeMs ?? Number.POSITIVE_INFINITY;
    if (!isPeerRecordFresh(record.updatedAt, maxAgeMs, Date.now())) {
      log('resolveDeviceToken: record for %s is stale (updatedAt=%d, maxAgeMs=%d)', peerId, record.updatedAt, maxAgeMs);
      return null;
    }

    return record;
  }

  /**
   * Delete this node's own `DeviceToken` row (logout / token invalidation). No-op
   * when no row exists. Like {@link registerDeviceToken}'s first insert, the delete
   * is gated on an owner signature (`DeviceToken.AuthorizedInsert` covers insert
   * AND delete), so it requires this node's owner service; a non-owner peer
   * must route the clear through its owner (downstream RN registration path).
   *
   * @throws if the node is not started, or a row exists but no owner service is
   *   available to sign the delete.
   */
  async clearDeviceToken(): Promise<void> {
    if (!this._running || !this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before clearing a device token');
    }
    const peerId = this.controlNode.peerId.toString();
    const existing = await this.controlDatabase.queryDeviceToken(peerId);
    if (!existing) {
      log('clearDeviceToken: no DeviceToken row for %s; no-op', peerId);
      return;
    }
    if (!this.seedBootstrapService) {
      throw new Error(
        `Cannot clear device token for ${peerId}: delete requires an owner signature ` +
        'and no owner service is initialized.'
      );
    }
    await this.seedBootstrapService.deleteDeviceToken(peerId);
    log('clearDeviceToken: deleted DeviceToken for %s', peerId);
  }

  /**
   * Expire ANOTHER peer's stale `DeviceToken` after a platform reported it
   * unregistered during a push-wake fan-out. Unlike {@link clearDeviceToken}
   * (self-only — it hardcodes the local peerId), this takes an arbitrary peerId.
   *
   * - When this node holds an owner seed service, it deletes the row
   *   (`deleteDeviceToken` is owner-gated and accepts any peerId), so the peer
   *   is not retried until it re-registers.
   * - When this node is NOT an owner it cannot delete the row, so it only logs
   *   that a re-registration is needed. The fan-out's own in-memory dead-token set
   *   is what actually stops re-pushing to the dead token this process — see
   *   {@link PushFanoutService}. That set is acceptably lossy across restarts (a
   *   restart re-learns staleness on the next failed send).
   *
   * Best-effort: never throws to the (best-effort) fan-out caller.
   */
  async expireDeviceToken(peerId: string): Promise<void> {
    if (this.seedBootstrapService) {
      try {
        await this.seedBootstrapService.deleteDeviceToken(peerId);
        log('expireDeviceToken: owner-deleted stale DeviceToken for %s', peerId);
      } catch (error) {
        log('expireDeviceToken: owner delete for %s failed: %o', peerId, error);
      }
      return;
    }
    log('expireDeviceToken: %s token is stale but this node is not an owner; re-registration required', peerId);
  }

  private async handleStrandAdded(strand: StrandRow): Promise<void> {
    log('Handling strand added from control network: %s', strand.Id);

    // A replicated row carries whatever id the founding node wrote, and the id becomes a
    // storage scope key and a libp2p protocol prefix. Checked FIRST — above the
    // discovery branch below — so a malformed id is never offered to the hosting app as
    // a strand it could join; that app's `addStrand` could only fail on it.
    //
    // Suppressed rather than retried: the id is a property of the row, so every later
    // attempt fails identically, and without this the watcher's ladder would re-emit
    // `strand:error` every five minutes for the life of the process. The throw still
    // matters — the watcher's catch runs `forgetStrand`, dropping the id from
    // `knownStrands`, so its removed-strand loop never detaches a strand that never ran.
    if (!isValidStrandScopeKey(strand.Id)) {
      const error = new InvalidStrandIdError(strand.Id);
      log('Refusing strand %s: %s', strand.Id, error.message);
      this.emit('strand:error', { strandId: strand.Id, error });
      this.strandWatcher?.suppressStrand(strand.Id);
      throw error;
    }

    // Check if we have sApp config for this strand
    const sAppConfig = this.sAppConfigs.get(strand.Id);
    if (!sAppConfig) {
      this.announceDiscoveredStrand(strand);
      // Announce-only unless this node hosts storage replicas. Also skipped when a
      // listener claimed the strand synchronously (an `addStrand` call registers its
      // config before its first await): that claim is launching it with the app's schema,
      // and a replica launch here would only race it.
      if (!this.hostUnclaimedStrands || this.sAppConfigs.has(strand.Id)) {
        return;
      }
    }

    try {
      const instance = await this.launchStrand(strand, sAppConfig);
      if (!sAppConfig) {
        void this.recordReplicaSAppId(instance.strandId);
      }
    } catch (error) {
      log('Error starting strand %s: %o', strand.Id, error);
      this.emit('strand:error', {
        strandId: strand.Id,
        error: error instanceof Error ? error : new Error(String(error))
      });
      // Rethrow after the event: the only caller is the StrandWatcher's
      // onStrandAdded callback, which uses the rejection to decide whether the
      // strand was really added. Swallowing it here would have the watcher mark
      // the strand as known-and-added, so no later poll would ever retry it.
      // The watcher catches and logs, so this never escapes as an unhandled
      // rejection.
      throw error;
    }
  }

  /**
   * Offer a strand no local config claims to the hosting app as `strand:discovered`, so
   * it can decide whether to join (register a config + addStrand); the strand-agnostic
   * seam keeps this class free of any app's join policy.
   *
   * Once per strand: a storage-replica launch that fails is retried by the watcher
   * (`StrandWatcher.forgetStrand` + backoff), and each retry comes back through
   * {@link handleStrandAdded} with no config — the app must still see one announcement.
   * The other thing that un-retains a strand in the watcher (a failed `addStrand`) leaves
   * the sApp config registered, so that retry takes the claimed branch instead.
   *
   * Recorded BEFORE the emit so a handler that synchronously drains
   * `getDiscoveredStrands()` sees this strand too. So this map — not the event — is what
   * a late subscriber reads. See the `strand:discovered` doc in types.ts.
   *
   * NOTE: a replica launch that keeps failing leaves the watcher not tracking the strand,
   * so if its control row is removed during the backoff no `handleStrandRemoved` arrives
   * and this entry outlives the row. Needs a persistently failing launch AND a removal
   * inside the backoff; if it is ever seen, have the watcher report removal of rows it
   * forgot, since `detachStrand` is already a no-op for an untracked instance.
   */
  private announceDiscoveredStrand(strand: StrandRow): void {
    if (this.discoveredStrands.has(strand.Id)) {
      return;
    }
    log('No sAppConfig registered for strand %s - emitting strand:discovered', strand.Id);
    this.discoveredStrands.set(strand.Id, strand);
    this.emit('strand:discovered', { strandId: strand.Id, strand });
  }

  /**
   * Record the sApp id a storage replica's `Strand.Header` names, for {@link getSAppId}.
   * Runs whenever a replica's database may have just been published (launch, the
   * first-sync gate opening, a wake); a no-op for a claimed strand, an unpublished
   * database, or an id already recorded. Never throws: a failed read logs and leaves the
   * id unknown, so an `sAppId` filter keeps the strand provisionally admitted — a
   * syncing replica, which is harmless.
   */
  private async recordReplicaSAppId(strandId: string): Promise<void> {
    const database = this.strandManager.getInstance(strandId)?.database;
    if (!database || this.sAppConfigs.has(strandId) || this.replicaSAppIds.has(strandId)) {
      return;
    }
    try {
      const sAppId = await readStrandHeaderSAppId(database.getDatabase());
      if (sAppId !== undefined) {
        this.replicaSAppIds.set(strandId, sAppId);
        log('Storage replica %s serves sApp %s', strandId, sAppId);
      }
    } catch (error) {
      log('Could not read the sApp id of storage replica %s (left unknown): %o', strandId, error);
    }
  }

  private async handleStrandRemoved(strandId: string): Promise<void> {
    log('Handling strand removed: %s', strandId);

    try {
      // Same local teardown the explicit stop performs — deliberately NOT stopStrand
      // itself, whose `_running` guard would throw on a poll that lands during shutdown.
      await this.detachStrand(strandId);
    } catch (error) {
      log('Error stopping strand %s: %o', strandId, error);
      this.emit('strand:error', {
        strandId,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  /**
   * Return this node to its pre-{@link start} state. The ONE teardown — `stop()` and
   * a failed `start()` both come here, so anything a stopped node must not still be
   * doing belongs in this method and not in `stop()`. `stop()` adds only the
   * `control:disconnected` emit, which a never-connected start has no edge for.
   */
  private async cleanup(): Promise<void> {
    // Open the connection gate's bring-up quiet period unconditionally: teardown
    // must never be gated, and this is the path a FAILED start() takes.
    this.controlBringUpInFlight = false;

    // Stop the relay retry loop BEFORE tearing the node down, not after: the control
    // node is stopped partway through below, and a tick that fires during it would
    // dial and then poll a half-torn-down node for the whole reserve timeout —
    // logging spurious dial failures on a `.unref()`'d timer that nothing ever
    // clears. `driveControlRelayReservation` starts this supervisor from inside
    // `start()`, so a start that fails ON the reservation leaves one running unless
    // it is stopped here.
    this.relayReserveSupervisor?.stop();
    this.relayReserveSupervisor = null;
    // Before anything it reads is torn down. An attempt in flight is not awaited (NOTE at
    // `PendingJoinRunner.stop`).
    this.pendingJoinRunner?.stop();
    this.pendingJoinRunner = null;
    // Drop the rest of the relay-reservation posture: a torn-down node holds no
    // reservation, so neither a restarted instance nor a caller inspecting a failed
    // start reports the previous attempt's `reserved`.
    this.relayReserveAddrs = [];
    this.relayReserveError = null;

    // Resolve + clear any in-flight wake windows first, so an in-flight check-in
    // or serviceWake unblocks and tears down cleanly rather than firing a stale
    // window timer (or hanging) after the strand manager is stopped below.
    this.clearWindowWaiters();

    // Stop self-record refresh timers + address-change listener (before the
    // control node is torn down, so removeEventListener has a live target).
    this.stopRecordRefresh();

    // Stop hibernation manager
    this.hibernationManager.stop();

    // Stop seed bootstrap service
    if (this.seedBootstrapService) {
      await this.seedBootstrapService.shutdown();
      this.seedBootstrapService = null;
    }

    // Stop strand wake service (unregister the WAKE_PROTOCOL handler)
    if (this.strandWakeService) {
      await this.strandWakeService.shutdown();
      this.strandWakeService = null;
    }

    // Stop strand-addr service (unregister the STRAND_ADDR_PROTOCOL handler so a
    // restart does not hit DuplicateProtocolHandlerError).
    if (this.strandAddrService) {
      await this.strandAddrService.shutdown();
      this.strandAddrService = null;
    }

    // Unregister the cadre invitation redemption handler, for the same reason.
    if (this.cadreInviteHandler && this.controlNode) {
      await this.cadreInviteHandler.unregister(this.controlNode);
    }
    this.cadreInviteHandler = null;

    // Tear down the push-wake fan-out (releases the notifier's APNs HTTP/2 session).
    if (this.pushFanoutService) {
      await this.pushFanoutService.close().catch((err) => log('Push fan-out close failed: %o', err));
      this.pushFanoutService = null;
    }

    // Unregister the formation responder once any queued swap has run, so no swap
    // registers a handler after this. A restarted node installs a fresh one.
    await this.solicitationSwaps;
    if (this.registeredSolicitation && this.controlNode) {
      await this.registeredSolicitation.unregisterResponder(this.controlNode);
    }
    this.registeredSolicitation = null;
    this.strandSolicitationService = null;

    // Stop strand watcher
    if (this.strandWatcher) {
      await this.strandWatcher.stop();
      this.strandWatcher = null;
    }

    // Stop all strand instances
    await this.strandManager.stopAll();

    // Clear sApp configs, recorded launch refusals and the unclaimed-strand backlog
    this.sAppConfigs.clear();
    this.strandLaunchRefusals.clear();
    this.discoveredStrands.clear();
    this.replicaSAppIds.clear();

    // Drop delegate-admission state: the grants are scoped to the session that
    // recorded them, so a stop()/start() cycle on this object must not keep
    // admitting delegates announced under the previous one, nor carry stale
    // announce timestamps that would suppress the next session's refresh.
    this.delegateAdmission.clear();
    this.delegateAnnounceAt.clear();

    // Control backfill first — before the database closes and the control node
    // stops — so no NEW catch-up push is issued against a torn-down transport.
    // A push already in flight is not awaited; it fails into the module's own
    // per-chunk catch. (Mirrors releaseRuntime in strand-instance-manager.ts.)
    if (this.controlBackfill) {
      this.controlBackfill.stop();
      this.controlBackfill = null;
    }

    // Close control database (this also shuts down the collection factory).
    // Detach the membership hub first: nothing this teardown does should drive a
    // gate refresh, and a notification arriving after this point is a no-op.
    if (this.controlDatabase) {
      this.controlDatabase.setMembershipChangeListener(null);
      this.controlDatabase.setGuardedDeleteListener(null);
      this.controlDatabase.setControlWriteAbandonedListener(null);
      await this.controlDatabase.close();
      this.controlDatabase = null;
    }

    // Stop control node
    if (this.controlNode) {
      await this.controlNode.stop();
      this.controlNode = null;
    }

    // Release the control store's claim on its cache LAST — after the database and
    // node that write through it are down. The wrapper counts holders, so this empties
    // and unregisters the cache only if no other scope still holds it. Dropping the
    // field is what lets a stop()/start() cycle re-resolve the provider against a live
    // cache instead of handing the restarted node a retired wrapper. Logged, never
    // thrown: a cache-bookkeeping failure must not abort a teardown.
    if (this.controlStorage) {
      const controlStorage = this.controlStorage;
      this.controlStorage = null;
      await disposeStorageCache(controlStorage).catch(
        (err) => log('Failed to dispose control storage cache: %o', err)
      );
    }

    // LAST, so every step above still ran against a node that considered itself up
    // (several of them early-return while `_running` is false). A failed `start()`
    // that had already flipped it — the reservation drive throws after that point —
    // must not leave `isRunning` true over a torn-down node, which would report
    // healthy and make the embedder's retry a no-op ("already running").
    this._running = false;
  }

  /**
   * A gated joiner's database was just published (`StartStrandConfig.onWritable`): the
   * instance is `'active'` now, so re-arm its idle timer as any activity would. Nothing
   * records activity on a gated joiner, so its idle timer may already have fired — the
   * instance read `'idle'` with a hibernate timer pending — and without this the flip
   * back to `'active'` would leave that timer to quiesce a strand the app just started
   * using. Emits `strand:writable` after the timers are settled.
   */
  private handleStrandWritable(strandId: string): void {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      this.hibernationManager.recordActivity(instance);
    }
    void this.recordReplicaSAppId(strandId);
    this.emit('strand:writable', { strandId });
  }

  // Hibernation callbacks
  private async handleStrandIdle(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = 'idle';
      log('Strand %s transitioned to idle', strandId);
      this.emit('strand:idle', { strandId });
    }
  }

  /**
   * Hibernate a strand: release its strand-network resources via the strand
   * manager (stop the libp2p node, close the StrandDatabase), which marks it
   * `hibernating`. A quiesced strand holds no open strand-network connections,
   * transports, or DB handles. No-ops if the strand is missing; one already quiesced
   * is only marked, and still emits.
   */
  private async handleStrandHibernate(strandId: string): Promise<void> {
    if (!this.strandManager.getInstance(strandId)) {
      log('handleStrandHibernate: strand %s not found', strandId);
      return;
    }

    log('Hibernating strand %s — releasing strand-network resources', strandId);
    await this.strandManager.quiesceStrand(strandId);
    this.emit('strand:hibernating', { strandId });
    log('Strand %s hibernating (resources released)', strandId);
  }

  /**
   * Wake a strand. If it was hibernating (quiesced — no libp2p node), re-resolve
   * the cohort discovery seed exactly as `launchStrand` does and rebuild
   * its runtime via the strand manager. If it is still live (e.g. waking an idle
   * strand, which retains its resources), just flip the status. Overlapping wake
   * triggers are coalesced upstream by `HibernationManager`, so this runs once
   * per wake; a wake racing a check-in joins the check-in's rebuild in `resumeStrand`.
   *
   * A failed rebuild re-hibernates the strand (see {@link rehibernateIfResumeFailed});
   * every failure rethrows, so the waker still sees the error.
   *
   * Records no activity itself: whoever asked for the wake did ({@link wakeStrand},
   * `HibernationManager.recordActivity`), and {@link serviceWake}'s own probe must not.
   */
  private async handleStrandWake(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('handleStrandWake: strand %s not found', strandId);
      return;
    }

    // Still live (idle wake, or defensive double-wake): no rebuild needed. A joiner
    // still behind its first-sync gate wakes back to `'syncing'`, not `'active'`. A
    // `'starting'` strand is mid-build (a check-in's resume, or its launch) with the node
    // attached before the database: not live yet, so it falls through and joins that build.
    // A strand being quiesced still holds its handles but is on its way down: it falls
    // through too, and its resume runs after the quiesce.
    if (instance.status !== 'starting' && (instance.libp2pNode || instance.database)
      && !this.strandManager.isQuiescing(strandId)) {
      instance.status = liveStrandStatus(instance);
      log('Strand %s woke (already live)', strandId);
      this.emit('strand:waking', { strandId });
      return;
    }

    // Quiesced: re-resolve the volatile cohort input (the seed may have grown)
    // and rebuild the runtime.
    log('Waking strand %s — rebuilding strand-network resources', strandId);
    try {
      await this.resumeStrandRuntime(strandId);
    } catch (error) {
      await this.rehibernateIfResumeFailed(instance, 'Wake', error);
      throw error;
    }
    this.emit('strand:waking', { strandId });
    log('Strand %s awake (resources rebuilt)', strandId);
  }

  /**
   * Undo a failed {@link resumeStrandRuntime}, but only when the rebuild itself failed — this
   * caller's, or the one it joined in `resumeStrand` — which leaves the instance `'error'`. A
   * failure before the rebuild (the cohort seed read) built nothing, and may find the strand
   * mid-build or just brought up by a concurrent wake or check-in; that runtime belongs to
   * whoever is building or holding it, so quiescing it here would stop a node still in use.
   */
  private async rehibernateIfResumeFailed(instance: StrandInstance, context: string, error: unknown): Promise<void> {
    if (instance.status !== 'error') {
      log('%s of strand %s failed before its rebuild (status=%s); leaving the strand as it is: %o',
        context, instance.strandId, instance.status, error);
      return;
    }
    log('%s of strand %s failed; re-hibernating so a later wake or check-in retries: %o', context, instance.strandId, error);
    await this.rehibernateAfterFailedResume(instance, context);
  }

  /**
   * Put a strand whose rebuild or wake window failed back to `'hibernating'`, through a
   * best-effort quiesce that releases any runtime left up. `resumeStrand` leaves a failed
   * strand `'error'`, which nothing retries: `HibernationManager` wakes only
   * `idle`/`hibernating` strands, and reads any other status after a check-in as "woke",
   * ending its chain. Safe to run twice for one failure (a wake that joined a failed
   * check-in's rebuild): quiescing a quiesced strand only marks it.
   *
   * The quiesce writes the status itself, ordered before any resume requested meanwhile;
   * this writes it only when the quiesce failed, since a failed release leaves the status
   * alone.
   */
  private async rehibernateAfterFailedResume(instance: StrandInstance, context: string): Promise<void> {
    try {
      await this.strandManager.quiesceStrand(instance.strandId);
    } catch (cleanupErr) {
      log('%s cleanup quiesce for strand %s failed: %o', context, instance.strandId, cleanupErr);
      instance.status = 'hibernating';
    }
  }

  /**
   * Rebuild a quiesced strand's runtime, re-resolving the volatile cohort input
   * first: the discovery seed may have grown since the strand last ran. Shared by
   * the wake (`handleStrandWake`) and check-in (`handleStrandCheckIn`) paths so both
   * apply the same fresh resolution. `resumeStrand` returns a live instance unchanged
   * and joins a rebuild already in flight, so the two paths never build twice.
   */
  private async resumeStrandRuntime(strandId: string): Promise<void> {
    // Re-derive the transport peerId (deterministic and cheap — a quiesced
    // instance has no `libp2pNode` to read it from) so the seed pass announces
    // the delegate before `resumeStrand` runs `libp2p.start()`.
    const delegatePeerId = this.identityKey
      ? peerIdFromPrivateKey(await strandTransportKey(this.identityKey, strandId)).toString()
      : undefined;
    const bootstrapNodes = await this.resolveCohortSeed(strandId, delegatePeerId);
    // NOTE: no `servingMachines` override — see `launchStrand` for why a strand node
    // declares no repair yardstick, and `StartStrandConfig.servingMachines` for the
    // count that would legitimately go here once one exists.
    const instance = await this.strandManager.resumeStrand(strandId, { bootstrapNodes });
    // Same reason as the launch path: `bootstrapNodes` only reaches the address
    // book through @libp2p/bootstrap discovery, so merge it directly as well.
    if (instance.libp2pNode) {
      await this.mergeStrandPeerAddrs(instance.libp2pNode, bootstrapNodes, strandId);
    }
    void this.recordReplicaSAppId(strandId);
  }

  /**
   * Real cohort check-in for a hibernating strand (the `onCheckIn` callback).
   *
   * Optimystic syncs pull-on-read, not on connect, and exposes no cheap
   * repo-level "pull pending" hook (`IRepo` is get/pend/commit/cancel only —
   * see the review handoff). So "query the cohort for pending activity" is
   * realized as a resume → bounded window → re-hibernate-if-idle cycle that
   * reuses the existing quiesce/resume primitives rather than a bespoke probe:
   *
   *   1. Resume the strand (rebuild node + db, re-resolve the cohort seed) so
   *      its strand network can reach cohort peers — exactly as a wake does.
   *   2. Hold it resumed for a bounded window, during which the app may drive
   *      reads (pull-on-read) and record activity.
   *   3. If activity was recorded during the window, leave the strand `active`
   *      (the idle/hibernate timers + backoff reset take over). Otherwise
   *      quiesce again and leave it `hibernating`, so `HibernationManager`
   *      schedules the next, longer-delayed check-in.
   *
   * No-ops unless the strand is currently `hibernating` — a concurrent wake may
   * have already resumed it.
   */
  private async handleStrandCheckIn(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('handleStrandCheckIn: strand %s not found', strandId);
      return;
    }
    if (instance.status !== 'hibernating') {
      log('handleStrandCheckIn: strand %s not hibernating (status=%s); skipping', strandId, instance.status);
      return;
    }

    // Before the resume, so a wake that joins this rebuild, or activity recorded while it
    // runs, counts: the window then leaves the strand up for it.
    const activityMark = instance.lastActivity;

    // 1. Resume exactly as a wake does: re-resolve the (possibly grown) cohort
    //    seed, then rebuild the runtime.
    log('Check-in: resuming strand %s to probe the cohort for pending activity', strandId);
    try {
      await this.resumeStrandRuntime(strandId);
    } catch (err) {
      // Every failure resolves: `HibernationManager.runCheckIn` decides wake-vs-escalate
      // from `instance.status` alone. A failed rebuild — on a flaky network, the very
      // scenario hibernation targets — leaves `resumeStrand`'s `error`, which reads as
      // "woke" and would STOP the chain with no runtime and no future check-in, so it goes
      // back to `hibernating` and the manager escalates the backoff and retries. A failure
      // before the rebuild (the seed read) built nothing: the strand is still `hibernating`
      // (the manager escalates), or a wake that began meanwhile is building or holding it,
      // and the manager hands the chain to that wake, whose outcome restores or ends it.
      await this.rehibernateIfResumeFailed(instance, 'Check-in', err);
      return;
    }

    // 2-3. Bounded window for the strand network to connect + the app to act,
    //      then re-hibernate-if-idle. Shared with the on-demand serviceWake.
    const windowMs = this.config.hibernation?.checkInWindowMs ?? DEFAULT_CHECKIN_WINDOW_MS;
    try {
      await this.runWakeWindow(instance, activityMark, windowMs);
    } catch (err) {
      // The window's quiesce threw with the rebuilt runtime up: release it best-effort and
      // leave the strand `hibernating`, for the same reason as a failed rebuild above.
      log('Check-in window failed for strand %s; re-hibernating to retry on backoff: %o', strandId, err);
      await this.rehibernateAfterFailedResume(instance, 'Check-in');
    }
  }

  /**
   * Window-then-decide for a just-resumed strand, shared by the check-in timer
   * path ({@link handleStrandCheckIn}) and the on-demand {@link serviceWake}:
   *
   *   1. Hold the strand live for `windowMs` so its strand network reaches the
   *      cohort and the app can drive pull-on-read activity.
   *   2. If activity landed since `activityMark`, leave the strand `active` (return
   *      `true`); otherwise quiesce it, which marks it `hibernating` again (return `false`).
   *      A wake or activity that lands during that quiesce rebuilds the strand after it.
   *
   * @param activityMark - `instance.lastActivity` as the caller read it BEFORE bringing the
   *   strand up. The bring-up records none, and every writer assigns a FRESH `Date`, so a
   *   changed reference means a wake or activity landed during the resume or the window —
   *   not millisecond-resolution noise.
   * @returns whether activity was observed (strand left active).
   */
  private async runWakeWindow(instance: StrandInstance, activityMark: Date, windowMs: number): Promise<boolean> {
    const strandId = instance.strandId;

    // NOTE: activity during the window arms the idle countdown, so a window longer than the
    // hint's idle + hibernate timeouts (only reachable with a custom `windowMs`; the shortest
    // default pair, archive's, is 40 s vs a 15 s window) can let the timer path quiesce the
    // strand mid-window, which this then marks live. If such windows become real, suspend the
    // idle countdown while a window holds the strand.
    await this.holdWakeWindow(instance, windowMs);

    const sawActivity = instance.lastActivity !== activityMark;
    if (sawActivity) {
      // A force-hibernate during the window has released the runtime and marked the strand
      // `hibernating`, which stands; a wake queued behind it writes its own status.
      if (instance.libp2pNode || instance.database) {
        instance.status = liveStrandStatus(instance);
        this.emit('strand:waking', { strandId });
      }
      log('Wake window: strand %s saw activity during the window; not re-hibernating', strandId);
      return true;
    }

    log('Wake window: no activity for strand %s; re-hibernating', strandId);
    await this.strandManager.quiesceStrand(strandId);
    return false;
  }

  /**
   * Hold a just-resumed strand live for `windowMs` (default
   * {@link DEFAULT_CHECKIN_WINDOW_MS} is applied by callers). A non-positive
   * window resolves immediately. The pending timer is tracked in
   * {@link windowWaiters} so {@link cleanup} can both clear it and resolve the
   * promise on teardown — a `stop()` during an in-flight window must neither fire
   * the timer afterward nor hang the awaiting check-in/serviceWake. Extracted as
   * its own method so tests can stub the wait (and inject activity during it).
   */
  private async holdWakeWindow(_instance: StrandInstance, windowMs: number): Promise<void> {
    if (windowMs <= 0) return;
    await new Promise<void>((resolve) => {
      const waiter = { timer: undefined as unknown as ReturnType<typeof setTimeout>, resolve };
      waiter.timer = setTimeout(() => {
        this.windowWaiters.delete(waiter);
        resolve();
      }, windowMs);
      this.windowWaiters.add(waiter);
    });
  }

  /**
   * Clear every in-flight wake window: cancel its timer and resolve its promise
   * so any awaiting check-in/serviceWake completes promptly rather than hanging
   * past teardown. Called from {@link cleanup}.
   */
  private clearWindowWaiters(): void {
    for (const waiter of this.windowWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.windowWaiters.clear();
  }

  /**
   * Add a strand with its sApp configuration.
   * The hosting application must provide the sApp schema when creating a strand.
   *
   * This is the ATTACH half only — it starts the local instance and never publishes the
   * `Strand` row. A joiner (the row arrived over the control network) wants exactly this; a
   * FOUNDER wants {@link foundStrand}, which publishes and attaches in one resumable call.
   * With no explicit `founder` flag, founder-ness is derived from the row's
   * `FounderOwnerKey` (see {@link StrandConfig.founder}) — so attaching a row THIS machine
   * published (e.g. re-attaching its own orphan after a restart) founds it, and attaching
   * anyone else's row joins, without the caller needing to know which it is.
   *
   * A joined row (no `founder: true`) this party's control database does not name — a
   * strand joined from another party — is remembered in the node's joined-strand store, so it
   * is re-offered as `strand:discovered` after a restart, and published party-wide by an
   * owner machine's reconcile pass (see {@link forgetJoinedStrand}).
   *
   * A rejected call leaves nothing running but DOES leave the sApp config
   * registered, deliberately: both an explicit retry and the {@link StrandWatcher}'s
   * automatic relaunch need it. A failed launch here hands the strand back to that
   * relaunch — `StrandWatcher.forgetStrand` drops the id from the watcher's
   * `knownStrands` and records the backoff, so a later poll re-attempts it on the same
   * `pollInterval * 2^(failures-1)` ladder a watcher-driven failure gets. Because the
   * config stays registered, the retry takes `handleStrandAdded`'s auto-launch branch:
   * what the app sees is `strand:error` per failed retry and `strand:started` when one
   * succeeds, never a second `strand:discovered`. {@link detachStrand} (reached via
   * {@link stopStrand}) is what abandons a strand for good, and its stop suppresses the
   * strand in the watcher so this retry cannot resurrect it — a call to THIS method lifts
   * that suppression again, since an explicit claim is a deliberate reversal of the
   * deliberate stop.
   */
  async addStrand(config: StrandConfig): Promise<StrandInstance> {
    if (!this._running) {
      throw new Error('CadreNode not running');
    }

    const { strandRow, sAppConfig, founder, partyMemberPrivateKey } = config;
    // Before anything is recorded: an unusable id must not leave a registered sApp
    // config behind, and must not lift a suppression this node set deliberately.
    assertStrandScopeKey(strandRow.Id);
    if (partyMemberPrivateKey !== undefined && strandRow.Type !== 'c') {
      // Only a closed strand seats a Member/Manager, so an open launch would drop this
      // key silently. Refuse instead: the caller has confused the party identity key
      // with something an open strand uses, and a silent drop hides that.
      throw new Error(
        `addStrand(${strandRow.Id}): partyMemberPrivateKey belongs to a CLOSED strand ` +
        `(Type 'c'), but this row is Type '${strandRow.Type}' — an open strand seats no ` +
        'Member/Manager, so the key would be ignored.'
      );
    }

    // A row this node offered itself came from the control table or is already a
    // remembered join, and a row this node founds is not a join, so only a joined row
    // from elsewhere can be a new join to remember. A founded row recorded here would
    // come back after a restart with `FounderOwnerKey: null` and relaunch as a joiner.
    // Captured before the backlog delete below.
    const rememberable = founder !== true && !this.discoveredStrands.has(strandRow.Id);

    // Store sApp config for this strand. The strand is claimed now, so it leaves the
    // unclaimed backlog — a later `getDiscoveredStrands()` drain must not re-offer it.
    this.sAppConfigs.set(strandRow.Id, sAppConfig);
    this.discoveredStrands.delete(strandRow.Id);
    // A claim also overrides any earlier `stopStrand` of this id: the watcher must track
    // the strand again, or a party-wide removal would never stop it here.
    this.strandWatcher?.unsuppressStrand(strandRow.Id);
    log('Registered sAppConfig for strand %s (sApp: %s, founder: %s)',
      strandRow.Id, sAppConfig.id, founder ?? 'derived');

    // Before the launch, so a foreign strand whose launch fails, or whose app is killed
    // mid-launch, is still offered again: by the watcher's retry and by the next start.
    if (rememberable) {
      await this.rememberForeignStrand(strandRow);
    }

    // An unset `founder` is DERIVED from the row inside launchStrand (this node founds
    // iff the row's FounderOwnerKey is its own owner key); an explicit flag wins — the
    // formation/responder flows pass one deliberately, since their consent-seated rows
    // carry a null column. See StrandConfig.founder. Same rule for the explicit
    // partyMemberPrivateKey: it wins over the StrandPartyKey control-row read.
    // Only the launch is wrapped, NOT the first-sync wait below: a wait that times out
    // rejects with the retryable StrandAwaitingFirstSyncError and deliberately leaves the
    // instance running, so there is nothing to re-offer and forgetting it would only have
    // the watcher re-enter a launch for a strand that is already up.
    let instance: StrandInstance;
    try {
      instance = await this.launchStrand(strandRow, sAppConfig, founder, partyMemberPrivateKey);
    } catch (error) {
      // Hand the strand back to the watcher's retry ladder. Harmless on the founder path
      // (`foundStrand` → `publishStrand` + this call), where the watcher may never have
      // offered the strand: the `knownStrands` delete is a no-op and the recorded backoff
      // only delays the watcher's own first attempt by one poll interval, which is what
      // should happen right after an attempt that just failed.
      //
      // NOTE: the retry relaunches from the CONTROL row (or, for a strand joined from
      // another party, the remembered join) plus the registered config, not
      // from the row and arguments passed here — so a caller that enriched either (a
      // synthetic `MemberPrivateKey`, an explicit `founder` or `partyMemberPrivateKey`)
      // is retried with less than it asked for. Inert today: founder-ness re-derives from
      // `FounderOwnerKey`, the party key re-reads from `StrandPartyKey`, and the row's
      // shared `MemberPrivateKey` is read only by the founder bootstrap. If a joiner
      // launch ever starts depending on that key, gate this hand-back on the passed row
      // matching the control one.
      this.strandWatcher?.forgetStrand(strandRow.Id);
      throw error;
    }

    // The first-sync write gate: a JOINING machine's database is withheld until it has
    // received the strand's Header from another member, because a write before that
    // forks every table it touches (see strand-first-sync-gate.ts). Waiting here is what
    // lets an app write straight after `addStrand` resolves — the reference chat apps
    // do — so the default is to wait, bounded by `strandFirstSync.timeoutMs`. A timeout
    // rejects with the retryable `StrandAwaitingFirstSyncError` and leaves the launch
    // up: this same call, made again once a member is reachable, completes the attach
    // (the tracked-instance path above returns the still-syncing instance, and this
    // wait picks it up). Founders and machines that already hold the Header resolve at
    // once. Only a LIVE gated instance is waited on — a hibernating one is returned as
    // it always was (no database either; a wake publishes it).
    if (config.awaitFirstSync !== false && this.strandManager.isAwaitingFirstSync(strandRow.Id)) {
      await this.strandManager.whenWritable(strandRow.Id, { timeoutMs: this.config.strandFirstSync?.timeoutMs });
    }
    return instance;
  }

  /**
   * Resolve once a launched strand is writable — its database published to the app and
   * its status `'active'` — or reject with the retryable `StrandAwaitingFirstSyncError`
   * after `timeoutMs` (default `strandFirstSync.timeoutMs`, else
   * `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`). The promise form of the `strand:writable`
   * event, for a caller that attached without waiting ({@link StrandConfig.awaitFirstSync}
   * `false`) or that holds a strand the watcher launched. Resolves immediately for a
   * strand that is already writable; rejects immediately for one this node does not run.
   * A hibernating strand is not woken — wake it first if that is what is wanted.
   */
  async whenStrandWritable(strandId: string, options?: { timeoutMs?: number }): Promise<StrandInstance> {
    return await this.strandManager.whenWritable(strandId, {
      timeoutMs: options?.timeoutMs ?? this.config.strandFirstSync?.timeoutMs
    });
  }

  /**
   * Publish a strand row to the shared control database under this node's own
   * owner identity, so other cadre members discover it via control-network
   * sync (their {@link StrandWatcher} fires `strand:discovered`).
   *
   * **Founding a strand is TWO steps** — this one (publish the row cadre-wide) and
   * {@link addStrand} (start the local instance, `founder: true` to write the strand's
   * `Header`/founding membership). `addStrand` deliberately omits the insert: it only
   * starts the LOCAL instance, whereas publishing makes the strand visible cadre-wide. A
   * discovering peer only does `addStrand` (the row already exists). Callers founding a
   * strand should use {@link foundStrand}, which performs both steps and is safe to
   * re-run — hand-rolling the pair is what left strands half-founded when an app was
   * killed between them.
   *
   * **Idempotent for identical content.** A live row whose `(Type, MemberPrivateKey)` match
   * the arguments is the state this call would have produced, so the call logs and returns
   * that row instead of writing — a publish interrupted after it committed can be repeated.
   * DIFFERENT content on the same id throws, naming the columns that differ, rather than
   * surfacing the raw `UNIQUE constraint failed: Strand.Id`: silently accepting it would
   * let a retry reopen a closed strand or swap the key gating its reads. The read and the
   * insert are not atomic, so a concurrent founder (two machines of one party, same id) is
   * caught on the insert's uniqueness rejection and resolved the same way — re-read, no-op
   * on a match, rethrow otherwise. Never an overwrite either way.
   *
   * A tombstoned strand is NOT resurrected here: {@link unpublishStrand} deletes the row, so
   * the idempotent branch is unreachable and the ordinary publish path re-seats it, exactly
   * as that method documents.
   *
   * **Already stuck on `UNIQUE constraint failed: Strand.Id`?** The row is already published
   * — attach, do NOT republish: `addStrand` (or {@link foundStrand}) with the id and, for a
   * closed strand, the `MemberPrivateKey` read back from the row. `unpublishStrand` + a
   * fresh publish also clears it for an OPEN strand, but is destructive for a closed one
   * (the key exists nowhere else). No app-data wipe is needed for either.
   *
   * The insert is signed with the ed25519 key behind this node's PeerId — which
   * {@link ed25519KeyPairFromLibp2p} also exposes as the node's owner keypair,
   * so peer identity and owner key are one and the same. That key is also persisted on the
   * row as `FounderOwnerKey` (the schema pins the column to the verified signer), which is
   * what later lets any launch derive "this machine is the founder" from the row alone.
   * The key must be enrolled in `OwnerKey` (e.g. via {@link ControlDatabase.ensureOwnerKey}
   * at genesis) or the schema's `Strand.AuthorizedInsert` constraint rejects the write.
   * Failing loudly here is intentional: a silently-unpublished strand would run
   * as a local-only island that no peer could ever discover or join.
   *
   * A CLOSED strand's publish also seats this party's own membership identity key —
   * the `StrandPartyKey` row {@link ensureStrandPartyKey} documents — which is what the
   * founder bootstrap derives `Member.Key`/`Manager.MemberKey` from. The
   * `memberPrivateKey` ARGUMENT stays the strand-wide read secret formation hands to
   * joiners; it derives nobody's identity.
   *
   * @param strandId - Unique strand identifier (typically the same id passed to
   *   {@link addStrand}).
   * @param type - `'o'` for open (default) or `'c'` for closed.
   * @param memberPrivateKey - Optional shared membership (read) key for a closed strand.
   * @returns The live `Strand` row — the one just inserted, or the matching one already
   *   there. A closed strand's caller should carry THIS row's `MemberPrivateKey` forward:
   *   on a repeat it is the stored key, not the argument.
   * @throws if the node is not started, exposes no owner signing key, the id is blank or
   *   unusable as a storage scope key (`InvalidStrandIdError` — see `storage-scope.ts`), a
   *   row with the same id holds different content, or the control DB rejects the
   *   (unauthorized) insert.
   */
  async publishStrand(strandId: string, type: 'o' | 'c' = 'o', memberPrivateKey?: string): Promise<StrandRow> {
    const signingKey = this.requireOwnerSigningKey(`publish strand ${strandId}`);
    // Trim/reject here so the id that lands matches the one unpublishStrand looks up: it
    // trims too, and an untrimmed row would be unreachable by the same string.
    const trimmed = requireNonBlank(strandId, 'strand id');
    // Refuse an unusable id HERE, not only at launch. `addStrand` already asserts, but it
    // runs after this row is written, and this row replicates: an id no node can turn into
    // a storage scope key would otherwise reach the whole party's control database and be
    // declined once per member. Asserted after the trim so the id checked is the id stored.
    assertStrandScopeKey(trimmed);
    // FounderOwnerKey records THIS machine as the row's publisher (the schema pins it to
    // the signing owner), which is what later lets a relaunch derive founder-ness.
    const desired: StrandRow = {
      Id: trimmed,
      Type: type,
      MemberPrivateKey: memberPrivateKey ?? null,
      FounderOwnerKey: signingKey.publicKeyB64,
    };

    // Read first rather than leaning on the insert's collision for BOTH readings. The
    // ordinary resume (an app killed after its own publish committed) then needs no error
    // matching at all: the collision path can only recognise itself by the engine's message
    // TEXT (see isStrandIdConflict), and an upstream reword there must degrade the RARE race,
    // not the common resume. It also spends no stamp or signature on a known no-op.
    const existing = await this.controlDatabase!.queryStrand(trimmed);
    if (existing) {
      // NOTE: reads local converged state, and `queryStrand` does not filter rows whose
      // StampId a Revocation has retired. So on a sibling that still physically holds a row
      // deleted elsewhere while ALONE (the delete-while-alone gap in docs/architecture.md),
      // an owner-signed republish now no-ops onto that doomed row instead of re-seating the
      // id under a fresh stamp. Harmless while that gap is itself unresolved — both
      // behaviours end at the same unconverged state — but if delete-while-alone ever gains
      // real replay, filter retired stamps here (queryStrandStampId + the Revocation read)
      // so a re-seat is not mistaken for a repeat.
      const matched = requireMatchingStrandRow(existing, desired, 'is already published');
      log('publishStrand(%s): already published (type %s) with identical content — no-op', trimmed, type);
      // A closed strand THIS machine published must hold a party key (its own membership
      // identity — see ensureStrandPartyKey). Insert-if-absent, so the ordinary repeat
      // is a read-only no-op and a publish interrupted between the row insert and the
      // mint heals here. A row another machine published is that machine's to mint for.
      if (type === 'c' && this.isSelfFoundedRow(matched)) {
        await this.ensureStrandPartyKey(trimmed);
      }
      return matched;
    }

    try {
      await this.controlDatabase!.insertStrand(
        trimmed,
        type,
        signingKey.publicKeyB64,
        signMessageWith(signingKey.privateKeyB64),
        memberPrivateKey
      );
    } catch (error) {
      // Only the uniqueness collision is a candidate for the idempotent reading; every
      // other rejection (unauthorized signer, retired stamp) must keep surfacing.
      if (!isStrandIdConflict(error, 'Strand')) {
        throw error;
      }
      const landed = await this.controlDatabase!.queryStrand(trimmed);
      if (!landed) {
        // Collided, yet no row is readable: not the race this branch handles (a row
        // deleted between the rejection and the re-read, or a stale local view). Surface
        // the original rather than guessing.
        throw error;
      }
      log('publishStrand(%s): lost a concurrent founding race; re-read the landed row', trimmed);
      return requireMatchingStrandRow(landed, desired, 'landed concurrently from another founder');
    }
    log('Published strand %s (type %s) to control DB under owner %s', trimmed, type, signingKey.publicKeyB64);
    // A closed strand's publish also mints this party's own membership identity key
    // (StrandPartyKey) — the key the founder bootstrap derives Member/Manager from,
    // deliberately distinct from the shared memberPrivateKey argument above. A failure
    // here surfaces (the strand row has already committed, so a retried publish takes
    // the idempotent branch and heals the mint; so does the next founder launch).
    if (type === 'c') {
      await this.ensureStrandPartyKey(trimmed);
    }
    return desired;
  }

  /**
   * Found a strand — publish its row cadre-wide AND start the local instance as its
   * founder — in one resumable call. The single entry point for creating a strand; a
   * caller joining one someone else founded uses {@link addStrand} alone.
   *
   * Safe to re-run from any point of interruption, which hand-rolling
   * {@link publishStrand} + {@link addStrand} is not. Either half can already have
   * happened:
   *
   * - **row already published** → the stored row is adopted rather than re-published, so a
   *   run killed after the insert committed no longer dies on
   *   `UNIQUE constraint failed: Strand.Id`. For a closed strand the row's STORED
   *   `MemberPrivateKey` wins over `config.memberPrivateKey`: a caller that mints a key per
   *   attempt (as the reference apps do) would otherwise present a key that does not match
   *   the membership already seated in the strand.
   * - **instance already running** → the tracked instance is returned, and — because the
   *   `Strand` row records its publishing machine (`FounderOwnerKey`) — a founder request
   *   against an instance that was first launched as a joiner now runs the (idempotent,
   *   insert-if-absent) founder bootstrap on it rather than silently skipping it
   *   ({@link StrandInstanceManager.foundExistingStrand}). So a strand that something else
   *   attached first — the reference RN app's `strand:discovered` handler after a restart,
   *   or this node's own {@link StrandWatcher} poll winning `launchStrand`'s
   *   `resolveCohortSeed` window — still ends up with its `Strand.Header` written.
   *
   * Founder-ness is resolved FROM THE ROW, not assumed: this machine founds iff the
   * resolved row's `FounderOwnerKey` is its own owner key. A fresh publish records this
   * machine, so the common path founds; a machine that lost a concurrent founding race to
   * a sibling adopts the sibling's row and ATTACHES instead — deliberately, since two
   * machines bootstrapping the same strand on separate replicas is the double-`Header`
   * hazard. The returned {@link FoundStrandResult.founded} says which happened.
   *
   * `Type` is compared, not adopted: a stored row of the other type means the caller and
   * the control plane disagree about what this strand IS, so it throws.
   *
   * @returns The instance AND the row the strand actually runs under — read the membership
   *   key from the returned row, not from a freshly minted one ({@link FoundStrandResult}).
   * @throws if the node is not started, the id is blank, a published row of the same id has
   *   a different `Type`, or either half rejects.
   */
  async foundStrand(config: FoundStrandConfig): Promise<FoundStrandResult> {
    const { strandId, type = 'o', memberPrivateKey, sAppConfig, awaitFirstSync } = config;
    if (!this._running || !this.controlDatabase) {
      throw new Error(`CadreNode must be started before attempting to found strand ${strandId}`);
    }
    const controlDatabase = this.controlDatabase;
    const trimmed = requireNonBlank(strandId, 'strand id');
    const timed = <T>(step: string, op: () => Promise<T>) => timedStep('foundStrand', trimmed, step, op);
    const tTotal = performance.now();
    const published = await timed('queryStrand', () => controlDatabase.queryStrand(trimmed));
    const strandRow = published
      ? this.adoptPublishedStrand(published, type, memberPrivateKey)
      : await timed('publishStrand', () => this.publishStrand(trimmed, type, memberPrivateKey));
    // Derived, not hardcoded `true`: adopting a row another machine published means that
    // machine runs the bootstrap — this one must attach or it would write a second Header.
    const founded = this.isSelfFoundedRow(strandRow);
    if (!founded) {
      log('foundStrand(%s): the stored row was published by a different machine ' +
        '(FounderOwnerKey is not this node\'s owner key) — attaching as a joiner; ' +
        'the founder bootstrap runs on the publishing machine', trimmed);
    }
    const instance = await timed('addStrand',
      () => this.addStrand({ strandRow, sAppConfig, founder: founded, awaitFirstSync }));
    timing(`[foundStrand:${trimmed}] total: ${Math.round(performance.now() - tTotal)}ms`);
    return { instance, strandRow, founded };
  }

  /**
   * Resume onto an already-published `Strand` row: keep its stored content, reject a type
   * disagreement. The stored `MemberPrivateKey` is authoritative — see {@link foundStrand}
   * for why a caller-minted key must lose here (and why that is NOT the same rule as
   * {@link publishStrand}'s, which throws on a key mismatch because it is being asked to
   * WRITE that key, not to resume onto what already exists).
   */
  private adoptPublishedStrand(
    published: StrandRow,
    type: 'o' | 'c',
    memberPrivateKey?: string
  ): StrandRow {
    if (published.Type !== type) {
      throw new Error(
        `Cannot found strand ${published.Id} as type '${type}': it is already published as ` +
        `type '${published.Type}'. Reconcile deliberately rather than re-founding — a ` +
        'published open strand cannot be closed, nor a closed one opened, by re-publishing.'
      );
    }
    if (memberPrivateKey !== undefined && memberPrivateKey !== published.MemberPrivateKey) {
      log('foundStrand(%s): already published — resuming on the STORED MemberPrivateKey; ' +
        'the supplied key is discarded (read it back from the returned instance)', published.Id);
    } else {
      log('foundStrand(%s): already published (type %s) — adopting the stored row', published.Id, type);
    }
    return published;
  }

  /**
   * Remove this party's `Strand` row from the shared control database — the owner-signed
   * inverse of {@link publishStrand}.
   *
   * Party-wide, unlike {@link stopStrand}, which only stops the strand on THIS node: every
   * cadre node watching the table sees the row vanish on its next poll (default 5 s) and
   * stops its own instance. This node converges immediately — the method forces a watcher
   * poll and stops any still-running local instance before resolving. Removing the row
   * removes OUR party's participation only: other parties in the strand keep their own
   * rows and the strand network carries on, so no cross-party sign-off is involved — this
   * is an owner-signed control-plane write like every other, not "destroy the network".
   *
   * Irreversible for a closed strand (`Type='c'`): the row carries `MemberPrivateKey`,
   * this party's read secret for that network, and the strand's `StrandPartyKey` row —
   * this party's own membership identity, removed (and tombstoned) in the SAME
   * transaction — is stored nowhere else either. With both gone the party can never
   * again sign as its seated member/manager there, and a re-published row mints a fresh
   * identity that does not match the membership already written into the strand's RBAC
   * layer. The strand id itself is NOT
   * blacklisted: a fresh owner-signed {@link publishStrand} re-seats it under a new
   * stamp — only the unsigned consent re-seat is permanently foreclosed (the removal's
   * `Revocation` tombstone names the id, which the consent branch of
   * `Strand.AuthorizedInsert` refuses ever after). Outstanding `FormationInvite` rows
   * bound to the removed strand are unredeemable while the row is absent (the formation
   * recorder resolves the strand as missing and rejects cleanly).
   *
   * Convergence caveats, same class as {@link enrollValidationKey}'s: a sibling that has
   * not yet synced keeps running the strand until its own watcher observes the missing
   * row; a sibling whose `strandFilter` never admitted this strand never observes the
   * removal AT ALL and keeps running its instance indefinitely — opting out of watching a
   * strand is also opting out of its party-wide removal, so such a node's only stop is its
   * own local {@link stopStrand}/`unpublishStrand` call; and a removal committed while
   * ALONE (0 control connections) deletes the row local-only. The accompanying
   * `Revocation` tombstone IS queued and re-issued on the next cohort-growth edge
   * ({@link noteGuardedDelete}/{@link drainPendingRevocations}), so the stamp retirement
   * — and with it the consent re-seat foreclosure — does propagate; but the physical row
   * deletion cannot be replayed, and `queryStrands` reads raw (no retired-stamp filter),
   * so siblings that already hold the row keep running the strand until the collection
   * itself converges (logged loudly; see "Deletes made while alone" in
   * docs/architecture.md).
   *
   * A no-op (no throw, no tombstone) when the row is already absent — but a
   * locally-running instance of that id is still stopped.
   *
   * NOTE: control-plane only — the strand's local durable storage is retained. Stopping the
   * instance closes the `StrandDatabase` and its libp2p node but purges no blocks, so a
   * closed strand's content stays readable on disk to anyone with the data directory. If a
   * caller ever needs removal to mean "and erase the local copy", that is a separate purge
   * step, not a widening of this method.
   *
   * @param strandId - The `Strand` row id to remove (as passed to {@link publishStrand}).
   * @throws if the node is not started, exposes no owner signing key, the id is blank, or
   *   the signer is not an enrolled owner (the schema's `Strand.AuthorizedDelete` rejects
   *   the write and the row survives). A rejection does NOT imply the row survived: the
   *   local stop runs after the control-plane delete has already committed, so a failure
   *   there throws over a completed removal.
   */
  async unpublishStrand(strandId: string): Promise<void> {
    const signingKey = this.requireOwnerSigningKey(`unpublish strand ${strandId}`);
    const trimmed = requireNonBlank(strandId, 'strand id');
    const removed = await this.controlDatabase!.deleteStrand(
      trimmed,
      signingKey.publicKeyB64,
      signMessageWith(signingKey.privateKeyB64)
    );
    // Gate on `removed`: the absent-row no-op wrote nothing, so warning about an
    // unreplicated deletion there would send an operator chasing a phantom.
    if (removed && this.committedAlone()) {
      log('unpublishStrand(%s) committed while ALONE (0 control connections): the deletion is ' +
        'local-only. Its Revocation tombstone is queued for re-issue on cohort growth, but the ' +
        'row deletion itself cannot be replayed, so other nodes may keep running the strand ' +
        'until the collection converges.', trimmed);
    }
    // A refused pre-split launch left no tracked instance, so the stop below never
    // reaches detachStrand for it — clear the refusal here so a re-founded id starts clean.
    this.strandLaunchRefusals.delete(trimmed);
    // A party-wide removal: the strand's peers must not stay dial targets for a strand
    // that no longer exists (a re-published id is a fresh strand with fresh peers).
    this.forgetStrandPeers(trimmed, 'unpublishStrand');
    // Clear THIS machine's own MemberPeer binding while the strand runtime — and the
    // retained party key — is still live: the delete above already destroyed the
    // party's StrandPartyKey row, so once this process forgets the key nothing can
    // ever sign the removal again. Runs AFTER the control delete so a rejected
    // unpublish (unauthorized signer) never strips a binding the party still needs;
    // best-effort by contract (never throws) — a hibernating or unreachable strand
    // keeps the stale binding, which grants nothing today. Sibling machines observing
    // this removal via their watchers do NOT clear their own bindings (see the NOTE on
    // StrandInstanceManager.clearOwnMemberPeerBinding).
    //
    // NOTE: this makes unpublishStrand await a STRAND-NETWORK write it never used to —
    // however long that write takes to reject or commit is now added to unpublish's
    // wall-clock. Fine while strand writes fail fast on an unreachable quorum; if
    // unpublish ever starts hanging on an isolated strand, give this call its own
    // deadline rather than dropping it (a binding cleared late is still worth more than
    // one never cleared).
    await this.strandManager.clearOwnMemberPeerBinding(trimmed);
    // Converge locally now rather than waiting up to a poll interval. The watcher fires
    // onStrandRemoved for a strand it tracked; the explicit teardown below covers a node
    // whose strandFilter never admitted this strand (the watcher never knew it, so it will
    // never fire). StrandInstanceManager.stopStrand no-ops on an unknown id, so the two
    // paths cannot double-stop into an error.
    //
    // detachStrand, NOT stopStrand: this is a party-wide removal, not a local abandonment
    // of a strand that still exists, so it must not SUPPRESS the id in the watcher. The
    // row is already gone — there is nothing to suppress — and an id re-published before
    // the next poll's suppression cleanup would then never be offered again this session.
    // (Same reasoning as handleStrandRemoved, which also avoids stopStrand's `_running`
    // guard; here the guard is already satisfied by requireOwnerSigningKey above.)
    await this.strandWatcher?.forcePoll();
    if (this.strandManager.getInstance(trimmed)) {
      await this.detachStrand(trimmed);
    }
    log('Unpublished strand %s from control DB under owner %s', trimmed, signingKey.publicKeyB64);
  }

  /**
   * Seat this party's own strand membership identity key — the `StrandPartyKey` row —
   * for `strandId`, minting a fresh one when none is given, and adopting the stored one
   * when a row already exists. Insert-if-absent and stable thereafter: the founding
   * `Member.Key` must not change across restarts, or the bootstrap's insert-if-absent
   * guards stop matching.
   *
   * This is the identity half of the closed-strand key split: the row's `PrivateKey` —
   * NOT the strand row's shared `MemberPrivateKey`, which formation hands to every
   * joining party — is what the founder bootstrap derives `Member.Key`/`Manager.MemberKey`
   * from. It replicates to every machine this party owns (same plaintext-at-rest stance
   * as `MemberPrivateKey`; docs/strands.md → "Closed-Strand Member Key Handling") and is
   * never put on the formation wire.
   *
   * Called internally by {@link publishStrand} (closed strands mint at publish) and by a
   * founder launch that finds no row (a publish interrupted before its mint); public so a
   * test harness — or a joiner flow that persists a formation-issued identity — can seat
   * a specific key deliberately.
   *
   * @param strandId - The strand the key is this party's identity for.
   * @param partyMemberPrivateKey - Optional specific key (base64 protobuf, as
   *   `generateStrandMemberKey` mints). When a row already holds a DIFFERENT key this
   *   throws — a party has one identity per strand; rotation is a deliberate
   *   remove-then-insert, not a silent swap.
   * @returns The live party key: the one just seated, or the stored one.
   */
  async ensureStrandPartyKey(strandId: string, partyMemberPrivateKey?: string): Promise<string> {
    const trimmed = requireNonBlank(strandId, 'strand id');
    const signingKey = this.requireOwnerSigningKey(`seat a party key for strand ${trimmed}`);
    const existing = await this.controlDatabase!.queryStrandPartyKey(trimmed);
    if (existing !== null) {
      if (partyMemberPrivateKey !== undefined && partyMemberPrivateKey !== existing) {
        // Neither key is included: the party key is this party's membership identity secret.
        throw new Error(
          `Strand ${trimmed} already has a party key and the supplied one differs. The stored ` +
          'key is the identity the strand membership was seated under; to rotate it, remove ' +
          'the row deliberately (deleteStrandPartyKey) rather than overwriting it.'
        );
      }
      return existing;
    }
    const key = partyMemberPrivateKey ?? await generateStrandMemberKey();
    try {
      await this.controlDatabase!.insertStrandPartyKey(
        trimmed, key, signingKey.publicKeyB64, signMessageWith(signingKey.privateKeyB64));
    } catch (error) {
      // The read and the insert are not atomic; a concurrent seat of the same strand's
      // key can land in between. Adopt the landed row when it satisfies this request —
      // the same resolution publishStrand applies to its own read-then-insert window —
      // and rethrow every other rejection (unauthorized signer, retired stamp).
      const landed = await this.controlDatabase!.queryStrandPartyKey(trimmed);
      if (landed === null || (partyMemberPrivateKey !== undefined && partyMemberPrivateKey !== landed)) {
        throw error;
      }
      log('ensureStrandPartyKey(%s): lost a concurrent seat race; adopting the landed key', trimmed);
      return landed;
    }
    log('Seated strand party key for %s under owner %s', trimmed, signingKey.publicKeyB64);
    return key;
  }

  /**
   * Resolve the party membership key a closed strand's launch threads into the founder
   * bootstrap: the explicit attach-time key when given, else the party's persisted
   * `StrandPartyKey` row, else — on the one machine whose owner key the row names as
   * founder — a freshly minted-and-persisted key, which seats the identity for a publish
   * that was interrupted before its mint. Everyone else resolves undefined: non-founding
   * machines never mint (no mint race between a party's machines), and only a founder
   * bootstrap needs the key at all.
   *
   * Minting does NOT repair a strand founded before the key split: its founding
   * membership was seated under the shared `MemberPrivateKey`, and nothing re-seats it —
   * the founder bootstrap refuses such a strand (`PreSplitStrandIdentityError`) instead.
   *
   * NOTE: "founding machine" here is the ROW's provenance, not the launch's resolved
   * `founder` flag — so an explicit `founder: false` over a row this machine published
   * still mints, an owner-signed write a caller that said "I am not founding" did not ask
   * for. Reached by a storage replica of a row this machine published (always a joiner,
   * see {@link launchStrand}) and kept on purpose: the party needs that identity for the
   * strand either way, the mint is insert-if-absent, and a closed-strand replica runs its
   * membership reconciler — which seats its own `MemberPeer` binding — only with a party key.
   */
  private async resolveStrandPartyKey(strand: StrandRow, explicitKey?: string): Promise<string | undefined> {
    if (explicitKey !== undefined) {
      return explicitKey;
    }
    if (!this.controlDatabase) {
      return undefined;
    }
    const stored = await this.controlDatabase.queryStrandPartyKey(strand.Id);
    if (stored !== null) {
      return stored;
    }
    if (!this.isSelfFoundedRow(strand)) {
      return undefined;
    }
    return await this.ensureStrandPartyKey(strand.Id);
  }

  /**
   * Publish an owner-signed `FormationInvite` (open-invitation token) to the
   * shared control database, so a later {@link formStrand} redemption can be
   * validated against it (the consent branch of `Strand.AuthorizedInsert`).
   *
   * Counterpart to {@link createOpenInvitation}, which only mints the
   * out-of-band {@link OpenInvitation} envelope: persisting the matching
   * `FormationInvite` row is what makes the token *redeemable* — the host's
   * {@link ControlFormationUsageRecorder} answers `isTokenValid`/`isTokenUsed`
   * from this row. A host minting a closed-strand invite does both (mint +
   * publish), exactly as the integration harness's `createInvitation` does.
   *
   * Signs with the same self-owner key as {@link publishStrand} (the ed25519
   * key behind this node's PeerId, which must be an enrolled `OwnerKey`).
   * Throws loudly if the node isn't started or exposes no signing key.
   *
   * @param token - Invitation token (the `FormationInvite` primary key); use the
   *   `token` of the {@link OpenInvitation} from {@link createOpenInvitation}.
   * @param sAppId - The sApp a redeemed strand will use.
   * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
   *   `strandId` (bind a closed/pre-existing host strand for provision-then-record).
   */
  async publishFormationInvite(
    token: string,
    sAppId: string,
    options: { expiresAtMs?: number; totalUses?: number; validationUrl?: string; strandId?: string } = {}
  ): Promise<void> {
    const signingKey = this.requireOwnerSigningKey(`publish formation invite ${token}`);
    await this.controlDatabase!.insertFormationInvite(
      token,
      sAppId,
      signingKey.publicKeyB64,
      signMessageWith(signingKey.privateKeyB64),
      options
    );
    // A host may publish an invite whose token was minted elsewhere; registering
    // it locally opens the connection gate's formation exemption immediately
    // rather than waiting for the durable row to become readable.
    this.strandSolicitationService?.registerMintedInvitation(
      token,
      options.expiresAtMs ?? Number.POSITIVE_INFINITY
    );
    log('Published formation invite %s (sApp %s) under owner %s', token, sAppId, signingKey.publicKeyB64);
  }

  /**
   * Enroll an approver public key allowed to sign off on `ValidationUrl` redemptions.
   *
   * A `FormationInvite` carrying a `ValidationUrl` is only redeemable when the approval
   * that comes back from that URL is signed by a key present in `CadreControl.ValidationKey`
   * — this is how a party says which outside approver it trusts. Without an enrollment,
   * every such invitation is unredeemable.
   *
   * Signs with the same self-owner key as {@link publishStrand} (the ed25519 key behind
   * this node's PeerId, which must be an enrolled `OwnerKey`). Throws loudly if the node
   * isn't started, exposes no signing key, or the key is blank — a blank key would reach
   * the database and fail the signature CHECK as an opaque constraint error.
   *
   * Enrolling this node's OWN owner key is permitted and harmless: the domain/action tags
   * baked into each authorization digest mean an owner-key signature can never satisfy the
   * approval rule and an approval can never satisfy an owner rule. No guard is needed.
   *
   * NOTE: enrollment is replicated control state, so a key enrolled here is visible to a
   * sibling cadre node only once control replication converges. A redemption that arrives
   * at a node which has not caught up is refused as not-enrolled — the same convergence
   * gap the schema records on `Strand.StampId`. Enroll before circulating the invitations
   * that depend on the key.
   *
   * @param key - Approver public key to enroll (base64url ed25519 public key).
   */
  async enrollValidationKey(key: string): Promise<void> {
    const signingKey = this.requireOwnerSigningKey('enroll a validation key');
    const trimmed = requireEd25519PublicKeyB64(key, 'validation key');
    await this.controlDatabase!.insertValidationKey(
      trimmed,
      signingKey.publicKeyB64,
      signMessageWith(signingKey.privateKeyB64)
    );
    log('Enrolled validation key %s under owner %s', trimmed, signingKey.publicKeyB64);
  }

  /**
   * Remove an approver public key.
   *
   * Narrows who may approve FUTURE redemptions ONLY. The schema's approval CHECKs run at
   * write time, so a join that was already approved by this key stays valid — removal is
   * not retroactive and does not re-examine committed rows.
   *
   * Rotation is therefore add-then-remove, in that order: removing the only enrolled key
   * while `ValidationUrl` invitations are outstanding makes every one of them unredeemable
   * until a new key is enrolled.
   *
   * Removing a key that is not enrolled is a silent no-op (no throw, no `Revocation`
   * tombstone) — see {@link ControlDatabase.deleteValidationKey}.
   *
   * @param key - Approver public key to remove (base64url ed25519 public key).
   */
  async removeValidationKey(key: string): Promise<void> {
    const signingKey = this.requireOwnerSigningKey('remove a validation key');
    const trimmed = requireNonBlank(key, 'validation key');
    await this.controlDatabase!.deleteValidationKey(
      trimmed,
      signingKey.publicKeyB64,
      signMessageWith(signingKey.privateKeyB64)
    );
    log('Removed validation key %s under owner %s', trimmed, signingKey.publicKeyB64);
  }

  /**
   * The approver keys currently enrolled, sorted. Read-only, so unlike
   * {@link enrollValidationKey} / {@link removeValidationKey} it needs no owner signing
   * key — only a started node.
   */
  async listValidationKeys(): Promise<string[]> {
    if (!this._running || !this.controlDatabase) {
      throw new Error('CadreNode must be started before listing validation keys');
    }
    return await this.controlDatabase.queryValidationKeys();
  }

  /**
   * Resolve the owner keypair every owner-signed control write needs — {@link publishStrand},
   * {@link unpublishStrand}, {@link publishFormationInvite}, {@link enrollValidationKey},
   * {@link removeValidationKey}
   * — failing loudly in one two-part shape (not started / no signing key, naming owner
   * genesis as the fix). Narrows `controlDatabase` for the caller: a non-null return means
   * `this.controlDatabase` is non-null too.
   *
   * @param action - Infinitive phrase naming the attempted write, e.g. `'enroll a
   *   validation key'`; interpolated into both messages.
   */
  private requireOwnerSigningKey(action: string): { privateKeyB64: string; publicKeyB64: string } {
    if (!this._running || !this.controlDatabase) {
      throw new Error(`CadreNode must be started before attempting to ${action}`);
    }
    const signingKey = this.getSelfSigningKey();
    if (!signingKey) {
      throw new Error(
        `Cannot ${action}: no owner signing key available ` +
        '(node identity is unavailable or does not match the node PeerId). Run owner ' +
        'genesis (ensureOwnerKey + initializeSeedBootstrap) before writing owner-signed ' +
        'control state.'
      );
    }
    return signingKey;
  }

  /**
   * Shared strand launch path for both the explicit (`addStrand`) and the
   * control-discovered (`handleStrandAdded`) entry points. Resolves the cohort
   * seed, starts the strand, and registers it with the hibernation manager
   * before emitting `strand:started`.
   *
   * Founder-ness: an explicit `founder` argument wins (the formation/responder flows pass
   * one deliberately — their consent-seated rows carry a null `FounderOwnerKey`); when
   * unset it is DERIVED from the row, so the control-discovered path
   * (`handleStrandAdded`) and a restart's re-attach found this machine's own strands
   * without the caller having to know. The derivation is pure key comparison — no I/O.
   *
   * Idempotent when the strand manager already tracks `strand.Id` — the watcher
   * rediscovers a row this node already started and calls this again via
   * `handleStrandAdded`; without the guard that re-entry would resolve a fresh
   * (already-connected) cohort seed and re-emit `strand:started` for an
   * instance that never stopped. The guard runs before the cohort-seed RPC
   * fan-out, so a rediscovery costs nothing beyond the map lookup plus the (pure)
   * founder derivation. NOT a silent no-op any more when the launch resolves as a
   * FOUNDER: the tracked instance may have been launched first as a joiner (an app
   * attach, or this node's own watcher poll winning the `resolveCohortSeed` window
   * below), which used to drop the founder request and leave the strand headerless —
   * now the tracked instance is founded in place
   * ({@link StrandInstanceManager.foundExistingStrand}), waking it first if quiesced
   * so the bootstrap actually runs before this resolves.
   *
   * A founder launch refused as pre-split (`PreSplitStrandIdentityError`) is recorded in
   * {@link strandLaunchRefusals} for the formation arm, then rethrown; a founder launch
   * that succeeds clears the record (it ran the bootstrap's pre-split check and passed).
   *
   * An absent `sAppConfig` launches a storage replica ({@link CadreNodeConfig.hostUnclaimedStrands}),
   * which is ALWAYS a joiner whatever the row says: the founder bootstrap writes the sApp
   * into `Strand.Header`, and a replica has none. So a self-founded row whose watcher poll
   * wins the race against its app's `addStrand` after a restart comes up as a replica — and
   * so does a `foundStrand` whose publish a watcher poll saw before its attach. A claim
   * that finds a tracked replica upgrades it in place, over the same node and store
   * ({@link StrandInstanceManager.attachSApp}), BEFORE any founding: the founder bootstrap
   * needs the sApp the attach supplies.
   */
  private async launchStrand(
    strand: StrandRow,
    sAppConfig: SAppConfig | undefined,
    founder?: boolean,
    explicitPartyKey?: string
  ): Promise<StrandInstance> {
    const resolvedFounder = sAppConfig ? (founder ?? this.isSelfFoundedRow(strand)) : false;
    try {
      const instance = await this.startOrFoundStrand(strand, sAppConfig, resolvedFounder, explicitPartyKey);
      if (resolvedFounder) {
        this.strandLaunchRefusals.delete(strand.Id);
      }
      return instance;
    } catch (error) {
      if (error instanceof PreSplitStrandIdentityError) {
        this.strandLaunchRefusals.set(strand.Id, error);
      }
      throw error;
    }
  }

  /**
   * The launch itself, for {@link launchStrand} (which documents the behaviour): found a
   * tracked instance in place, or start a fresh one.
   */
  private async startOrFoundStrand(
    strand: StrandRow,
    sAppConfig: SAppConfig | undefined,
    resolvedFounder: boolean,
    explicitPartyKey: string | undefined
  ): Promise<StrandInstance> {
    const timed = <T>(step: string, op: () => Promise<T>) => timedStep('startOrFoundStrand', strand.Id, step, op);
    if (this.strandManager.getInstance(strand.Id)) {
      return this.claimTrackedStrand(strand, sAppConfig, resolvedFounder, explicitPartyKey);
    }

    // A closed strand's launch carries the party's OWN membership identity key: the
    // explicit attach-time key, else the control-layer StrandPartyKey row — minted here
    // when this machine is the row-derived founder and no row exists yet (a publish
    // interrupted before its mint). A joiner with no persisted key threads undefined;
    // only a FOUNDER bootstrap needs the key, and that path throws loudly without one
    // (StrandDatabase).
    const partyMemberPrivateKey = strand.Type === 'c'
      ? await timed('resolveStrandPartyKey', () => this.resolveStrandPartyKey(strand, explicitPartyKey))
      : undefined;

    // Each strand node gets its own transport identity, derived from the cadre
    // identity key + strandId (see strand-transport-key.ts). Sharing the
    // control node's key here gave every node one peerId, which collides at a
    // shared circuit relay (github.com/gotchoices/sereus/issues/1). The
    // retained launch config carries this derived key, so hibernate → wake
    // (resumeStrand) reuses the same peerId.
    //
    // Without an identity key (a node configured with neither `keyStore` nor
    // `privateKey` — tests, and an embedder that opted out of a stable identity) the
    // strand node still runs under a key CADRE-CORE HOLDS: a fresh random Ed25519 key,
    // exactly what libp2p would generate internally if handed none, except that the
    // delegate announcement below can name the strand peer id before the node exists and
    // the retained launch config keeps that id across a hibernation resume. Stability
    // across RESTARTS still needs an identity key.
    //
    // NOTE: derivation requires an Ed25519 identity key, so a node configured
    // with some other key type now fails strand launch outright (surfaced as
    // `strand:error` / a rejected addStrand) where it previously started the
    // strand on that key. Ed25519 is already required for every control-DB
    // signing path, so nothing reachable today hits this; if a non-Ed25519
    // identity is ever supported, take the random-key branch below for it — it
    // still avoids the collision, and gives up only peerId stability across restarts.
    const identityKey = this.identityKey;
    const transportKey = identityKey
      ? await timed('strandTransportKey', () => strandTransportKey(identityKey, strand.Id))
      : await generateKeyPair('Ed25519');

    // Derived BEFORE seed resolution so the seed pass doubles as the delegate
    // announcement and every grant is recorded before `startStrand` runs
    // `libp2p.start()` (the responder records the grant before replying; the
    // client awaits the replies).
    const delegatePeerId = transportKey ? peerIdFromPrivateKey(transportKey).toString() : undefined;
    const bootstrapNodes = await timed('resolveCohortSeed', () => this.resolveCohortSeed(strand.Id, delegatePeerId));

    // Checked again after the awaits above: another launch of this strand may have started
    // meanwhile (a replica's watcher launch racing an app's claim, in either order), and
    // `startStrand` would hand its instance back unchanged — a claim holding a replica with
    // no `App` tables, a founder request dropped. Nothing awaits between this check and
    // `startStrand`'s own, so no third launch can slip in.
    if (this.strandManager.getInstance(strand.Id)) {
      return this.claimTrackedStrand(strand, sAppConfig, resolvedFounder, explicitPartyKey);
    }

    const instance = await timed('strandManager.startStrand', () => this.strandManager.startStrand({
      strandRow: strand,
      sAppConfig,
      storage: this.config.storage,
      network: this.config.network,
      profile: this.config.profile,
      defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? 'interactive',
      privateKey: transportKey,
      bootstrapNodes,
      requireSignedSchemas: this.config.requireSignedSchemas,
      clusterSize: this.config.strandClusterSize,
      // NOTE: deliberately NO `servingMachines`, so the strand node declares no repair
      // yardstick and runs the frozen STRAND_CLUSTER_POLICY. The only count this node holds
      // is the party's enrolled machines (`authorizedControlPeers`), and passing that here
      // is the regression `bug-strand-yardstick-counts-party-machines` removed — a strand
      // runs on a subset of the party, and over-declaring makes repair impossible rather
      // than merely weak. The full argument, and the count that will legitimately go here,
      // are on `StartStrandConfig.servingMachines`.
      backfill: this.config.strandBackfill,
      reactivity: this.config.strandReactivity,
      revocationEnforcement: this.config.strandRevocationEnforcement,
      membershipReconciliation: this.config.strandMembershipReconciliation,
      onSelfRevoked: (revokedStrandId) => {
        this.forgetRevokedJoin(revokedStrandId);
        this.emit('strand:revoked', { strandId: revokedStrandId });
      },
      // Where the strand node saves its network state and what it re-imports when it is
      // built. Retained with the launch config, so a hibernation wake rebuilds the node
      // over the table the quiesced node last saved. `?? undefined`: the field is `null`
      // before start(), and a strand cannot launch before start(), so this is belt and
      // braces.
      networkState: this.strandNetworkStateStore ?? undefined,
      onRejoinBlocked: (blockedStrandId) => this.emit('strand:rejoin-blocked', { strandId: blockedStrandId }),
      // The joiner's first-sync write gate (strand-first-sync-gate.ts): a launch that
      // comes up `'syncing'` announces the moment its database is published.
      firstSync: this.config.strandFirstSync,
      onWritable: (writableStrandId) => this.handleStrandWritable(writableStrandId),
      // Re-announce the delegate to ONE relay before the strand node's reservation
      // supervisor re-drives it (see announceDelegateToRelay). Retained with the
      // launch config, so a hibernation wake's rebuilt supervisors get it too.
      announceDelegateToRelay: (announcedStrandId, relayAddr, announcedDelegatePeerId) =>
        this.announceDelegateToRelay(announcedStrandId, relayAddr, announcedDelegatePeerId),
      // The staged formation invitation seam for the bring-up membership
      // reconciler: read lazily per pass (a re-formation replaces the entry) and
      // cleared once spent, burned, or dead — see pendingMembershipInvites.
      pendingMembershipInvite: {
        get: () => this.pendingMembershipInvites.get(strand.Id),
        clear: (settled) => this.unstageMembershipInvite(strand.Id, settled)
      },
      // The RESOLVED flag, never the raw argument — see the doc comment above.
      founder: resolvedFounder,
      // Retained with the launch config, so a hibernation wake rebuilds under the
      // same identity without re-reading the control DB.
      partyMemberPrivateKey
    }));

    // The seed reached the node as `bootstrapNodes`, which only enters the
    // address book via @libp2p/bootstrap discovery. Merge it directly too, so a
    // sibling is dialable by bare peer id from the first moment (see
    // mergeStrandPeerAddrs; refreshStrandPeerAddrs keeps it warm from here on).
    const strandNode = instance.libp2pNode;
    if (strandNode) {
      await timed('mergeStrandPeerAddrs', () => this.mergeStrandPeerAddrs(strandNode, bootstrapNodes, strand.Id));
    }

    this.hibernationManager.trackStrand(instance);
    this.emit('strand:started', { strandId: strand.Id });
    return instance;
  }

  /**
   * {@link startOrFoundStrand} for a strand the manager already tracks: a claim of a
   * storage replica gives it the app's schema in place, then a founder request founds it,
   * waking a quiesced instance so the bootstrap has run before this resolves. Emits
   * nothing — `strand:started` fired when the instance launched.
   *
   * A launch of the strand still in flight (the watcher's launch racing an app's
   * `addStrand`, in either order) is waited out first: until its build settles the tracked
   * instance is `'starting'` with no database, and returning it would resolve `addStrand`
   * with a strand the app cannot use — and skip that call's first-sync wait, which only a
   * `'syncing'` instance gets. If that launch fails, this rejects too: its record is gone.
   */
  private async claimTrackedStrand(
    strand: StrandRow,
    sAppConfig: SAppConfig | undefined,
    resolvedFounder: boolean,
    explicitPartyKey: string | undefined
  ): Promise<StrandInstance> {
    const timed = <T>(step: string, op: () => Promise<T>) => timedStep('startOrFoundStrand', strand.Id, step, op);
    const existing = await this.strandManager.whenRuntimeBuilt(strand.Id);
    if (!existing) {
      throw new Error(`Strand ${strand.Id}: the launch this one waited on failed (reported by the call that started it)`);
    }
    // Before the founder branch: the founder bootstrap writes the sApp into Strand.Header,
    // so it must run against the attached config.
    if (sAppConfig && !existing.sAppInfo) {
      const attached = await timed('attachSApp', () => this.strandManager.attachSApp(strand.Id, sAppConfig,
        { requireSignedSchemas: this.config.requireSignedSchemas }));
      log('launchStrand: strand %s was running as a storage replica — sApp %s claimed it (%s)',
        strand.Id, sAppConfig.id, attached);
    }
    if (!resolvedFounder) {
      log('launchStrand: strand %s already tracked locally — skipping re-launch', strand.Id);
      return existing;
    }
    // The resolver runs only when the retained config lacks a party key for a
    // closed strand (see foundExistingStrand), so the common watcher re-entry
    // ('already-founder') still costs no control read.
    const outcome = await timed('foundExistingStrand', () => this.strandManager.foundExistingStrand(strand.Id,
      () => this.resolveStrandPartyKey(strand, explicitPartyKey)));
    if (outcome === 'needs-resume') {
      try {
        // Quiesced instance: the retained config now founds, but founding promises
        // the bootstrap has RUN by the time the caller resolves — wake through the
        // hibernation manager (coalesced with any in-flight wake, timer-aware) so
        // the rebuild executes it now rather than at some eventual wake.
        await timed('wakeStrand', () => this.wakeStrand(strand.Id));
        // The wake's rebuild founds — UNLESS a wake was already in flight when the
        // config flipped, in which case it had already read the pre-flip config and
        // rebuilt as a joiner, and `wakeStrand` merely coalesced onto it. Re-run the
        // (insert-if-absent) bootstrap so founding never resolves headerless.
        await timed('ensureFounderBootstrap', () => this.strandManager.ensureFounderBootstrap(strand.Id));
      } catch (error) {
        // The founding did not happen (e.g. the rebuild refused a pre-split strand and
        // rolled back, leaving the instance tracked with no runtime): withdraw the flip
        // so the next attempt re-runs the founding instead of resolving
        // 'already-founder' over an instance that never founded.
        this.strandManager.withdrawFounderRequest(strand.Id);
        throw error;
      }
    }
    log('launchStrand: strand %s already tracked — founder request honored (%s)',
      strand.Id, outcome);
    return existing;
  }

  /**
   * Resolve a strand's discovery seed — the dialable strand-network multiaddr
   * strings for cohort siblings. Membership comes from the control network's
   * CadrePeer rows; the **strand-network** bootstrap addresses are resolved on
   * demand over the control mesh via the strand-addr RPC — deliberately NOT
   * from `CadrePeer.Multiaddr`, which carries *control* addresses that must not
   * seed the strand mesh.
   *
   * Only siblings we already hold an open control connection to are RPC'd: they
   * are the ones that can answer right now, and dialing them by peerId reuses the
   * live connection. When no connected sibling yet runs the strand the seed is
   * empty (`[]`) — the empty seed self-heals on the next resume / check-in pass.
   * Returns an empty seed when the control DB or node is absent (not yet
   * started / torn down).
   *
   * When `delegatePeerId` is given (a strand launch/resume is imminent), the
   * pass doubles as the delegate ANNOUNCEMENT: our circuit relays are merged
   * into the RPC targets and every request carries the delegate peerId, so each
   * receiver records an admission grant BEFORE `libp2p.start()` (re-)dials the
   * relay reservation — the gate denial there is fatal, not degraded. A
   * party-member relay answers the RPC (its control node admits us as a
   * member); a dedicated ops/ relay does not speak the protocol and the
   * per-peer failure comes back `unreachable` — harmless, it has no membership gate and
   * needs no grant. The relay's direct addr rides along as the dial fallback
   * for a relay we are not yet connected to.
   */
  private async resolveCohortSeed(strandId: string, delegatePeerId?: string): Promise<string[]> {
    const siblings = await this.resolveSiblingSeed(strandId, delegatePeerId);
    // Sibling answers FIRST: they were resolved just now, while the formation-carried
    // addresses are as old as the formation. `unionAddrs` appends only what the siblings
    // did not already name, so a fresher answer is never displaced and each source keeps
    // its own ordering.
    return unionAddrs(siblings, this.formationStrandAddrs.get(strandId) ?? []);
  }

  /**
   * The own-party half of {@link resolveCohortSeed}: strand-network addresses resolved
   * from CONNECTED cohort siblings over the control-mesh strand-addr RPC, doubling as
   * the delegate announcement when `delegatePeerId` is given. Empty when the control DB
   * or node is absent (not yet started / torn down).
   */
  private async resolveSiblingSeed(strandId: string, delegatePeerId?: string): Promise<string[]> {
    if (!this.controlDatabase || !this.controlNode) {
      return [];
    }
    const targets = await this.connectedSiblingTargets();
    const relays = delegatePeerId === undefined ? [] : this.circuitRelayTargets();
    for (const relay of relays) {
      if (!targets.some((t) => t.peerId === relay.relayPeerId)) {
        targets.push(relayStrandAddrPeer(relay));
      }
    }
    const bootstrapNodes = targets.length
      ? (await this.collectSiblingStrandAddrs(this.controlNode, targets, strandId, delegatePeerId)).addrs
      : [];
    // Throttle state for the RELAY targets only — refreshDelegateGrants never
    // looks up a sibling key, so recording one would only be dead weight. The
    // siblings' refresh due times are deliberately left alone too: stamping here
    // would race the refresh pass's pruning while the strand node is still coming
    // up, and all it would save is one extra RPC per sibling on the first tick.
    this.recordDelegateAnnounces(relays.map((r) => r.relayPeerId), strandId);
    return bootstrapNodes;
  }

  /**
   * The co-cadre siblings worth sending a strand-addr RPC to right now: cohort
   * members (self excluded) we already hold an open control connection to. They
   * are the ones that can answer immediately, and dialing them by peerId reuses
   * the live connection instead of opening a second one.
   *
   * Shared by {@link resolveCohortSeed} (launch/resume) and
   * {@link refreshStrandPeerAddrs} (the periodic pass) so both ask the same set.
   * Empty when the control DB or node is absent (not yet started / torn down).
   *
   * The read below is issued even when the node holds no control connection and
   * the answer is therefore empty by construction. That is deliberate on the
   * launch path: `control-database-solo-warm-start.spec.ts` exists to prove this
   * exact read does not stall as an embedder's FIRST awaited control operation,
   * on a warm cohort no one can reach. A caller that re-enters often enough for
   * the read to matter should skip the call itself, as
   * {@link refreshStrandPeerAddrs} does.
   *
   * NOTE: this read is UNBOUNDED and sits on the critical path an embedding app
   * awaits during startup — `addStrand` cannot resolve until it does, and it is
   * the first control operation an embedder's boot order issues (before genesis,
   * before seed bootstrap). Measured fine today: the warm-start-alone shape a
   * report pointed at — a `CadrePeer` list naming peers that are all gone, read
   * off real files after a restart — completes in milliseconds, and
   * `control-database-solo-warm-start.spec.ts` covers it under a deadline. If a
   * control read ever CAN stall (a transactor change that consults the network
   * for a local row, a storage backend with blocking I/O), give this one a
   * timeout — and decide then whether the breach fails `addStrand` or degrades
   * to an empty seed, because those promise callers different things.
   */
  private async connectedSiblingTargets(): Promise<StrandAddrPeer[]> {
    const controlNode = this.controlNode;
    if (!this.controlDatabase || !controlNode) {
      return [];
    }
    const peers = await this.controlDatabase.queryCadrePeers();
    const connected = new Set(controlNode.getConnections().map((c) => c.remotePeer.toString()));
    return deriveCohortMembers(peers, controlNode.peerId.toString())
      .filter((id) => connected.has(id))
      .map((peerId) => ({ peerId }));
  }

  /**
   * The circuit relays this node's strand nodes would reserve through: the
   * union of CONFIGURED relays — `network.relayAddrs`, plus any hand-written
   * `network.listenAddrs` circuit entry, both of which a strand node inherits
   * verbatim — and the control node's own live `/p2p-circuit` multiaddrs (a
   * reservation this node discovered rather than configured).
   *
   * The CONFIGURED half reads `network.relayAddrs` and `network.listenAddrs`
   * directly rather than going through {@link resolveListenAddrs}: the control
   * node's resolution takes the `'search'` route, whose bare `/p2p-circuit` entry
   * names no relay, so a configured relay would be unannounceable here until this
   * node's own reservation landed — and the announce must be in place BEFORE a
   * strand node dials its reservation, since the relay's membership gate does not
   * know the strand's derived peerId (see delegate-admission.ts). Configuration is
   * authoritative; the live multiaddrs only ADD relays nobody configured.
   *
   * The `listenAddrs` half is now unreachable on a control node — `relay-addrs.ts`
   * rejects a hand-written `<relay>/p2p-circuit` listen entry outright, because the
   * bring-up quiet period denies the dial that listener makes from inside
   * `libp2p.start()`. Kept because it costs one spread and this is the one place
   * that would silently stop announcing if that rejection is ever relaxed.
   *
   * NOTE: a relay the STRAND node discovers on its own (autorelay — in neither
   * source) gets no announcement, and a membership-gated one will deny it; fine
   * now, every realistic topology feeds one of the two sources.
   */
  private circuitRelayTargets(): CircuitRelayTarget[] {
    return extractCircuitRelayTargets([
      ...relayCircuitAddrs(this.config.network?.relayAddrs ?? []),
      ...(this.config.network?.listenAddrs ?? []),
      ...(this.controlNode?.getMultiaddrs().map(String) ?? [])
    ]);
  }

  /**
   * Record the announce timestamps {@link refreshDelegateGrants} throttles on,
   * for every relay a delegate-carrying announce pass dialed.
   *
   * Recorded OPTIMISTICALLY at announce time, whatever `collectStrandAddrs`
   * reports per peer: a dedicated `ops/` relay never speaks the strand-addr
   * protocol, so recording only on success would re-announce to it on every
   * reconcile tick, one wasted protocol negotiation each. A failed INITIAL announce
   * costs the strand supervisor its first attempt only (the relay denies the
   * reservation; every re-drive re-announces first through
   * {@link announceDelegateToRelay}); a failed REFRESH retries within
   * `DELEGATE_GRANT_TTL_MS / 2` (15 min), still inside the 30 min TTL.
   */
  private recordDelegateAnnounces(relayPeerIds: readonly string[], strandId: string, now = Date.now()): void {
    for (const relayPeerId of relayPeerIds) {
      this.delegateAnnounceAt.set(peerStrandKey(relayPeerId, strandId), now);
    }
  }

  /**
   * Re-announce every running strand's delegate peerId to this node's circuit
   * relays, throttled to once per `DELEGATE_GRANT_TTL_MS / 2` per
   * (relay, strand). A grant must outlive the reservation: a dropped relay
   * connection makes the strand's circuit-relay transport re-dial and face the
   * connection gate again, so the relay must still hold a live grant then.
   * RELAY targets only — siblings get their announce on every launch/resume
   * seed pass, and a grant only matters where a reservation can be re-dialed.
   *
   * Strands announce CONCURRENTLY: this runs ahead of the reconcile pass's
   * sibling enumeration, and one unreachable relay costs a dial timeout per
   * target, which must not stack up per strand.
   */
  private async refreshDelegateGrants(now = Date.now()): Promise<void> {
    if (!this.controlNode) {
      return;
    }
    // A running strand's delegate peerId is simply its live node's peerId — no
    // re-derivation here.
    const running = new Map<string, string>();
    for (const [strandId, instance] of this.strandManager.getInstances()) {
      if (instance.libp2pNode) {
        running.set(strandId, instance.libp2pNode.peerId.toString());
      }
    }
    prunePeerStrandKeys(this.delegateAnnounceAt, new Set(running.keys()));
    if (running.size === 0) {
      return;
    }
    const relays = this.circuitRelayTargets();
    if (relays.length === 0) {
      return;
    }
    await Promise.all([...running].map(
      ([strandId, delegatePeerId]) => this.announceDelegateToDueRelays(strandId, delegatePeerId, relays, now)
    ));
  }

  /**
   * Announce ONE strand's delegate peerId to ONE relay, UNTHROTTLED — the
   * `beforeRedrive` hook of that strand node's per-relay reservation supervisor
   * (`strand-instance-manager.ts` → `buildStrandRuntime`), run before every
   * re-drive after the first attempt.
   *
   * Why a re-drive must re-announce first: a party control node running the relay
   * server admits the strand node's derived peerId on an in-memory delegate grant
   * (`delegate-admission.ts`), and a relay restart drops every grant it held
   * without telling the announcer. {@link refreshDelegateGrants} would re-announce
   * on its own at most every `DELEGATE_GRANT_TTL_MS / 2` (15 min) per (relay,
   * strand) — far slower than the supervisor's backoff — so without this the first
   * re-drives after a relay restart would be denied at the relay's connection gate.
   * The throttle map is updated afterwards, so the periodic pass does not announce
   * again right away.
   *
   * Against a dedicated ops relay (no strand-addr RPC) the request fails per-peer
   * and `collectStrandAddrs` reports it `unreachable`: one wasted protocol negotiation per
   * re-drive attempt, bounded by the supervisor's backoff. Never throws on that
   * path; a relay addr that names no peer id is logged and skipped (the hook's
   * caller runs the drive regardless).
   *
   * NOTE: against a relay that is DOWN this hook costs up to two strand-addr
   * timeouts (dial by peer id, then by addr; 28.5 s each at the default declared link round trip)
   * before the reservation drive even starts, so one failed re-drive holds the supervisor
   * `driving` for those 57 s plus the drive's own deadline — 75 s at the default, and longer on
   * a host that declared a slower one (`link-budget.ts`).
   * Bounded and harmless while the relay is unreachable anyway; if recovery
   * latency after a relay comes back ever matters, skip the announce when the
   * control node holds no connection to the relay (the drive's own dial fails
   * faster) rather than shortening the strand-addr timeout.
   */
  private async announceDelegateToRelay(strandId: string, relayAddr: string, delegatePeerId: string): Promise<void> {
    const controlNode = this.controlNode;
    if (!controlNode) {
      return;
    }
    const relayPeerId = trailingPeerId(multiaddr(relayAddr));
    if (relayPeerId === null) {
      log('announceDelegateToRelay: relay addr %s names no peer id; strand %s not announced', relayAddr, strandId);
      return;
    }
    await this.collectSiblingStrandAddrs(
      controlNode,
      [{ peerId: relayPeerId, addrs: [multiaddr(relayAddr)] }],
      strandId,
      delegatePeerId
    );
    this.recordDelegateAnnounces([relayPeerId], strandId);
  }

  /** One strand's share of {@link refreshDelegateGrants}: announce to the relays whose grant is due. */
  private async announceDelegateToDueRelays(
    strandId: string,
    delegatePeerId: string,
    relays: readonly CircuitRelayTarget[],
    now: number
  ): Promise<void> {
    const controlNode = this.controlNode;
    if (!controlNode) {
      return;
    }
    const due = dueRelayAnnounces(this.delegateAnnounceAt, relays, strandId, now);
    if (due.length === 0) {
      return;
    }
    await this.collectSiblingStrandAddrs(controlNode, due.map(relayStrandAddrPeer), strandId, delegatePeerId);
    this.recordDelegateAnnounces(due.map((relay) => relay.relayPeerId), strandId, now);
  }

  /**
   * Keep each running strand's own libp2p address book warm: re-merge the address
   * records its FRET routing table holds on every pass
   * ({@link remergeStrandFretRecords}), and re-ask each connected SIBLING for its
   * strand addresses over the control mesh when that (sibling, strand) is due
   * ({@link strandAddrAskDueAt}).
   *
   * Without this, cadre-core writes a strand's address book exactly once — the
   * launch/resume seed — and everything below cadre-core that dials a strand peer
   * by bare peer id (Optimystic's cluster and repo clients, FRET ping/announce)
   * loses its address for any peer it is not currently connected to: a sibling
   * that restarted its strand node or rotated its relay reservation is never
   * re-resolved, and every address, another party's included, falls off at the
   * peerStore's one-hour expiry (see `peer-addr-book.ts`).
   *
   * Due times are per (sibling, strand) and set from each sibling's own outcome, so
   * a sibling that connects late — a phone joining after the party's always-on
   * machines — is asked on the next tick, and one that could not answer or refused
   * (its view of the membership may not include us yet) is retried within
   * {@link STRAND_PEER_ADDR_RETRY_MS} rather than {@link STRAND_PEER_ADDR_REFRESH_MS}.
   *
   * Distinct from {@link refreshDelegateGrants}, deliberately: that pass covers
   * RELAYS on a `DELEGATE_GRANT_TTL_MS / 2` throttle to keep circuit-relay
   * admission grants alive, this one covers SIBLINGS on an address-expiry
   * throttle to keep the address book warm. They overlap only in that both carry
   * `delegatePeerId`, so a sibling that also runs a relay gets its grant
   * refreshed here as a side effect. Merging them would tie an admission-grant
   * TTL to an address-expiry window that has nothing to do with it.
   *
   * Strands refresh CONCURRENTLY, like `refreshDelegateGrants`, so one
   * unreachable sibling's dial timeout does not stack up per strand.
   */
  private async refreshStrandPeerAddrs(now = Date.now()): Promise<void> {
    if (!this._running || !this.controlNode) {
      return;
    }
    // A hibernating / quiescing strand has no node to seed, so it is not running
    // for this pass's purposes even though its instance is still tracked.
    const running = new Set<string>();
    for (const [strandId, instance] of this.strandManager.getInstances()) {
      if (instance.libp2pNode) {
        running.add(strandId);
      }
    }
    if (running.size === 0) {
      this.strandAddrAskDueAt.clear();
      return;
    }
    const targets = await this.strandAddrRefreshTargets();
    // A shutdown landed mid-enumeration.
    if (!this._running || !this.controlNode) {
      return;
    }
    // Drop due times for strands no longer running and siblings no longer connected:
    // the map must not grow for the node's lifetime, a resumed strand must not
    // inherit its previous incarnation's due times, and a sibling that reconnects (a
    // phone restart, a new relay reservation) must be asked on its next connected
    // tick. An enumeration failure prunes everything, which costs one extra round of
    // asks, never a missed one.
    prunePeerStrandKeys(this.strandAddrAskDueAt, running, new Set(targets.map((t) => t.peerId)));
    await Promise.all([...running].map((strandId) => this.refreshOneStrandPeerAddrs(strandId, targets, now)));
  }

  /**
   * The siblings {@link refreshStrandPeerAddrs} may ask this pass: the connected
   * cohort, or none when enumeration fails (logged, never thrown).
   *
   * `connectedSiblingTargets`' membership read is unbounded, and with zero
   * connections its answer is empty whatever the table holds, so decide it from the
   * connection list instead of paying for the read once a tick.
   *
   * NOTE: otherwise the read runs on EVERY tick with a running strand, not only when
   * some (sibling, strand) is due: pruning a departed sibling needs the current
   * target set, and whether anyone is due cannot be told without it (a connected
   * non-member never gets a due time to compare). One more `CadrePeer` read per 15 s
   * tick, on top of the two `runReconcileControlCohort` already makes; if those reads
   * get costly, share one row-set across the pass (see the NOTE there) rather than
   * skipping ticks here.
   *
   * NOTE: one strand-addr RPC per (running strand × due sibling) — each a tiny
   * request/response on an already-open control connection. If a node ever runs
   * MANY strands at once, batch the RPC to carry several strand ids per request
   * rather than one fan-out per strand.
   */
  private async strandAddrRefreshTargets(): Promise<StrandAddrPeer[]> {
    if (this.controlNode?.getConnections().length === 0) {
      return [];
    }
    return this.connectedSiblingTargets().catch((error): StrandAddrPeer[] => {
      log('refreshStrandPeerAddrs: sibling enumeration failed (asking nobody this pass): %o', error);
      return [];
    });
  }

  /**
   * One strand's share of {@link refreshStrandPeerAddrs}: RPC the siblings that are
   * due and merge their answers into the strand's address book, then re-merge the
   * address records the strand node's FRET table holds. Errors are logged and
   * swallowed so one strand's failure never costs the others their refresh.
   *
   * The sibling half runs first, so a failure reading the FRET table cannot cost a
   * sibling answer its merge. The FRET half, and the formation-carried addresses of
   * the peers it holds no record for, run on EVERY pass, whether or not any sibling is
   * due or connected — see {@link remergeStrandFretRecords} and
   * {@link remergeUnrecordedFormationAddrs} for why.
   */
  private async refreshOneStrandPeerAddrs(
    strandId: string,
    targets: readonly StrandAddrPeer[],
    now: number
  ): Promise<void> {
    const controlNode = this.controlNode;
    const strandNode = this.strandManager.getInstance(strandId)?.libp2pNode;
    if (!controlNode || !strandNode) {
      return;
    }
    try {
      // Inside the try: a strand node torn down mid-pass may throw on any read, and one
      // strand's failure must never cost the others their refresh.
      const strandPeerId = strandNode.peerId.toString();
      const due = targets.filter(
        (target) => now >= (this.strandAddrAskDueAt.get(peerStrandKey(target.peerId, strandId)) ?? 0)
      );
      // The running strand node's own peerId is the delegate to announce — see
      // the relationship note on refreshStrandPeerAddrs.
      const siblingAddrs = due.length === 0
        ? []
        : await this.askSiblingsForStrandAddrs(controlNode, due, strandId, strandPeerId, now);
      if (!this.isRunningStrandNode(strandId, strandNode)) {
        return;
      }
      if (siblingAddrs.length > 0) {
        await this.mergeStrandPeerAddrs(strandNode, siblingAddrs, strandId);
      }
      const recorded = await this.remergeStrandFretRecords(strandNode, strandId);
      await this.remergeUnrecordedFormationAddrs(strandNode, strandId, recorded);
    } catch (error) {
      log('refreshStrandPeerAddrs: strand %s refresh failed (continuing): %o', strandId, error);
    }
  }

  /**
   * Is `strandNode` still the node `strandId` runs on? Asked again after every await
   * in a refresh pass: a strand stopped mid-pass, or one already restarted onto a new
   * node, must never have its store written to.
   */
  private isRunningStrandNode(strandId: string, strandNode: Libp2p): boolean {
    return this._running && this.strandManager.getInstance(strandId)?.libp2pNode === strandNode;
  }

  /**
   * Re-merge, into a running strand node's address book, the addresses of every peer
   * its FRET routing table holds a signed address record for (`strand-fret-addrs.ts`).
   *
   * This is what keeps ANOTHER PARTY's strand nodes dialable from a node that stays
   * up. Nothing re-resolves their addresses — the strand-addr RPC answers own-party
   * siblings only — and the peerStore hides an address one hour after it was first
   * observed. FRET keeps each peer's record but hands it to the peerStore only when it
   * arrives or is imported, so without this pass a connection to another party that
   * drops after the first hour could not be redialed by either side.
   *
   * A record is held while FRET holds the peer's table entry, and at most 14 days after
   * it was last confirmed, so that is also how long a wrong address can keep being
   * re-merged. Each record is signed by the peer it names and verified before use, so
   * the exposure is failed dials to an address that peer itself published.
   *
   * NOTE: every pass serialises the whole FRET table (`exportTable()`), verifies one
   * signature per record and makes one `peerStore.merge` per peer, per running strand
   * per 15 s tick. Fine at strand table sizes, and an unchanged address set writes
   * nothing in libp2p's persistent peer store. If many strands or large tables make it
   * show up, read only the entries whose address stamp is near the one-hour mark.
   *
   * @returns the ids of the peers the table holds a usable record for.
   */
  private async remergeStrandFretRecords(strandNode: Libp2p, strandId: string): Promise<ReadonlySet<string>> {
    const { peers, rejected } = await strandFretPeerAddrs(strandNode);
    const recorded = new Set(peers.keys());
    if ((peers.size === 0 && rejected === 0) || !this.isRunningStrandNode(strandId, strandNode)) {
      return recorded;
    }
    const counts: Record<MergeAddrsResult, number> = { merged: 0, restamped: 0, skipped: 0, failed: 0 };
    for (const [peerId, addrs] of peers) {
      counts[await mergePeerAddrs(strandNode, peerId, addrs)]++;
    }
    log('strand %s FRET address records re-merged (peers=%d, merged=%d, restamped=%d, failed=%d, rejected=%d)',
      strandId, peers.size, counts.merged, counts.restamped, counts.failed, rejected);
    return recorded;
  }

  /**
   * Re-merge the addresses this strand's formation carried ({@link formationStrandAddrs})
   * for every peer the strand node's FRET table holds no record for (`recorded`).
   *
   * Until the first connection to the responder, the carried addresses are the only
   * thing naming it, and the launch seed writes them once. FRET's `bootstraps` keep only
   * the peer id, so if the responder stays unreachable past the peerStore's one-hour
   * expiry, nothing could dial it when it returns. Once FRET holds the peer's own signed
   * record, that record supersedes what the formation carried and this stops.
   */
  private async remergeUnrecordedFormationAddrs(
    strandNode: Libp2p,
    strandId: string,
    recorded: ReadonlySet<string>
  ): Promise<void> {
    const carried = this.formationStrandAddrs.get(strandId);
    if (!carried) {
      return;
    }
    const unrecorded = [...groupAddrsByPeerId(carried)]
      .filter(([peerId]) => !recorded.has(peerId))
      .flatMap(([, addrs]) => addrs.map((addr) => addr.toString()));
    if (unrecorded.length === 0 || !this.isRunningStrandNode(strandId, strandNode)) {
      return;
    }
    await this.mergeStrandPeerAddrs(strandNode, unrecorded, strandId);
  }

  /**
   * RPC `due` siblings for `strandId` and set each one's next due time from its own
   * outcome: an answer, even an empty one, waits the full refresh interval; anything
   * else retries in {@link STRAND_PEER_ADDR_RETRY_MS} (or the refresh interval, if
   * configured shorter). Stamped before the caller
   * re-checks that the strand is still running, so a strand torn down mid-pass still
   * records who was asked.
   */
  private async askSiblingsForStrandAddrs(
    controlNode: Libp2p,
    due: readonly StrandAddrPeer[],
    strandId: string,
    delegatePeerId: string,
    now: number
  ): Promise<string[]> {
    const { addrs, outcomes } = await this.collectSiblingStrandAddrs(controlNode, [...due], strandId, delegatePeerId);
    const refreshMs = this.config.network?.controlCohort?.strandAddrRefreshMs ?? STRAND_PEER_ADDR_REFRESH_MS;
    // A configured refresh shorter than the retry must not leave a failing sibling
    // waiting longer than a healthy one.
    const retryMs = Math.min(refreshMs, STRAND_PEER_ADDR_RETRY_MS);
    for (const [peerId, outcome] of outcomes) {
      const waitMs = siblingAnswered(outcome) ? refreshMs : retryMs;
      this.strandAddrAskDueAt.set(peerStrandKey(peerId, strandId), now + waitMs);
    }
    return addrs;
  }

  /**
   * Merge strand-network addresses into ONE strand node's libp2p address book,
   * attributed per peer. Best-effort throughout: an address-book write must never
   * fail a launch, a resume, or a reconcile pass.
   *
   * `addrs` is a peer-agnostic list — the union the strand-addr RPC returns, or the
   * addresses a formation carried — so {@link groupAddrsByPeerId} attributes each
   * entry to the **strand transport** peerId in its final `/p2p/` component — never
   * the sibling's control peerId, which names a different libp2p node entirely.
   * Entries that name no peer are dropped there and counted here, once per pass.
   *
   * NOTE: a member could answer with arbitrary multiaddrs bound to arbitrary peer
   * ids and poison this address book. That is the same exposure the launch-time
   * `bootstrapNodes` seeding already accepts, and the cost is bounded: an address
   * grants no authority, the dialed peer authenticates by peer id at the
   * handshake, and a bad entry costs one failed dial that ages out at the
   * peerStore's one-hour expiry. No new gating here — cross-party strand trust is
   * `backlog/strand-network-nat-relay-reachability`.
   *
   * NOTE: one input outlives that hour — a formation's carried addresses
   * ({@link formationStrandAddrs}) are in every launch and resume seed for as long as
   * this process remembers the formation, and re-merged on every refresh pass until the
   * strand node's FRET table holds the peer's own record, so a junk address from a
   * responder that is never met keeps being re-merged. Bounded by `sanitizeStrandAddrs`,
   * replaced by a re-formation, dropped on `unpublishStrand` / `forgetJoinedStrand`, and
   * still authority-free — so the exposure is a handful of failed dials, not a trust hole.
   */
  private async mergeStrandPeerAddrs(strandNode: Libp2p, addrs: string[], strandId: string): Promise<void> {
    const counts: Record<MergeAddrsResult, number> = { merged: 0, restamped: 0, skipped: 0, failed: 0 };
    let grouped = 0;
    let peers = 0;
    try {
      const groups = groupAddrsByPeerId(addrs);
      peers = groups.size;
      const selfId = strandNode.peerId.toString();
      for (const [peerId, peerAddrs] of groups) {
        grouped += peerAddrs.length;
        // We never RPC ourselves, so self should never appear — belt and braces:
        // a node must not write its own addresses into its own address book.
        if (peerId === selfId) {
          continue;
        }
        counts[await mergePeerAddrs(strandNode, peerId, peerAddrs)]++;
      }
    } catch (error) {
      // `mergePeerAddrs` folds its own failures, so reaching here means the node
      // itself is unusable (torn down mid-merge). Never fail a launch/resume or a
      // reconcile pass over an address book.
      log('strand %s address book merge failed (continuing): %o', strandId, error);
    }
    log('strand %s address book merged (peers=%d, merged=%d, restamped=%d, skipped=%d, failed=%d, dropped=%d)',
      strandId, peers, counts.merged, counts.restamped, counts.skipped, counts.failed,
      addrs.length - grouped);
  }

  /**
   * The local strand instance's dialable strand-network multiaddrs for the
   * strand-addr RPC, ordered signaling-first (reusing the control node's
   * {@link orderSignalingFirst}). Returns `[]` when the strand is not running
   * locally or has no live libp2p node (hibernating / quiescing / never
   * participated) — a node only answers for a strand it is actively meshing,
   * regardless of the strand's mode. A `bootstrap`-mode first node still has a
   * live node, so it answers and a later sibling can dial in.
   */
  private getStrandMultiaddrs(strandId: string): string[] {
    const node = this.strandManager.getInstance(strandId)?.libp2pNode;
    if (!node) {
      return [];
    }
    // Every entry is bound to THIS strand node's id, because both consumers — the
    // strand-addr RPC answer and the formation result's `strandAddrs` — are attributed
    // per peer on arrival (`groupAddrsByPeerId`) and an entry naming no destination is
    // dropped there. libp2p already appends the id to its announced addresses, so this
    // is normally a no-op; it is the guard for a bare listen addr and for a relay hop
    // whose trailing `/p2p/` names the RELAY. An addr terminating in a DIFFERENT id is
    // dropped rather than announced — it does not reach this node, and announcing it
    // would file our address under someone else's id in the receiver's address book.
    //
    // Re-parsed through this package's own `multiaddr` rather than passed straight in:
    // libp2p hands back its nested `@multiformats/multiaddr` copy, a structurally
    // different type from the one `withTrailingPeerId` takes (see
    // `backlog/reference-app-web-libp2p-interface-dedup`). Re-parsing a string libp2p
    // itself produced cannot fail.
    const selfId = node.peerId.toString();
    const addrs: string[] = [];
    for (const ma of node.getMultiaddrs()) {
      const bound = this.bindAddrToPeer(multiaddr(ma.toString()), selfId);
      if (bound !== null) {
        addrs.push(bound.toString());
      }
    }
    return orderSignalingFirst(addrs);
  }

  /**
   * Leave a strand joined from another party, for the whole party: remove its party-wide
   * `JoinedStrand` row (owner-signed, with a `Revocation` tombstone), then this machine's
   * unpublished record, its formation-carried addresses, its saved network state and any
   * session-kept entry, then
   * {@link stopStrand} it here. Every other machine's watcher then sees the row gone and
   * detaches the strand, a storage replica included; a machine offline at the time reaps the
   * row once the tombstone reaches it. The joiner's counterpart of {@link unpublishStrand},
   * which only works on a row the party's own `Strand` table holds. For one of those, or for
   * a join still local-only, there is no party-wide row and this is a local forget plus
   * {@link stopStrand}.
   *
   * The other members of the strand are not told, and this party's membership row in the
   * strand stays, so a later re-formation reuses the same identity.
   *
   * @throws when a party-wide row exists and this machine cannot sign its removal (not an
   *   enrolled owner) — {@link stopStrand} stops the strand on this machine only — or when
   *   the party-wide table cannot be read.
   */
  async forgetJoinedStrand(strandId: string): Promise<void> {
    if (!this._running) {
      throw new Error('CadreNode not running');
    }
    await this.joinedStrands!.leave(strandId);
    this.forgetStrandPeers(strandId, 'forgetJoinedStrand');
    await this.stopStrand(strandId);
  }

  /**
   * Record `row` as a join from another party when this party's control database names it
   * neither as its own strand nor as a party-wide join — the one case nothing else would
   * re-offer after a restart (`JoinedStrandSession.rememberForeign`).
   *
   * Best-effort, for {@link addStrand}: a failure costs the strand its re-offer after the
   * next restart, not this attach, so it is reported and the attach goes on.
   * {@link formStrand}, whose join nothing else would name, fails loudly instead.
   *
   * NOTE: "no control row" also describes a row the party has just unpublished. A claim
   * of such a row the app kept from an earlier offer, made after the watcher already
   * withdrew it, is remembered as a join and survives the removal on this machine until
   * {@link forgetJoinedStrand}. Contrived today (a claim of a row the node itself is still
   * offering skips this method); if it shows up, check the strand's `Revocation`
   * tombstone here before recording.
   */
  private async rememberForeignStrand(row: StrandRow): Promise<void> {
    if (!this.joinedStrands || !this.controlDatabase) {
      return;
    }
    try {
      await this.joinedStrands.rememberForeign(row);
    } catch (error) {
      console.warn(`addStrand(${row.Id}): could not remember this strand as joined from another party, ` +
        'so it will not be re-offered after a restart:', error);
    }
  }

  /**
   * Self-revocation arm of the joined-strand records: a party removed from a strand must
   * not re-attach it on every launch of every machine. The strand keeps running this
   * session here — the `strand:revoked` contract is that nothing is torn down for the app —
   * and its party-wide row is queued for removal by the next connected owner reconcile pass
   * (`JoinedStrandSession.forgetAfterThisSession`). A no-op for this party's own strands,
   * which have neither record; the formation-carried addresses and the saved network
   * state are forgotten either way, since a removed party must not keep dialing the
   * strand's peers.
   *
   * NOTE: accepted tradeoff — a sibling machine that has not raised `strand:revoked` itself
   * detaches the strand (`strand:stopped`) when the party-wide removal reaches it, instead
   * of keeping it for the session, which weakens "nothing is stopped on the removed
   * machine's behalf" for siblings. Weighed against a party-wide row that brings a revoked
   * strand back on every start of every machine. Revisit if apps need the "you were
   * removed" screen on every device: the sibling could re-check its own revocation state
   * (`refreshRevocationEnforcement`) before detaching a vanished joined row.
   *
   * NOTE: a manager can re-admit a removed party directly (`addMemberByManager`), and the
   * membership loop then finishes the join on its own — but the records are gone by then,
   * so the next start does not re-attach the strand. Re-forming records it again. If direct
   * re-admission becomes a routine flow, re-record the join when the revoked-peer gate
   * clears for this node.
   */
  private forgetRevokedJoin(strandId: string): void {
    void this.joinedStrands?.forgetAfterThisSession(strandId).catch((error: unknown) => {
      log('forgetting revoked joined strand %s failed; it will be re-offered on the next start: %o',
        strandId, error);
    });
    // The strand's peers go with the join: a removed party must not keep dialing them.
    this.forgetStrandPeers(strandId, 'self-revocation');
  }

  /**
   * Forget what this node holds about a strand's peers: the addresses its formation
   * carried (see {@link formationStrandAddrs}) and its saved network state (see
   * {@link strandNetworkStateStore}). The store write is fire-and-log — the removal is
   * visible synchronously by the store's contract, and a failed persist only leaves the
   * entry on disk for the next start.
   */
  private forgetStrandPeers(strandId: string, caller: string): void {
    this.formationStrandAddrs.delete(strandId);
    void this.strandNetworkStateStore?.forget(strandId).catch((error: unknown) => {
      log('%s: forgetting strand %s network state failed (continuing): %o', caller, strandId, error);
    });
  }

  /**
   * Stop a strand on THIS node only: untrack it from hibernation, drop its sApp config,
   * stop the local instance, and emit `strand:stopped`. The shared `Strand` row is left
   * intact, so on the next node RESTART the strand is rediscovered and surfaces as
   * `strand:discovered` again — but never again in THIS session: the stop suppresses the
   * id in the watcher (`StrandWatcher.suppressStrand`) and drops it from
   * {@link getDiscoveredStrands}, so neither a later poll nor a drain can undo a
   * deliberate stop. Only an explicit {@link addStrand} does, which is the caller
   * reversing its own decision. Party-wide removal is {@link unpublishStrand}. A strand
   * joined from another party comes back the same way, from its remembered join;
   * {@link forgetJoinedStrand} is how to leave one for good.
   */
  async stopStrand(strandId: string): Promise<void> {
    if (!this._running) {
      throw new Error('CadreNode not running');
    }

    // Suppressed HERE and not in detachStrand: the other caller of that method is
    // `handleStrandRemoved`, which arrives precisely because the control row is gone, and
    // a row that later reappears is a fresh strand that should be offered again.
    this.strandWatcher?.suppressStrand(strandId);
    await this.detachStrand(strandId);
  }

  /**
   * Local teardown for one strand, shared by the caller-driven {@link stopStrand} and the
   * watcher-driven `handleStrandRemoved`: untrack hibernation, drop the sApp config and any
   * recorded launch refusal, stop the instance, emit `strand:stopped`. Touches no
   * control-plane row — which side of the removal the node is on is the caller's concern,
   * not this method's.
   *
   * The stop + emit are skipped when the strand manager holds no instance for `strandId` —
   * e.g. a party owner that published a strand's row but never ran it locally, or an
   * explicit {@link stopStrand} for an id this node never started. `hibernationManager`
   * untrack and the `sAppConfigs` / {@link strandLaunchRefusals} / {@link discoveredStrands}
   * deletes stay unconditional (all no-ops when there is nothing to remove), so a launch
   * that failed before an instance was ever tracked still gets its stray entries cleared.
   *
   * Dropping the {@link discoveredStrands} entry here covers both callers, and both
   * readings are the intended one: `handleStrandRemoved` arrives because the control row
   * is gone, and an explicit {@link stopStrand} is a deliberate abandonment — neither
   * strand may be re-offered to a later `getDiscoveredStrands()` drain.
   *
   * The watcher-level suppression that makes a stop permanent is deliberately NOT here,
   * only in {@link stopStrand}: the two callers diverge on it. A vanished control row
   * that reappears is a fresh strand and must be offered again.
   */
  private async detachStrand(strandId: string): Promise<void> {
    this.hibernationManager.untrackStrand(strandId);
    this.sAppConfigs.delete(strandId);
    this.strandLaunchRefusals.delete(strandId);
    this.discoveredStrands.delete(strandId);
    if (!this.strandManager.hasStrand(strandId)) {
      log('detachStrand: strand %s not tracked locally — no-op (no stop, no strand:stopped)', strandId);
      return;
    }
    await this.strandManager.stopStrand(strandId);
    this.emit('strand:stopped', { strandId });
  }

  /**
   * Record activity on a strand (resets hibernation timer).
   *
   * Also drives the server push-wake fan-out: whatever already drives activity on
   * this node's strand (its relay/app layer doing pull-on-read) additionally wakes
   * hibernating mobile peers — the same imperative seam local-wake uses, with no
   * new contract. No-op for the fan-out when push is not configured.
   */
  recordStrandActivity(strandId: string): void {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      this.hibernationManager.recordActivity(instance);
    }
    this.notifyStrandActivity(strandId);
  }

  /**
   * Explicit fan-out trigger: an always-on host/relay/sApp calls this when it
   * observes activity for a strand this node participates in, to wake hibernating
   * mobile members over a direct control-network dial (falling back to FCM/APNs
   * for suspended phones). This is the supported, honest v1 trigger — Optimystic
   * exposes no passive repo-level "new transaction" hook to drive it automatically
   * (see the deferred passive-detector follow-up). No-op when push is not
   * configured; best-effort (never throws — the check-in wake is the backstop).
   *
   * @param strandId - the strand that saw activity.
   * @param reason - free-form cause hint carried in the wake (default `activity`).
   */
  notifyStrandActivity(strandId: string, reason?: string): void {
    void this.pushFanoutService?.notify(strandId, reason);
  }

  /**
   * Force wake a hibernating strand. A requested wake is activity, recorded before the
   * wake starts: a check-in holding the strand — or rebuilding it, a rebuild this wake then
   * joins — leaves it up instead of re-quiescing it at the end of its window. Once awake the
   * strand's idle countdown runs, so it hibernates again if nothing uses it.
   */
  async wakeStrand(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('wakeStrand: strand %s not found; nothing to wake', strandId);
      return;
    }
    instance.lastActivity = new Date();
    await this.hibernationManager.wakeStrand(instance);
  }

  // ============================================================================
  // Mobile background lifecycle primitives
  //
  // Imperative control a mobile BackgroundRunner drives from OS app-state and
  // push events, rather than from the internal idle/hibernate/check-in timers.
  // ============================================================================

  /**
   * Force a single strand to hibernate immediately, bypassing the idle/hibernate
   * timers — the background-entry path. No-op if the strand is realtime
   * (never-hibernate latency hint), already hibernating, or unknown.
   *
   * Routes through {@link HibernationManager.forceHibernate}, which cancels the
   * strand's pending idle/hibernate (and check-in) timers — so a stale timer
   * can't re-fire on or resurrect the strand — then runs the same `onHibernate`
   * path as the timer (`quiesceStrand`, which marks it `hibernating`, then
   * `strand:hibernating`). Unlike the timer path it does NOT re-arm check-ins:
   * the strand stays down until the caller drives a wake (e.g. {@link serviceWake}).
   */
  async hibernateStrand(strandId: string): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('hibernateStrand: strand %s unknown; no-op', strandId);
      return;
    }
    if (!this.hibernationManager.hibernates(instance)) {
      log('hibernateStrand: strand %s is realtime; no-op', strandId);
      return;
    }
    if (instance.status === 'hibernating') {
      log('hibernateStrand: strand %s already hibernating; no-op', strandId);
      return;
    }
    await this.hibernationManager.forceHibernate(instance);
  }

  /**
   * Force-hibernate every tracked strand whose latency hint is not realtime,
   * tolerating per-strand failure (one strand failing to quiesce never aborts
   * the others). Realtime strands are left running — the caller keeps the control
   * connection and realtime strands alive for as long as the OS permits.
   *
   * @returns the strandIds actually hibernated (now in `hibernating` status);
   *   realtime strands are excluded.
   */
  async hibernateAll(): Promise<string[]> {
    const hibernated: string[] = [];
    for (const [strandId, instance] of this.strandManager.getInstances()) {
      if (!this.hibernationManager.hibernates(instance)) {
        log('hibernateAll: skipping realtime strand %s', strandId);
        continue;
      }
      try {
        await this.hibernateStrand(strandId);
        if (instance.status === 'hibernating') {
          hibernated.push(strandId);
        }
      } catch (error) {
        // Collect-and-continue: a single strand's quiesce failure must not strand
        // the rest of the background-entry sweep.
        log('hibernateAll: strand %s failed to hibernate (continuing): %o', strandId, error);
      }
    }
    log('hibernateAll: hibernated %d strand(s)', hibernated.length);
    return hibernated;
  }

  /**
   * On-demand equivalent of a check-in cycle, for a push-delivered wake on
   * mobile: resume the strand, hold it live for `windowMs` so its strand network
   * reaches the cohort and the app can pull pending activity, then re-hibernate
   * if no activity was recorded (else leave it active).
   *
   * Idempotent / coalesced two ways: concurrent `serviceWake`s for the same
   * strand share one in-flight operation ({@link serviceWakePromises}), and the
   * underlying resume coalesces with a racing push-wake via
   * {@link HibernationManager}'s wake coalescing — one runtime build, one window,
   * one re-hibernate decision. A wake or activity from elsewhere that lands during
   * the resume or the window leaves the strand up; this call's own wake does not.
   * Afterwards a strand left up has its idle countdown running, and a re-hibernated one
   * gets back the check-in chain this call interrupted — it never gains one it lacked,
   * so a strand the mobile runner force-hibernated stays down until the next push.
   * Returns `{ serviced: false }` (never throws) when
   * the node is not running or the strand is unknown, and surfaces a wake or
   * window failure as `{ serviced: true, hadActivity: false }`.
   *
   * @param strandId - the strand a push said has pending activity.
   * @param opts.windowMs - override the live-window duration (defaults to the
   *   configured `checkInWindowMs` / {@link DEFAULT_CHECKIN_WINDOW_MS}).
   */
  async serviceWake(strandId: string, opts?: { windowMs?: number }): Promise<ServiceWakeResult> {
    const existing = this.serviceWakePromises.get(strandId);
    if (existing) {
      log('serviceWake: joining in-flight wake for strand %s', strandId);
      return existing;
    }
    const op = this.runServiceWake(strandId, opts);
    this.serviceWakePromises.set(strandId, op);
    try {
      return await op;
    } finally {
      this.serviceWakePromises.delete(strandId);
    }
  }

  /** Body of {@link serviceWake}; serialised per-strand by its coalescing guard. */
  private async runServiceWake(strandId: string, opts?: { windowMs?: number }): Promise<ServiceWakeResult> {
    // Not-running / control-absent guard (mirrors pushWake): a background task
    // must get a branchable result, never a throw.
    if (!this._running || !this.controlNode) {
      log('serviceWake: node not running; not serviced (strand %s)', strandId);
      return { strandId, serviced: false, hadActivity: false };
    }

    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      log('serviceWake: strand %s unknown to this node; not serviced', strandId);
      return { strandId, serviced: false, hadActivity: false };
    }

    // Already live (active or idle — both retain their runtime) or coming up (a launch,
    // or a check-in with its own window): servicing is a no-op success. Do NOT run a
    // window that would re-hibernate a strand the app may be actively using, and do NOT
    // rebuild a second runtime. `'starting'` counts before any handle is attached. A strand
    // being quiesced does not count: the wake below rebuilds it after the quiesce.
    if (!this.strandManager.isQuiescing(strandId)
      && (instance.status === 'starting' || instance.libp2pNode || instance.database)) {
      log('serviceWake: strand %s already live; no-op success', strandId);
      return { strandId, serviced: true, hadActivity: true };
    }

    // Before the resume, as the check-in takes it (see handleStrandCheckIn).
    // NOTE: a `wakeStrand` already resuming when this runs stamped its activity before this
    // mark, so the probe joins it without counting it and the window can re-hibernate a strand
    // that wake asked to keep up; if foreground wakes and serviceWake overlap in practice, mark
    // before the joined wake's stamp instead.
    const activityMark = instance.lastActivity;
    const windowMs = opts?.windowMs ?? this.config.hibernation?.checkInWindowMs ?? DEFAULT_CHECKIN_WINDOW_MS;
    try {
      return await this.wakeAndHoldForService(instance, activityMark, windowMs);
    } finally {
      // After the window (or a failure) decided the state: the idle countdown if the strand
      // stayed up, else the check-in chain this probe interrupted, if any.
      this.hibernationManager.endProbe(instance);
    }
  }

  /**
   * The wake and window of {@link runServiceWake}. A failure in either — the network
   * unreachable inside a Doze grant, say — must not throw out of a background task, so it
   * reports no activity. Each stage cleans up only what it owns.
   */
  private async wakeAndHoldForService(instance: StrandInstance, activityMark: Date, windowMs: number): Promise<ServiceWakeResult> {
    const { strandId } = instance;
    try {
      // Coalesced resume: HibernationManager.beginWake, so a racing push-wake shares this
      // single runtime build. Not through `wakeStrand`, which records the wake as activity:
      // this probe's own wake must not count as a reason to stay up.
      await this.hibernationManager.probeWake(instance);
    } catch (error) {
      // handleStrandWake has already re-hibernated a failed rebuild, and left alone a strand
      // it failed before building, which may be a check-in's.
      log('serviceWake: wake of strand %s failed: %o', strandId, error);
      return { strandId, serviced: true, hadActivity: false };
    }
    try {
      const hadActivity = await this.runWakeWindow(instance, activityMark, windowMs);
      return { strandId, serviced: true, hadActivity };
    } catch (error) {
      log('serviceWake: strand %s failed during wake window; re-hibernating: %o', strandId, error);
      await this.rehibernateAfterFailedResume(instance, 'serviceWake');
      return { strandId, serviced: true, hadActivity: false };
    }
  }

  /**
   * Get the control network node (for advanced use)
   */
  getControlNode(): Libp2p | null {
    return this.controlNode;
  }

  /**
   * The boot-path half of {@link reserveRelays}: reserve through every
   * `network.relayAddrs` entry, or fail `start()`.
   *
   * WHY IT RUNS HERE, AT THE END. `network.relayAddrs` used to resolve to a
   * CONFIGURED circuit listener, which libp2p dials from inside `libp2p.start()`
   * — so the relay was already a connected peer, and therefore already in this
   * node's Optimystic cohort, before `ControlDatabase.initialize()` ran. Building
   * that database is a long chain of cohort-consulting block probes (catalog
   * hydration, then one per table, then the indexes), and a sibling that has not
   * yet replicated this node's `CadrePeer` row correctly refuses every one of
   * them, so bring-up died on `BlockUnavailableError` — deterministically, on
   * every boot of a relay-only node. Retrying could not converge either: the
   * condition that clears the refusal is this node's own row reaching the
   * sibling, and writing that row needs the database the retry is building.
   *
   * So the invariant is ordering, not retrying: the control database is built
   * while this node holds ZERO control connections (a cohort of one, entirely
   * local), and only then does it reach out. Everything above in {@link start}
   * has completed by the time this runs.
   *
   * BUDGET: the supervisor's first attempt is what `start()` waits on — deliberately the drive's
   * ordinary deadline rather than a boot-specific one. That deadline is now COUNTED, four link
   * round trips at the declared `network.linkRoundTripMs` plus the relay's two admission
   * decisions (18 s at its default, where it was a fixed 10 s): a healthy dial-plus-reserve is sub-second even over a WAN, so this is slack for
   * a slow link, while going much longer would make a dead relay indistinguishable from a hung
   * start and much shorter would fail nodes on links that were merely slow. A host that declares
   * a slower link lengthens it without touching this path — `link-budget.ts`. The retries carry
   * on in the background after this resolves, exactly as they do for a {@link reserveRelays}
   * caller.
   *
   * `network.requireRelay === false` softens only the outcome below: a first
   * attempt that lands no `/p2p-circuit` address is logged instead of thrown, and
   * `start()` carries on with the retry supervisor already running in the
   * background (the same supervisor {@link reserveRelays} always starts).
   */
  private async driveControlRelayReservation(): Promise<void> {
    const relayAddrs = this.config.network?.relayAddrs ?? [];
    if (relayAddrs.length === 0) {
      return;
    }
    const t0 = performance.now();
    const state = await this.reserveRelays([...relayAddrs]);
    timing('[start] reserveRelays: %dms', Math.round(performance.now() - t0));
    if (state.status !== 'reserved') {
      if (this.config.network?.requireRelay === false) {
        log('Relay reservation did not land on the first attempt (status: %s); ' +
          'continuing without it because network.requireRelay is false: %o', state.status, state);
        return;
      }
      throw new RelayReservationFailedError(relayAddrs, state);
    }
    log('Reserved a relay slot: %o', state.circuitAddrs);
  }

  /**
   * Start keeping a relay reservation: dial the given relay(s) from the control
   * node, ask the first one that answers for a reservation slot, wait until the
   * resulting `/p2p-circuit` address makes this node dialable — and keep a
   * supervisor running that re-drives whenever the reservation is later lost.
   *
   * The FAIL-SOFT entry point, for a caller that discovers its relay at runtime
   * (a browser tab, a host UI). A node that names `network.relayAddrs` gets the
   * same drive from {@link driveControlRelayReservation} at the end of
   * {@link start}, which is fail-fast instead. Both fill the pending reservation
   * the bare `/p2p-circuit` search listener registered; calling this afterwards
   * simply replaces the supervisor with one over the new list.
   *
   * Resolves once the FIRST attempt has settled, exactly as it did when it drove
   * once; the retries continue in the background until {@link stop} or the next
   * `reserveRelays` call. Fail-soft — never throws. An unreachable relay, a
   * missing control node, or a timeout all resolve to a non-`reserved` status, so
   * a caller can await this during startup without a dead relay aborting the node.
   *
   * Passing an empty list stops the supervisor and resets the posture to `none`
   * without dialing or waiting.
   */
  async reserveRelays(
    addrs: string[],
    opts?: RelayReservationSupervisorOptions
  ): Promise<RelayReservationState> {
    // Stop first, unconditionally: a second call with a different list must not
    // leave two loops fighting over one pending reservation slot.
    this.relayReserveSupervisor?.stop();
    this.relayReserveSupervisor = null;
    this.relayReserveAddrs = [...addrs];
    this.relayReserveError = null;
    if (addrs.length === 0) {
      return this.getRelayReservationState();
    }
    if (!this.controlNode) {
      // No node to supervise, so this is the one failure the node records itself.
      this.relayReserveError = 'control node unavailable';
      return this.getRelayReservationState();
    }
    // The drive's deadline is counted in link round trips (`link-budget.ts`), so a host that
    // declared a slower link gets a longer drive without naming a number here. A caller's own
    // `timeoutMs` still wins.
    const supervisor = superviseRelayReservation(this.controlNode, addrs, {
      timeoutMs: relayReservationBudgetMs(this.config.network?.linkRoundTripMs),
      ...opts
    });
    this.relayReserveSupervisor = supervisor;
    await supervisor.firstAttempt;
    // Read through `this`, not `supervisor`: an overlapping call may have replaced
    // it while the first attempt was in flight, and the newest list is the truth.
    return this.getRelayReservationState();
  }

  /**
   * The node's CURRENT relay-reservation posture, recomputed from the control
   * node's live multiaddrs on every call.
   *
   * Deliberately not memoised: a reservation can be lost after
   * {@link reserveRelays} succeeds (the relay restarts, the connection drops) and
   * a cached `reserved` would let a caller mint invitations carrying circuit
   * addresses that no longer route.
   *
   * A lost reservation now recovers on its own — the supervisor {@link reserveRelays}
   * starts re-drives on a backoff, reporting `retrying` meanwhile. `error` here
   * means nothing is going to try again: no supervisor, or no control node.
   */
  getRelayReservationState(): RelayReservationState {
    const supervisor = this.relayReserveSupervisor;
    return resolveRelayReservationState(
      this.controlNode,
      this.relayReserveAddrs,
      supervisor ? supervisor.lastError : this.relayReserveError,
      supervisor?.driving ?? false,
      supervisor?.retryAtMs ?? null
    );
  }

  /**
   * Get the control database (for advanced queries)
   */
  getControlDatabase(): ControlDatabase | null {
    return this.controlDatabase;
  }

  /**
   * Open control-network connections right now. A lower-bound proxy for replication
   * reach: 0 connections ⇒ a control write commits local-only. The private
   * `committedAlone` write-while-alone seam is defined in terms of this.
   *
   * It approximates the precise signal (the block's cluster size), and a caller that
   * samples it AFTER a write samples a slightly wider window than `committedAlone`
   * does inside the write itself. It exists so an embedder can warn an owner before a
   * control write that this machine currently sees none of its siblings, and report
   * after one that the write may not have travelled — a warning shown unconditionally
   * is a warning people learn to ignore.
   */
  getControlConnectionCount(): number {
    return this.controlNode?.getConnections().length ?? 0;
  }

  /**
   * Force a poll of the strand watcher (for testing)
   */
  async forceStrandPoll(): Promise<void> {
    await this.strandWatcher?.forcePoll();
  }

  /**
   * Get the sApp configuration for a strand
   */
  getSAppConfig(strandId: string): SAppConfig | undefined {
    return this.sAppConfigs.get(strandId);
  }

  // ============================================================================
  // Seed Bootstrap API
  // ============================================================================

  /**
   * Initialize the seed bootstrap service with an owner key.
   * Must be called before using seed-related methods that require signing.
   *
   * @param ownerPrivateKey - The owner's private key (base64url encoded)
   */
  async initializeSeedBootstrap(ownerPrivateKey: string): Promise<void> {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before initializing seed bootstrap');
    }

    // A node wiring seed-bootstrap with an owner PRIVATE key is declaring that
    // key an authority of its own party (founder genesis / self-signing owner)
    // — anchor it in the node-local store. The in-memory set updates
    // synchronously (see TrustedOwnerStore.trust); only the file persist is
    // fire-and-forget, logged on failure.
    // NOTE: non-founder members that also wire seed-bootstrap with their own
    // derived key (e.g. the phone joiner path in runOwnerGenesis, which needs
    // it to self-publish its CadrePeer row) self-anchor a key that is not a
    // party authority. Harmless while such a node never mints an invite: the
    // store does not replicate, so a node trusting itself grants nothing to
    // others. But `createCadreInvitation` hands out the anchor's contents as the
    // device's pins, so the moment a non-founder member mints an
    // invitation it exports its own non-authority key as a cadre owner key. If that
    // becomes reachable (today only cadre-cli/cadre-host owners mint invitations),
    // gate this self-anchor on the actual OwnerKey genesis insert instead.
    if (this.trustedOwnerStore) {
      void this.trustedOwnerStore
        .trust(ed25519PublicKeyFromPrivate(ownerPrivateKey), 'genesis')
        .catch((error) => log('Trusted-owner genesis anchor persist failed: %o', error));
    }

    await this.installSeedBootstrapService(new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      ownerPrivateKey,
      ...this.seedServiceBudgets(),
      trustPolicy: this.config.seedTrustPolicy,
      // Seed trust anchors on the node-local store (seeded just above with this
      // node's own genesis key), never on the replicated OwnerKey table.
      ...(this.trustedOwnerStore ? { trustedOwners: this.trustedOwnerStore } : {}),
    }), this.controlNode, this.controlDatabase);
    log('Seed bootstrap service initialized');
    // Embedders wire the owner key after start(), so the runner's first pass usually found
    // this machine not yet an owner; without this it would wait a full poll interval.
    this.pendingJoinRunner?.kick();
  }

  /**
   * Push the multiaddrs that future invites should advertise. Pass `null` to
   * revert to the libp2p-reported addresses (the default). The host calls this
   * at spawn and on every NAT change.
   *
   * Entries need NOT carry a `/p2p/<peerId>` suffix — {@link resolveInviteAddresses}
   * appends this node's own before anything publishes or dials them (see
   * {@link normalizeSelfAddrs}). Passing them suffixed is equally fine.
   */
  setInviteAddresses(addresses: string[] | null): void {
    this.latestInviteAddresses = addresses;
    log('Invite addresses updated: %s', addresses ? `${addresses.length} pushed` : 'cleared (libp2p fallback)');
  }

  /**
   * Resolve the addresses to embed in invites. Prefers pushed addresses, then
   * any config-supplied resolver, then the libp2p-observed multiaddrs. The two
   * app-supplied sources are normalized onto `/p2p/<self>` (see
   * {@link normalizeSelfAddrs}) so neither hook has to remember the suffix;
   * libp2p's own addresses already carry it.
   */
  private async resolveInviteAddresses(): Promise<string[]> {
    if (this.latestInviteAddresses !== null) {
      return this.normalizeSelfAddrs(this.latestInviteAddresses);
    }
    if (this.config.network?.inviteAddressResolver) {
      return this.normalizeSelfAddrs(await this.config.network.inviteAddressResolver());
    }
    // Not normalized: this branch is libp2p's own output, which already
    // encapsulates the peer id into every address it reports. Only the two app
    // hooks above take arbitrary strings and therefore need the guarantee.
    return this.getMultiaddrs();
  }

  /**
   * Normalize addresses an app handed us for THIS node onto `/p2p/<self>`, the
   * same invariant {@link normalizeDialAddrs} enforces on the way out.
   *
   * `setInviteAddresses` (the admin API `PUT /admin/invite-addresses`) and
   * `network.inviteAddressResolver` both take arbitrary strings, and whatever
   * they return ends up in this node's published `CadrePeer` record — so ONE
   * unsuffixed entry from either hook is enough to give every sibling in the
   * party a mixed candidate list for this peer. Establishing the suffix here,
   * where those strings enter the system, means neither hook has to know the
   * rule; `cadre-host`'s `buildInviteAddresses` already appends it, and
   * re-normalizing an already-suffixed address is a no-op.
   *
   * Unparsable and other-peer-addressed entries are passed through untouched
   * rather than dropped: publication is not the place to police an address's
   * validity, and {@link resolvePeerAddrs} already drops both on the read side.
   * Before `start()` resolves an identity there is no peer id to append, so the
   * list is returned as given.
   */
  private normalizeSelfAddrs(addrs: string[]): string[] {
    const selfPeerId = this.peerId?.toString();
    if (!selfPeerId) {
      return addrs;
    }
    return addrs.map((addr) => {
      let parsed: Multiaddr;
      try {
        parsed = multiaddr(addr);
      } catch (error) {
        log('normalizeSelfAddrs: leaving unparsable multiaddr %s as-is: %o', addr, error);
        return addr;
      }
      return withTrailingPeerId(parsed, selfPeerId)?.toString() ?? addr;
    });
  }

  /**
   * Enumerate the cadre's `CadrePeer` membership — the ADDRESSABLE surface (see
   * {@link isMember}). Rows whose stamp is retired in `CadreControl.Revocation`
   * never reach here: {@link ControlDatabase.queryCadrePeers} excludes them, so a
   * revoked peer is not addressable either.
   */
  async listMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before listing members');
    }
    return this.controlDatabase.queryCadrePeers();
  }

  /**
   * Probe whether a given peer is a `CadrePeer` member.
   *
   * This is the ADDRESSABLE surface ("do I have a dialable address record for this
   * peer") — it includes this node's own self-published row. Address resolution and
   * push fan-out use this. A peer whose stamp is retired in `CadreControl.Revocation`
   * is excluded here too (the filter lives in
   * {@link ControlDatabase.queryCadrePeers}): revocation removes a peer from the
   * addressable surface, not only the trust-facing one, so a revoked peer is no
   * longer dialed, RPC'd, or handed out as an address. The trust-facing gate is
   * {@link isAuthorizedMember}.
   */
  async isMember(peerId: string): Promise<boolean> {
    const members = await this.listMembers();
    return members.some(m => m.peerId === peerId);
  }

  /**
   * Enumerate the party's AUTHORIZED members — the trust-facing set, distinct from
   * the addressable set ({@link listMembers}). A peer is authorized iff ALL hold:
   *
   *  1. it is not this node itself — a node publishes its own `CadrePeer` address
   *     row so its dialable address rides in seeds, but "self" is not a peer this
   *     node authorized;
   *  2. its `CadrePeer` row carries a complete proof: EITHER an owner voucher
   *     (`StampId`, `VouchOwner`, `VouchSig` all non-null) OR an invitation admission
   *     (`VouchSig` null, `VouchUsage` naming a `CadreInviteUsage` row);
   *  3. `VouchOwner` is in the NODE-LOCAL trusted-owner anchor
   *     ({@link getTrustedOwnerStore}) — never the replicated `OwnerKey` table,
   *     which any stranger can genesis-pollute; and
   *  4. the proof verifies: for a voucher, `VouchSig` is that owner's signature over
   *     the row's voucher digest ({@link verifyCadrePeerVoucher}), so the anchored
   *     owner really vouched THIS peer id under THIS row's nonce; for an admission,
   *     the chain row → usage → invitation → anchored issuer verifies link by link
   *     ({@link verifyInvitationAdmission} — the issuer is `VouchOwner`, the invitation's
   *     own owner signature, the holder's and the device's signatures, and the stored
   *     peer key really is the key behind the peer id); and
   *  5. the row's `StampId` is NOT retired in `CadreControl.Revocation` — enforced
   *     upstream in {@link ControlDatabase.queryCadrePeers}, which drops retired rows
   *     before ANY reader (this predicate included) sees them, so a row resurrected
   *     by replaying the captured admission approval on a node that had not yet
   *     converged on the tombstone (the write-time `NotRevoked` CHECK only sees
   *     local rows) is still inert to every reader that has the tombstone.
   *
   * Fail-closed at every step: a missing anchor (pre-start), an empty anchor (a
   * not-yet-enrolled node authorizes no one), a null/partial proof, an
   * unanchored `VouchOwner`, a bad signature, or a usage or invitation row this node
   * does not hold all yield "not authorized" — having an address row is NOT
   * membership. The control-network wake and strand-address gates consult this set,
   * NOT the addressable one.
   *
   * The usage and invitation tables are read only when at least one row needs them,
   * so a cadre with no invitation-admitted member stays at one read per call.
   *
   * NOTE (rotation): if a party owner rotates keys and only the NEW key is pinned
   * in the anchor, rows the OLD key vouched fail check 3 until re-vouched — a
   * legit member goes un-authorized on readers that only pin the new key. Full
   * rotation handling (re-vouch on rotate) is the
   * `flip-strand-membership-rotation-known-gap` work, not this predicate's.
   *
   * @param retry - Whether the underlying membership reads may retry a transient cluster
   *   failure. Only {@link refreshAuthorizedControlPeers} passes `false`, because it runs
   *   as the control database's membership listener with that database's write lock held;
   *   see its comment.
   */
  async listAuthorizedMembers(retry = true): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before listing members');
    }
    const selfPeerId = this.peerId?.toString();
    const rows = await this.controlDatabase.queryCadrePeers(retry);
    const chain = rows.some(isInvitationAdmitted)
      ? await this.loadInvitationChain(this.controlDatabase, retry)
      : null;
    const authorized = rows
      .filter(row => row.peerId !== selfPeerId && this.hasAnchoredProof(row, chain))
      .map(({ peerId, multiaddr }) => ({ peerId, multiaddr }));
    // A node whose anchor was never seeded (no invite pin, no operator pin, not a
    // founder) refuses every wake and strand-addr request, which from the outside
    // looks like an unexplained "non-member" rejection. Say so once per call rather
    // than leaving the operator to infer it from silence.
    if (authorized.length === 0 && rows.length > 0 && (this.trustedOwnerStore?.all().size ?? 0) === 0) {
      log('listAuthorizedMembers: %d CadrePeer row(s) but the node-local trusted-owner anchor is EMPTY — authorizing no one (this node has no invite/operator owner-key pin)', rows.length);
    }
    return authorized;
  }

  /**
   * Checks 2–4 of the authorized-membership predicate (see
   * {@link listAuthorizedMembers}) for one `CadrePeer` row, by the kind of proof it
   * carries: an owner voucher ({@link hasAnchoredVoucher}) or an invitation admission
   * ({@link verifyInvitationAdmission} over the usage and invitation rows in `chain`,
   * loaded only when some row needs them). A row with a `VouchSig` is judged as a
   * voucher even if it also names a usage — the signature is the stronger proof and the
   * one an owner re-vouch leaves behind.
   */
  private hasAnchoredProof(row: CadrePeerVoucherFields, chain: InvitationChain | null): boolean {
    if (!isInvitationAdmitted(row)) {
      return this.hasAnchoredVoucher(row);
    }
    const usage = chain?.usages.get(row.vouchUsage!);
    const invite = usage === undefined ? undefined : chain?.invites.get(usage.inviteKey);
    if (usage === undefined || invite === undefined) {
      return false;
    }
    return verifyInvitationAdmission(row, usage, invite, key => this.trustedOwnerStore?.has(key) ?? false);
  }

  /**
   * The usage and invitation rows {@link hasAnchoredProof} resolves an invitation-admitted
   * row through, keyed for lookup. Both reads honour `retry` for
   * {@link listAuthorizedMembers}' reason.
   *
   * NOTE: once invitations are the only admission route (ticket
   * `cadre-invitations-redeemable-by-any-member`), every cadre with a member not yet
   * re-vouched pays these two whole-table reads and three ed25519 verifies per row on every
   * membership refresh. Both tables are append-only and a verified chain never changes (expiry,
   * use count and withdrawal are not re-checked), so if the gate's admission deadline ever
   * shows this, memoise verified (row stamp → usage stamp) pairs per node and skip the reads
   * when every admitted row is already memoised.
   */
  private async loadInvitationChain(controlDatabase: ControlDatabase, retry: boolean): Promise<InvitationChain> {
    const [usages, invites] = await Promise.all([
      controlDatabase.queryCadreInviteUsages(retry),
      controlDatabase.queryCadreInvites(retry),
    ]);
    return {
      usages: new Map(usages.map(usage => [usage.usageStampId, usage])),
      invites: new Map(invites.map(invite => [invite.key, invite])),
    };
  }

  /**
   * The owner-voucher half of {@link hasAnchoredProof}: complete voucher, `VouchOwner` in
   * the node-local anchor, signature valid over the row's (PeerId, StampId) voucher digest.
   *
   * NOTE: verifies the ed25519 signature on every call (no memo of already-
   * verified (peerId, stampId, vouchSig) triples). Cadres are a handful of
   * devices and the gates run per inbound request, so this is cheap today; if
   * membership or gate traffic ever grows, cache verified triples keyed on the
   * row's `StampId` (which rotates with every re-vouch).
   */
  private hasAnchoredVoucher(row: CadrePeerVoucherFields): boolean {
    if (row.stampId === null || row.vouchOwner === null || row.vouchSig === null) {
      return false;
    }
    if (!this.trustedOwnerStore?.has(row.vouchOwner)) {
      return false;
    }
    return verifyCadrePeerVoucher(row.peerId, row.stampId, row.vouchOwner, row.vouchSig);
  }

  /**
   * Probe whether a given peer is an AUTHORIZED party member (see
   * {@link listAuthorizedMembers}) — the gate the control-network wake and
   * strand-address responders consult, NOT {@link isMember} (the addressable
   * surface). Deliberately scans the full membership (one `CadrePeer` query)
   * rather than adding a single-row read path: cadres are small, and one code
   * path keeps the predicate impossible to drift from the list.
   */
  async isAuthorizedMember(peerId: string): Promise<boolean> {
    const members = await this.listAuthorizedMembers();
    return members.some(m => m.peerId === peerId);
  }

  /**
   * Push-wake a hibernating cadre peer over the control network.
   *
   * Resolves the target's signed control-network address from its `CadrePeer`
   * record (via {@link resolvePeerAddrs}, signaling/relay first — so a NAT'd peer
   * is reachable through its circuit-relay address), dials `WAKE_PROTOCOL`, sends
   * the {@link WakeRequest}, and returns the peer's {@link WakeAck}. The receiver
   * gates the request on cadre membership and only resumes a strand it already
   * participates in; it acks once it has decided, before the strand is up. The
   * dial deadlines derive from this node's `network.linkRoundTripMs`.
   *
   * @param targetPeerId - The hibernating cadre peer to wake.
   * @param strandId - The strand the caller knows has pending activity.
   * @param reason - Optional cause hint, e.g. `"activity"` or `"manual"`.
   * @throws if the node is not started or the target has no dialable address.
   */
  async pushWake(targetPeerId: string, strandId: string, reason?: string): Promise<WakeAck> {
    if (!this.controlNode) {
      throw new Error('CadreNode must be started before pushing wakes');
    }
    const addrs = await this.resolvePeerAddrs(targetPeerId);
    if (addrs.length === 0) {
      throw new Error(`No dialable control-network address for peer ${targetPeerId}`);
    }
    const request: WakeRequest = { strandId, reason };
    return await dialWake(this.controlNode, addrs, request, { linkRoundTripMs: this.config.network?.linkRoundTripMs });
  }

  /**
   * Enable the seed listener for receiving seeds via the /sereus/seed/1.0.0 protocol.
   * This is for drone nodes that need to receive seeds without being an owner.
   * Does not require an owner key.
   */
  async enableSeedListener(): Promise<void> {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error('CadreNode must be started before enabling seed listener');
    }

    // Don't re-initialize if already has a service
    if (this.seedBootstrapService) {
      log('Seed bootstrap service already initialized');
      return;
    }

    await this.installSeedBootstrapService(new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      // No owner key - this node only receives seeds
      ...this.seedServiceBudgets(),
      trustPolicy: this.config.seedTrustPolicy,
      // A listener-only node accepts a wire-delivered seed solely against this
      // anchor (there is no per-call override on the inbound handler): with no
      // genesis/invite/operator pin it authorizes nobody, which is the point.
      ...(this.trustedOwnerStore ? { trustedOwners: this.trustedOwnerStore } : {}),
    }), this.controlNode, this.controlDatabase);
    log('Seed listener enabled');
  }

  /**
   * Get the seed bootstrap service (for advanced use)
   */
  getSeedBootstrapService(): SeedBootstrapService | null {
    return this.seedBootstrapService;
  }

  /**
   * Make `service` this node's seed service and register its inbound seed handler.
   * The field is set before the registration is awaited, so a concurrent
   * {@link enableSeedListener} finds it and does not register a second handler; a
   * failed registration puts the previous service back and rethrows.
   *
   * NOTE: libp2p's registrar stores the handler before its peer-store merge, so a
   * failed merge leaves SEED_PROTOCOL registered with no service owning it and a retry
   * here rejects as a duplicate; if peer-store writes can fail in practice, unhandle on
   * a non-duplicate failure (never on a duplicate — that handler belongs to someone else).
   */
  private async installSeedBootstrapService(
    service: SeedBootstrapService,
    controlNode: Libp2p,
    controlDatabase: ControlDatabase
  ): Promise<void> {
    service.setEventCallbacks(this.seedEventCallbacks());
    const previous = this.seedBootstrapService;
    this.seedBootstrapService = service;
    try {
      await service.initialize(controlNode, controlDatabase);
    } catch (error) {
      if (this.seedBootstrapService === service) this.seedBootstrapService = previous;
      throw error;
    }
  }

  /**
   * The event callbacks every {@link SeedBootstrapService} this node owns is
   * wired with — shared by the owner-capable service ({@link initializeSeedBootstrap})
   * and the listener-only one ({@link enableSeedListener}) so the two cannot drift.
   *
   * A seed applied by the INBOUND protocol handler writes no `CadrePeer` row of
   * its own (it merges the libp2p peer store and dials owners), so the automatic
   * write-driven refresh never fires for it — yet applying it can ANCHOR a new
   * owner key, which flips rows already present from unauthorized to authorized.
   * Hence the explicit refresh here; without it a peer the freshly anchored owner
   * vouched for stays denied until the next timed cohort reconcile.
   */
  private seedEventCallbacks(): SeedEventCallbacks {
    return {
      onSeedReceived: (partyId, peerId) => this.emit('seed:received', { partyId, peerId }),
      onSeedApplied: (partyId, peersAdded, seed) => {
        this.emit('seed:applied', { partyId, peersAdded });
        // A wire-delivered seed never passes through the `applySeed` wrapper, so
        // this is where its owner peers become cold-start bootstrap targets.
        this.recordSeedBootstrapPeers(seed);
        void this.refreshMembershipGate('seed-applied');
      },
      onSeedError: (partyId, error) => this.emit('seed:error', { partyId, error }),
    };
  }

  /**
   * Re-materialize the authorized-peer snapshot that the fail-closed per-stream
   * control-DB gate ({@link authorizeInboundControlStream}) judges against.
   *
   * NO `CadrePeer` writer needs to call this: the control database notifies it
   * after every committed member-row write (`ControlDatabase.mutateCadrePeer`,
   * wired in {@link start}), which is exactly what makes the refresh automatic
   * rather than a caller obligation. It stays public for the changes that write
   * NO row locally and so raise no notification:
   *
   * - a membership row that arrived by REPLICATION (otherwise picked up on the
   *   next timed cohort reconcile — bounded staleness by design), and
   * - a newly anchored trusted owner key ({@link applySeed}), which flips rows
   *   ALREADY present from unauthorized to authorized without touching them.
   *
   * Coalescing: marks the snapshot stale and resolves once a refresh that began
   * after this call has completed, so a caller that awaits it always observes
   * its own change. Concurrent callers share one read. Idempotent and
   * best-effort (a failed read keeps the previous snapshot); never rejects.
   */
  async refreshMembershipGate(reason = 'external-write'): Promise<void> {
    this.membershipGateDirty = true;
    if (this.membershipGateDeferDepth > 0) {
      // Flushed once when the enclosing scope exits.
      return;
    }
    while (this.membershipGateDirty) {
      // Re-checked after the await: the drain may have taken its last look at
      // the flag before we set it, in which case we need a fresh one.
      this.membershipGateDrain ??= this.drainMembershipGate(reason);
      await this.membershipGateDrain;
    }
  }

  /**
   * Re-materialize a CLOSED strand's revoked-peer deny set now, and hang up any
   * connected peer it newly covers — the strand-side counterpart to
   * {@link refreshMembershipGate}.
   *
   * Unlike that one, NOTHING calls this automatically: strand membership is
   * written through the strand's own `Database` handle
   * (`strand-membership-writer.ts`), which raises no notification this runtime
   * can hook, and a revocation that arrives by REPLICATION raises none either.
   * The gate therefore polls (default 30 s). An app that has just called
   * `revokeMember` or `leaveStrand` should follow the write with this call so
   * the cut is immediate rather than up to one poll interval late.
   *
   * Quiet no-op for a strand that is not running, is quiesced, is open, or has
   * the gate disabled. Never rejects; resolves once the sweep has finished.
   */
  async refreshRevocationEnforcement(strandId: string): Promise<void> {
    await this.strandManager.refreshRevocationEnforcement(strandId);
  }

  /**
   * The single in-flight refresh loop behind {@link refreshMembershipGate}: read
   * until the stale flag stays clear, then release the slot.
   *
   * NOTE: correct only because {@link membershipGateDirty} is guaranteed TRUE at
   * entry — its sole caller sets it synchronously, with no await in between. Were
   * this ever invoked with the flag already clear, the body would never suspend,
   * so the `finally` would null the slot BEFORE the caller's `??=` filled it, and
   * the slot would be left holding an already-settled drain that every later
   * refresh reuses — an unbreakable await/re-check spin. If a second caller is
   * ever added, have it mark the flag first (or assert it here).
   */
  private async drainMembershipGate(reason: string): Promise<void> {
    try {
      while (this.membershipGateDirty) {
        // Cleared BEFORE the read (not after) so a write landing mid-read marks
        // the snapshot stale again and earns another pass, and so a throw still
        // terminates the loop.
        this.membershipGateDirty = false;
        await this.refreshAuthorizedControlPeers(reason);
      }
    } catch (error) {
      // Upholds `refreshMembershipGate`'s never-rejects contract. The read helper
      // already swallows its own failures, so this is defensive — but a rejection
      // here would otherwise surface out of every awaiting writer.
      log('membership gate drain (%s) failed — keeping previous snapshot: %o', reason, error);
    } finally {
      this.membershipGateDrain = null;
    }
  }

  /**
   * Collapse a burst of `CadrePeer` writes into ONE gate refresh at scope exit.
   *
   * For loops that re-touch many rows (the write-while-alone drains), where a
   * per-row refresh would mean one full membership read per row for a snapshot
   * that only has to be correct once the loop settles.
   *
   * The depth counter is instance-level, so it also suppresses a genuinely
   * CONCURRENT external write's refresh for the life of the scope: that writer's
   * promise resolves before its peer is admitted, and admission lands at scope
   * exit instead. Acceptable — scope exit is milliseconds away (bounded by the
   * drain), versus the ~15 s reconcile interval that was the alternative before
   * any of this existed — but it is the reason these scopes stay short and rare.
   */
  private async deferMembershipGateRefresh<T>(reason: string, body: () => Promise<T>): Promise<T> {
    this.membershipGateDeferDepth++;
    try {
      return await body();
    } finally {
      this.membershipGateDeferDepth--;
      if (this.membershipGateDeferDepth === 0 && this.membershipGateDirty) {
        await this.refreshMembershipGate(reason);
      }
    }
  }

  /**
   * Authorize a new peer to join the cadre.
   * Signs the peer ID with the owner key and inserts into CadrePeer table.
   *
   * @param peerId - The peer ID to authorize
   * @param multiaddrs - Optional multiaddrs for the peer
   */
  async authorizePeer(peerId: string, multiaddrs?: string[]): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    // The insert notifies the control DB's membership hub, so the per-stream gate
    // has already admitted the just-vouched peer by the time this resolves.
    await this.seedBootstrapService.authorizePeer({ peerId, multiaddrs });
    // Queue for re-replication if this committed local-only (no connected cohort).
    this.noteControlWrite(peerId, 'authorize');
    // NOTE: unlike addDrone, `multiaddrs` is not retained as a dial target: the
    // flows that vouch through here have the new peer reach this node (it applies a
    // seed naming the owners, or it dialed in with an invite). If one ever vouches a
    // peer that cannot reach this node, retain its addresses as addDrone does.
  }

  /**
   * Remove a previously-authorized peer from the cadre.
   * Signs the peer ID with the owner key and deletes the CadrePeer row.
   *
   * @param peerId - The peer ID to remove
   */
  async removePeer(peerId: string): Promise<void> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    // The delete notifies the membership hub, so the removed peer is out of the
    // per-stream gate by the time this resolves.
    await this.seedBootstrapService.removePeer(peerId);
    // Track + loudly flag a delete that committed local-only (security-relevant).
    this.noteControlWrite(peerId, 'remove');
    // A removed peer is no longer a dial target, however this node learned its
    // address. Gone from the store synchronously; a persist failure only lets the
    // entry reappear after a restart, so it is logged rather than failing a
    // removal that has already committed.
    void this.bootstrapPeerStore?.forget(peerId).catch((error: unknown) => {
      log('removePeer: persisting the removal of dial target %s failed (forgotten in memory): %o', peerId, error);
    });
  }

  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an owner.
   */
  async createSeed(): Promise<ControlNetworkSeed> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.createSeed();
  }

  /**
   * Apply a seed to populate the peer cache and enable connections.
   *
   * Validates the seed signature, then evaluates a trust anchor for the signer
   * key (see `SeedTrustPolicy`). An operator-driven caller can pass a per-seed
   * `trustPolicy` override — e.g. a `pinnedKeyTrustPolicy` built from a pinned
   * owner key — so a cold-start node can accept its first seed without
   * reconfiguring the service.
   */
  async applySeed(
    seed: ControlNetworkSeed,
    options?: { trustPolicy?: SeedTrustPolicy }
  ): Promise<ApplySeedResult> {
    if (!this.seedBootstrapService) {
      // Create a temporary service for applying seeds (doesn't need owner key).
      // partyId is the attacker-influenced seed.partyId — it only labels logs; the
      // trust decision rests solely on signerKey vs the anchor set (configured
      // default below, or the per-call options.trustPolicy override).
      //
      // This temp service is discarded after the call, so it must NOT own the shared
      // node's inbound seed handler: pass { registerHandler: false }. That keeps
      // repeated service-less applySeed idempotent (no handler leak, no
      // DuplicateProtocolHandlerError). The temp service still applies this seed; a
      // node that wants to RECEIVE inbound seeds needs a persistent service
      // (enableSeedListener / initializeSeedBootstrap) to own the handler.
      const tempService = new SeedBootstrapService({
        partyId: seed.partyId,
        trustPolicy: this.config.seedTrustPolicy,
        ...this.seedServiceBudgets(),
        // The anchor is node-scoped, not service-scoped: a throwaway service
        // must consult (and persist an accepted signer into) the SAME store the
        // persistent one would, or a cold-start enrollment via this path would
        // anchor nothing and re-prompt for the pin on every later seed.
        ...(this.trustedOwnerStore ? { trustedOwners: this.trustedOwnerStore } : {}),
      });
      if (this.controlNode && this.controlDatabase) {
        await tempService.initialize(this.controlNode, this.controlDatabase, { registerHandler: false });
      }
      const tempResult = await tempService.applySeed(seed, options);
      this.noteAppliedSeed(tempResult, seed);
      // Not a row write (so nothing notifies): applying a seed can anchor a new
      // owner key, which flips rows ALREADY present into the authorized set.
      await this.refreshMembershipGate('applySeed');
      return tempResult;
    }
    const result = await this.seedBootstrapService.applySeed(seed, options);
    this.noteAppliedSeed(result, seed);
    await this.refreshMembershipGate('applySeed');
    return result;
  }

  /**
   * Post-process an {@link applySeed} outcome: retain the seed's owner peers as
   * cold-start bootstrap targets, and surface a seed that was accepted but whose
   * every owner dial failed — the node is now seeded yet unconnected, and the
   * cold-start reconcile branch is what gets it out of that state.
   */
  private noteAppliedSeed(result: ApplySeedResult, seed: ControlNetworkSeed): void {
    if (!result.success) {
      return;
    }
    this.recordSeedBootstrapPeers(seed);
    if (result.ownerDialsAttempted > 0 && result.ownerDialsFailed === result.ownerDialsAttempted) {
      log('applySeed: seeded but no owner reachable (%d/%d dial(s) failed) — cold-start reconcile will retry',
        result.ownerDialsFailed, result.ownerDialsAttempted);
    }
  }

  /**
   * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
   */
  async deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.deliverSeed(targetMultiaddr, seed);
  }

  /**
   * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
   */
  encodeSeed(seed: ControlNetworkSeed): string {
    // Static method - doesn't need service initialization
    const json = JSON.stringify(seed);
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode a seed from base64url encoding.
   */
  decodeSeed(encoded: string): ControlNetworkSeed {
    // Static method - doesn't need service initialization
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as ControlNetworkSeed;
  }

  /**
   * Get this node's circuit relay address for inclusion in seeds.
   * Returns null if no relay address is available.
   */
  async getRelayAddress(): Promise<string | null> {
    if (!this.controlNode) {
      return null;
    }

    const addrs = this.controlNode.getMultiaddrs();
    const relayAddr = addrs.find(addr => addr.toString().includes('/p2p-circuit/'));
    return relayAddr?.toString() ?? null;
  }

  // ============================================================================
  // Seed Bootstrap Helper Methods
  // ============================================================================

  /**
   * Add a drone to the cadre (for phone/server adding provider-hosted node).
   * Creates authorization and seed for drone initialization.
   *
   * Also retains the drone's handed-over addresses as a durable dial target (see
   * {@link bootstrapPeerStore}). The drone cannot dial an owner that does not
   * listen (a phone), and its `CadrePeer` row stays unsigned — so unresolvable —
   * until it self-publishes over a connection; this node therefore has to open
   * that connection from the addresses it was handed, on this launch or a later
   * one.
   *
   * Nothing is dialed here: the drone has not received the seed yet. After
   * delivering it, call {@link reconcileControlCohort} to dial straight away;
   * otherwise the next timed reconcile pass does. A pass already in flight is
   * joined rather than restarted, and one that listed siblings before this add
   * does not dial the drone, so a caller waiting for the connection should allow
   * for one more timed pass.
   */
  async addDrone(options: AddDroneOptions): Promise<DroneInitResult> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    // The drone's `CadrePeer` insert notifies the membership hub on the way to the
    // seed, so the per-stream gate already admits it here.
    const result = await this.seedBootstrapService.addDrone(options);
    // Same queueing as authorizePeer: a phone adding its first always-on node has
    // no control connection, so the insert usually committed local-only.
    this.noteControlWrite(options.dronePeerId, 'authorize');
    this.retainDialTarget(options.dronePeerId, options.droneMultiaddrs, 'addDrone');
    return result;
  }

  /**
   * Add a phone to the cadre with relay support.
   * Use when both nodes are NAT'd (phone-to-phone).
   */
  async addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    // The service authorizes the phone (a `CadrePeer` insert, which notifies the
    // membership hub) on the way to the seed, so the per-stream gate admits it
    // before this resolves — not on the next reconcile, by which time the phone's
    // own control-DB schema load may have died denied.
    return await this.seedBootstrapService.addPhoneWithRelay(phonePeerId);
  }

  // ============================================================================
  // Cadre Invitation API (redeemable at any member, `/sereus/cadre-invite/1.0.0`)
  // ============================================================================

  /**
   * Mint an owner-signed cadre invitation that a device can redeem at ANY member machine of
   * this party, the owner offline included ({@link redeemCadreInvitation}). Requires the
   * owner key ({@link initializeSeedBootstrap}).
   *
   * The invitation is an ed25519 keypair: the public half is the `CadreInvite` row's key,
   * the private half rides in the returned bundle as the proof of possession. Whoever holds
   * the bundle can redeem it, so an UNTARGETED, OWNER-GRANTING invitation — a bearer
   * credential for admin rights — defaults to a 15-minute lifetime; every other kind to 24
   * hours. One use unless `uses` says otherwise. The bundle carries the signed row (so a
   * member that has not received it by replication seats it from the bundle), this node's
   * anchored owner keys (the device pins them and checks the member's reply against them;
   * sourced from the node-local anchor only, never the replicated `OwnerKey` table, because
   * the device anchors whatever arrives and a stranger's genesis-inserted key must not ride
   * an invitation into a fresh node's anchor; an empty anchor is refused because a reply
   * could not be checked), and the addresses of this machine first
   * ({@link resolveInviteAddresses}, which honours pushed NAT addresses) then up to three
   * other members ({@link siblingInvitationAddrs}).
   *
   * The row commits locally and replicates like any other control write; minted while
   * alone (a phone with no connection), it reaches the other members through the
   * peer-join block catch-up on the next connection. Until a member holds the row, that
   * member's connection gate denies the device ({@link admitInboundControlConnection}
   * check 6 admits a stranger only while a live `CadreInvite` row is held locally), so the
   * device's dial of it fails and it moves to the next address; the bundle's copy of the
   * row is seated only at a member whose gate is already open (no vouched member yet, or
   * another live invitation). See the blocked ticket
   * `decide-cadre-invite-redeemed-before-the-row-replicates`.
   *
   * @throws when no owner key is wired, the anchor is empty, `uses` is not a positive
   *   integer, or neither this machine nor any other member has an address.
   */
  async createCadreInvitation(options: CreateCadreInvitationOptions): Promise<CreateCadreInvitationResult> {
    const service = this.seedBootstrapService;
    if (!service?.canAuthorize()) {
      throw new Error('Seed bootstrap service not initialized with an owner key. Call initializeSeedBootstrap() first.');
    }
    const ownerKeys = Array.from(this.trustedOwnerStore?.all() ?? []);
    if (ownerKeys.length === 0) {
      throw new Error('createCadreInvitation: this node anchors no owner key, and an invitation without owner keys cannot be verified by the device that redeems it');
    }
    const uses = options.uses ?? 1;
    if (!Number.isInteger(uses) || uses < 1) {
      throw new Error(`createCadreInvitation: uses must be a positive integer (received ${String(options.uses)})`);
    }
    const members = [...await this.resolveInviteAddresses(), ...await this.siblingInvitationAddrs()];
    if (members.length === 0) {
      throw new Error('createCadreInvitation: neither this machine nor any other machine of the party has an address a device could dial');
    }
    const expiresInMs = options.expiresInMs
      ?? (options.grantsOwner && !options.peerId ? OWNER_INVITATION_DEFAULT_TTL_MS : CADRE_INVITATION_DEFAULT_TTL_MS);
    const invitePrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const row = await service.insertCadreInvite({
      key: ed25519PublicKeyFromPrivate(invitePrivateKey),
      peerId: options.peerId ?? null,
      grantsOwner: options.grantsOwner,
      expiresAtMs: Date.now() + expiresInMs,
      totalUses: uses,
    });
    const invitation: CadreInvitation = {
      v: 1,
      partyId: this.config.controlNetwork.partyId,
      invitePrivateKey,
      invite: row,
      ownerKeys,
      members,
    };
    log('Cadre invitation minted: %s (peer=%s owner=%s uses=%d, %d member address(es))',
      row.key, row.peerId ?? 'any', row.grantsOwner, uses, members.length);
    return { invitation, encoded: encodeCadreInvitation(invitation) };
  }

  /**
   * Every cadre invitation this node holds — minted here or replicated in — with its
   * standing ({@link CadreInviteStatus}: live, withdrawn, redemptions recorded).
   */
  async listCadreInvitations(): Promise<CadreInviteStatus[]> {
    if (!this.controlDatabase) {
      throw new Error('CadreNode must be started before listing cadre invitations');
    }
    return await this.controlDatabase.listCadreInviteStatuses();
  }

  /**
   * Withdraw a cadre invitation: an owner-signed `Revocation` tombstone over its row, which
   * stays as the proof of membership for every device it admitted. No further redemption
   * succeeds anywhere the tombstone reaches, and a member holding it refuses the bundle's
   * copy of the row. A withdrawal committed while alone is re-issued on cohort growth like
   * any other tombstone.
   *
   * @returns `true` when this call filed the tombstone, `false` when the row is not held
   *   here or was already withdrawn.
   */
  async withdrawCadreInvitation(key: string): Promise<boolean> {
    if (!this.seedBootstrapService) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return await this.seedBootstrapService.withdrawCadreInvite(key);
  }

  /**
   * Join the cadre an invitation names by redeeming it at one of the member machines it
   * lists, the owner that minted it offline or not. Needs a started node with a stable
   * identity (`keyStore` or `privateKey`): the redemption is signed with the key behind
   * this node's peer id, and the member checks that the two match.
   *
   * Steps: refuse an invitation for another party; pin its `ownerKeys` into the node-local
   * anchor (`'invite'` provenance — the pin sticks even if the redemption then fails, as it
   * does for a seed invite, so a later attempt or seed from the same owner is anchored);
   * sign the request; dial the listed members in order ({@link redeemAtMembers}); on
   * acceptance verify the reply against the pinned keys, merge its dial hints into the peer
   * store, retain the answering member as a cold-start dial target, refresh the membership
   * gate and start a cohort reconcile pass. This node then syncs the control database over
   * the connection it already holds, the same unified behaviour as after a seed.
   *
   * A device that is already a member (a restart with the invitation still configured) is
   * answered as accepted by the member's idempotent redemption, with no second usage row.
   *
   * When the invitation grants ownership, the member seats this node's key as an `OwnerKey`
   * row by consent. The caller still has to wire that key for signing afterwards —
   * `initializeSeedBootstrap(ownKey)`, which anchors it; never `ensureOwnerKey`, the row is
   * already there. Until the plan ticket `owner-anchor-follows-owner-key-changes` lands,
   * other machines accept this node's vouches only after a seed from it, because their
   * anchors do not follow `OwnerKey` additions.
   *
   * Limit: the reply check ({@link verifyRedeemReply}) does not authenticate the member. A
   * forged bundle, or a legitimate one whose addresses were swapped, dials a machine that
   * can echo the owner-signed row it was just sent; that is what pasting an attacker's
   * invitation means. What protects this node afterwards is its anchor: every row it then
   * syncs is judged against the pinned owner keys, so a machine that is not a member of the
   * cadre the invitation names can admit nobody this node will trust.
   *
   * @throws `CadreInviteRejectedError` on a final refusal, `CadreInviteReplyInvalidError` on
   *   an acceptance that fails the reply check, `CadreInviteUnreachableError` when every
   *   listed address was tried without an acceptance, and a plain `Error` for the
   *   preconditions above.
   */
  async redeemCadreInvitation(invitation: CadreInvitation): Promise<RedeemCadreInvitationResult> {
    const controlNode = this.controlNode;
    if (!controlNode || !this.controlDatabase || !this._running) {
      throw new Error('CadreNode must be started before redeeming a cadre invitation');
    }
    if (invitation.partyId !== this.config.controlNetwork.partyId) {
      throw new Error(`Cadre invitation is for party ${invitation.partyId}; this node serves ${this.config.controlNetwork.partyId}`);
    }
    const signer = this.getSelfSigningKey();
    if (!signer) {
      throw new Error('redeemCadreInvitation: this node runs on an ephemeral identity; configure `keyStore` or `privateKey` so its key can sign the redemption');
    }
    await this.trustOwnerKeys(invitation.ownerKeys, 'invite');
    const pinned = new Set(invitation.ownerKeys);
    const request = signRedeemRequest(
      invitation,
      { peerKey: signer.publicKeyB64, peerPrivateKey: signer.privateKeyB64 },
      generateStampId(controlNode.peerId.toString()),
      await this.resolveInviteAddresses()
    );
    const { reply, memberPeerId, memberAddr } = await redeemAtMembers(controlNode, {
      invitation,
      request,
      isTrustedIssuer: (ownerKey) => pinned.has(ownerKey),
      linkRoundTripMs: this.config.network?.linkRoundTripMs,
    });
    log('Cadre invitation %s redeemed at %s (owner=%s)', invitation.invite.key, memberAddr, reply.invite.grantsOwner);

    const selfPeerId = controlNode.peerId.toString();
    await mergeSeedPeers(controlNode, reply.peers.filter((peer) => peer.peerId !== selfPeerId));
    if (memberPeerId !== null) {
      // Every address the bundle gave the answering member, so a restart has the same choices.
      const memberAddrs = this.parseMultiaddrs(invitation.members)
        .filter((addr) => trailingPeerId(addr) === memberPeerId)
        .map((addr) => addr.toString());
      this.retainDialTarget(memberPeerId, memberAddrs, 'redeemCadreInvitation');
    }
    // The pins above flip nothing yet (this node holds no rows), but the rows about to
    // replicate in are judged against them; refresh so the snapshot is not stale when they land.
    await this.refreshMembershipGate('invitation-redeemed');
    void this.reconcileControlCohort().catch((error) =>
      log('redeemCadreInvitation: the post-redemption reconcile pass failed: %o', error));
    return { peerId: memberPeerId, grantsOwner: reply.invite.grantsOwner, redeemedAt: new Date().toISOString() };
  }

  // ============================================================================
  // Strand Solicitation API (native cadre-core formation transport)
  // ============================================================================

  /**
   * Replace this node's strand solicitation service — the formation responder every node
   * installs at {@link start}, and the initiator side of {@link formStrand}. Optional: call it
   * only to customize the responder (an approver, a provisioner, formation deadlines). The
   * new service's handler replaces the previous one's on the control node, and invitations
   * the previous service minted stay outstanding.
   *
   * Without `options.formationUsageRecorder`, tokens are checked against this party's
   * replicated `FormationInvite`/`FormationUsage` rows ({@link ControlFormationUsageRecorder}).
   * A responder that accepts every token is reachable only by constructing
   * {@link StrandSolicitationService} directly.
   *
   * @param options - Configuration for the solicitation service
   */
  async initializeStrandSolicitation(options?: StrandSolicitationServiceOptions): Promise<void> {
    const controlNode = this.controlNode;
    const controlDatabase = this.controlDatabase;
    if (!controlNode || !controlDatabase) {
      throw new Error('CadreNode must be started before initializing strand solicitation');
    }

    const service = new StrandSolicitationService({
      ...options,
      formationUsageRecorder: options?.formationUsageRecorder ?? new ControlFormationUsageRecorder(controlDatabase),
      partyId: this.config.controlNetwork.partyId,
      // Read per formation: the responder is installed during start, before a relay
      // reservation gives a relay-only node any address, and addresses change after.
      cadrePeerAddrs: () => this.getMultiaddrs(),
      // Every formation deadline derives from this node's declared link, like every other
      // dial budget here; a caller's own declaration on the formation config still wins.
      formationConfig: {
        linkRoundTripMs: this.config.network?.linkRoundTripMs,
        ...options?.formationConfig
      },
      // Overrides any caller-supplied hook, exactly like partyId/cadrePeerAddrs: only
      // this node can say which strand-network addresses it is actually listening on,
      // and a wrong answer here seeds a joiner's mesh with addresses that reach nobody.
      resolveStrandAddrs: (strandId: string) => this.getStrandMultiaddrs(strandId),
      // Overridden on the same grounds: only this node holds the running strand
      // instance's database and this party's `StrandPartyKey` identity, and a wrong
      // issuer here would admit joiners under someone else's authority.
      issueMembershipInvite: (strandId: string, signal?: AbortSignal) =>
        this.issueStrandMembershipInvite(strandId, signal)
    });

    const previous = this.strandSolicitationService;
    if (previous) {
      service.adoptMintedInvitations(previous);
    }
    // Set before the swap is awaited, so a concurrent createOpenInvitation / formStrand
    // uses this service instead of building another.
    this.strandSolicitationService = service;
    const swap = this.solicitationSwaps.then(() => this.swapFormationResponder(service, controlNode));
    // The queue only orders swaps; a failed one rejects this call's own await below.
    this.solicitationSwaps = swap.catch(() => undefined);
    await swap;
    log('Strand solicitation service initialized');
  }

  /**
   * Answer formation from start. Log-and-continue: a node that cannot is still useful, and
   * {@link createOpenInvitation} / {@link formStrand} install the responder when it is missing.
   */
  private async installDefaultFormationResponder(): Promise<void> {
    try {
      await this.initializeStrandSolicitation();
    } catch (error) {
      log('Formation responder not installed at start; createOpenInvitation/formStrand will retry: %o', error);
    }
  }

  /**
   * Move the control node's formation handler from the registered service to `service`.
   * Queued by {@link initializeStrandSolicitation} so swaps run one at a time: libp2p allows
   * one handler per protocol id, and two overlapping swaps would each find the other's
   * handler in the way. A failed swap registers the previous service again, points
   * {@link strandSolicitationService} back at it unless a later call has replaced it, and
   * rethrows.
   *
   * NOTE: same stray-handler caveat as {@link installSeedBootstrapService} — a failed
   * peer-store merge leaves the formation handler registered, so the restore below (and a
   * retry) rejects as a duplicate.
   */
  private async swapFormationResponder(service: StrandSolicitationService, controlNode: Libp2p): Promise<void> {
    const previous = this.registeredSolicitation;
    try {
      await previous?.unregisterResponder(controlNode);
      await service.registerResponder(controlNode);
      this.registeredSolicitation = service;
    } catch (error) {
      if (this.strandSolicitationService === service) this.strandSolicitationService = previous;
      await previous?.registerResponder(controlNode).catch((restoreError: unknown) =>
        log('Re-registering the previous formation responder failed; none answers until the next initializeStrandSolicitation: %o', restoreError));
      throw error;
    }
  }

  /**
   * Get the strand solicitation service (for advanced use). Non-null on a started node unless
   * the install at {@link start} failed.
   */
  getStrandSolicitationService(): StrandSolicitationService | null {
    return this.strandSolicitationService;
  }

  /**
   * Create an open invitation for others to form strands with this party.
   *
   * The invitation's bootstrap list names this machine first (it is the one most likely to
   * run the host strand), then a few of the party's other machines
   * ({@link siblingInvitationAddrs}), so a joiner can still form while this one is offline.
   *
   * @param sAppId - The sApp to use for formed strands
   * @param expirationMs - How long the invitation is valid (ms from now)
   * @returns The open invitation to share out-of-band
   * @throws when neither this machine nor any other machine of the party has an address
   */
  async createOpenInvitation(
    sAppId: string,
    expirationMs: number = 24 * 60 * 60 * 1000 // 24 hours default
  ): Promise<OpenInvitation> {
    if (!this.strandSolicitationService) {
      // Only when the install at start failed.
      await this.initializeStrandSolicitation();
    }

    const bootstrap = [...this.getMultiaddrs(), ...await this.siblingInvitationAddrs()];
    if (bootstrap.length === 0) {
      throw new Error('No multiaddrs available for invitation');
    }

    return await this.strandSolicitationService!.createOpenInvitation(
      sAppId,
      expirationMs,
      bootstrap
    );
  }

  /**
   * Addresses of the party's other machines for an invitation's bootstrap list — an open
   * strand invitation's ({@link createOpenInvitation}) or a cadre invitation's
   * ({@link createCadreInvitation}); {@link selectInvitationSiblingAddrs} picks which. The
   * source is each authorized member's signed `CadrePeer` record ({@link resolvePeerRecord}),
   * so a machine whose record is missing, stale or untrusted is left out; live connections
   * only order them.
   *
   * Best-effort: a failed read leaves the invitation naming this machine alone, which is what
   * it named before siblings were added.
   */
  private async siblingInvitationAddrs(): Promise<string[]> {
    const controlNode = this.controlNode;
    if (!controlNode || !this.controlDatabase) {
      return [];
    }
    try {
      const siblings: InvitationSibling[] = [];
      for (const { peerId } of await this.listAuthorizedMembers()) {
        const resolved = await this.resolvePeerRecord(peerId, {});
        if (resolved && resolved.addrs.length > 0) {
          siblings.push({ peerId, updatedAt: resolved.updatedAt, addrs: resolved.addrs.map(String) });
        }
      }
      const connected = new Set(controlNode.getConnections().map((c) => c.remotePeer.toString()));
      return selectInvitationSiblingAddrs(siblings, connected);
    } catch (error) {
      log('siblingInvitationAddrs: resolving the other machines failed; the invitation names only this one: %o', error);
      return [];
    }
  }

  /**
   * Form a strand with a responder via an open invitation: one attempt, from this machine, with
   * nothing recorded party-wide. {@link requestJoin} is the path that keeps trying.
   *
   * @param invitation - The open invitation received out-of-band
   * @param disclosure - Identity/context information to share with the responder
   * @returns The member key and strand info if successful
   * @throws `FormationRejectedError` or `FormationUnreachableError` when the formation fails, and
   *   `FormationPostApprovalError` when it was approved and a step on this machine then failed
   */
  async formStrand(
    invitation: OpenInvitation,
    disclosure: StrandFormationDisclosure = {}
  ): Promise<FormStrandResult> {
    if (!this.controlNode) {
      throw new Error('CadreNode must be started before forming strands');
    }

    if (!this.strandSolicitationService) {
      await this.initializeStrandSolicitation();
    }

    const result = await this.strandSolicitationService!.formStrand(
      invitation,
      disclosure,
      this.controlNode
    );
    await this.recordFormationStrandAddrs(result.strandId, result.strandAddrs);
    // A closed host strand's approval carries the joiner's own membership invitation —
    // persist this party's identity key and stage the invitation for bring-up to redeem.
    // Runs AFTER the addr recording so a persistence failure (which throws — see the
    // method) still leaves the cross-party seed in place for a manual recovery.
    if (result.membershipInvite) {
      await this.adoptFormationMembershipInvite(result.strandId, result.membershipInvite);
    }
    await this.rememberFormedStrand(result);
    return result;
  }

  /**
   * Ask to join through `invitation` and have the party keep trying until the join works, the
   * invitation is used up or expires, or the request is dismissed: across restarts, and from
   * any owner machine of the party (`docs/strands.md` → "Joining while the inviter is
   * offline"). Records a party-wide `JoinRequest` row, runs one attempt on this machine at
   * once, and returns the status after it: `'joined'` when the inviter answered yes, `'waiting'`
   * when it was unreachable or not ready, `'failed'` when it refused for good.
   *
   * Asking again for an invitation whose request is still pending adopts that request as it
   * is; asking again after it finished starts a fresh one. Later changes arrive as
   * `pendingJoin:changed`. A joined strand is offered through `strand:discovered` like any
   * {@link formStrand} join. Do not also call {@link formStrand} with the same invitation:
   * nothing coordinates the two, and one of them gets `token-spent`.
   *
   * @throws on a machine that is not an enrolled owner (the row is owner-signed), and on an
   *   invitation already past its expiration
   */
  async requestJoin(invitation: OpenInvitation, disclosure: StrandFormationDisclosure = {}): Promise<PendingJoinStatus> {
    const { database, runner } = this.requirePendingJoins();
    const signer = await this.requireOwnerSigner(
      'requestJoin needs an enrolled owner machine of this party, because the party-wide join request is ' +
      'owner-signed. formStrand(invitation, disclosure) joins once from this machine, with no retries.'
    );
    const now = Date.now();
    const expiresAt = invitation.expiration.getTime();
    if (!Number.isFinite(expiresAt)) {
      throw new Error('The invitation carries no valid expiration');
    }
    if (now >= expiresAt) {
      throw new Error(`The invitation expired at ${invitation.expiration.toISOString()}; ask the inviter for a fresh one`);
    }
    const requested = requestedPendingJoin(
      pendingJoinId(invitation.token), this.encodeInvitation(invitation), disclosure, expiresAt, now);
    const row = await this.recordJoinRequest(database, requested, signer);
    log('requestJoin: pending join %s recorded; attempting now', row.Id);
    return runner.attemptNow(row);
  }

  /**
   * Every join asked for with {@link requestJoin} and not dismissed, pending or finished, as this
   * machine sees it (see `PendingJoinStatus` for which states are machine-local).
   */
  async listPendingJoins(): Promise<PendingJoinStatus[]> {
    const { database, runner } = this.requirePendingJoins();
    return (await database.queryPendingJoins()).map((row) => runner.statusOf(row));
  }

  /**
   * Remove a join request party-wide. On a pending request this cancels it: every owner machine
   * stops at its next read, and an attempt already running does not record its outcome (a join
   * it made stays on that machine, as any {@link formStrand} join does). Owner machines only.
   * Resolves `false` when there was no such request.
   */
  async dismissPendingJoin(id: string): Promise<boolean> {
    const { database, runner } = this.requirePendingJoins();
    const { ownerKey, signMessage } = await this.requireOwnerSigner(
      'dismissPendingJoin needs an enrolled owner machine of this party: the removal is owner-signed');
    const removed = await database.deletePendingJoin(id, ownerKey, signMessage);
    runner.forgetRow(id);
    return removed;
  }

  private requirePendingJoins(): { database: ControlDatabase; runner: PendingJoinRunner } {
    if (!this._running || !this.controlDatabase || !this.pendingJoinRunner) {
      throw new Error('CadreNode must be started before using pending joins');
    }
    return { database: this.controlDatabase, runner: this.pendingJoinRunner };
  }

  /** This machine's owner key and signer for an owner-signed control write, or a throw carrying `refusal`. */
  private async requireOwnerSigner(refusal: string): Promise<{ ownerKey: string; signMessage: (message: Uint8Array) => string }> {
    const signingKey = await this.enrolledOwnerSigningKey();
    if (!signingKey) {
      throw new Error(refusal);
    }
    return { ownerKey: signingKey.publicKeyB64, signMessage: signMessageWith(signingKey.privateKeyB64) };
  }

  /**
   * Write a join request, or adopt the party's existing request for the same invitation: a
   * pending one as it is, a finished one rewritten as `requested` (the user asked again).
   */
  private async recordJoinRequest(
    database: ControlDatabase,
    requested: JoinRequestFields,
    { ownerKey, signMessage }: { ownerKey: string; signMessage: (message: Uint8Array) => string }
  ): Promise<PendingJoin> {
    let written: PendingJoin;
    try {
      written = await database.insertJoinRequest(requested, ownerKey, signMessage);
    } catch (error) {
      if (!isPendingJoinConflict(error)) {
        throw error;
      }
      const existing = await database.queryPendingJoin(requested.Id);
      if (!existing) {
        throw new Error(
          `A removed join request for this invitation (${requested.Id}) is still held on this machine until its ` +
          'clean-up runs, which needs a connection to the party. Ask again once connected.',
          { cause: error }
        );
      }
      if (existing.outcome === null) {
        return existing;
      }
      written = await database.rewritePendingJoin(existing.StampId, { ...requested, outcome: null }, ownerKey, signMessage);
    }
    this.pendingJoinRunner?.noteWritten(written, 'request');
    return written;
  }

  /** Build and start the pending-join retry loop over this node (see {@link pendingJoinRunner}). */
  private startPendingJoinRunner(): void {
    const database = (): ControlDatabase => {
      if (!this.controlDatabase) {
        throw new Error('CadreNode is stopped: no control database for pending joins');
      }
      return this.controlDatabase;
    };
    const outcomeSigner = (): Promise<{ ownerKey: string; signMessage: (message: Uint8Array) => string }> =>
      this.requireOwnerSigner('Cannot record a pending join outcome: this machine is not an enrolled owner of the party');
    this.pendingJoinRunner = new PendingJoinRunner({
      selfId: this.controlNode!.peerId.toString(),
      linkRoundTripMs: this.config.network?.linkRoundTripMs,
      isOwner: async () => (await this.enrolledOwnerSigningKey()) !== null,
      // NOTE: one owner-key read and one pending-join read (three tables) per pass (30 s); for a
      // party that never asked for a join the second reads never-written blocks, which consults
      // the cohort. If it shows up in a device profile, poll more slowly while the tables read empty.
      readRows: () => database().queryPendingJoins(),
      readRow: (id) => database().queryPendingJoin(id),
      attempt: (join) => this.formStrand(this.pendingJoinInvitation(join), parseStoredDisclosure(join)),
      record: async (expected, outcome) => {
        const { ownerKey, signMessage } = await outcomeSigner();
        return database().recordJoinOutcome(expected, outcome, ownerKey, signMessage);
      },
      rewrite: async (expectedStampId, next) => {
        const { ownerKey, signMessage } = await outcomeSigner();
        return database().rewritePendingJoin(expectedStampId, next, ownerKey, signMessage);
      },
      remove: async (id) => {
        const { ownerKey, signMessage } = await outcomeSigner();
        return database().deletePendingJoin(id, ownerKey, signMessage);
      },
      isAlone: () => this.committedAlone(),
      sAppIdOf: (row) => this.pendingJoinSAppId(row),
      observeRows: (rows) => this.stageMembershipInvitesFromPendingJoins(rows),
      emit: (status) => this.emit('pendingJoin:changed', status),
    });
    this.pendingJoinRunner.start();
  }

  /** The invitation a `JoinRequest` row stores. A failure names the row, never the invitation, which is a bearer credential. */
  private pendingJoinInvitation(join: PendingJoin): OpenInvitation {
    try {
      return this.decodeInvitation(join.Invitation);
    } catch {
      throw new Error(`JoinRequest ${join.Id}: the stored invitation does not decode`);
    }
  }

  private pendingJoinSAppId(join: PendingJoin): string {
    try {
      return this.decodeInvitation(join.Invitation).sAppId;
    } catch {
      log('JoinRequest %s: the stored invitation does not decode; reporting no sApp', join.Id);
      return '';
    }
  }

  /**
   * Stage the membership invitation of each joined request this process has not staged yet, so a
   * closed strand joined on another owner machine is seated by whichever machine launches it
   * first; the party key it admits is the replicated `StrandPartyKey` row the finishing machine
   * seated. A strand that already has an invitation staged keeps it, for the reconciler to
   * settle first.
   */
  private stageMembershipInvitesFromPendingJoins(joins: readonly PendingJoin[]): void {
    for (const { rowId, strandId, invite } of membershipInvitesToStage(joins, this.stagedMembershipInviteKeys, Date.now())) {
      this.stagedMembershipInviteKeys.add(invite.inviteKey);
      if (this.pendingMembershipInvites.has(strandId)) {
        continue;
      }
      this.pendingMembershipInvites.set(strandId, invite);
      log('pending join %s: staged its membership invitation for strand %s', rowId, strandId);
      this.strandManager.notifyMembershipInviteStaged(strandId);
    }
  }

  /**
   * Remember the strand a formation just joined (see {@link joinedStrandStore}), so it
   * is re-offered after a restart even when the app is killed before its `addStrand`, and
   * published party-wide by the next connected owner reconcile pass. A re-join also
   * cancels a party-wide removal a self-revocation queued for the strand.
   * Last in {@link formStrand}, after the membership adoption, so a failure here leaves
   * the party key and staged invitation in place for the re-formation it asks for.
   *
   * Throws on failure, like {@link adoptFormationMembershipInvite}: the formation's
   * token is spent, and a join no store names would vanish at the next restart.
   */
  private async rememberFormedStrand(result: FormStrandResult): Promise<void> {
    try {
      await this.joinedStrands!.remember({
        Id: result.strandId,
        Type: result.memberPrivateKey ? 'c' : 'o',
        MemberPrivateKey: result.memberPrivateKey ?? null,
        joinedAt: Date.now()
      });
    } catch (error) {
      throw new FormationPostApprovalError(
        result.strandId,
        `Formation for strand ${result.strandId} was approved (its one-time token is spent), but ` +
        'remembering the join in this node\'s joined-strand store failed, so the strand would not ' +
        'come back after a restart. Fix the store (usually the configured keyStore), then redeem a ' +
        'fresh invitation.',
        { cause: error }
      );
    }
  }

  /**
   * Adopt an approved closed-strand formation's membership half on the JOINER:
   *
   * 1. Mint-or-reuse this party's own strand identity — {@link ensureStrandPartyKey}
   *    with no explicit key returns the stored `StrandPartyKey` row when one exists (a
   *    re-formation by an existing member party: lost addresses, an app reinstall with
   *    an intact control DB) and mints + persists a fresh one otherwise. The invitation
   *    will admit THIS key's public half as the `Strand.Member`.
   * 2. Stage the invitation in {@link pendingMembershipInvites} for the strand
   *    bring-up flow (`strand-node-binds-member-peer`) to redeem via `consumeInvite`,
   *    and tell the instance manager, which re-arms an already-finished membership
   *    reconciler so a RE-formation against a launched strand is attempted at once — the
   *    removed-party case, where the loop finished long before the removal. A strand not
   *    launched here yet has no loop to re-arm, and its bring-up finds the entry.
   *
   * Throws — failing the whole {@link formStrand} — when the identity cannot be
   * persisted: a joiner "joined" without a persistable identity could never become a
   * member, and failing loudly beats a silent half-member. The formation itself has
   * already succeeded by then and its one-time token is SPENT, so the error says so:
   * recovery is fixing the underlying cause (no owner signing key / control DB write
   * rejected) and redeeming a FRESH invitation.
   */
  private async adoptFormationMembershipInvite(strandId: string, invite: StrandMembershipInvite): Promise<void> {
    try {
      await this.ensureStrandPartyKey(strandId);
    } catch (error) {
      throw new FormationPostApprovalError(
        strandId,
        `Formation for strand ${strandId} was approved (its one-time token is spent), but ` +
        'persisting this party\'s membership identity (StrandPartyKey) failed — the joiner ' +
        'cannot become a member without it. Fix the underlying cause, then redeem a fresh ' +
        'invitation (the delivered one dies with this error).',
        { cause: error }
      );
    }
    this.pendingMembershipInvites.set(strandId, invite);
    this.stagedMembershipInviteKeys.add(invite.inviteKey);
    log('formStrand: staged membership invitation for strand %s (party key persisted)', strandId);
    this.strandManager.notifyMembershipInviteStaged(strandId);
  }

  /**
   * The reconciler's half of the {@link pendingMembershipInvites} seam: drop `settled`
   * (spent, burned, or dead) only while it is still the staged entry. A re-formation
   * replaces the entry between a pass's read and its settle, and the fresh invitation it
   * staged is the one the re-armed loop is about to redeem — deleting it here would lose
   * it silently, the very outcome the re-arm exists to prevent.
   */
  private unstageMembershipInvite(strandId: string, settled: StrandMembershipInvite): void {
    if (this.pendingMembershipInvites.get(strandId)?.inviteKey !== settled.inviteKey) {
      log('strand %s: a fresh membership invitation replaced the one just settled — keeping it staged', strandId);
      return;
    }
    this.pendingMembershipInvites.delete(strandId);
  }

  /**
   * The pending single-use membership invitation a closed-strand formation carried back
   * for `strandId`, or `undefined` when none is staged — the seam the strand bring-up
   * membership reconciler (`strand-membership-reconciler.ts`) reads to redeem the
   * joiner's `Strand.Member` seat. `undefined` therefore also means "already redeemed,
   * burned, or found dead": the reconciler clears the entry as soon as it settles the
   * invitation, so a caller polling this sees it disappear on its own. In-memory only;
   * see {@link pendingMembershipInvites} for lifetime and re-formation semantics.
   */
  getPendingMembershipInvite(strandId: string): StrandMembershipInvite | undefined {
    return this.pendingMembershipInvites.get(strandId);
  }

  /**
   * Responder-side issuer behind the formation manager's `issueMembershipInvite` seam
   * (see `StrandFormationManagerOptions.issueMembershipInvite` for the contract this
   * implements): mint a single-use `Strand.Invite` against the LIVE host strand so a
   * validated joiner can seat its own `Strand.Member` row.
   *
   * - Open host strand → `null` (no members, nothing to invite into).
   * - Closed host strand whose founder launch was refused as pre-split
   *   ({@link strandLaunchRefusals}) → rethrow the recorded `PreSplitStrandIdentityError`;
   *   the manager maps it to the NON-retryable `HOST_STRAND_MUST_BE_RECREATED_REASON`.
   * - Closed host strand with no `StrandPartyKey` row → throw: this party's identity is
   *   the invite's issuing manager, and without it nothing can sign the issuance. (The
   *   founder's publish/launch paths mint it, so this is a not-yet-converged sibling.)
   *   The manager maps the throw to a clean retryable rejection BEFORE the formation
   *   token is spent.
   * - Closed host strand whose runtime is HIBERNATING or being quiesced → woken first
   *   ({@link wakeHostStrandForFormation}, bounded by `signal`), then issued as below. In
   *   every state the redemption counts as activity, so the host stays up for the
   *   joiner's first sync.
   * - Closed host strand with no running local instance/database (never launched, still
   *   starting, or a hibernating one whose wake failed or outran `signal`) →
   *   throw, same mapping: a joiner admitted without an invitation would look joined and
   *   never become a member, and a responder not running the strand cannot serve its sync
   *   anyway.
   * - Closed host strand whose LIVE rows carry the pre-split fingerprint
   *   (`assertNotPreSplitStrand`) → throw `PreSplitStrandIdentityError`, same mapping as
   *   the recorded refusal. Covers the responders that never ran a refused founder launch:
   *   a sibling machine of the founding party, or a node restarted since the refusal.
   *
   * The recorded refusal is checked first: it is an in-memory read and the only
   * permanent diagnosis. Identity is checked BEFORE the runtime: it is the cheaper read
   * and the more actionable diagnosis when both are missing (a missing runtime is
   * transient, a missing identity is not), and it keeps the branch reachable without
   * standing a strand runtime up. For the same reason every control-database check runs
   * before a wake: a strand that cannot issue anyway is not woken.
   *
   * `signal` is the formation's provisioning budget. Once it has aborted nothing is
   * issued — the joiner has already been told to retry, and an invitation written now
   * would only sit in the strand until it expires.
   *
   * The invitation expires `MEMBERSHIP_INVITE_TTL_MS` from now — see that constant for
   * the slow-joiner / lost-result tradeoff.
   *
   * NOTE: the issuing identity must be a `Strand.Manager` (the schema's `InviteValid`
   * gate), and only the FOUNDING party's key is seated as one. Today only the founder
   * party can host a bound formation at all — a joining party never gets the host
   * strand's control `Strand` row, so `resolveStrand` reports `missing` on it — so this
   * never bites. If a joined party is ever able to host formations into a strand it
   * joined (re-invite / multi-hop join), issuance here fails the manager gate and every
   * such redemption rejects with the retryable-sounding
   * `MEMBERSHIP_INVITE_UNAVAILABLE_REASON` forever; that flow needs manager delegation,
   * not a retry.
   */
  private async issueStrandMembershipInvite(
    strandId: string,
    signal?: AbortSignal
  ): Promise<StrandMembershipInvite | null> {
    if (!this.controlDatabase) {
      throw new Error(`Cannot issue a membership invitation for strand ${strandId}: control database unavailable`);
    }
    const row = await this.controlDatabase.queryStrand(strandId);
    if (!row) {
      // The bound resolution saw this row moments ago; a vanished row is a concurrent
      // unpublish — reject rather than invite into a strand this party just removed.
      throw new Error(`Cannot issue a membership invitation for strand ${strandId}: its Strand row is gone`);
    }
    if (row.Type !== 'c') {
      return null;
    }
    const refusal = this.strandLaunchRefusals.get(strandId);
    if (refusal) {
      throw refusal;
    }
    const partyKey = await this.controlDatabase.queryStrandPartyKey(strandId);
    if (partyKey === null) {
      throw new Error(
        `Cannot issue a membership invitation for closed strand ${strandId}: this party holds ` +
        'no StrandPartyKey row for it (identity not yet converged from the machine that published it)'
      );
    }
    await this.wakeHostStrandForFormation(strandId, signal);
    const db = this.strandManager.getInstance(strandId)?.database?.getDatabase();
    if (!db) {
      throw new Error(
        `Cannot issue a membership invitation for closed strand ${strandId}: its runtime is ` +
        'not live on this responder (not launched, or still starting)'
      );
    }
    if (row.MemberPrivateKey) {
      await assertNotPreSplitStrand(db, strandId, strandMemberKeyPair(row.MemberPrivateKey).publicKeyB64);
    }
    if (signal?.aborted) {
      throw new Error(
        `Cannot issue a membership invitation for closed strand ${strandId}: the formation ` +
        'provisioning budget expired before issuance'
      );
    }
    return await issueInvite(db, {
      managerKeyPair: strandMemberKeyPair(partyKey),
      expiration: Date.now() + MEMBERSHIP_INVITE_TTL_MS
    });
  }

  /**
   * Count a bound closed-strand redemption as activity on the host strand, and wake the
   * strand when it is HIBERNATING or being quiesced (its database is closing) so the
   * membership invitation can be issued. Only reached after the formation manager has
   * authorized the redemption (token, disclosure, outside approval, seat pre-check), so only
   * a caller already entitled to the strand's member key can cause a wake. No other state is
   * woken — never launched or still starting is not something this node recovers from on
   * demand; the caller's live-database check refuses those.
   *
   * The activity is recorded in every state, through the hibernation manager rather than
   * {@link recordStrandActivity}, whose push fan-out would wake this party's phones for
   * nothing. It keeps the host up for the joiner's first sync: a live strand's idle timer
   * restarts, a check-in window that happens to have the strand live sees activity and
   * leaves it up instead of re-quiescing it, and a hibernating strand has its idle →
   * hibernate timers re-armed once the wake leaves it `active`. The explicit
   * {@link wakeStrand} coalesces onto the wake `recordActivity` began, and still wakes when
   * `recordActivity` is a no-op (hibernation disabled but the strand force-hibernated, or
   * the manager stopped).
   *
   * Bounded by `signal` (the formation's provisioning budget): when it aborts first this
   * throws — a retryable rejection, token unspent — and leaves the wake running, so the
   * joiner's retry finds the strand live.
   */
  private async wakeHostStrandForFormation(strandId: string, signal?: AbortSignal): Promise<void> {
    const instance = this.strandManager.getInstance(strandId);
    if (!instance) {
      return;
    }
    this.hibernationManager.recordActivity(instance);
    if (!this.strandManager.isQuiescing(strandId) && (instance.status !== 'hibernating' || instance.database)) {
      return;
    }
    log('wakeHostStrandForFormation: waking host strand %s (%s) for an authorized formation', strandId, instance.status);
    const wake = this.wakeStrand(strandId);
    if (await resolvesBeforeAbort(wake, signal)) {
      return;
    }
    void wake.catch((error: unknown) =>
      log('wakeHostStrandForFormation: background wake of host strand %s failed: %o', strandId, error));
    throw new Error(
      `Cannot issue a membership invitation for closed strand ${strandId}: its hibernating ` +
      'runtime did not wake within the formation provisioning budget (still waking)'
    );
  }

  /**
   * Keep the responder's strand-network addresses for a strand this node just formed
   * (see {@link formationStrandAddrs}), so the strand's discovery seed has something to
   * dial when the app launches it.
   *
   * The carried list is peer-agnostic (`sanitizeStrandAddrs` bounds and parses it,
   * nothing more), so it is attributed per peer here (`groupAddrsByPeerId`, the same
   * rule the address-book merge applies) and kept grouped by peer; an entry naming no
   * destination peer is dropped there. Scoped strictly to `strandId`: these addresses
   * reach ONE strand node of ONE other party and must never seed another strand's mesh
   * or the control peerStore.
   *
   * A list that names a peer REPLACES the strand's earlier one: the responder
   * disclosed its current addresses, so the older list is stale. An empty list, or one
   * naming no peer, records nothing, so it cannot wipe an earlier disclosure.
   *
   * A strand already running when this lands (a re-formation, which is the recovery
   * path for a dead address) gets the new addresses merged into its address book now.
   * Nothing else would deliver them: the seed is read only at launch and resume, and the
   * refresh pass skips a peer FRET already holds a record for — the stale one, here.
   */
  private async recordFormationStrandAddrs(strandId: string, strandAddrs: readonly string[]): Promise<void> {
    const attributed = [...groupAddrsByPeerId([...strandAddrs]).values()]
      .flatMap((peerAddrs) => peerAddrs.map((addr) => addr.toString()));
    if (attributed.length === 0) {
      log('formStrand: responder disclosed no usable strand addrs for %s (%d carried) — cross-party seed unchanged',
        strandId, strandAddrs.length);
      return;
    }
    this.formationStrandAddrs.set(strandId, attributed);
    log('formStrand: kept %d of %d cross-party strand addr(s) for %s', attributed.length, strandAddrs.length, strandId);
    const runningNode = this.strandManager.getInstance(strandId)?.libp2pNode;
    if (runningNode) {
      await this.mergeStrandPeerAddrs(runningNode, attributed, strandId);
    }
  }

  /**
   * Encode an open invitation for out-of-band delivery (QR, link, etc.).
   */
  encodeInvitation(invitation: OpenInvitation): string {
    const json = JSON.stringify({
      ...invitation,
      expiration: invitation.expiration.toISOString()
    });
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode an open invitation from base64url encoding.
   */
  decodeInvitation(encoded: string): OpenInvitation {
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return {
      ...parsed,
      expiration: new Date(parsed.expiration)
    };
  }
}

