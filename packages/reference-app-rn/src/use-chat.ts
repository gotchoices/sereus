/**
 * use-chat.ts — React hook for the chat message list and send/receive.
 *
 * Because Optimystic doesn't yet expose reactive subscriptions, this hook
 * polls the strand's Quereus database on a configurable interval.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { StrandInstance } from '@serfab/cadre-core';
import {
  insertParticipant,
  queryMessages,
  queryParticipants,
  type ChatMessage,
  type ChatParticipant,
} from './chat-operations';
import { ChatSender } from './chat-send';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseChatOptions {
  /** The active strand instance (null if not yet created/joined) */
  strand: StrandInstance | null;
  /** Local participant ID (e.g. peerId) */
  participantId: string | null;
  /** Local display name */
  participantName?: string;
  /** Polling interval in ms (default 2000) */
  pollIntervalMs?: number;
}

export interface UseChatResult {
  /** Chat messages, oldest first */
  messages: ChatMessage[];
  /** Known participants */
  participants: ChatParticipant[];
  /** Whether the initial load is in progress */
  loading: boolean;
  /** Last error */
  error: string | null;
  /** Send a text message */
  send: (content: string) => Promise<void>;
  /** Re-read now; resolves immediately if a read for the active strand is already running */
  refresh: () => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChat(opts: UseChatOptions): UseChatResult {
  const { strand, participantId, participantName, pollIntervalMs = 2000 } = opts;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track latest strand so callbacks stay current
  const strandRef = useRef(strand);
  strandRef.current = strand;

  const participantIdRef = useRef(participantId);
  participantIdRef.current = participantId;

  // ── Register local participant on first attach ─────────────────────────

  // Keyed by strandId, not a single boolean: switching to a second strand via
  // the picker must register the local participant there too (register once per strand).
  const registeredStrandsRef = useRef<Set<string>>(new Set());

  // Gated on `strand.database`: a joiner comes up `'syncing'` with no database until it
  // has received the strand's data from another member, and a write before that would
  // fork the Participant table (it never merges — see docs/strands.md, "Joining"). The
  // dep on `strand.database` is what re-runs this once the strand becomes writable
  // (`use-cadre` re-renders on `strand:writable`).
  useEffect(() => {
    if (!strand?.database || !participantId) return;
    const sid = strand.strandId;
    if (registeredStrandsRef.current.has(sid)) return;

    (async () => {
      try {
        await insertParticipant(strand, participantId, participantName ?? participantId);
        registeredStrandsRef.current.add(sid);
      } catch (err) {
        console.warn('Failed to register participant:', err);
      }
    })();
  }, [strand, strand?.database, participantId, participantName]);

  // ── Reset view on strand switch ─────────────────────────────────────────

  // Clear the previous strand's messages/participants (and re-enter loading) the
  // moment the active strand id changes, so the list never renders the wrong
  // conversation in the gap before the new strand's first poll completes.
  useEffect(() => {
    setMessages([]);
    setParticipants([]);
    setLoading(true);
  }, [strand?.strandId]);

  // ── Fetch messages + participants ──────────────────────────────────────

  // Strands with a read still running. A strand read is not local — it refreshes
  // each table's tree over the network — so on a slow link it can outlast the poll
  // interval; starting another one anyway queues more requests on the same
  // connection, slowing every read, commit and peer request until delivery is
  // minutes late. Keyed per strand instance (the same identity the stale-result
  // check uses) so a read still running for the previous strand never delays the
  // first read of the one just switched to.
  // NOTE: a read that never settles stops polling for that strand; relies on
  // optimystic bounding its network requests — if chat ever freezes silently, add a timeout here.
  const inFlightRef = useRef<Set<StrandInstance>>(new Set());

  const refresh = useCallback(async () => {
    const s = strandRef.current;
    if (!s?.database) return;
    if (inFlightRef.current.has(s)) return;
    inFlightRef.current.add(s);

    try {
      const [msgs, parts] = await Promise.all([
        queryMessages(s),
        queryParticipants(s),
      ]);
      // A switch may have landed while this query was in flight. Applying a
      // previous strand's rows now would re-bleed the very conversation the
      // reset-on-switch effect just cleared, so drop the stale result.
      if (strandRef.current !== s) return;
      setMessages(msgs);
      setParticipants(parts);
      setError(null);
    } catch (err) {
      if (strandRef.current !== s) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      inFlightRef.current.delete(s);
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

  // One sender for the life of the hook: it holds the id minted for the draft in the
  // composer, so pressing Send again after a failed send re-presents that same primary key
  // rather than storing the message a second time. See `chat-send.ts`.
  const senderRef = useRef<ChatSender | null>(null);
  if (!senderRef.current) senderRef.current = new ChatSender();
  const sender = senderRef.current;

  const send = useCallback(async (content: string) => {
    const s = strandRef.current;
    const pid = participantIdRef.current;
    if (!s) throw new Error('No strand attached');
    if (!pid) throw new Error('No participant ID');

    const { message } = await sender.send(s, pid, content);
    if (message) {
      // Optimistic update — append immediately, next poll will reconcile
      setMessages(prev => [...prev, message]);
    } else {
      // A resend that found the row already stored wrote nothing, and that row belongs to an
      // earlier attempt, not this one — re-read the list rather than inventing it.
      await refresh();
    }
    setError(null);
  }, [sender, refresh]);

  return { messages, participants, loading, error, send, refresh };
}

