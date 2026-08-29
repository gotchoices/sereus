import { describe, it, expect } from 'vitest';
import type { Libp2p, PeerId } from '@libp2p/interface';
import type { ActionRev, IBlock, IPeerNetwork } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import {
  StrandBackfill,
  MAX_BLOCK_MESSAGE_BYTES,
  type StrandBackfillDeps,
  type StrandBackfillConfig,
  type StrandBackfillPushClient
} from '../src/strand-backfill.js';

/**
 * Unit coverage for the strand peer-join block catch-up. Everything here drives
 * `catchUpPeer` (or the connection:open path) against a FAKE raw store and a captured
 * push client — no libp2p node is dialled, per the ticket's test plan. The physical
 * two-node evidence lives in the integration suite
 * (`strand-membership-closed-strand-e2e.integration.ts`).
 */

// ── Fakes ────────────────────────────────────────────────────────────────────

/** One fake block: its committed tip (absent = pending-only) and its content (absent = unmaterialized). */
interface FakeBlock {
  latest?: ActionRev;
  block?: IBlock;
}

/** A block whose JSON encoding is padded to a controllable size. */
function makeBlock(id: string, fill = ''): IBlock {
  return { header: { id, type: 'test', collectionId: 'col' }, fill } as unknown as IBlock;
}

/** A committed, materialized fake block at rev 1 (the common case). */
function committed(id: string, rev = 1, fill = ''): FakeBlock {
  return { latest: { rev, actionId: `a-${id}-${rev}` }, block: makeBlock(id, fill) };
}

/**
 * The minimal IRawStorage the backfill reads: listBlockIds + getMetadata +
 * getMaterializedBlock over a literal map. Every write-side method throws — the
 * catch-up must never write to its own store.
 */
function makeStorage(blocks: Record<string, FakeBlock>, opts: { listBlockIds?: boolean } = {}): IRawStorage {
  const refuse = (name: string) => async () => { throw new Error(`backfill must not call ${name}`); };
  const storage: IRawStorage = {
    getMetadata: async (blockId) => {
      const entry = blocks[blockId];
      if (!entry) return undefined;
      return { ranges: [], ...(entry.latest ? { latest: entry.latest } : {}) };
    },
    getMaterializedBlock: async (blockId, actionId) => {
      const entry = blocks[blockId];
      return entry?.latest?.actionId === actionId ? entry.block : undefined;
    },
    saveMetadata: refuse('saveMetadata'),
    getRevision: refuse('getRevision'),
    saveRevision: refuse('saveRevision'),
    listRevisions: () => { throw new Error('backfill must not call listRevisions'); },
    getPendingTransaction: refuse('getPendingTransaction'),
    savePendingTransaction: refuse('savePendingTransaction'),
    deletePendingTransaction: refuse('deletePendingTransaction'),
    listPendingTransactions: () => { throw new Error('backfill must not call listPendingTransactions'); },
    getTransaction: refuse('getTransaction'),
    saveTransaction: refuse('saveTransaction'),
    getBlockProof: refuse('getBlockProof'),
    saveBlockProof: refuse('saveBlockProof'),
    saveMaterializedBlock: refuse('saveMaterializedBlock'),
    promotePendingTransaction: refuse('promotePendingTransaction')
  };
  if (opts.listBlockIds !== false) {
    storage.listBlockIds = async function* () {
      yield* Object.keys(blocks);
    };
  }
  return storage;
}

/** A fake libp2p surface: event registry + a controllable connection list. */
function makeLibp2p(connections: Array<{ remotePeer: PeerId }> = []) {
  const handlers = new Map<string, Set<(evt: unknown) => void>>();
  return {
    node: {
      addEventListener: (type: string, handler: (evt: unknown) => void) => {
        const set = handlers.get(type) ?? new Set();
        set.add(handler);
        handlers.set(type, set);
      },
      removeEventListener: (type: string, handler: (evt: unknown) => void) => {
        handlers.get(type)?.delete(handler);
      },
      getConnections: () => connections
    } as unknown as Libp2p,
    dispatchConnectionOpen(remotePeer: PeerId) {
      for (const handler of handlers.get('connection:open') ?? []) {
        handler({ detail: { remotePeer } });
      }
    },
    listenerCount(type: string) {
      return handlers.get(type)?.size ?? 0;
    }
  };
}

