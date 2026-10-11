/**
 * use-cadre.ts — React hook for CadreNode lifecycle management.
 *
 * Manages the singleton phone node, exposes connection status, and provides
 * methods for joining an existing cadre, seed application and strand creation.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { decodeCadreInvitation } from '@serfab/cadre-core';
import type { CadreInvitation, CadreNode } from '@serfab/cadre-core';
import type {
  StrandInstance,
  CadreNodeEvents,
  RelayReservationState,
  RelayReservationStatus,
  StrandFormationDisclosure,
  NodeClaimPayload,
  CadreInviteStatus,
  CreateCadreInvitationOptions,
  CreateCadreInvitationResult,
} from '@serfab/cadre-core';
import {
  startPhoneNode,
  stopPhoneNode,
  getPhoneNode,
  getOwnerPublicKey,
  getNoiseCryptoMode,
  getRelayState,
  getRunningOptions,
  getPhoneNodeStatus,
  joinCadreByInvitation,
  loadSavedStartOptions,
  dialPeer as dialPeerImpl,
  createOpenInvitation,
  publishFormationInvite,
  formStrand,
  createCadreInvitation as createCadreInvitationImpl,
  listCadreInvitations as listCadreInvitationsImpl,
  withdrawCadreInvitation as withdrawCadreInvitationImpl,
  identityPeerId,
  joinRequestText,
  pendingStrandMove,
  finishStrandMove,
  dissolveFormerParty,
  FormerPartyNotEmptyError,
  StrandMoveNotOwnerError,
  StrandMovePendingError,
  type JoinCadreResult,
  type PhoneNodeOptions,
  type SavedStartOptions,
  type StrandMoveOutcome,
} from './cadre-phone';
import { flowForProgress, JoinCancelledError, type JoinFlow } from './join-flow';
import type { NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';
import {
  createChatStrand,
  joinChatStrand,
  createClosedChatStrand,
  joinClosedChatStrandFromFormation,
  CHAT_SAPP_ID,
} from './chat-strand';
import {
  createBackgroundRunner,
  type BackgroundRunner,
  type RunnerState,
} from '@serfab/cadre-rn/lifecycle';
import { pickActiveStrandId } from './strand-selection';
import { createReactNativeAppState } from './app-state';
import { acquireAndRegisterDeviceToken, clearDeviceTokenRegistration } from './push-wake-native';

/** How long a closed-strand invitation stays valid (24h). */
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * How often the relay posture surfaced to the UI is re-read while the app is in the
 * foreground. Nothing announces a reservation gained or lost — `CadreNode` exposes it
 * only as a live read — so the banner polls. Foreground only, so a backgrounded phone
 * adds no wakeups of its own (the reservation supervisor inside cadre-core keeps its own
 * liveness check running regardless — see the NOTE beside `relayAddrs` in
 * `@serfab/cadre-rn/phone-node`'s `buildPhoneNodeConfig`).
 *
 * The invite guard does NOT use this value: it reads {@link getRelayState} at the
 * moment of the tap, so a stale poll can never let a doomed invitation through.
 */
const RELAY_POSTURE_POLL_MS = 5_000;

/**
 * Why an invitation cannot be minted, phrased for the person holding the phone and
 * naming the thing they can actually change. The guard itself is `getMultiaddrs()`
 * being empty — this phone runs the strand it invites to, so it must be reachable
 * itself; the posture only explains WHY it is empty.
 */
function unreachableInviteMessage(relay: RelayReservationState): string {
  const lead = 'This device has no reachable address yet, so nobody could redeem an invitation.';
  switch (relay.status) {
    case 'none':
      return `${lead} No relay is configured — set one in Settings under "Relay", then reconnect.`;
    case 'dialing':
      return `${lead} Still reserving a slot on the relay — try again in a moment.`;
    case 'retrying':
    case 'error':
      return `${lead} The relay is not answering (${relay.status}${relay.error ? `: ${relay.error}` : ''}).`;
    default:
      // `reserved` with no multiaddrs should not happen — a held reservation IS a
      // `/p2p-circuit` address. Say something true rather than something confident.
      return `${lead} Connect through a relay or a host node first.`;
  }
}

// ── Joining an existing cadre: the steps after admission ────────────────────

const RESPONSE_FOR_ANOTHER_APP = 'This response was made for another app. Copy this app\'s request again and ask for a new one.';

/** Why a strand move stopped short: the `move-incomplete` step's reason and message. */
type MoveStall = Pick<Extract<JoinFlow, { step: 'move-incomplete' }>, 'reason' | 'message'>;

/**
 * Refuse, before anything stops, a response the owner app made from another app's request: the
 * members would refuse it too, but only after this app had left its own cadre to ask.
 */
async function refuseResponseForAnotherApp(invitation: CadreInvitation): Promise<void> {
  const target = invitation.invite.peerId;
  if (target && target !== await identityPeerId()) throw new Error(RESPONSE_FOR_ANOTHER_APP);
}

/** Why the move a join reported did not finish, or null when it did or there was none. */
function joinMoveStall(move: StrandMoveOutcome | undefined): MoveStall | null {
  if (!move || move.state === 'done') return null;
  if (move.state !== 'deferred') return { reason: 'partial' };
  if (move.reason === 'owner-key-not-wired') return { reason: 'owner-key-not-wired' };
  return { reason: 'adoption-failed', message: move.error.message };
}

/** Why `finishStrandMove` threw. */
function retryMoveStall(err: unknown): MoveStall {
  if (err instanceof StrandMoveNotOwnerError) return { reason: 'owner-key-not-wired' };
  console.warn('[use-cadre] moving the strands failed:', err);
  return { reason: 'adoption-failed', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Why a move the kit still records has not finished, when nothing reported it: this app's key is
 * not an owner of the joined party yet (the kit reports no owner key then), or an adoption failed.
 */
function recordedMoveStall(): MoveStall {
  return { reason: getOwnerPublicKey() === null ? 'owner-key-not-wired' : 'partial' };
}

/** The `move-incomplete` step, with the strands the kit's move record still lists. */
async function incompleteMoveFlow(moved: number, stall: MoveStall): Promise<JoinFlow> {
  let waiting: string[] = [];
  try {
    waiting = (await pendingStrandMove())?.strandIds ?? [];
  } catch (err) {
    // The step still shows, its count read as "some".
    console.warn('[use-cadre] could not read the strands still waiting to move:', err);
  }
  return { step: 'move-incomplete', moved, waiting, ...stall };
}

/** The step a refused or failed `dissolveFormerParty` leaves the flow at. */
function flowAfterRefusedDissolve(err: unknown, moved: number): JoinFlow {
  if (err instanceof StrandMovePendingError) {
    return { step: 'move-incomplete', moved, waiting: err.pending.strandIds, ...recordedMoveStall() };
  }
  if (err instanceof FormerPartyNotEmptyError) {
    // Other machines may hold the old cadre's data, so they are never discarded from here.
    if (err.otherMachines.length > 0) return { step: 'old-cadre-kept', otherMachines: err.otherMachines };
    return { step: 'confirm-discard', strandIds: err.strandIds, pendingJoinIds: err.pendingJoinIds };
  }
  console.warn('[use-cadre] removing the old cadre failed:', err);
  return { step: 'old-cadre-remains', error: err instanceof Error ? err.message : String(err) };
}

/** The last step. Standing is read off the kit, which reports an owner key only once it is wired. */
function doneFlow(moved: number): JoinFlow {
  return { step: 'done', grantsOwner: getOwnerPublicKey() !== null, moved };
}

/** The steps during which the kit is joining, moving or removing; a button tapped twice must not queue another. */
function flowRunning(flow: JoinFlow | null): boolean {
  return flow !== null && ['joining', 'admitted', 'moving-strands', 'removing-old-cadre'].includes(flow.step);
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CadreStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface UseCadreResult {
  /** Current connection status */
  status: CadreStatus;
  /** The running CadreNode (null until connected) */
  node: CadreNode | null;
  /** This node's peer ID string (null until connected) */
  peerId: string | null;
  /**
   * This node's owner **public** key (base64url), shareable out-of-band for
   * pairing / enrollment. Null until connected. Never carries private material.
   */
  ownerPublicKey: string | null;
  /**
   * The Noise crypto mode the running node was built with (the `noiseCryptoMode`
   * start option, or the build default when that was absent). Null until connected.
   */
  noiseCryptoMode: NoiseCryptoMode | null;
  /** Active strand instances */
  strands: Map<string, StrandInstance>;
  /** Explicitly selected strand id (null = use the deterministic default). */
  selectedStrandId: string | null;
  /** The strand the chat should render, per pickActiveStrandId. Null if none. */
  activeStrand: StrandInstance | null;
  /** Pick a strand to view; persists until changed or the strand disappears. */
  selectStrand: (strandId: string) => void;
  /** Last error message */
  error: string | null;
  /** OS-lifecycle phase owned by the {@link BackgroundRunner} (foreground/background/…). */
  runnerState: RunnerState;
  /** True while a foreground resume is settling (control network catching up). */
  resuming: boolean;
  /** True after a resume settled without the control network reconnecting (offline/degraded). */
  degraded: boolean;
  /**
   * Relay-reservation posture, polled while the app is in the foreground. Anything
   * other than `reserved` means this phone has no address a stranger could dial, so
   * it cannot hand out an invitation — which the chat banner says out loud, before
   * the user taps Invite and finds out.
   */
  relayStatus: RelayReservationStatus;
  /**
   * The options the node last started with, read once at launch for the Settings form
   * to prefill from. Null until that read resolves, and when nothing is saved.
   */
  savedStartOptions: PhoneNodeOptions | null;
  /** Start the node with the given options */
  start: (opts: PhoneNodeOptions) => Promise<void>;
  /** Stop the node */
  stop: () => Promise<void>;
  /**
   * Apply a base64url-encoded seed. Accepted only when this node already anchors the
   * seed's signer: it founded the cadre, or an operator pinned the key (a redeemed
   * invitation does that — see {@link joinExistingCadre}).
   */
  applySeed: (encoded: string) => Promise<void>;
  /**
   * Where "Join my existing cadre" is (`join-flow.ts`): set by {@link joinExistingCadre}, and
   * after a launch or Connect into a party whose join an earlier session left unfinished.
   * Null when nothing is on screen. Held here, not in Settings, so it survives a tab switch.
   */
  joinFlow: JoinFlow | null;
  /** This app's peer id, the same in every party; answered with no node running. */
  identityPeerId: () => Promise<string>;
  /** The join request this app shows (`sereus-join-request:1.…`) for the app holding the cadre to answer. */
  joinRequestText: () => Promise<string>;
  /**
   * Join the cadre a pasted response or invitation (`sereus-invite:1.…`) names, then move this
   * app's chats into it and remove the cadre it leaves, each step shown in {@link joinFlow}.
   * The kit's `PhoneNode.joinCadre` stops the node, starts it in the invitation's party and
   * redeems there, waiting for one of the members it lists to answer; needs no started node.
   *
   * Throws, with no flow left on screen and the app back in the cadre it ran before, when the
   * join itself does not happen: the decoder's error, a response made for another app's request,
   * the redemption's error (`describeJoinFailure` words them), or `JoinCancelledError` after
   * {@link cancelJoin}. Once a member admitted the app it does not throw: what is left to do
   * shows as a step.
   */
  joinExistingCadre: (encoded: string) => Promise<void>;
  /** Cancel the join while it waits for a member; does nothing once admitted, which the kit never rolls back. */
  cancelJoin: () => void;
  /** Adopt the chats a join left waiting, then remove the old cadre once none waits. Ignored while a step runs. */
  retryStrandMove: () => Promise<void>;
  /**
   * Remove the cadre this app founded and left; `discard` gives up the strand and join ids the
   * joined cadre does not hold. Ignored while a step runs.
   */
  removeOldCadre: (discard?: string[]) => Promise<void>;
  /** Keep the old cadre with what only it holds (the other answer to `confirm-discard`). */
  keepOldCadre: () => void;
  /** Clear the flow off the screen. */
  dismissJoinFlow: () => void;
  /** Dial a peer by multiaddr while already connected */
  dialPeer: (addr: string) => Promise<void>;
  /** Create a new chat strand and return its instance */
  createStrand: (strandId: string) => Promise<StrandInstance>;
  /**
   * Create a CLOSED chat strand with the given id, mint + publish a formation invite
   * bound to it, and return the encoded `OpenInvitation` to hand an invitee
   * out-of-band. The caller picks the id so its own logs name the same strand as
   * cadre-core's founding trace.
   */
  createClosedStrandWithInvite: (strandId: string) => Promise<string>;
  /**
   * Join a closed strand from an encoded `OpenInvitation`: run the consent
   * handshake (`formStrand`), then attach the host's closed strand using the
   * strand id + membership key the result carries.
   */
  joinViaInvite: (encoded: string) => Promise<StrandInstance>;
  /**
   * Whether this device's owner key is one of the cadre's owner keys. Only an owner can
   * add a node: a claim signed by any other key would leave the node owned by a key the
   * cadre does not trust. False when the node is not running.
   */
  isOwnerDevice: () => Promise<boolean>;
  /**
   * Add a cadre-host node to this cadre from its decoded node code (`node-claim.ts` →
   * `readNodeCode`), through `CadreNode.claimNode`. Resolves once the node accepted the
   * claim; the node then restarts once under this cadre, and this phone's reconcile passes
   * reconnect to it. Throws `claimNode`'s errors (`describeClaimFailure` puts them into
   * words), or a plain `Error` when the node is not running or another claim is running.
   * Callers check {@link isOwnerDevice} first.
   */
  claimHostNode: (payload: NodeClaimPayload) => Promise<void>;
  /**
   * Whether `peerId` is already a machine of this cadre (a `CadrePeer` row that is not
   * revoked), so an owner is not offered an invitation for an app the cadre holds. False
   * when the node is not running.
   */
  isMemberPeer: (peerId: string) => Promise<boolean>;
  /**
   * Mint an invitation into this cadre (`CadreNode.createCadreInvitation`): for one app's
   * peer id, or for whoever redeems it first. Throws when this device holds no owner key,
   * or when neither it nor any other machine of the cadre has an address a device could dial.
   */
  createCadreInvitation: (options: CreateCadreInvitationOptions) => Promise<CreateCadreInvitationResult>;
  /** Every cadre invitation this node holds, with its standing (`CadreNode.listCadreInvitations`). */
  listCadreInvitations: () => Promise<CadreInviteStatus[]>;
  /**
   * Withdraw a cadre invitation by its key (`CadreNode.withdrawCadreInvitation`). False when
   * it was already withdrawn or is not held here.
   */
  withdrawCadreInvitation: (key: string) => Promise<boolean>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useCadreInternal(): UseCadreResult {
  const [status, setStatus] = useState<CadreStatus>(() =>
    getPhoneNode()?.isRunning ? 'connected' : 'idle',
  );
  const [node, setNode] = useState<CadreNode | null>(getPhoneNode);
  const [peerId, setPeerId] = useState<string | null>(
    () => getPhoneNode()?.peerId?.toString() ?? null,
  );
  const [ownerPublicKey, setOwnerPublicKey] = useState<string | null>(
    () => getOwnerPublicKey(),
  );
  const [noiseCryptoMode, setNoiseCryptoMode] = useState<NoiseCryptoMode | null>(
    () => getNoiseCryptoMode(),
  );
  const [strands, setStrands] = useState<Map<string, StrandInstance>>(
    () => getPhoneNode()?.getStrands() ?? new Map(),
  );
  const [selectedStrandId, setSelectedStrandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runnerState, setRunnerState] = useState<RunnerState>('foreground');
  const [resuming, setResuming] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [relayStatus, setRelayStatus] = useState<RelayReservationStatus>(() => getRelayState().status);
  const [savedStartOptions, setSavedStartOptions] = useState<PhoneNodeOptions | null>(null);
  const [joinFlow, setJoinFlowState] = useState<JoinFlow | null>(null);

  // `joinFlow` as of now, for callbacks that must not act on a render's copy: a second Join,
  // and the launch check racing a join.
  const joinFlowRef = useRef<JoinFlow | null>(null);
  // Cancels the join; set while it waits for a member.
  const joinAbortRef = useRef<AbortController | null>(null);
  // Chats the join on screen has moved so far, for the `done` step. 0 when the flow resumed a
  // join an earlier session left, which recorded no count.
  const movedRef = useRef(0);

  // Track the latest node so event handlers always reference it
  const nodeRef = useRef<CadreNode | null>(node);
  nodeRef.current = node;

  // Last options passed to `start` (a Connect tap, or the launch resume below with the
  // saved ones), so the BackgroundRunner can cold-start the node (re-run
  // `startPhoneNode`) on a foreground return after the OS killed it.
  const optsRef = useRef<PhoneNodeOptions | null>(null);
  const runnerRef = useRef<BackgroundRunner | null>(null);

  // True while a node claim runs. A ref, not state: the guard has to hold against a
  // same-frame second tap, which a re-render cannot.
  const claimingRef = useRef(false);

  // ── Strand event sync ──────────────────────────────────────────────────

  const refreshStrands = useCallback(() => {
    const current = nodeRef.current;
    if (current?.isRunning) {
      setStrands(new Map(current.getStrands()));
    }
  }, []);

  // Pick a strand to view. Persists until changed or the strand disappears
  // (the derivation below guards on presence, so a stale/unsynced id falls back
  // to the deterministic default rather than dangling).
  const selectStrand = useCallback((strandId: string) => {
    setSelectedStrandId(strandId);
  }, []);

  // Deterministically derive the strand the chat renders. Order-independent of
  // the Map's insertion order, so it never depends on the create-vs-control-sync
  // race (see strand-selection.ts).
  const activeStrand = useMemo<StrandInstance | null>(() => {
    const activeId = pickActiveStrandId([...strands.keys()], selectedStrandId);
    return activeId !== null ? strands.get(activeId) ?? null : null;
  }, [strands, selectedStrandId]);

  // Subscribe to strand lifecycle events
  useEffect(() => {
    if (!node) return;

    const onStarted = () => refreshStrands();
    const onStopped = () => refreshStrands();
    const onError = ({ strandId, error: err }: CadreNodeEvents['strand:error']) => {
      console.warn(`Strand ${strandId} error:`, err);
      refreshStrands();
    };

    // A strand this node holds no config for was offered — created by another member,
    // created by US in a previous session (sApp configs are in-memory only, so every
    // stored strand is "unclaimed" again after a restart), or joined from another party
    // in a previous session (the node remembers those joins and re-offers them). OPEN
    // strands (`Type:'o'`) are auto-joined — "anyone can participate". A CLOSED strand
    // (`Type:'c'`) is auto-joined only when its row carries the read secret: a remembered
    // join is the product of an earlier `joinViaInvite`'s consent, and our own party's
    // closed strand carries its key in the control row. A closed row without the key
    // stays unclaimed in the node's discovered map; the way in is the explicit consent
    // handshake (`joinViaInvite` → `formStrand`).
    //
    // A closed strand is re-attached through `joinChatStrand` with the offered row
    // unchanged, NOT `joinClosedChatStrand`: that helper rebuilds the row with a null
    // `FounderOwnerKey`, which would join our own orphaned closed strand rather than found
    // it (see the NOTE below), and it writes the `member` role the first attach already
    // wrote.
    //
    // NOTE: this passes no `founder` flag, and needs none — the `Strand` row records the
    // machine that published it (`FounderOwnerKey`), and `CadreNode` derives founder-ness
    // from it at launch. So attaching our OWN orphaned strand here (published, then the
    // app died before founding) runs the founder bootstrap and seats its `Strand.Header`,
    // while attaching another party's strand joins without writing anything — the handler
    // no longer has to tell the two apart.
    //
    // Reached from BOTH the event and the catch-up drain below, so it must be
    // idempotent. `getStrands().has(strandId)` alone is not enough: the strand
    // manager only tracks an instance once `addStrand` has resolved, and this is
    // fire-and-forget, so two offers seconds apart could both pass that check and
    // launch twice. `joining` closes that window.
    //
    // NOTE: `joining` is per effect RUN, which is sufficient only because this
    // effect's deps are `[node, refreshStrands]` and `refreshStrands` is stable
    // (`useCallback` with `[]`) — so a re-run means a different node, with its own
    // backlog and nothing in flight from the old one. If this effect ever gains a
    // dep that changes under a live node, or the app mounts under React's
    // `StrictMode` (which runs cleanup and re-runs the effect on the same node),
    // a fresh set would let a second launch through: hoist it to a `useRef` then.
    const joining = new Set<string>();
    const claimDiscovered = ({ strandId, strand }: CadreNodeEvents['strand:discovered']) => {
      if (strand.Type !== 'o' && !strand.MemberPrivateKey) return;
      if (node.getStrands().has(strandId)) return;
      if (joining.has(strandId)) return;
      joining.add(strandId);
      void (async () => {
        try {
          await joinChatStrand(node, strand);
          refreshStrands();
        } catch (err) {
          console.warn(`Failed to auto-join discovered strand ${strandId}:`, err);
        } finally {
          joining.delete(strandId);
        }
      })();
    };

    // A strand that came up `'syncing'` (a joiner still waiting for the other
    // member's data) mutates in place when it becomes writable; the Map copy is
    // what makes React re-render, so `useChat`'s `strand.database` effects fire.
    const onWritable = () => refreshStrands();

    node.on('strand:started', onStarted);
    node.on('strand:stopped', onStopped);
    node.on('strand:error', onError);
    node.on('strand:writable', onWritable);
    node.on('strand:discovered', claimDiscovered);

    // Catch up on strands discovered BEFORE this effect could subscribe. The
    // watcher's first poll runs inside `CadreNode.start()`, which resolves before
    // `startPhoneNode` does (it still has owner genesis to await) and long before
    // React runs this effect — so on a restart into a party that already has
    // strands, every `strand:discovered` fires into an empty listener list. The
    // node keeps those strands in `getDiscoveredStrands()`; this drains them.
    //
    // Subscribe-then-drain, in that order: a strand discovered between the two
    // steps is then offered twice (harmless — `claimDiscovered` is idempotent)
    // rather than zero times.
    for (const [strandId, strand] of node.getDiscoveredStrands()) {
      claimDiscovered({ strandId, strand });
    }

    return () => {
      node.off('strand:started', onStarted);
      node.off('strand:stopped', onStopped);
      node.off('strand:error', onError);
      node.off('strand:writable', onWritable);
      node.off('strand:discovered', claimDiscovered);
    };
  }, [node, refreshStrands]);

  // Show `running` (the kit's node, or none) and what is read off it.
  const showNode = useCallback((running: CadreNode | null) => {
    setNode(running);
    nodeRef.current = running;
    setPeerId(running?.peerId?.toString() ?? null);
    setOwnerPublicKey(getOwnerPublicKey());
    setNoiseCryptoMode(getNoiseCryptoMode());
    setStrands(new Map(running?.getStrands() ?? []));
  }, []);

  // Take on whatever node the kit runs now (or none), after a transition the kit drove
  // from start to finish: a join switches the node, or puts the left party's back.
  const adoptRunningNode = useCallback(() => {
    showNode(getPhoneNode());
    // The runner's cold start must start the party the app is in now.
    optsRef.current = getRunningOptions() ?? optsRef.current;
    const kit = getPhoneNodeStatus();
    if (kit.state === 'failed') setError(kit.error.message);
    setStatus(kit.state === 'running' ? 'connected' : kit.state === 'failed' ? 'error' : 'idle');
  }, [showNode]);

  // ── Background lifecycle (AppState-driven) ───────────────────────────────

  // Cold-start hook for the runner: re-run `startPhoneNode` with the last opts
  // when a foreground return finds the node stopped/killed, then re-sync React
  // state. Idempotent (startPhoneNode no-ops a running node).
  const ensureNode = useCallback(async () => {
    const opts = optsRef.current;
    if (!opts) return;
    showNode(await startPhoneNode(opts));
  }, [showNode]);

  // Own the OS foreground/background lifecycle once the node exists. The runner
  // observes the node singleton (it does not fight the manual Settings start/stop)
  // and tears down its AppState + node listeners on unmount/stop.
  useEffect(() => {
    if (!node) return;
    const runner = createBackgroundRunner({
      getNode: getPhoneNode,
      appState: createReactNativeAppState(),
      ensureNode,
    });
    runnerRef.current = runner;
    const sync = () => {
      setRunnerState(runner.state);
      setResuming(runner.resuming);
      setDegraded(runner.degraded);
    };
    const unsubscribe = runner.onStateChange(sync);
    runner.start();
    sync();
    return () => {
      unsubscribe();
      runner.stop();
      runnerRef.current = null;
    };
  }, [node, ensureNode]);

  // ── Relay posture (dialability) ─────────────────────────────────────────

  // Poll the node's relay posture so the banner can say "not reachable" before an
  // invite is attempted, and stop saying it once a down relay comes back — the
  // supervisor re-drives on its own backoff, with no event to subscribe to.
  //
  // Polling stops while backgrounded, so this timer costs nothing when the screen is
  // off. cadre-core's own reservation supervisor does keep running there — see the
  // NOTE beside `relayAddrs` in `@serfab/cadre-rn/phone-node`'s `buildPhoneNodeConfig`.
  useEffect(() => {
    if (!node) {
      setRelayStatus('none');
      return;
    }
    if (runnerState !== 'foreground') return;
    const sync = () => setRelayStatus(getRelayState().status);
    sync();
    const timer = setInterval(sync, RELAY_POSTURE_POLL_MS);
    return () => clearInterval(timer);
  }, [node, runnerState]);

  const setJoinFlow = useCallback((flow: JoinFlow | null) => {
    joinFlowRef.current = flow;
    setJoinFlowState(flow);
  }, []);

  // A join an earlier session left unfinished, found once the node runs in the joined party:
  // the app was killed between the join's steps, or the user tapped Later. The old cadre is
  // still named as `formerPartyId` until it is removed.
  //
  // NOTE: an old cadre kept on purpose (it has other machines, or the user kept what only it
  // holds) is still named, so every Connect and launch shows it again, with Later to dismiss.
  // If that nags, remember the answer per old party in the node-local store.
  const resumeUnfinishedJoin = useCallback(async () => {
    if (joinFlowRef.current || getRunningOptions()?.formerPartyId === undefined) return;
    let waiting: string[] | undefined;
    try {
      waiting = (await pendingStrandMove())?.strandIds;
    } catch (err) {
      // Removing the old cadre reads the same record, and says what failed.
      console.warn('[use-cadre] could not read the strand move a join left:', err);
    }
    if (joinFlowRef.current) return;
    movedRef.current = 0;
    setJoinFlow(waiting
      ? { step: 'move-incomplete', moved: 0, waiting, ...recordedMoveStall() }
      : { step: 'old-cadre-remains' });
  }, [setJoinFlow]);

  // ── Actions ────────────────────────────────────────────────────────────

  const start = useCallback(async (opts: PhoneNodeOptions) => {
    try {
      setStatus('connecting');
      setError(null);
      optsRef.current = opts;
      showNode(await startPhoneNode(opts));
      setStatus('connected');
      // Acquire + publish the FCM/APNs device token so a server peer can push-wake
      // this phone while suspended. Best-effort: permission-denied / pre-membership
      // defers silently and retries on the next start (see push-wake-native).
      void acquireAndRegisterDeviceToken();
      void resumeUnfinishedJoin();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('error');
    }
  }, [showNode, resumeUnfinishedJoin]);

  // ── Launch: resume the last session ────────────────────────────────────

  // The provider is mounted at the app root, so this runs once per launch. A session
  // that ended connected (anything but Disconnect — an OS kill included) starts again
  // with the options it last started with, through `start`, so status, device-token
  // registration and every other side effect of Connect happen exactly as for a tap.
  //
  // Through `start` even when a push wake already started the node in this JS runtime:
  // `startPhoneNode` hands back the running node, or joins that start while it is still
  // in flight, so the hook's state catches up with it either way (the initial state read
  // the singleton only once, at first render) and `optsRef` gets the saved options for
  // the runner's cold start. A Connect tap that beat this read owns `optsRef` already
  // and is not second-guessed.
  useEffect(() => {
    let unmounted = false;
    const resume = async () => {
      let saved: SavedStartOptions | undefined;
      try {
        saved = await loadSavedStartOptions();
      } catch (err) {
        // NOTE: fields stay blank, so a Connect now mints a new party id and, on
        // success, overwrites the unreadable record. Acceptable because the party-scoped
        // stores live in the same database and propagate a read fault, which fails that
        // start before anything is saved.
        console.warn('[use-cadre] could not read the saved start options:', err);
        if (!unmounted) {
          setError(`Could not read the saved connection settings: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (unmounted || !saved) return;
      setSavedStartOptions(saved.options);
      if (!saved.autoStart || optsRef.current) return;
      await start(saved.options);
    };
    void resume();
    return () => {
      unmounted = true;
    };
  }, [start]);

  const stop = useCallback(async () => {
    // The singleton reads null from the moment `stopPhoneNode` begins its teardown, so a
    // foreground return during Disconnect would have the runner cold-start the node
    // straight back once the stop finishes. With no options the runner's `ensureNode`
    // does nothing.
    optsRef.current = null;
    // Clear the DeviceToken row + drop the rotation listener before stopping, so a
    // logged-out phone is no longer push-wake addressable. Best-effort (logs on
    // failure); must run before stopPhoneNode tears the node down.
    await clearDeviceTokenRegistration();
    await stopPhoneNode();
    showNode(null);
    setSelectedStrandId(null);
    // A step left on screen acts on the running node; the next Connect shows it again.
    setJoinFlow(null);
    setStatus('idle');
  }, [showNode, setJoinFlow]);

  const applySeed = useCallback(async (encoded: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const seed = current.decodeSeed(encoded);
    const result = await current.applySeed(seed);
    if (!result.success) {
      throw new Error(result.error ?? 'Seed application failed');
    }
  }, []);

  // ── Joining an existing cadre ──────────────────────────────────────────

  // A join or a dissolve stops this node at once and runs another (or the same party's again)
  // when it ends. Until then the hook holds none, so no screen writes through a stopped node.
  const showSwitching = useCallback((flow: JoinFlow) => {
    setJoinFlow(flow);
    setStatus('connecting');
    showNode(null);
  }, [setJoinFlow, showNode]);

  // After a join or a dissolve: take on the node the kit runs now, and refill the Connect form
  // from its party, or Disconnect → Connect would start the party the form was filled from.
  const adoptSwitchedNode = useCallback(() => {
    adoptRunningNode();
    const running = getRunningOptions();
    if (running) setSavedStartOptions(running);
  }, [adoptRunningNode]);

  const dissolveOldCadre = useCallback(async (discard?: string[]) => {
    showSwitching({ step: 'removing-old-cadre' });
    let next: JoinFlow;
    try {
      await dissolveFormerParty(discard ? { discard } : undefined);
      next = doneFlow(movedRef.current);
    } catch (err) {
      next = flowAfterRefusedDissolve(err, movedRef.current);
    }
    adoptSwitchedNode();
    setJoinFlow(next);
  }, [showSwitching, adoptSwitchedNode, setJoinFlow]);

  // Admitted: finish the move the join reported, then remove the cadre the app left, as far as
  // each goes now; what is left shows as a step.
  const settleAfterJoin = useCallback(async (joined: JoinCadreResult) => {
    const move = joined.strandMove;
    movedRef.current = move && 'report' in move ? move.report.moved.length : 0;
    const stall = joinMoveStall(move);
    if (stall) {
      setJoinFlow(await incompleteMoveFlow(movedRef.current, stall));
    } else if (joined.formerPartyId !== undefined) {
      await dissolveOldCadre();
    } else {
      setJoinFlow(doneFlow(movedRef.current));
    }
  }, [setJoinFlow, dissolveOldCadre]);

  const joinExistingCadre = useCallback(async (encoded: string) => {
    const invitation = decodeCadreInvitation(encoded);
    await refuseResponseForAnotherApp(invitation);
    // After the last await before the flow is set, so two taps in one frame cannot both pass.
    if (joinFlowRef.current) throw new Error('A join is already on screen; finish it first.');
    const controller = new AbortController();
    joinAbortRef.current = controller;
    movedRef.current = 0;
    setError(null);
    showSwitching({ step: 'joining' });
    let joined: JoinCadreResult;
    try {
      joined = await joinCadreByInvitation(invitation, {
        signal: controller.signal,
        onProgress: (progress) => setJoinFlow(flowForProgress(progress)),
      });
    } catch (err) {
      setJoinFlow(null);
      throw controller.signal.aborted ? new JoinCancelledError() : err;
    } finally {
      joinAbortRef.current = null;
      adoptSwitchedNode();
    }
    await settleAfterJoin(joined);
    // As after a Connect: publish the device token, now in the joined party. After the old
    // cadre's removal, which restarts the node.
    void acquireAndRegisterDeviceToken();
  }, [showSwitching, setJoinFlow, adoptSwitchedNode, settleAfterJoin]);

  const cancelJoin = useCallback(() => {
    if (joinFlowRef.current?.step === 'joining') joinAbortRef.current?.abort();
  }, []);

  const removeOldCadre = useCallback(async (discard?: string[]) => {
    if (!flowRunning(joinFlowRef.current)) await dissolveOldCadre(discard);
  }, [dissolveOldCadre]);

  // The move runs on the running node; nothing stops.
  const retryStrandMove = useCallback(async () => {
    if (flowRunning(joinFlowRef.current)) return;
    setJoinFlow({ step: 'moving-strands' });
    let report: Awaited<ReturnType<typeof finishStrandMove>>;
    try {
      report = await finishStrandMove();
    } catch (err) {
      setJoinFlow(await incompleteMoveFlow(movedRef.current, retryMoveStall(err)));
      return;
    }
    // The adoption seated strands, and wired the owner key when it was not yet.
    adoptRunningNode();
    if (report) movedRef.current = report.moved.length;
    if (report && report.failed.length > 0) {
      setJoinFlow(await incompleteMoveFlow(movedRef.current, { reason: 'partial' }));
    } else {
      await dissolveOldCadre();
    }
  }, [setJoinFlow, adoptRunningNode, dissolveOldCadre]);

  const keepOldCadre = useCallback(() => {
    setJoinFlow({ step: 'old-cadre-kept', otherMachines: [] });
  }, [setJoinFlow]);

  const dismissJoinFlow = useCallback(() => {
    setJoinFlow(null);
  }, [setJoinFlow]);

  const dialPeer = useCallback(async (addr: string) => {
    await dialPeerImpl(addr);
  }, []);

  const createStrand = useCallback(async (strandId: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const instance = await createChatStrand(current, strandId);
    // Explicit user action selects it — this is what keeps the chat on the
    // phone-created strand even if the drone's pre-created strand syncs in.
    setSelectedStrandId(instance.strandId);
    refreshStrands();
    return instance;
  }, [refreshStrands]);

  // ── Closed-strand consent flow ─────────────────────────────────────────

  // Host: create a closed strand, then mint + persist a formation invite BOUND to
  // that strand (the `strandId` option threads onto the FormationInvite row so the
  // responder provisions the host's actual strand at redemption). The OpenInvitation
  // alone is handed out — it carries the formation token + the host's bootstrap
  // addrs; the strand id + membership key are delivered over the protocol after
  // consent, no side-channel envelope.
  const createClosedStrandWithInvite = useCallback(async (strandId: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    // The invitation also names the party's other machines, but only this node runs
    // the strand it is about to found, so an unreachable node cannot invite anyone —
    // refuse BEFORE founding, or every attempt leaves an orphaned closed strand behind.
    // A phone is reachable only through a relay; see `relay-config.ts` for where that
    // address comes from.
    if (current.getMultiaddrs().length === 0) {
      // Read the posture LIVE rather than off `relayStatus`: a relay that came back
      // seconds ago must not be reported as down, and one lost seconds ago must not be
      // reported as held.
      throw new Error(unreachableInviteMessage(getRelayState()));
    }
    await createClosedChatStrand(current, strandId);
    setSelectedStrandId(strandId);
    const invitation = await createOpenInvitation(CHAT_SAPP_ID, INVITE_EXPIRY_MS);
    await publishFormationInvite(invitation.token, CHAT_SAPP_ID, {
      expiresAtMs: invitation.expiration.getTime(),
      strandId,
    });
    const encoded = current.encodeInvitation(invitation);
    refreshStrands();
    return encoded;
  }, [refreshStrands]);

  // Invitee: decode the OpenInvitation, run the explicit consent handshake against
  // the host (formStrand validates our disclosure + the token, and the host
  // provisions + returns its strand id + membership key), then attach that closed
  // strand locally (schema-gated). A failed handshake throws — joining a closed
  // strand REQUIRES the host's consent and reachability.
  const joinViaInvite = useCallback(async (encoded: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const invitation = current.decodeInvitation(encoded);
    const disclosure: StrandFormationDisclosure = {
      partyId: current.peerId?.toString(),
      purpose: 'join closed chat strand',
      metadata: { app: CHAT_SAPP_ID },
    };
    const formResult = await formStrand(invitation, disclosure);
    const instance = await joinClosedChatStrandFromFormation(current, formResult);
    setSelectedStrandId(instance.strandId);
    refreshStrands();
    return instance;
  }, [refreshStrands]);

  // ── Adding a cadre-host node (claim by its code) ───────────────────────

  const isOwnerDevice = useCallback(async () => {
    const controlDb = nodeRef.current?.getControlDatabase();
    const ownerKey = getOwnerPublicKey();
    if (!controlDb || !ownerKey) return false;
    return (await controlDb.getOwnerKeys()).has(ownerKey);
  }, []);

  // Stopping the node during a claim needs no cleanup here: `claimNode` writes nothing
  // before the node accepts, so the claim just fails.
  //
  // NOTE: accepted tradeoff — killed or disconnected between the node accepting and
  // `claimNode` writing the node's `CadrePeer` row (one local insert), the node belongs
  // to this owner while this phone has no row, and the code is gone with the process
  // (the host stops showing it once claimed). The recovery is Reset on the machine and a
  // fresh scan. Revisit if a device run sees that window hit (slow control writes on React
  // Native): persist the pending code in the app-private `sereus-node-local` store and
  // finish the claim on the next start.
  const claimHostNode = useCallback(async (payload: NodeClaimPayload) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    if (claimingRef.current) throw new Error('A node is already being added');
    claimingRef.current = true;
    try {
      await current.claimNode(payload);
    } finally {
      claimingRef.current = false;
    }
  }, []);

  // ── Adding a device or app (cadre invitations) ─────────────────────────

  const isMemberPeer = useCallback(async (candidate: string) => {
    const controlDb = nodeRef.current?.getControlDatabase();
    if (!controlDb) return false;
    return (await controlDb.queryCadrePeers()).some((row) => row.peerId === candidate);
  }, []);

  const createCadreInvitation = useCallback(async (options: CreateCadreInvitationOptions) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await createCadreInvitationImpl(options);
  }, []);

  const listCadreInvitations = useCallback(async () => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await listCadreInvitationsImpl();
  }, []);

  const withdrawCadreInvitation = useCallback(async (key: string) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await withdrawCadreInvitationImpl(key);
  }, []);

  return {
    status, node, peerId, ownerPublicKey, noiseCryptoMode, strands,
    selectedStrandId, activeStrand, selectStrand,
    error, runnerState, resuming, degraded, relayStatus, savedStartOptions,
    start, stop, applySeed, dialPeer, createStrand,
    joinFlow, identityPeerId, joinRequestText, joinExistingCadre, cancelJoin, retryStrandMove,
    removeOldCadre, keepOldCadre, dismissJoinFlow,
    createClosedStrandWithInvite, joinViaInvite, isOwnerDevice, claimHostNode,
    isMemberPeer, createCadreInvitation, listCadreInvitations, withdrawCadreInvitation,
  };
}

