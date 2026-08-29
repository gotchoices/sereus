import debug from 'debug';
import type { Connection, Libp2p, PeerId } from '@libp2p/interface';
import type { ActionId, IPeerNetwork } from '@optimystic/db-core';
import { BlockTransferClient, type BlockCommitProof, type IRawStorage } from '@optimystic/db-p2p';

// NOTE: this copies the WHOLE local store to every newly connected strand peer, which is
// right while a strand mesh is one party's handful of machines (see docs/architecture.md →
// Replication cluster size, "On a strand, the machine count is not a party count"). If
// strand meshes ever get large, filter the pushed set by FRET cohort responsibility for
// each block id instead of pushing everything.
//
// NOTE: this lives in cadre-core only because `../optimystic` is read-only from this repo.
// If Optimystic ever grows a cohort-join catch-up of its own, delete this module rather
// than running two.
//
// Membership: anything connected on the strand's own libp2p network already receives
// cohort replicas of new commits, so pushing older blocks to it exposes nothing new. No
// membership gate here — adding one would diverge from what ordinary replication already
// does on this network. A peer that does NOT speak this strand's block-transfer protocol
// (a bare circuit relay or bootstrap node the strand node also connects to) cannot receive
// anything: the protocol id is namespaced per strand, so the dial fails and the push is
// dropped.
//
// NOTE: that failing case costs one dial timeout per connection:open from such a peer, and
// is never memoized (only clean runs are). Bounded today by the debounce plus the
// unreachable-peer bail in `runCatchUp` — one dial per event, not one per chunk. If a strand
// node ever holds many non-strand connections, or the enumeration ahead of the first chunk
// gets expensive, pre-check `libp2p.peerStore` for this strand's block-transfer protocol
// before enumerating.
//
// NOTE: a run that fails is retried only when that peer next opens a connection. Over a
// stable connection a transient push failure therefore leaves the peer partially copied
// until the next reconnect (read repair still covers reads meanwhile). If strand meshes
// ever hold long-lived connections where that matters, re-arm the debounce timer with a
// backoff on a non-clean run instead of waiting for connection:open.

const log = debug('sereus:cadre:strand-backfill');

/**
 * The block-transfer protocol's hard cap on one length-prefixed message. Mirrors
 * `MAX_BLOCK_MESSAGE_BYTES` in `@optimystic/db-p2p`'s `protocol-limits.ts` (8 MiB), which
 * that package does not re-export from its index — keep the two in sync if upstream ever
 * changes it or starts exporting it.
 */
export const MAX_BLOCK_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Tuning for the per-peer strand catch-up. Every field optional; defaults in {@link DEFAULT_STRAND_BACKFILL}. */
export interface StrandBackfillConfig {
  /** Default true. False disables the catch-up entirely (the pre-existing behaviour). */
  enabled?: boolean;
  /** Settle time after a connection opens before catching that peer up, ms. Default 1000. */
  debounceMs?: number;
  /** Ceiling on blocks copied in one catch-up. Default 10_000. Reaching it is LOGGED, never silent. */
  maxBlocks?: number;
  /** Soft byte budget per push message. Default 1 MiB. Protocol hard cap is {@link MAX_BLOCK_MESSAGE_BYTES} (8 MiB). */
  maxChunkBytes?: number;
  /** Max blocks per push message. Default 64. */
  maxChunkBlocks?: number;
  /** Per-push dial deadline, ms. Default 3000 (matches SpreadOnChurnMonitor). */
  dialTimeoutMs?: number;
  /** Per-push response deadline, ms. Default 10_000 (matches SpreadOnChurnMonitor). */
  responseTimeoutMs?: number;
}

/** The resolved defaults every {@link StrandBackfill} starts from. */
export const DEFAULT_STRAND_BACKFILL: Required<StrandBackfillConfig> = {
  enabled: true,
  debounceMs: 1000,
  maxBlocks: 10_000,
  maxChunkBytes: 1024 * 1024,
  maxChunkBlocks: 64,
  dialTimeoutMs: 3000,
  responseTimeoutMs: 10_000
};

/**
 * The one capability the catch-up needs from a transfer client. Structural (rather than
 * the concrete `BlockTransferClient`) so unit tests can capture pushes without dialing
 * libp2p — see {@link StrandBackfillDeps.createPushClient}.
 */
export type StrandBackfillPushClient = Pick<BlockTransferClient, 'pushBlocks'>;