function peer(id: string): PeerId {
  return { toString: () => id } as unknown as PeerId;
}

interface CapturedPush {
  ids: string[];
  buffers: Uint8Array[];
  reason: string | undefined;
  meta: { blockMeta?: Record<string, { rev: number; actionId: string }>; blockProofs?: Record<string, unknown> } | undefined;
  options: { dialTimeoutMs?: number; responseTimeoutMs?: number } | undefined;
}

/**
 * A push client that records every call. `respond` shapes each response (default: all
 * accepted); throw from it to simulate a dead peer.
 */
function makePushClient(
  respond: (push: CapturedPush) => { missing: string[] } = () => ({ missing: [] })
) {
  const pushes: CapturedPush[] = [];
  const client: StrandBackfillPushClient = {
    pushBlocks: async (ids, buffers, reason, meta, options) => {
      const push: CapturedPush = { ids: [...ids], buffers: [...buffers], reason, meta, options };
      pushes.push(push);
      const { missing } = respond(push);
      return { blocks: {}, missing };
    }
  };
  return { pushes, client };
}

function makeBackfill(
  blocks: Record<string, FakeBlock>,
  config?: StrandBackfillConfig,
  overrides: Partial<StrandBackfillDeps> & { respond?: (push: CapturedPush) => { missing: string[] } } = {}
) {
  const { respond, ...depOverrides } = overrides;
  const { pushes, client } = makePushClient(respond);
  const fake = makeLibp2p();
  const deps: StrandBackfillDeps = {
    strandId: 'strand-test',
    libp2p: fake.node,
    peerNetwork: {} as IPeerNetwork,
    storage: makeStorage(blocks),
    protocolPrefix: '/optimystic/strand-strand-test',
    createPushClient: () => client,
    ...depOverrides
  };
  return { backfill: new StrandBackfill(deps, config), pushes, fake };
}

