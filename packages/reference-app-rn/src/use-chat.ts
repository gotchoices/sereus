/**
 * use-chat.ts — React hook for the chat message list and send/receive.
 *
 * Because Optimystic doesn't yet expose reactive subscriptions, this hook
 * polls the strand's Quereus database on a configurable interval.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { CadreNode, CadreNodeEvents, StrandInstance, StrandQueueState } from '@serfab/cadre-core';
import {
  discardQueuedMessage,
  insertParticipant,
  queryMessages,
  queryParticipants,
  type ChatMessage,
  type ChatParticipant,
  type StoredMessage,
} from './chat-operations';
import { ChatSender } from './chat-send';
import type { QueuedMessageRecord } from './queued-messages';
import {
  isSettled,
  markForStatus,
  markOnSend,
  queueStatusLine,
  type SendMark,
  type SentMessage,
} from './send-marks';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseChatOptions {
  /** The running node, whose strand events move a sent message's mark along */
  node: CadreNode | null;
  /** The active strand instance (null if not yet created/joined) */
  strand: StrandInstance | null;
  /** Local participant ID (e.g. peerId) */
  participantId: string | null;
  /** Local display name */
  participantName?: string;
  /** Polling interval in ms (default 2000) */
  pollIntervalMs?: number;
  /**
   * Called with the draft's text when a poll shows that a send which reported failure did land:
   * drop the "not confirmed" state, and clear the composer if it still holds that text.
   */
  onDraftSettled?: (text: string) => void;
  /**
   * Where messages sent in offline mode are recorded until their queue settles them, so their
   * marks come back after a restart. Absent: those marks live in memory only.
   */
  queuedMessages?: QueuedMessageRecord;
}