export interface StrandBackfillDeps {
  strandId: string;
  /** The STRAND's libp2p node (not the control node) — source of connection events and peer ids. */
  libp2p: Libp2p;
  /** `node.keyNetwork`, the IPeerNetwork BlockTransferClient dials through. */
  peerNetwork: IPeerNetwork;
  /** This strand's own raw block store — the same instance handed to the libp2p node. */
  storage: IRawStorage;
  /** Must equal the prefix the receiver registered its handler under: `/optimystic/strand-<strandId>`. */
  protocolPrefix: string;
  /**
   * Test seam: build the per-peer push client. Defaults to a real
   * `BlockTransferClient` over {@link peerNetwork} + {@link protocolPrefix}.
   */
  createPushClient?: (peerId: PeerId) => StrandBackfillPushClient;
}

/** What one peer's catch-up actually did. Returned for tests and logged at the end of each run. */
export interface StrandBackfillResult {
  /** Blocks offered: had a committed `latest` AND materialized content locally. */
  offered: number;
  /** Blocks the remote reported it persisted. */
  accepted: number;
  /** Block ids the remote reported in `missing` (parse or persist failure on its side). */
  rejected: string[];
  /** Skipped: metadata has no `latest` (pending-only — not yet a durability claim here). */
  uncommitted: number;
  /** Skipped: `latest` exists but no materialized block is stored for that actionId. */
  unmaterialized: number;
  /** Not attempted because `maxBlocks` was reached. */
  capped: number;
  /** Skipped: a single block whose wire size alone exceeds {@link MAX_BLOCK_MESSAGE_BYTES}. */
  oversized: string[];
}

function emptyResult(): StrandBackfillResult {
  return { offered: 0, accepted: 0, rejected: [], uncommitted: 0, unmaterialized: 0, capped: 0, oversized: [] };
}

/** One in-flight push message being accumulated. */
interface Chunk {
  ids: string[];
  buffers: Uint8Array[];
  meta: Record<string, { rev: number; actionId: ActionId }>;
  /**
   * The cohort commit proof retained for each block's pushed revision, where one exists.
   *
   * A receiver running the default `requirePushCertificate: true` REJECTS a block pushed
   * without one, so this is what makes peer-join catch-up land at all — a push carrying only
   * `meta` is the legacy shape and is refused. Sparse deliberately: a block whose proof was
   * never retained is still offered with its meta, which is the only thing that lets a
   * receiver migrating with the flag off land the replica at this node's revision rather than
   * a fabricated rev 1. Upstream's rule is the other direction and holds here by construction:
   * a proof is never attached WITHOUT its meta, because both are written from the same
   * `latest` in one place.
   */
  proofs: Record<string, BlockCommitProof>;
  bytes: number;
}

/**
 * Base64 wire size of a raw buffer — `pushBlocks` base64-encodes each block into the JSON
 * request, so the protocol cap must be judged against the encoded size, not the raw bytes.
 */
function base64WireBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Copies every block in one strand's own raw store to each peer its libp2p node connects
 * to, so a peer that joined the strand after blocks were committed still ends up holding
 * them physically (the receiver persists each push via `saveReplicatedBlock`, which is
 * monotonic and idempotent — crossing pushes from both ends cannot regress a revision).
 *
 * Best-effort throughout: nothing here throws into a libp2p event handler or into
 * `buildStrandRuntime`; a failed chunk is logged and the run continues. A peer is marked
 * fully caught up ONLY after a run with no thrown chunk and an empty `missing` list, so
 * the next `connection:open` from a peer whose catch-up failed retries it.
 */
export class StrandBackfill {
  private readonly config: Required<StrandBackfillConfig>;
  private readonly createPushClient: (peerId: PeerId) => StrandBackfillPushClient;
  private started = false;
  private stopped = false;
  /** Peers fully caught up this runtime (never retried until the runtime is rebuilt). */
  private readonly done = new Set<string>();
  /** Peers with a catch-up currently running (suppresses concurrent duplicates). */
  private readonly inFlight = new Set<string>();
  /** Pending per-peer debounce timers, cleared on stop. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onConnectionOpen: (evt: CustomEvent<Connection>) => void;
  private loggedNoListBlockIds = false;

  constructor(private readonly deps: StrandBackfillDeps, config?: StrandBackfillConfig) {
    this.config = { ...DEFAULT_STRAND_BACKFILL, ...config };
    this.createPushClient = deps.createPushClient
      ?? ((peerId) => new BlockTransferClient(peerId, deps.peerNetwork, deps.protocolPrefix));
    this.onConnectionOpen = (evt) => this.schedulePeer(evt.detail.remotePeer);
  }

  /** Subscribe to connection:open AND schedule a catch-up for peers already connected. */
  start(): void {
    if (this.started || this.stopped || !this.config.enabled) return;
    this.started = true;
    this.deps.libp2p.addEventListener('connection:open', this.onConnectionOpen);
    // A runtime rebuilt over live connections (resumeStrand) never sees their
    // connection:open, so walk what is already connected once.
    const existing = this.deps.libp2p.getConnections();
    for (const connection of existing) {
      this.schedulePeer(connection.remotePeer);
    }
    log('[%s] started (%d peer(s) already connected)', this.deps.strandId, existing.length);
  }