/** Poll until `condition` holds (short real-timer waits for the debounced paths). */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StrandBackfill', () => {
  it('copies every committed+materialized block, with blockMeta carrying the source (rev, actionId)', async () => {
    const blocks: Record<string, FakeBlock> = { b1: committed('b1', 1), b2: committed('b2', 7), b3: committed('b3', 2) };
    const { backfill, pushes } = makeBackfill(blocks);

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.offered).toBe(3);
    expect(result.accepted).toBe(3);
    expect(result.rejected).toEqual([]);
    expect(result.uncommitted).toBe(0);
    expect(result.unmaterialized).toBe(0);
    expect(result.capped).toBe(0);

    const allIds = pushes.flatMap((p) => p.ids).sort();
    expect(allIds).toEqual(['b1', 'b2', 'b3']);
    for (const push of pushes) {
      expect(push.reason).toBe('replication');
      expect(push.options).toEqual({ dialTimeoutMs: 3000, responseTimeoutMs: 10_000 });
      for (const [i, id] of push.ids.entries()) {
        expect(push.meta?.blockMeta?.[id]).toEqual({ rev: blocks[id]!.latest!.rev, actionId: blocks[id]!.latest!.actionId });
        // The buffer is the block's own JSON, encoded once.
        expect(JSON.parse(new TextDecoder().decode(push.buffers[i]!))).toEqual(blocks[id]!.block);
      }
    }
  });

  it('skips a block whose metadata has no latest — counted uncommitted, never pushed', async () => {
    const { backfill, pushes } = makeBackfill({
      pendingOnly: { block: makeBlock('pendingOnly') },
      real: committed('real')
    });

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.uncommitted).toBe(1);
    expect(result.offered).toBe(1);
    expect(pushes.flatMap((p) => p.ids)).toEqual(['real']);
  });

  it('skips a block with latest but no materialized content — counted unmaterialized', async () => {
    const { backfill, pushes } = makeBackfill({
      tombstone: { latest: { rev: 3, actionId: 'a-tombstone-3' } },
      real: committed('real')
    });

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.unmaterialized).toBe(1);
    expect(result.offered).toBe(1);
    expect(pushes.flatMap((p) => p.ids)).toEqual(['real']);
  });

  it('chunks by block count — no push carries more than maxChunkBlocks', async () => {
    const blocks = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`b${i}`, committed(`b${i}`)])
    );
    const { backfill, pushes } = makeBackfill(blocks, { maxChunkBlocks: 2 });

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.offered).toBe(5);
    expect(result.accepted).toBe(5);
    expect(pushes.map((p) => p.ids.length)).toEqual([2, 2, 1]);
  });

  it('chunks by byte budget — a multi-block chunk never exceeds maxChunkBytes', async () => {
    // Each block's JSON is ~120 bytes with this fill; a 300-byte budget fits two.
    const fill = 'x'.repeat(60);
    const blocks = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`b${i}`, committed(`b${i}`, 1, fill)])
    );
    const budget = 300;
    const { backfill, pushes } = makeBackfill(blocks, { maxChunkBytes: budget });

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.offered).toBe(4);
    expect(pushes.length).toBeGreaterThan(1);
    for (const push of pushes) {
      const bytes = push.buffers.reduce((sum, b) => sum + b.length, 0);
      // A multi-block chunk stays inside the budget; only a single oversized block
      // may exceed it (covered by the ship-alone test below).
      if (push.ids.length > 1) expect(bytes).toBeLessThanOrEqual(budget);
    }
  });

  it('ships a single block larger than maxChunkBytes alone rather than dropping it', async () => {
    const { backfill, pushes } = makeBackfill(
      {
        small: committed('small'),
        huge: committed('huge', 1, 'y'.repeat(500)),
        small2: committed('small2')
      },
      { maxChunkBytes: 100 }
    );

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.offered).toBe(3);
    expect(result.accepted).toBe(3);
    const hugePush = pushes.find((p) => p.ids.includes('huge'));
    expect(hugePush?.ids).toEqual(['huge']);
  });

  it('skips a block whose wire size alone exceeds MAX_BLOCK_MESSAGE_BYTES, naming it', async () => {
    // base64 wire bytes = ceil(raw/3)*4, so raw >= 6 MiB crosses the 8 MiB cap.
    const rawOverCap = Math.ceil((MAX_BLOCK_MESSAGE_BYTES * 3) / 4);
    const { backfill, pushes } = makeBackfill({
      giant: committed('giant', 1, 'z'.repeat(rawOverCap)),
      real: committed('real')
    });

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.oversized).toEqual(['giant']);
    expect(result.offered).toBe(1);
    expect(pushes.flatMap((p) => p.ids)).toEqual(['real']);
  });

  it('stops offering at maxBlocks — capped counts the remainder, which is never pushed', async () => {
    const blocks = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`b${i}`, committed(`b${i}`)])
    );
    const { backfill, pushes } = makeBackfill(blocks, { maxBlocks: 3 });

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(result.offered).toBe(3);
    expect(result.capped).toBe(4);
    expect(pushes.flatMap((p) => p.ids).length).toBe(3);
  });

  it('lands remote-reported missing ids in rejected and does NOT mark the peer done — a second run retries', async () => {
    const { backfill, pushes } = makeBackfill(
      { b1: committed('b1'), b2: committed('b2') },
      undefined,
      { respond: (push) => ({ missing: push.ids.filter((id) => id === 'b2') }) }
    );

    const first = await backfill.catchUpPeer(peer('p1'));
    expect(first.rejected).toEqual(['b2']);
    expect(first.accepted).toBe(1);

    const pushCountAfterFirst = pushes.length;
    const second = await backfill.catchUpPeer(peer('p1'));
    // The retry re-offers everything (the receiver's saveReplicatedBlock is idempotent).
    expect(second.offered).toBe(2);
    expect(pushes.length).toBeGreaterThan(pushCountAfterFirst);
  });

  it('resolves (never rejects) when a push throws, and does not mark the peer done', async () => {
    let calls = 0;
    const { backfill, pushes } = makeBackfill(
      { b1: committed('b1') },
      undefined,
      {
        respond: () => {
          calls += 1;
          if (calls === 1) throw new Error('dial failed');
          return { missing: [] };
        }
      }
    );

    const first = await backfill.catchUpPeer(peer('p1'));
    expect(first.offered).toBe(1);
    expect(first.accepted).toBe(0);
    expect(first.rejected).toEqual([]);

    // Not marked done: the next run pushes again — and this time succeeds.
    const second = await backfill.catchUpPeer(peer('p1'));
    expect(second.accepted).toBe(1);
    expect(pushes.length).toBe(2);

    // NOW it is done: a third run pushes nothing.
    const third = await backfill.catchUpPeer(peer('p1'));
    expect(third.offered).toBe(0);
    expect(pushes.length).toBe(2);
  });

  it('keeps pushing after a mid-run chunk failure once the peer has answered at least one push', async () => {
    // A transient blip on a peer that demonstrably speaks the protocol must not abandon
    // the rest of the store — only a peer that has answered NOTHING is treated as dead.
    let calls = 0;
    const { backfill, pushes } = makeBackfill(
      { b1: committed('b1'), b2: committed('b2'), b3: committed('b3') },
      { maxChunkBlocks: 1 },
      {
        respond: () => {
          calls += 1;
          if (calls === 2) throw new Error('stream reset');
          return { missing: [] };
        }
      }
    );

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(pushes.length).toBe(3);
    expect(result.accepted).toBe(2);
    // Not clean, so the peer is not memoized — the next connection:open re-offers everything.
    const retry = await backfill.catchUpPeer(peer('p1'));
    expect(retry.offered).toBe(3);
  });

  it('abandons the run after the first failed chunk instead of dialing an unreachable peer per chunk', async () => {
    // A peer that does not speak this strand's block-transfer protocol (a bare relay)
    // fails every dial. One chunk per block, so without fail-fast this would be 3 pushes.
    const { backfill, pushes } = makeBackfill(
      { b1: committed('b1'), b2: committed('b2'), b3: committed('b3') },
      { maxChunkBlocks: 1 },
      { respond: () => { throw new Error('protocol not supported'); } }
    );

    const result = await backfill.catchUpPeer(peer('relay'));

    expect(pushes.length).toBe(1);
    expect(result.accepted).toBe(0);

    // Not marked done — the next connection:open retries the whole store from the start.
    const retry = await backfill.catchUpPeer(peer('relay'));
    expect(pushes.length).toBe(2);
    expect(retry.accepted).toBe(0);
  });

  it('marks the peer done after a clean run — a second connection:open pushes nothing', async () => {
    const { backfill, pushes, fake } = makeBackfill({ b1: committed('b1') }, { debounceMs: 1 });
    backfill.start();

    fake.dispatchConnectionOpen(peer('p1'));
    await until(() => pushes.length === 1);

    fake.dispatchConnectionOpen(peer('p1'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushes.length).toBe(1);

    backfill.stop();
  });

  it('debounces reconnect flapping — many connection:open events, one run', async () => {
    const { backfill, pushes, fake } = makeBackfill(
      { b1: committed('b1'), b2: committed('b2') },
      { debounceMs: 25 }
    );
    backfill.start();

    for (let i = 0; i < 5; i++) {
      fake.dispatchConnectionOpen(peer('p1'));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await until(() => pushes.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // One debounced run — both blocks fit one chunk, so exactly one push.
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.ids.sort()).toEqual(['b1', 'b2']);

    backfill.stop();
  });

  it('catches up peers that were already connected when start() ran (resumeStrand over live connections)', async () => {
    const { pushes, client } = makePushClient();
    const fake = makeLibp2p([{ remotePeer: peer('pre-connected') }]);
    const backfill = new StrandBackfill({
      strandId: 'strand-test',
      libp2p: fake.node,
      peerNetwork: {} as IPeerNetwork,
      storage: makeStorage({ b1: committed('b1') }),
      protocolPrefix: '/optimystic/strand-strand-test',
      createPushClient: () => client
    }, { debounceMs: 1 });

    backfill.start();
    await until(() => pushes.length === 1);
    expect(pushes[0]!.ids).toEqual(['b1']);

    backfill.stop();
  });

  it('stop() mid-run abandons the remaining chunks', async () => {
    const blocks = { b1: committed('b1'), b2: committed('b2'), b3: committed('b3') };
    // One block per chunk, and the first push stops the backfill while in flight.
    const holder: { backfill?: StrandBackfill } = {};
    const { backfill, pushes } = makeBackfill(blocks, { maxChunkBlocks: 1 }, {
      respond: () => {
        holder.backfill!.stop();
        return { missing: [] };
      }
    });
    holder.backfill = backfill;

    const result = await backfill.catchUpPeer(peer('p1'));

    expect(pushes.length).toBe(1);
    // Stopped before the run finished — nothing more may be pushed, ever.
    expect(result.offered).toBeLessThan(3);
    const after = await backfill.catchUpPeer(peer('p1'));
    expect(after.offered).toBe(0);
    expect(pushes.length).toBe(1);
  });

  it('is inert (no throw, zero pushes) when the storage backend lacks listBlockIds', async () => {
    const { pushes, client } = makePushClient();
    const fake = makeLibp2p();
    const backfill = new StrandBackfill({
      strandId: 'strand-test',
      libp2p: fake.node,
      peerNetwork: {} as IPeerNetwork,
      storage: makeStorage({ b1: committed('b1') }, { listBlockIds: false }),
      protocolPrefix: '/optimystic/strand-strand-test',
      createPushClient: () => client
    });

    const result = await backfill.catchUpPeer(peer('p1'));
    expect(result.offered).toBe(0);
    expect(pushes.length).toBe(0);
  });

  it('start() respects enabled: false and stop() removes the listener', async () => {
    const { backfill: disabled, fake: disabledFake } = makeBackfill({ b1: committed('b1') }, { enabled: false });
    disabled.start();
    expect(disabledFake.listenerCount('connection:open')).toBe(0);

    const { backfill, fake } = makeBackfill({ b1: committed('b1') });
    backfill.start();
    expect(fake.listenerCount('connection:open')).toBe(1);
    backfill.stop();
    expect(fake.listenerCount('connection:open')).toBe(0);
  });

  it('suppresses a concurrent duplicate run for the same peer', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Hold the first run open inside its push so the second call observably overlaps it.
    const captured = makePushClient();
    const stalledClient: StrandBackfillPushClient = {
      pushBlocks: async (...args) => {
        await gate;
        return captured.client.pushBlocks(...args);
      }
    };
    const fake = makeLibp2p();
    const backfill = new StrandBackfill({
      strandId: 'strand-test',
      libp2p: fake.node,
      peerNetwork: {} as IPeerNetwork,
      storage: makeStorage({ b1: committed('b1') }),
      protocolPrefix: '/optimystic/strand-strand-test',
      createPushClient: () => stalledClient
    });

    const first = backfill.catchUpPeer(peer('p1'));
    const second = await backfill.catchUpPeer(peer('p1'));
    expect(second.offered).toBe(0); // duplicate suppressed while the first is in flight

    release!();
    const firstResult = await first;
    expect(firstResult.accepted).toBe(1);
    expect(captured.pushes.length).toBe(1);
  });
});
