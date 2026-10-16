/**
 * use-cadre.ts — React hook for CadreNode lifecycle management.
 *
 * Manages the singleton phone node, exposes connection status, and provides
 * methods for joining an existing cadre, seed application and strand creation.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { finishRental, rentNode, type CadreNode } from '@serfab/cadre-core';
import type {
  StrandInstance,
  CadreNodeEvents,
  RelayReservationState,
  RelayReservationStatus,
  StrandFormationDisclosure,
  NodeClaimPayload,
  CadreInviteStatus,
  CadreMachine,
  CreateCadreInvitationOptions,
  CreateCadreInvitationResult,
  MachineRemovalPlan,
  MachineRemovalResult,
  CadreOwnerKey,
  ExportedOwnerKey,
  ImportedOwnerKey,
  OwnerKeyExportOptions,
  OwnerKeyRemovalPlan,
  OwnerKeyRemovalResult,
  RemoveOwnerOptions,
  ProviderClient,
  RentalFailed,
  RentNodeResult,
  RentNodeStep,
} from '@serfab/cadre-core';
import type { Rental } from '@serfab/cadre-rn/provider';
import { recordingClient } from './rentals';
import {
  rentals,
  startPhoneNode,
  stopPhoneNode,
  getPhoneNode,
  getOwnerPublicKey,
  getNoiseCryptoMode,
  getRelayState,
  getRunningOptions,
  getPhoneNodeStatus,
  onPhoneNodeStatus,
  loadSavedStartOptions,
  dialPeer as dialPeerImpl,
  createOpenInvitation,
  publishFormationInvite,
  formStrand,
  createCadreInvitation as createCadreInvitationImpl,
  listCadreInvitations as listCadreInvitationsImpl,
  withdrawCadreInvitation as withdrawCadreInvitationImpl,
  listMachines as listMachinesImpl,
  planMachineRemoval as planMachineRemovalImpl,
  removeMachine as removeMachineImpl,
  listOwnerKeys as listOwnerKeysImpl,
  addBackupOwnerKey as addBackupOwnerKeyImpl,
  exportOwnerKey as exportOwnerKeyImpl,
  importOwnerKey as importOwnerKeyImpl,
  planOwnerKeyRemoval as planOwnerKeyRemovalImpl,
  removeOwner as removeOwnerImpl,
  identityPeerId,
  joinRequestText,
  type PhoneNodeOptions,
  type PhoneNodeStatus,
  type SavedStartOptions,
} from './cadre-phone';
import { useJoinFlow, type JoinFlowActions } from './use-join-flow';
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


export type CadreStatus = 'idle' | 'connecting' | 'connected' | 'error';

export type SavedStartRead = 'reading' | 'read' | 'failed';

/** This app's removal from a cadre by one of its owners, as the kit reported it (its `removed` status). */
export interface RemovedFrom {
  partyId: string;
  /** The owner key that removed this app, when this phone could verify it; null otherwise. */
  signerKey: string | null;
  /** The cadre this app founded and left, which {@link UseCadreResult.returnToOwnCadre} starts. */
  formerPartyId?: string;
}

export interface RentProviderNodeOptions {
  /** Each `rentNode` step, for a progress line. */
  onProgress?: (step: RentNodeStep) => void;
  /** The container the provider created, as soon as its record is written and before the join goes on. */
  onCreated?: (containerId: string) => void;
}

