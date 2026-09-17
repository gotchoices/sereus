/**
 * use-chat.spec.ts — the chat poll's single-flight guard.
 *
 * A strand read refreshes each table's tree over the network, so on a slow
 * relayed link it can take longer than the poll interval. `useChat` must not
 * start another read of a strand while one is still running (overlapping reads
 * slow each other and every commit on the same connection), but a read still
 * running for the previous strand must not hold up the first read of the strand
 * just switched to.
 *
 * Strategy: mount the real hook with `react-test-renderer` and mock
 * `chat-operations` so each `queryMessages` call hands back a promise the test
 * settles by hand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import type { StrandInstance } from '@serfab/cadre-core';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { useChat, type UseChatResult } from '../../src/use-chat';
import { queryMessages, type ChatMessage } from '../../src/chat-operations';

vi.mock('../../src/chat-operations', () => ({
  insertParticipant: vi.fn(async () => {}),
  insertMessage: vi.fn(),
  queryMessages: vi.fn(),
  queryParticipants: vi.fn(async () => []),
}));

// ── Harness ───────────────────────────────────────────────────────────────────

const POLL_MS = 2000;

interface PendingRead {
  strand: StrandInstance;
  resolve: (rows: ChatMessage[]) => void;
  reject: (err: Error) => void;
}

/** Every `queryMessages` call, in order, still waiting for the test to settle it. */
let reads: PendingRead[] = [];

function fakeStrand(strandId: string): StrandInstance {
  return { strandId, database: {} } as unknown as StrandInstance;
}

function message(id: string): ChatMessage {
  return { Id: id, ParticipantId: 'p', Content: id, Timestamp: '2026-09-17T00:00:00Z' };
}

interface Sink {
  current: UseChatResult | null;
}

function ChatHarness({ strand, sink }: { strand: StrandInstance; sink: Sink }): React.ReactElement | null {
  sink.current = useChat({ strand, participantId: 'me', pollIntervalMs: POLL_MS });
  return null;
}

function mountChat(strand: StrandInstance): { sink: Sink; renderer: ReactTestRenderer } {
  const sink: Sink = { current: null };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(ChatHarness, { strand, sink }));
  });
  return { sink, renderer };
}

async function switchTo(renderer: ReactTestRenderer, sink: Sink, strand: StrandInstance): Promise<void> {
  await act(async () => {
    renderer.update(React.createElement(ChatHarness, { strand, sink }));
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settle(read: PendingRead, rows: ChatMessage[]): Promise<void> {
  await act(async () => {
    read.resolve(rows);
    await vi.advanceTimersByTimeAsync(0);
  });
}

function messageIds(sink: Sink): string[] {
  return sink.current!.messages.map((m) => m.Id);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useChat — poll does not overlap a slow read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    reads = [];
    vi.mocked(queryMessages).mockImplementation((strand) =>
      new Promise<ChatMessage[]>((resolve, reject) => {
        reads.push({ strand, resolve, reject });
      }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips poll ticks while the read is still running, then reads again on the next tick', async () => {
    const x = fakeStrand('x');
    const { sink } = mountChat(x);
    expect(reads).toHaveLength(1);

    await advance(POLL_MS * 5);
    expect(reads).toHaveLength(1);

    // The returned `refresh` shares the guard.
    await act(async () => {
      await sink.current!.refresh();
    });
    expect(reads).toHaveLength(1);

    await settle(reads[0], [message('m1')]);
    expect(messageIds(sink)).toEqual(['m1']);
    expect(sink.current!.loading).toBe(false);

    await advance(POLL_MS);
    expect(reads).toHaveLength(2);
    expect(reads[1].strand).toBe(x);
  });

  it('releases the guard when a read fails', async () => {
    const { sink } = mountChat(fakeStrand('x'));

    await act(async () => {
      reads[0].reject(new Error('peers unreachable'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sink.current!.error).toBe('peers unreachable');

    await advance(POLL_MS);
    expect(reads).toHaveLength(2);
  });

  it('a read still running for the previous strand does not delay the new strand, and its late result is dropped', async () => {
    const x = fakeStrand('x');
    const y = fakeStrand('y');
    const { sink, renderer } = mountChat(x);
    expect(reads).toHaveLength(1);

    await switchTo(renderer, sink, y);
    expect(reads).toHaveLength(2);
    expect(reads[1].strand).toBe(y);

    // Y's own read is still running: its ticks are skipped too.
    await advance(POLL_MS * 3);
    expect(reads).toHaveLength(2);

    await settle(reads[0], [message('x1')]);
    expect(messageIds(sink)).toEqual([]);
    expect(sink.current!.loading).toBe(true);

    await settle(reads[1], [message('y1')]);
    expect(messageIds(sink)).toEqual(['y1']);
    expect(sink.current!.loading).toBe(false);
  });

  it('switching back to a strand whose read is still running does not start a second read of it', async () => {
    const x = fakeStrand('x');
    const y = fakeStrand('y');
    const { sink, renderer } = mountChat(x);

    await switchTo(renderer, sink, y);
    await switchTo(renderer, sink, x);
    expect(reads.map((r) => r.strand)).toEqual([x, y]);

    // X is active again, so its original read now applies.
    await settle(reads[0], [message('x1')]);
    expect(messageIds(sink)).toEqual(['x1']);

    await advance(POLL_MS);
    expect(reads.map((r) => r.strand)).toEqual([x, y, x]);
  });
});