  /** Unsubscribe, clear timers; in-flight runs observe the stopped flag and bail. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.started) {
      this.deps.libp2p.removeEventListener('connection:open', this.onConnectionOpen);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    log('[%s] stopped', this.deps.strandId);
  }

  /** Debounced entry point for connection churn: one run per peer per settle window. */
  private schedulePeer(peerId: PeerId): void {
    const key = peerId.toString();
    if (this.stopped || this.done.has(key) || this.inFlight.has(key)) return;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.catchUpPeer(peerId);
    }, this.config.debounceMs));
  }

  /**
   * Run one peer's catch-up now, bypassing the debounce. Never rejects. Returns an
   * all-zero result without pushing when the peer is already caught up, already being
   * caught up, or this backfill is stopped.
   */
  async catchUpPeer(peerId: PeerId): Promise<StrandBackfillResult> {
    const key = peerId.toString();
    if (this.stopped || this.done.has(key) || this.inFlight.has(key)) {
      return emptyResult();
    }
    this.inFlight.add(key);
    try {
      const { result, clean } = await this.runCatchUp(peerId);
      // NOTE: a run that hit `maxBlocks` is still "clean" and still memoizes the peer, so
      // the tail past the ceiling never reaches it. Deliberate: enumeration is not
      // resumable, so not memoizing would re-push the same prefix on every reconnect
      // without ever advancing. Loud in the log below (capped > 0). If a strand's store can
      // realistically exceed maxBlocks, the fix is a resumable cursor, not either policy.
      if (clean && !this.stopped) {
        this.done.add(key);
      }
      log('[%s] catch-up peer=%s offered=%d accepted=%d rejected=%d uncommitted=%d unmaterialized=%d capped=%d oversized=%d done=%s',
        this.deps.strandId, key, result.offered, result.accepted, result.rejected.length,
        result.uncommitted, result.unmaterialized, result.capped, result.oversized.length, clean);
      return result;
    } catch (error) {
      // runCatchUp already contains a per-chunk catch; this guards the enumeration and
      // metadata reads too — a backfill fault must never surface through a libp2p event.
      log('[%s] catch-up peer=%s failed: %o', this.deps.strandId, key, error);
      return emptyResult();
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** The actual copy. `clean` = every chunk pushed and the remote persisted every block. */
  private async runCatchUp(peerId: PeerId): Promise<{ result: StrandBackfillResult; clean: boolean }> {
    const result = emptyResult();
    const { storage } = this.deps;

    if (!storage.listBlockIds) {
      if (!this.loggedNoListBlockIds) {
        this.loggedNoListBlockIds = true;
        log('[%s] raw storage does not implement listBlockIds(); backfill is inert', this.deps.strandId);
      }
      return { result, clean: false };
    }

    const client = this.createPushClient(peerId);
    const encoder = new TextEncoder();
    let chunk: Chunk = { ids: [], buffers: [], meta: {}, proofs: {}, bytes: 0 };
    let chunkFailed = false;
    let anyChunkDelivered = false;
    /**
     * A peer that has answered no push at all, and failed one, is not reachable on this
     * protocol — abandon rather than spend a dial timeout per remaining chunk. Once ONE
     * push has been answered the peer demonstrably speaks it, so a later failure is a
     * transient blip and the rest of the store is still worth pushing.
     */
    const peerUnreachable = (): boolean => chunkFailed && !anyChunkDelivered;

    const flush = async (): Promise<void> => {
      if (chunk.ids.length === 0) return;
      const { ids, buffers, meta, proofs } = chunk;
      chunk = { ids: [], buffers: [], meta: {}, proofs: {}, bytes: 0 };
      try {
        // ONE certification value rather than two arguments, so a caller cannot pair a proof
        // for one revision with meta for another — both were written from the same `latest`.
        const response = await client.pushBlocks(ids, buffers, 'replication',
          { blockMeta: meta, blockProofs: proofs }, {
          dialTimeoutMs: this.config.dialTimeoutMs,
          responseTimeoutMs: this.config.responseTimeoutMs
        });
        anyChunkDelivered = true;
        const missing = new Set(response.missing);
        for (const id of ids) {
          if (missing.has(id)) {
            result.rejected.push(id);
          } else {
            result.accepted += 1;
          }
        }
        if (response.missing.length > 0) {
          log('[%s] peer=%s rejected %d block(s): %o', this.deps.strandId, peerId.toString(), response.missing.length, response.missing);
        }
      } catch (error) {
        chunkFailed = true;
        log('[%s] push to peer=%s failed for %d block(s): %s', this.deps.strandId, peerId.toString(), ids.length, (error as Error).message);
      }
    };

    for await (const blockId of storage.listBlockIds()) {
      if (this.stopped) break;
      if (result.offered >= this.config.maxBlocks) {
        // Past the ceiling: count what is left (id enumeration only — no more reads or
        // pushes) so the cap is loud in the end-of-run log rather than silent.
        result.capped += 1;
        continue;
      }

      const metadata = await storage.getMetadata(blockId);
      const latest = metadata?.latest;
      if (!latest) {
        result.uncommitted += 1;
        continue;
      }
      // NOTE: a block whose latest revision is a DELETE materializes to nothing (a
      // tombstone), so it is skipped here — a peer that joins after such a delete never
      // receives the tombstone from this path and relies on read repair for it. Fine
      // while nothing deletes whole blocks pre-join; if the whole-store coverage gate in
      // strand-membership-closed-strand-e2e ever reports a tombstone residue, teach this
      // to push the promoted delete transform instead of skipping.
      const block = await storage.getMaterializedBlock(blockId, latest.actionId);
      if (!block) {
        result.unmaterialized += 1;
        log('[%s] block=%s has latest rev %d but no materialized content; skipped', this.deps.strandId, blockId, latest.rev);
        continue;
      }

      const buffer = encoder.encode(JSON.stringify(block));
      // NOTE: MAX_BLOCK_MESSAGE_BYTES caps the whole framed request, not one block, and
      // this test ignores the request envelope (ids array, blockMeta, JSON punctuation).
      // A lone block within a few KiB of the cap therefore still ships and is rejected by
      // the receiver's length-prefix decoder — a permanent chunk failure for that peer. No
      // block in a strand comes close today; if one ever can, subtract a measured envelope
      // allowance here rather than raising the cap.
      if (base64WireBytes(buffer.length) >= MAX_BLOCK_MESSAGE_BYTES) {
        result.oversized.push(blockId);
        log('[%s] block=%s is %d bytes (%d on the wire) — exceeds the %d-byte protocol cap alone; skipped',
          this.deps.strandId, blockId, buffer.length, base64WireBytes(buffer.length), MAX_BLOCK_MESSAGE_BYTES);
        continue;
      }

      // Flush before adding when this block would overflow either budget. A single block
      // larger than maxChunkBytes still ships — alone, in its own chunk.
      if (chunk.ids.length > 0
        && (chunk.ids.length + 1 > this.config.maxChunkBlocks || chunk.bytes + buffer.length > this.config.maxChunkBytes)) {
        await flush();
        if (this.stopped || peerUnreachable()) break;
      }
      chunk.ids.push(blockId);
      chunk.buffers.push(buffer);
      chunk.meta[blockId] = { rev: latest.rev, actionId: latest.actionId };
      // Read the proof for EXACTLY the revision being pushed, from the same `latest` the meta
      // above was written from. Absent is normal (nothing retained a proof for that revision);
      // the block still ships with its meta and the receiver decides.
      const proof = await storage.getBlockProof(blockId, latest.rev);
      if (proof) {
        chunk.proofs[blockId] = proof;
      }
      chunk.bytes += buffer.length;
      result.offered += 1;
    }

    if (!this.stopped && !peerUnreachable()) {
      await flush();
    }

    if (result.capped > 0) {
      log('[%s] peer=%s catch-up CAPPED at %d blocks; %d block id(s) not attempted',
        this.deps.strandId, peerId.toString(), this.config.maxBlocks, result.capped);
    }

    const clean = !chunkFailed && result.rejected.length === 0;
    return { result, clean };
  }
}
