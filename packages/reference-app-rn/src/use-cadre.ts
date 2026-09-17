/**
 * use-cadre.ts — React hook for CadreNode lifecycle management.
 *
 * Manages the singleton phone node, exposes connection status, and provides
 * methods for seed application and strand creation.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import type { CadreNode } from '@serfab/cadre-core';
import type {
  StrandInstance,
  CadreNodeEvents,
  RelayReservationState,
  RelayReservationStatus,
  StrandFormationDisclosure,
} from '@serfab/cadre-core';
import {
  startPhoneNode,
  stopPhoneNode,
  getPhoneNode,
  getOwnerPublicKey,
  getRelayState,
  dialPeer as dialPeerImpl,
  createOpenInvitation,
  publishFormationInvite,
  formStrand,
  type PhoneNodeOptions,
} from './cadre-phone';
import {
  createChatStrand,
  joinChatStrand,
  createClosedChatStrand,
  joinClosedChatStrandFromFormation,
  CHAT_SAPP_ID,
} from './chat-strand';
import {
  requestHostNode as runHostNodeRequest,
  type HostNodeRequestResult,
  type HostNodeRequestStage,
} from './host-node-request';
import {
  createBackgroundRunner,
  type BackgroundRunner,
  type RunnerState,
} from './background-runner';
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
 * `phone-node-config.ts`).
 *
 * The invite guard does NOT use this value: it reads {@link getRelayState} at the
 * moment of the tap, so a stale poll can never let a doomed invitation through.
 */
const RELAY_POSTURE_POLL_MS = 5_000;

/**
 * Why an invitation cannot be minted, phrased for the person holding the phone and
 * naming the thing they can actually change. The guard itself is `getMultiaddrs()`
 * being empty — the precondition `createOpenInvitation` really has; the posture only
 * explains WHY it is empty.
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

/**
 * How long {@link UseCadreResult.stop} waits for a cancelled host-node request to
 * finish undoing itself before the node comes down anyway. Bounded because the
 * abort cannot interrupt a node call the request is already inside (a cohort
 * reconcile dials peers and can take tens of seconds), and logging out must not
 * wait that out — the cost of giving up is a logged cleanup failure, not a hang.
 */
const HOST_REQUEST_CANCEL_WAIT_MS = 5_000;

/** A host-node request in flight: the handle {@link stop} cancels through, and its settle. */
interface InFlightHostRequest {
  abort: AbortController;
  /** Resolves once the request has returned or thrown — which is after its cleanup ran. */
  settled: Promise<void>;
}