export interface UseCadreResult extends JoinFlowActions {
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
   * The options the node last started with, read at launch for the Settings form to
   * prefill from, and replaced by every start, join or dissolve that succeeds. Null until
   * that read resolves, and while nothing is saved.
   */
  savedStartOptions: PhoneNodeOptions | null;
  /**
   * How the launch read of the saved start went: `read` whether or not it found one, so
   * `read` with null {@link savedStartOptions} means this app has no party yet.
   */
  savedStartRead: SavedStartRead;
  /**
   * Set when an owner removed this app from its cadre: the kit has stopped the node and deleted
   * that cadre's data from this phone. Status is `idle`. Cleared when a node runs again, and by
   * {@link dismissRemoval}.
   */
  removedFrom: RemovedFrom | null;
  /** Clear {@link removedFrom} off the screen. */
  dismissRemoval: () => void;
  /**
   * After a removal: start the cadre this app founded and left, which the saved start names
   * (with auto-start off) once the kit has acted on the removal. Throws when no start is saved.
   */
  returnToOwnCadre: () => Promise<void>;
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
  /** This app's peer id, the same in every party; answered with no node running. */
  identityPeerId: () => Promise<string>;
  /** The join request this app shows (`sereus-join-request:1.…`) for the app holding the cadre to answer. */
  joinRequestText: () => Promise<string>;
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
  /** The cadre's machines as this node judges them (`CadreNode.listMachines`). */
  listMachines: () => Promise<CadreMachine[]>;
  /** What removing a machine would do, read without writing (`CadreNode.planMachineRemoval`). */
  planMachineRemoval: (peerId: string) => Promise<MachineRemovalPlan>;
  /**
   * Remove a machine from the cadre (`CadreNode.removeMachine`). Throws `MachineRemovalRefusedError`
   * on a refusal; all false when it was already removed.
   */
  removeMachine: (peerId: string) => Promise<MachineRemovalResult>;
  /** The cadre's live owner keys (`CadreNode.listOwnerKeys`). */
  listOwnerKeys: () => Promise<CadreOwnerKey[]>;
  /**
   * Seat a new owner key under `options.label`, signed by this device's owner key, and return its
   * export, the only copy. Throws `OwnerKeyAddRefusedError` `alone` while this phone has no
   * connection to a cadre that has other machines.
   */
  addBackupOwnerKey: (options: OwnerKeyExportOptions) => Promise<ExportedOwnerKey>;
  /**
   * This app's own owner key as export text, with the key it holds, which can differ from
   * {@link ownerPublicKey} (the kit's `exportOwnerKey`); throws when it holds none of its own.
   */
  exportOwnerKey: (options: OwnerKeyExportOptions) => Promise<ExportedOwnerKey>;
  /**
   * Store an exported owner key in this app's owner slot, and sign with it at once when the cadre
   * lists it (`wired`, and {@link ownerPublicKey} follows). Throws the kit's refusals:
   * `OwnerKeyExportError`, and `OwnerKeySlotOccupiedError` when this app holds another key.
   */
  importOwnerKey: (text: string, passphrase?: string) => Promise<ImportedOwnerKey>;
  /** What removing an owner key would do, read without writing (`CadreNode.planOwnerKeyRemoval`). */
  planOwnerKeyRemoval: (key: string) => Promise<OwnerKeyRemovalPlan>;
  /** Remove an owner key, re-vouching first the rows `options.revouch` keeps (`CadreNode.removeOwner`). Throws `OwnerKeyRemovalRefusedError` on a refusal. */
  removeOwner: (key: string, options: RemoveOwnerOptions) => Promise<OwnerKeyRemovalResult>;
  /**
   * Rent a node from the provider `client` talks to and add it to this cadre (cadre-core's
   * `rentNode`, by claim or by invitation as the cadre's reach decides). The rental is recorded for
   * this party as soon as the provider creates the container, `finished: false`, and marked finished
   * when `rentNode` returns, so a kill in between leaves a record {@link finishProviderRental} resumes;
   * `onCreated` tells the caller the container id at the same moment, so a step retried after the
   * provider refused the token resumes that container rather than renting a second one. Throws
   * `rentNode`'s errors (`describeRentalFailure` puts them into words), or a plain `Error` when the
   * node is not running or another node is being added. Callers check {@link isOwnerDevice} first.
   */
  rentProviderNode: (provider: { id: string; name: string }, client: ProviderClient, options?: RentProviderNodeOptions) => Promise<RentNodeResult>;
  /**
   * Resume a rental this app did not finish (cadre-core's `finishRental`): the record is marked
   * finished when it returns done; a failed invitation join comes back as `RentalFailed` and the record stays.
   */
  finishProviderRental: (client: ProviderClient, containerId: string, onProgress?: (step: RentNodeStep) => void) => Promise<RentNodeResult | RentalFailed>;
  /** This party's rental records, oldest first. */
  listRentals: () => Promise<Rental[]>;
  /** Note a rented node's peer id once a status read reports it, for Devices and nodes. */
  noteRentalPeer: (containerId: string, peerId: string) => Promise<void>;
  /** Drop a rental record; the container, if it still exists, is untouched. */
  forgetRental: (containerId: string) => Promise<void>;
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
  const [savedStartRead, setSavedStartRead] = useState<SavedStartRead>('reading');
  const [removedFrom, setRemovedFrom] = useState<RemovedFrom | null>(null);
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

  // A join or a dissolve stops the node at once and runs another (or the same party's again) when it ends.
  const holdNoNode = useCallback(() => {
    setStatus('connecting');
    showNode(null);
  }, [showNode]);

