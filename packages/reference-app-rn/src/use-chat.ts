/**
 * use-chat.ts — React hook for the chat message list and send/receive.
 *
 * Because Optimystic doesn't yet expose reactive subscriptions, this hook
 * polls the strand's Quereus database on a configurable interval.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { StrandInstance } from '@serfab/cadre-core';
import {
  insertMember,
  insertMessage,
  queryMessages,
  queryMembers,
  type ChatMessage,
  type ChatMember,
} from './chat-operations';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseChatOptions {
  /** The active strand instance (null if not yet created/joined) */
  strand: StrandInstance | null;
  /** Local member ID (e.g. peerId) */
  memberId: string | null;
  /** Local display name */
  memberName?: string;
  /** Polling interval in ms (default 2000) */
  pollIntervalMs?: number;
}

export interface UseChatResult {
  /** Chat messages, oldest first */
  messages: ChatMessage[];
  /** Known members */
  members: ChatMember[];
  /** Whether the initial load is in progress */
  loading: boolean;
  /** Last error */
  error: string | null;
  /** Send a text message */
  send: (content: string) => Promise<void>;
  /** Force a refresh */
  refresh: () => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChat(opts: UseChatOptions): UseChatResult {
  const { strand, memberId, memberName, pollIntervalMs = 2000 } = opts;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track latest strand so callbacks stay current
  const strandRef = useRef(strand);
  strandRef.current = strand;

  const memberIdRef = useRef(memberId);
  memberIdRef.current = memberId;

  // ── Register local member on first attach ──────────────────────────────

  // Keyed by strandId, not a single boolean: switching to a second strand via
  // the picker must register the local member there too (register once per strand).
  const registeredStrandsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!strand || !memberId) return;
    const sid = strand.strandId;
    if (registeredStrandsRef.current.has(sid)) return;

    (async () => {
      try {
        await insertMember(strand, memberId, memberName ?? memberId);
        registeredStrandsRef.current.add(sid);
      } catch (err) {
        console.warn('Failed to register member:', err);
      }
    })();
  }, [strand, memberId, memberName]);

  // ── Reset view on strand switch ─────────────────────────────────────────

  // Clear the previous strand's messages/members (and re-enter loading) the
  // moment the active strand id changes, so the list never renders the wrong
  // conversation in the gap before the new strand's first poll completes.
  useEffect(() => {
    setMessages([]);
    setMembers([]);
    setLoading(true);
  }, [strand?.strandId]);

  // ── Fetch messages + members ───────────────────────────────────────────

  const refresh = useCallback(async () => {
    const s = strandRef.current;
    if (!s?.database) return;

    try {
      const [msgs, mems] = await Promise.all([
        queryMessages(s),
        queryMembers(s),
      ]);
      // A switch may have landed while this query was in flight. Applying a
      // previous strand's rows now would re-bleed the very conversation the
      // reset-on-switch effect just cleared, so drop the stale result.
      if (strandRef.current !== s) return;
      setMessages(msgs);
      setMembers(mems);
      setError(null);
    } catch (err) {
      if (strandRef.current !== s) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (strandRef.current === s) setLoading(false);
    }
  }, []);

  // ── Polling loop ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!strand?.database) {
      setLoading(false);
      return;
    }

    // Initial fetch
    void refresh();

    const timer = setInterval(() => void refresh(), pollIntervalMs);
    return () => clearInterval(timer);
  }, [strand, strand?.database, pollIntervalMs, refresh]);

  // ── Send ───────────────────────────────────────────────────────────────

  const send = useCallback(async (content: string) => {
    const s = strandRef.current;
    const mid = memberIdRef.current;
    if (!s) throw new Error('No strand attached');
    if (!mid) throw new Error('No member ID');

    const msg = await insertMessage(s, mid, content);
    // Optimistic update — append immediately, next poll will reconcile
    setMessages(prev => [...prev, msg]);
    setError(null);
  }, []);

  return { messages, members, loading, error, send, refresh };
}