/** Resolve when `settled` does, or after `ms`, whichever comes first. */
function waitBounded(settled: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  /** Start the node with the given options */
  start: (opts: PhoneNodeOptions) => Promise<void>;
  /** Stop the node */
  stop: () => Promise<void>;
  /** Apply a base64url-encoded seed, optionally pinning owner keys (e.g. from a CadreInvite). */
  applySeed: (encoded: string, pinnedOwnerKeys?: string[]) => Promise<void>;
  /** Decode a pasted base64url CadreInvite and return its pinned owner keys (empty if none). */
  ownerKeysFromInvite: (encodedInvite: string) => string[];
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
   * Ask the cadre-host at `hostUrl` to lend this cadre a node, using a grant
   * token its admin issued, and resolve once the phone is connected to that node
   * (see `host-node-request.ts` for the six stages `onStage` reports).
   *
   * Only one request may run at a time — a second call rejects rather than
   * provisioning a second node against the same grant. {@link stop} cancels one
   * in flight.
   *
   * Nothing else needs refreshing afterwards: the new peer arrives through the
   * control database like any other member.
   */
  requestHostNode: (
    hostUrl: string,
    grantToken: string,
    onStage?: (stage: HostNodeRequestStage) => void,
  ) => Promise<HostNodeRequestResult>;
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
  const [strands, setStrands] = useState<Map<string, StrandInstance>>(
    () => getPhoneNode()?.getStrands() ?? new Map(),
  );
  const [selectedStrandId, setSelectedStrandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runnerState, setRunnerState] = useState<RunnerState>('foreground');
  const [resuming, setResuming] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [relayStatus, setRelayStatus] = useState<RelayReservationStatus>(() => getRelayState().status);

  // Track the latest node so event handlers always reference it
  const nodeRef = useRef<CadreNode | null>(node);
  nodeRef.current = node;

  // Last options passed to `start`, so the BackgroundRunner can cold-start the
  // node (re-run `startPhoneNode`) on a foreground return after the OS killed it.
  const optsRef = useRef<PhoneNodeOptions | null>(null);
  const runnerRef = useRef<BackgroundRunner | null>(null);

  // Non-null exactly while a host-node request is in flight, so it doubles as the
  // re-entry guard and as the handle `stop` cancels through. A ref, not state: the
  // guard has to hold against a same-frame second tap, which a re-render cannot.
  const hostRequestRef = useRef<InFlightHostRequest | null>(null);

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

    // A strand this node holds no config for arrived over the control network —
    // created by another member, or created by US in a previous session (sApp
    // configs are in-memory only, so every stored strand is "unclaimed" again
    // after a restart). Only OPEN strands (`Type:'o'`) are auto-joined — "anyone
    // can participate". A CLOSED strand (`Type:'c'`) is invitation-only by design
    // and must go through the explicit consent handshake (`joinViaInvite` →
    // `formStrand`); blindly attaching it here would bypass that flow. A closed
    // strand simply stays unclaimed in the node's discovered map.
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
      if (strand.Type !== 'o') return;
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

  // ── Background lifecycle (AppState-driven) ───────────────────────────────

  // Cold-start hook for the runner: re-run `startPhoneNode` with the last opts
  // when a foreground return finds the node stopped/killed, then re-sync React
  // state. Idempotent (startPhoneNode no-ops a running node).
  const ensureNode = useCallback(async () => {
    const opts = optsRef.current;
    if (!opts) return;
    const started = await startPhoneNode(opts);
    setNode(started);
    nodeRef.current = started;
    setPeerId(started.peerId?.toString() ?? null);
    setOwnerPublicKey(getOwnerPublicKey());
    setStrands(new Map(started.getStrands()));
  }, []);

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
  // NOTE beside `relayAddrs` in `phone-node-config.ts`.
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
      const started = await startPhoneNode(opts);
      setNode(started);
      nodeRef.current = started;
      setPeerId(started.peerId?.toString() ?? null);
      setOwnerPublicKey(getOwnerPublicKey());
      setStrands(new Map(started.getStrands()));
      setStatus('connected');
      // Acquire + publish the FCM/APNs device token so a server peer can push-wake
      // this phone while suspended. Best-effort: permission-denied / pre-membership
      // defers silently and retries on the next start (see push-wake-native).
      void acquireAndRegisterDeviceToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('error');
    }
  }, []);

  const stop = useCallback(async () => {
    // Cancel a host-node request first, and give it a bounded moment to unwind:
    // the first thing its cleanup does is drop the lent node's authorization row,
    // which needs this node still running. Aborting without waiting would leave
    // that removal racing the teardown below (see HOST_REQUEST_CANCEL_WAIT_MS for
    // why the wait is bounded rather than open-ended).
    const hostRequest = hostRequestRef.current;
    if (hostRequest) {
      hostRequest.abort.abort();
      await waitBounded(hostRequest.settled, HOST_REQUEST_CANCEL_WAIT_MS);
    }
    // Clear the DeviceToken row + drop the rotation listener before stopping, so a
    // logged-out phone is no longer push-wake addressable. Best-effort (logs on
    // failure); must run before stopPhoneNode tears the node down.
    await clearDeviceTokenRegistration();
    await stopPhoneNode();
    setNode(null);
    nodeRef.current = null;
    setPeerId(null);
    setOwnerPublicKey(null);
    setStrands(new Map());
    setSelectedStrandId(null);
    setStatus('idle');
  }, []);

  const applySeed = useCallback(async (encoded: string, pinnedOwnerKeys?: string[]) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const seed = current.decodeSeed(encoded);
    const trustPolicy = pinnedOwnerKeys?.length
      ? pinnedKeyTrustPolicy(pinnedOwnerKeys)
      : undefined;
    if (pinnedOwnerKeys?.length) {
      // Enrollment seam: the invite's owner keys are out-of-band trust — anchor
      // them in the node-local trusted-owner store BEFORE the seed is applied,
      // so the anchor already holds them when membership/seed trust consults it.
      await current.trustOwnerKeys(pinnedOwnerKeys, 'invite');
    }
    const result = await current.applySeed(seed, trustPolicy ? { trustPolicy } : undefined);
    if (!result.success) {
      throw new Error(result.error ?? 'Seed application failed');
    }
  }, []);

  // Decode a pasted CadreInvite and surface its pinned owner keys so the
  // caller can anchor a cold-start seed against `pinnedKeyTrustPolicy`. An older
  // invite without `ownerKeys` yields `[]` (no pin). Guard ordering matches
  // `applySeed`: throw 'Node not started' before touching the node.
  const ownerKeysFromInvite = useCallback((encodedInvite: string): string[] => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    return current.decodeInvite(encodedInvite).ownerKeys ?? [];
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
    // The invitation's bootstrap is this node's own addresses, so an unreachable
    // node cannot invite anyone — refuse BEFORE founding, or every attempt leaves an
    // orphaned closed strand behind. A phone is reachable only through a relay; see
    // `relay-config.ts` for where that address comes from.
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

  // ── Borrowing a node from a cadre-host ─────────────────────────────────

  // The guard is here rather than only on the button: a disabled button takes
  // effect one render late, and two provisions against one grant would use up a
  // one-node grant on a node the phone then only half-owns.
  //
  // NOTE: the in-flight request holds the node it started with. If the OS kills the
  // node mid-request, the BackgroundRunner's cold start (`ensureNode`) replaces the
  // singleton and the request's own calls then fail against the dead one — which is
  // the outcome we want (a clear failure plus cleanup), but the message names the
  // node call that failed rather than the kill. Thread the abort through the runner
  // if that ever needs to read better.
  const requestHostNode = useCallback(async (
    hostUrl: string,
    grantToken: string,
    onStage?: (stage: HostNodeRequestStage) => void,
  ): Promise<HostNodeRequestResult> => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    if (hostRequestRef.current) throw new Error('A host node request is already running');
    const abort = new AbortController();
    // `settled` is what `stop` waits on. It resolves in the `finally` below, which
    // runs only after the flow's own cleanup has — that is the point of the wait.
    let settle!: () => void;
    hostRequestRef.current = { abort, settled: new Promise<void>((resolve) => { settle = resolve; }) };
    try {
      return await runHostNodeRequest(hostUrl, grantToken, {
        fetch,
        node: current,
        onStage,
        signal: abort.signal,
      });
    } finally {
      hostRequestRef.current = null;
      settle();
    }
  }, []);

  return {
    status, node, peerId, ownerPublicKey, strands,
    selectedStrandId, activeStrand, selectStrand,
    error, runnerState, resuming, degraded, relayStatus,
    start, stop, applySeed, ownerKeysFromInvite, dialPeer, createStrand,
    createClosedStrandWithInvite, joinViaInvite, requestHostNode,
  };
}