  const { resumeUnfinishedJoin, ...joinFlowActions } = useJoinFlow({ holdNoNode, adoptRunningNode, setSavedStartOptions, setError });
  const { dismissJoinFlow } = joinFlowActions;

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

  // ── Actions ────────────────────────────────────────────────────────────

  const start = useCallback(async (opts: PhoneNodeOptions) => {
    try {
      setStatus('connecting');
      setError(null);
      optsRef.current = opts;
      showNode(await startPhoneNode(opts));
      setStatus('connected');
      // The kit saved this start; Settings asks before founding only while none is saved.
      setSavedStartOptions(getRunningOptions() ?? opts);
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
          setSavedStartRead('failed');
          setError(`Could not read the saved connection settings: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (unmounted) return;
      // Options before the read state, so no render sees `read` with a saved start still null.
      if (saved) setSavedStartOptions(saved.options);
      setSavedStartRead('read');
      if (!saved?.autoStart || optsRef.current) return;
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
    dismissJoinFlow();
    setStatus('idle');
  }, [showNode, dismissJoinFlow]);

  // ── Removed from the cadre by an owner ─────────────────────────────────

  // The runner's options name the removed party, and its cold start would build that party again
  // on empty storage. They go when the node reports the removal: the kit stops the node at once but
  // reports `removed` only after deleting the party's storage, and a foreground return in between
  // finds no node and cold-starts.
  useEffect(() => {
    if (!node) return;
    const onRemoved = () => {
      optsRef.current = null;
    };
    node.on('cadre:removed', onRemoved);
    return () => {
      node.off('cadre:removed', onRemoved);
    };
  }, [node]);

  // The kit has stopped the node and deleted the party's storage. Dropping the node stops the
  // runner. The saved start now names this app's own cadre with auto-start off, or nothing; the
  // Connect form refills from it.
  const forgetRemovedParty = useCallback((removed: Extract<PhoneNodeStatus, { state: 'removed' }>) => {
    optsRef.current = null;
    showNode(null);
    setSelectedStrandId(null);
    // A step left on screen acts on the node that is gone.
    dismissJoinFlow();
    setError(null);
    setStatus('idle');
    setRemovedFrom({ partyId: removed.partyId, signerKey: removed.removal.signerKey, formerPartyId: removed.formerPartyId });
    void loadSavedStartOptions().then(
      (saved) => setSavedStartOptions(saved?.options ?? null),
      (err: unknown) => console.warn('[use-cadre] could not read the saved start after this app was removed:', err),
    );
  }, [showNode, dismissJoinFlow]);

  // NOTE: a removal the kit fails to act on (its saved-start write throws) reports `failed` after
  // it has stopped the node, and this follows only `removed`, so the screen keeps showing the
  // stopped node as connected until Disconnect. If that failure is seen, treat `failed` with no
  // kit node as a stop here.
  useEffect(() => {
    const follow = (kit: PhoneNodeStatus) => {
      if (kit.state === 'removed') forgetRemovedParty(kit);
      else if (kit.state === 'running') setRemovedFrom(null);
    };
    const unsubscribe = onPhoneNodeStatus(follow);
    // A removal the kit acted on before this mounted (a push wake's node) is still its status.
    follow(getPhoneNodeStatus());
    return unsubscribe;
  }, [forgetRemovedParty]);

  const dismissRemoval = useCallback(() => {
    setRemovedFrom(null);
  }, []);

  // Read again rather than taken from `savedStartOptions`, which the removal refills asynchronously.
  const returnToOwnCadre = useCallback(async () => {
    const saved = await loadSavedStartOptions();
    if (!saved) throw new Error('This app has no cadre of its own saved on this phone.');
    await start(saved.options);
  }, [start]);

  const applySeed = useCallback(async (encoded: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const seed = current.decodeSeed(encoded);
    const result = await current.applySeed(seed);
    if (!result.success) {
      throw new Error(result.error ?? 'Seed application failed');
    }
  }, []);

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
    const current = nodeRef.current;
    return current ? await current.isOwner() : false;
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

  // ── Devices and nodes (listing and removing machines) ──────────────────

  const listMachines = useCallback(async () => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await listMachinesImpl();
  }, []);

  const planMachineRemoval = useCallback(async (peerId: string) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await planMachineRemovalImpl(peerId);
  }, []);

  const removeMachine = useCallback(async (peerId: string) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await removeMachineImpl(peerId);
  }, []);

  // ── Owner keys ─────────────────────────────────────────────────────────

  const listOwnerKeys = useCallback(async () => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await listOwnerKeysImpl();
  }, []);

  const addBackupOwnerKey = useCallback(async (options: OwnerKeyExportOptions) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await addBackupOwnerKeyImpl(options);
  }, []);

  const exportOwnerKey = useCallback(async (options: OwnerKeyExportOptions) => {
    return await exportOwnerKeyImpl(options);
  }, []);

  // A wired key changes what this device signs with, and every owner-only section re-reads its
  // standing when `ownerPublicKey` changes.
  const importOwnerKey = useCallback(async (text: string, passphrase?: string) => {
    const imported = await importOwnerKeyImpl(text, passphrase);
    setOwnerPublicKey(getOwnerPublicKey());
    return imported;
  }, []);

  const planOwnerKeyRemoval = useCallback(async (key: string) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await planOwnerKeyRemovalImpl(key);
  }, []);

  const removeOwner = useCallback(async (key: string, options: RemoveOwnerOptions) => {
    if (!nodeRef.current) throw new Error('Node not started');
    return await removeOwnerImpl(key, options);
  }, []);

  // ── Renting a node from a hosting provider ─────────────────────────────

  /** The running node, for a rental step; `claimingRef` is shared with `claimHostNode`, since both may claim. */
  const beginAddingNode = (): CadreNode => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    if (claimingRef.current) throw new Error('A node is already being added');
    claimingRef.current = true;
    return current;
  };

  // The claimed-without-a-row window the accepted tradeoff above names applies to a provider
  // claim too: `finishRental` then judges the container by its claim's party and writes no row
  // (its `judgeClaimed` NOTE); the remedy is Cancel and rent again.
  const rentProviderNode = useCallback(async (provider: { id: string; name: string }, client: ProviderClient, options: RentProviderNodeOptions = {}) => {
    const current = beginAddingNode();
    try {
      const recording = recordingClient(client, async (container, join) => {
        // The caller learns the id before the record is written: a record that cannot be written
        // must not leave a retry renting a second container.
        options.onCreated?.(container.id);
        await rentals.add(current.partyId, {
          providerId: provider.id, providerName: provider.name, containerId: container.id, join, createdAt: Date.now(), finished: false,
        });
      });
      const result = await rentNode(current, recording, { onProgress: options.onProgress });
      await rentals.update(current.partyId, result.containerId, { finished: true, ...(result.peerId ? { peerId: result.peerId } : {}) });
      return result;
    } finally {
      claimingRef.current = false;
    }
  }, []);

  const finishProviderRental = useCallback(async (client: ProviderClient, containerId: string, onProgress?: (step: RentNodeStep) => void) => {
    const current = beginAddingNode();
    try {
      const result = await finishRental(current, client, containerId, { onProgress });
      if ('outcome' in result) return result;
      await rentals.update(current.partyId, containerId, { finished: true, ...(result.peerId ? { peerId: result.peerId } : {}) });
      return result;
    } finally {
      claimingRef.current = false;
    }
  }, []);

  const listRentals = useCallback(async () => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    return await rentals.list(current.partyId);
  }, []);

  const noteRentalPeer = useCallback(async (containerId: string, peerId: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    await rentals.update(current.partyId, containerId, { peerId });
  }, []);

  const forgetRental = useCallback(async (containerId: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    await rentals.remove(current.partyId, containerId);
  }, []);

  return {
    status, node, peerId, ownerPublicKey, noiseCryptoMode, strands,
    selectedStrandId, activeStrand, selectStrand,
    error, runnerState, resuming, degraded, relayStatus, savedStartOptions, savedStartRead,
    removedFrom, dismissRemoval, returnToOwnCadre,
    start, stop, applySeed, dialPeer, createStrand,
    identityPeerId, joinRequestText, ...joinFlowActions,
    createClosedStrandWithInvite, joinViaInvite, isOwnerDevice, claimHostNode,
    isMemberPeer, createCadreInvitation, listCadreInvitations, withdrawCadreInvitation,
    listMachines, planMachineRemoval, removeMachine,
    listOwnerKeys, addBackupOwnerKey, exportOwnerKey, importOwnerKey, planOwnerKeyRemoval, removeOwner,
    rentProviderNode, finishProviderRental, listRentals, noteRentalPeer, forgetRental,
  };
}

