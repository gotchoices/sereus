/**
 * use-cadre.ts — React hook for CadreNode lifecycle management.
 *
 * Manages the singleton phone node, exposes connection status, and provides
 * methods for seed application and strand creation.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { CadreNode } from '@serfab/cadre-core';
import type { StrandInstance, CadreNodeEvents } from '@serfab/cadre-core';
import {
  startPhoneNode,
  stopPhoneNode,
  getPhoneNode,
  dialPeer as dialPeerImpl,
  type PhoneNodeOptions,
} from './cadre-phone';
import { createChatStrand } from './chat-strand';

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

    node.on('strand:started', onStarted);
    node.on('strand:stopped', onStopped);
    node.on('strand:error', onError);

    return () => {
      node.off('strand:started', onStarted);
      node.off('strand:stopped', onStopped);
      node.off('strand:error', onError);
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

  return { status, node, peerId, strands, error, start, stop, applySeed, dialPeer, createStrand };
}

