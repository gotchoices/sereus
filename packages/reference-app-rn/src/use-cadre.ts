/**
 * use-cadre.ts — React hook for CadreNode lifecycle management.
 *
 * Manages the singleton phone node, exposes connection status, and provides
 * methods for seed application and strand creation.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
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
  joinClosedChatStrand,
  encodeClosedStrandInvite,
  decodeClosedStrandInvite,
  CHAT_SAPP_ID,
} from './chat-strand';
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
  /** Start the node with the given options */
  start: (opts: PhoneNodeOptions) => Promise<void>;
  /** Stop the node */
  stop: () => Promise<void>;
  /** Apply a base64url-encoded seed string */
  applySeed: (encoded: string) => Promise<void>;
  /** Dial a peer by multiaddr while already connected */
  dialPeer: (addr: string) => Promise<void>;
  /** Create a new chat strand and return its instance */
  createStrand: (strandId: string) => Promise<StrandInstance>;
  /**
   * Create a CLOSED chat strand, mint + publish a formation invite for it, and
   * return the encoded invitation envelope to hand an invitee out-of-band.
   */
  createClosedStrandWithInvite: () => Promise<string>;
  /**
   * Join a closed strand from an encoded invitation envelope: run the consent
   * handshake (`formStrand`), then attach the host's closed strand.
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

  // Track the latest node so event handlers always reference it
  const nodeRef = useRef<CadreNode | null>(node);
  nodeRef.current = node;

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

    // A strand created by another member arrived over the control network. Join
    // it (register the chat config + addStrand), then refresh. Guard against a
    // double-join (we may already host it — e.g. our own just-published strand,
    // or a re-fire) and surface failures rather than eating them.
    const onDiscovered = ({ strandId, strand }: CadreNodeEvents['strand:discovered']) => {
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

  // ── Actions ────────────────────────────────────────────────────────────

  const start = useCallback(async (opts: PhoneNodeOptions) => {
    try {
      setStatus('connecting');
      setError(null);
      const started = await startPhoneNode(opts);
      setNode(started);
      nodeRef.current = started;
      setPeerId(started.peerId?.toString() ?? null);
      setStrands(new Map(started.getStrands()));
      setStatus('connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('error');
    }
  }, []);

  const stop = useCallback(async () => {
    await stopPhoneNode();
    setNode(null);
    nodeRef.current = null;
    setPeerId(null);
    setStrands(new Map());
    setStatus('idle');
  }, []);

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
    refreshStrands();
    return instance;
  }, [refreshStrands]);

  // ── Closed-strand consent flow ─────────────────────────────────────────

  // Host: create a closed strand, then mint + persist a formation invite for it.
  // Both the OpenInvitation envelope and the persisted FormationInvite row are
  // required — the envelope so the invitee can reach + attach the strand, the
  // row so the host's recorder validates the token at redemption.
  const createClosedStrandWithInvite = useCallback(async () => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const strandId = uuid();
    const { memberPrivateKey } = await createClosedChatStrand(current, strandId);
    const invitation = await createOpenInvitation(CHAT_SAPP_ID, INVITE_EXPIRY_MS);
    await publishFormationInvite(invitation.token, CHAT_SAPP_ID, {
      expiresAtMs: invitation.expiration.getTime(),
    });
    const encoded = encodeClosedStrandInvite(current, { invitation, strandId, memberPrivateKey });
    refreshStrands();
    return encoded;
  }, [refreshStrands]);

  // Invitee: decode the envelope, run the explicit consent handshake against the
  // host (formStrand validates our disclosure + the token), then attach the
  // host's closed strand locally (schema-gated). A failed handshake throws —
  // joining a closed strand REQUIRES the host's consent and reachability.
  const joinViaInvite = useCallback(async (encoded: string) => {
    const current = nodeRef.current;
    if (!current) throw new Error('Node not started');
    const invite = decodeClosedStrandInvite(current, encoded);
    const disclosure: StrandFormationDisclosure = {
      partyId: current.peerId?.toString(),
      purpose: 'join closed chat strand',
      metadata: { app: CHAT_SAPP_ID },
    };
    await formStrand(invite.invitation, disclosure);
    const instance = await joinClosedChatStrand(current, invite.strandId, invite.memberPrivateKey);
    refreshStrands();
    return instance;
  }, [refreshStrands]);

  return {
    status, node, peerId, strands, error,
    start, stop, applySeed, dialPeer, createStrand,
    createClosedStrandWithInvite, joinViaInvite,
  };
}