export interface UseChatResult {
  /** Chat messages, oldest first */
  messages: ChatMessage[];
  /** The marks on the shown strand's messages this device sent that no other member holds yet, by message id */
  marks: ReadonlyMap<string, SendMark>;
  /** The shown strand's messages that were refused when sent, whose rows have left the list */
  unsent: readonly SentMessage[];
  /** The line above the list while the shown strand's offline queue holds anything; null while it is empty */
  queueLine: string | null;
  /** Known participants */
  participants: ChatParticipant[];
  /** Whether the initial load is in progress */
  loading: boolean;
  /** Last error */
  error: string | null;
  /** Send a text message */
  send: (content: string) => Promise<void>;
  /** Report every change to the composer's text, trimmed as `send` is given it */
  composerChanged: (text: string) => void;
  /** Re-read now; resolves immediately if a read for the active strand is already running */
  refresh: () => Promise<void>;
  /** Withdraw a message still waiting to send; returns what to tell the user when it cannot be, else null */
  discard: (messageId: string) => string | null;
  /** Stop showing a message that was not sent */
  dismissUnsent: (messageId: string) => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChat(opts: UseChatOptions): UseChatResult {
  const { node, strand, participantId, participantName, pollIntervalMs = 2000 } = opts;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Kept per strand, so a switch away and back still shows them, and an event for one strand
  // cannot change a mark on another. In memory, except that a queued message is also recorded in
  // `queuedMessages` until its queue settles it: a message read from storage carries no mark
  // otherwise, and a mark whose commit nothing follows stays until the app restarts
  // (docs/strands.md, "A commit's durability").
  const [sent, setSent] = useState<readonly SentMessage[]>([]);
  const sentRef = useRef(sent);
  sentRef.current = sent;
  const [queueStates, setQueueStates] = useState<ReadonlyMap<string, StrandQueueState['state']>>(() => new Map());
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track latest strand so callbacks stay current
  const strandRef = useRef(strand);
  strandRef.current = strand;

  const participantIdRef = useRef(participantId);
  participantIdRef.current = participantId;

  const onDraftSettledRef = useRef(opts.onDraftSettled);
  onDraftSettledRef.current = opts.onDraftSettled;

  const queuedMessagesRef = useRef(opts.queuedMessages);
  queuedMessagesRef.current = opts.queuedMessages;

  // One sender for the life of the hook: it holds the id minted for the draft in the
  // composer, so pressing Send again after a failed send re-presents that same primary key
  // rather than storing the message a second time. See `chat-send.ts`.
  const senderRef = useRef<ChatSender | null>(null);
  if (!senderRef.current) senderRef.current = new ChatSender();
  const sender = senderRef.current;

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
      const settled = sender.settle(msgs);
      if (settled !== null) onDraftSettledRef.current?.(settled);
    } catch (err) {
      if (strandRef.current !== s) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      inFlightRef.current.delete(s);
      if (strandRef.current === s) setLoading(false);
    }
  }, [sender]);

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

  // ── Marks on sent messages ─────────────────────────────────────────────

  // The offline queues whose marks were rebuilt from `queuedMessages`: once per database build,
  // since a build's restore delivers its `queued` statuses before anything can listen.
  const restoredQueuesRef = useRef(new WeakSet<object>());

  // Rebuild the marks of the strand's recorded messages from what its queue says of each now,
  // and drop from the record those it has settled or no longer knows.
  const restoreMarks = useCallback(async (running: CadreNode, strandId: string) => {
    const record = queuedMessagesRef.current;
    const queue = running.getStrand(strandId)?.database?.offline;
    if (!record || !queue || restoredQueuesRef.current.has(queue)) return;
    restoredQueuesRef.current.add(queue);
    const restored = new Map<string, SentMessage | null>();
    for (const message of await record.forStrand(strandId)) {
      const status = queue.status(message.transactionId);
      if (!status || isSettled(status)) void forgetQueued(record, message.transactionId);
      const mark = status ? markForStatus(running.getStrand(strandId), status, null) : null;
      restored.set(message.transactionId, mark ? { ...message, mark } : null);
    }
    setSent((prev) => [
      ...prev.filter((m) => m.strandId !== strandId || !restored.has(m.transactionId)),
      ...[...restored.values()].filter((m): m is SentMessage => m !== null),
    ]);
  }, []);

  useEffect(() => {
    if (!node) return;
    const restore = (strandId: string) => {
      restoreMarks(node, strandId).catch((err: unknown) => console.warn(`Could not mark strand ${strandId}'s queued messages:`, err));
    };
    const onHeld = ({ strandId, transactionId }: CadreNodeEvents['strand:commit-held']) => {
      setSent((prev) => {
        const kept = prev.filter((m) => m.strandId !== strandId || m.transactionId !== transactionId);
        return kept.length === prev.length ? prev : kept;
      });
    };
    const onStatus = ({ strandId, status }: CadreNodeEvents['strand:offline-status']) => {
      const target = node.getStrand(strandId);
      setSent((prev) => withStatus(prev, target, strandId, status));
      const record = queuedMessagesRef.current;
      if (record && isSettled(status)) void forgetQueued(record, status.transactionId);
    };
    // Also the cue that a database was published, possibly over a restored queue.
    const onQueueState = ({ strandId, state }: CadreNodeEvents['strand:queue-state']) => {
      setQueueStates((prev) => new Map(prev).set(strandId, state));
      restore(strandId);
    };
    node.on('strand:commit-held', onHeld);
    node.on('strand:offline-status', onStatus);
    node.on('strand:queue-state', onQueueState);
    // Strands published before this subscribed (during the node's own start) were announced unheard.
    for (const [strandId, instance] of node.getStrands()) {
      const queue = instance.database?.offline;
      if (!queue) continue;
      setQueueStates((prev) => new Map(prev).set(strandId, queue.queueState()));
      restore(strandId);
    }
    return () => {
      node.off('strand:commit-held', onHeld);
      node.off('strand:offline-status', onStatus);
      node.off('strand:queue-state', onQueueState);
    };
  }, [node, restoreMarks]);

  const shownStrandId = strand?.strandId;
  const marks = useMemo(
    () => new Map(sent.filter((m) => m.strandId === shownStrandId).map((m) => [m.messageId, m.mark])),
    [sent, shownStrandId],
  );
  const unsent = useMemo(
    () => sent.filter((m) => m.strandId === shownStrandId && m.mark.kind === 'failed' && !messages.some((row) => row.Id === m.messageId)),
    [sent, shownStrandId, messages],
  );
  const queueLine = queueStatusLine(shownStrandId === undefined ? undefined : queueStates.get(shownStrandId));

  // A status or a `strand:commit-held` queued after this mark changes it, since React applies the
  // updaters in order; one that landed earlier shows in `markOnSend`'s read.
  const markSent = useCallback((s: StrandInstance, stored: StoredMessage, transactionId: string) => {
    const mark = markOnSend(s, transactionId);
    if (!mark) return;
    const message = { strandId: s.strandId, transactionId, messageId: stored.message.Id, content: stored.message.Content };
    setSent((prev) => [...prev, { ...message, mark }]);
    const record = queuedMessagesRef.current;
    if (record && (mark.kind === 'waiting' || mark.kind === 'sending')) {
      record.add(message).catch((err: unknown) => console.warn('Could not record a queued message:', err));
    }
  }, []);

  const discard = useCallback((messageId: string): string | null => {
    const s = strandRef.current;
    const message = sentRef.current.find((m) => m.strandId === s?.strandId && m.messageId === messageId);
    // Its `failed` status clears the mark, and the next read finds the row gone.
    return s && message ? discardQueuedMessage(s, message.transactionId) : null;
  }, []);

  const dismissUnsent = useCallback((messageId: string) => {
    const shown = strandRef.current?.strandId;
    setSent((prev) => prev.filter((m) => m.strandId !== shown || m.messageId !== messageId));
  }, []);

  // ── Send ───────────────────────────────────────────────────────────────

  const send = useCallback(async (content: string) => {
    const s = strandRef.current;
    const pid = participantIdRef.current;
    if (!s) throw new Error('No strand attached');
    if (!pid) throw new Error('No participant ID');

    const { stored } = await sender.send(s, pid, content);
    if (stored?.transactionId) markSent(s, stored, stored.transactionId);
    // A switch may have landed while the insert ran; the row belongs to the strand it was
    // stored in, not to the list now showing another one.
    if (strandRef.current !== s) return;
    if (stored) {
      // Optimistic update — append immediately, next poll will reconcile
      setMessages(prev => [...prev, stored.message]);
    } else {
      // A resend that found the row already stored wrote nothing, and that row belongs to an
      // earlier attempt, not this one — re-read the list rather than inventing it.
      await refresh();
    }
    setError(null);
  }, [sender, refresh, markSent]);

  const composerChanged = useCallback((text: string) => sender.composerChanged(text), [sender]);

  return { messages, marks, unsent, queueLine, participants, loading, error, send, composerChanged, refresh, discard, dismissUnsent };
}

/** `sent` after one status of a queued transaction: its message's mark moved along or cleared. */
function withStatus(
  sent: readonly SentMessage[],
  strand: StrandInstance | undefined,
  strandId: string,
  status: CadreNodeEvents['strand:offline-status']['status'],
): readonly SentMessage[] {
  const index = sent.findIndex((m) => m.strandId === strandId && m.transactionId === status.transactionId);
  if (index < 0) return sent;
  const mark = markForStatus(strand, status, sent[index].mark);
  if (mark === sent[index].mark) return sent;
  return mark ? sent.map((m, i) => (i === index ? { ...m, mark } : m)) : sent.filter((_, i) => i !== index);
}

function forgetQueued(record: QueuedMessageRecord, transactionId: string): Promise<void> {
  return record.remove(transactionId).catch((err: unknown) => {
    console.warn('Could not drop a settled message from the queued-message record:', err);
  });
}

