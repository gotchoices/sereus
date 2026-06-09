/**
 * use-cadre.ts — React hook for CadreNode lifecycle management.
 *
 * Manages the singleton phone node, exposes connection status, and provides
 * methods for seed application and strand creation.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { pinnedKeyTrustPolicy } from '@serfab/cadre-core';
import type { CadreNode } from '@serfab/cadre-core';
import type { StrandInstance, CadreNodeEvents, StrandFormationDisclosure } from '@serfab/cadre-core';
import {
  startPhoneNode,
  stopPhoneNode,
  getPhoneNode,
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
  createBackgroundRunner,
  type BackgroundRunner,
  type RunnerState,
} from './background-runner';
import { createReactNativeAppState } from './app-state';
import { acquireAndRegisterDeviceToken, clearDeviceTokenRegistration } from './push-wake-native';
import { uuid } from './uuid';

/** How long a closed-strand invitation stays valid (24h). */
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export type CadreStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface UseCadreResult {
  /** Current connection status */
  status: CadreStatus;
  /** The running CadreNode (null until connected) */
  node: CadreNode | null;
  /** This node's peer ID string (null until connected) */
  peerId: string | null;
  /** Active strand instances */
  strands: Map<string, StrandInstance>;
  /** Last error message */
  error: string | null;
  /** OS-lifecycle phase owned by the {@link BackgroundRunner} (foreground/background/…). */
  runnerState: RunnerState;
  /** True while a foreground resume is settling (control network catching up). */
  resuming: boolean;
  /** True after a resume settled without the control network reconnecting (offline/degraded). */
  degraded: boolean;
  /** Start the node with the given options */
  start: (opts: PhoneNodeOptions) => Promise<void>;
  /** Stop the node */
  stop: () => Promise<void>;
  /** Apply a base64url-encoded seed, optionally pinning authority keys (e.g. from a CadreInvite). */
  applySeed: (encoded: string, pinnedAuthorityKeys?: string[]) => Promise<void>;
  /** Decode a pasted base64url CadreInvite and return its pinned authority keys (empty if none). */
  authorityKeysFromInvite: (encodedInvite: string) => string[];
  /** Dial a peer by multiaddr while already connected */
  dialPeer: (addr: string) => Promise<void>;
  /** Create a new chat strand and return its instance */
  createStrand: (strandId: string) => Promise<StrandInstance>;
  /**
   * Create a CLOSED chat strand, mint + publish a formation invite bound to it,
   * and return the encoded `OpenInvitation` to hand an invitee out-of-band.
   */
  createClosedStrandWithInvite: () => Promise<string>;
  /**
   * Join a closed strand from an encoded `OpenInvitation`: run the consent
   * handshake (`formStrand`), then attach the host's closed strand using the
   * strand id + membership key the result carries.
   */
  joinViaInvite: (encoded: string) => Promise<StrandInstance>;
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
  const [strands, setStrands] = useState<Map<string, StrandInstance>>(
    () => getPhoneNode()?.getStrands() ?? new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [runnerState, setRunnerState] = useState<RunnerState>('foreground');
  const [resuming, setResuming] = useState(false);
  const [degraded, setDegraded] = useState(false);

  // Track the latest node so event handlers always reference it
  const nodeRef = useRef<CadreNode | null>(node);
  nodeRef.current = node;

  // Last options passed to `start`, so the BackgroundRunner can cold-start the
  // node (re-run `startPhoneNode`) on a foreground return after the OS killed it.
  const optsRef = useRef<PhoneNodeOptions | null>(null);
  const runnerRef = useRef<BackgroundRunner | null>(null);

  // ── Strand event sync ──────────────────────────────────────────────────

  const refreshStrands = useCallback(() => {
    const current = nodeRef.current;
    if (current?.isRunning) {
      setStrands(new Map(current.getStrands()));
    }
  }, []);

  // Subscribe to strand lifecycle events
  useEffect(() => {
    if (!node) return;

    const onStarted = () => refreshStrands();
    const onStopped = () => refreshStrands();
    const onError = ({ strandId, error: err }: CadreNodeEvents['strand:error']) => {
      console.warn(`Strand ${strandId} error:`, err);
      refreshStrands();
    };

    // A strand created by another member arrived over the control network. Only
    // OPEN strands (`Type:'o'`) are auto-joined — "anyone can participate". A
    // CLOSED strand (`Type:'c'`) is invitation-only by design and must go through
    // the explicit consent handshake (`joinViaInvite` → `formStrand`); blindly
    // attaching it here would bypass that flow. Join the open one (register the
    // chat config + addStrand), then refresh. Guard against a double-join (we may
    // already host it — e.g. our own just-published strand, or a re-fire) and
    // surface failures rather than eating them.
    const onDiscovered = ({ strandId, strand }: CadreNodeEvents['strand:discovered']) => {
      if (strand.Type !== 'o') return;
      if (node.getStrands().has(strandId)) return;
      void (async () => {
        try {
          await joinChatStrand(node, strand);
          refreshStrands();
        } catch (err) {
          console.warn(`Failed to auto-join discovered strand ${strandId}:`, err);
        }
      })();
    };

    node.on('strand:started', onStarted);
    node.on('strand:stopped', onStopped);
    node.on('strand:error', onError);
    node.on('strand:discovered', onDiscovered);

    return () => {
      node.off('strand:started', onStarted);
      node.off('strand:stopped', onStopped);
      node.off('strand:error', onError);
      node.off('strand:discovered', onDiscovered);
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
    // Clear the DeviceToken row + drop the rotation listener before stopping, so a
    // logged-out phone is no longer push-wake addressable. Best-effort (logs on
    // failure); must run before stopPhoneNode tears the node down.
    await clearDeviceTokenRegistration();
    await stopPhoneNode();
    setNode(null);
    nodeRef.current = null;
    setPeerId(null);
    setStrands(new Map());
    setStatus('idle');
  }, []);

  const applySeed = useCallback(async (encoded: string, pinnedAuthorityKeys?: string[]) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const seed = current.decodeSeed(encoded);
    const trustPolicy = pinnedAuthorityKeys?.length
      ? pinnedKeyTrustPolicy(pinnedAuthorityKeys)
      : undefined;
    const result = await current.applySeed(seed, trustPolicy ? { trustPolicy } : undefined);
    if (!result.success) {
      throw new Error(result.error ?? 'Seed application failed');
    }
  }, []);

  // Decode a pasted CadreInvite and surface its pinned authority keys so the
  // caller can anchor a cold-start seed against `pinnedKeyTrustPolicy`. An older
  // invite without `authorityKeys` yields `[]` (no pin). Guard ordering matches
  // `applySeed`: throw 'Node not started' before touching the node.
  const authorityKeysFromInvite = useCallback((encodedInvite: string): string[] => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    return current.decodeInvite(encodedInvite).authorityKeys ?? [];
  }, []);

  const dialPeer = useCallback(async (addr: string) => {
    await dialPeerImpl(addr);
  }, []);

  const createStrand = useCallback(async (strandId: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const instance = await createChatStrand(current, strandId);
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
  const createClosedStrandWithInvite = useCallback(async () => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const strandId = uuid();
    await createClosedChatStrand(current, strandId);
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
    refreshStrands();
    return instance;
  }, [refreshStrands]);

  return {
    status, node, peerId, strands, error, runnerState, resuming, degraded,
    start, stop, applySeed, authorityKeysFromInvite, dialPeer, createStrand,
    createClosedStrandWithInvite, joinViaInvite,
  };
}

