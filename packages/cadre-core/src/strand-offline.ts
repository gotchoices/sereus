import { EntryNotDiscardableError, UnknownEntryError } from '@optimystic/db-core';
import type { IKVStore } from '@optimystic/db-p2p';
import type { OfflineModeState, QueuedTransactionStatus, StrandOfflineController } from '@serfab/quereus-plugin-sereus';

/**
 * Which acknowledgement a strand's transactions get from the moment it is set: `'offline'`, a
 * commit resolves once the transaction is queued on this machine; `'online'`, once the strand's
 * members have taken it.
 */
export type StrandOfflineMode = 'online' | 'offline';

/** `CadreNodeConfig.strandOffline`: what a node needs to offer offline mode on its strands. */
export interface StrandOfflineConfig {
  /**
   * The journal for one strand: called once per database build with the strand id (a storage scope
   * key). Queued transactions are saved in it before their commit resolves, so they survive a
   * restart. A throw or rejection fails the build, as a storage provider's does.
   *
   * Nothing in cadre-core or Optimystic closes the store, and every rebuild (a wake, a retry while
   * no seed peer answers) calls this again, so return the same store for the same scope and close
   * it yourself after the node stops.
   */
  journal: (scope: string) => IKVStore | Promise<IKVStore>;
  /** The mode every strand starts in until the app sets one. Default `'online'`. */
  initialMode?: StrandOfflineMode;
}

/**
 * `StrandDatabase.offline`: the strand connection's offline queue, less the mode switch, which
 * goes through `CadreNode.setStrandOfflineMode` so that it outlives the database. Listeners taken
 * here die with the database; the `CadreNode` events do not.
 */
export type StrandOfflineQueue = Pick<StrandOfflineController,
  'queueState' | 'entries' | 'status' | 'outcomes' | 'acknowledge' | 'discard' | 'whenDrained' | 'onStatus' | 'onQueueState'>;

/** `strand:offline-status`: one status of one queued transaction. */
export interface StrandOfflineStatus {
  readonly strandId: string;
  readonly status: QueuedTransactionStatus;
}

/** `strand:queue-state`: the queue's state, for a status line. */
export interface StrandQueueState {
  readonly strandId: string;
  readonly state: OfflineModeState;
}

/**
 * Where a strand database reports its offline queue. Retained with the launch config and handed to
 * every database built for the launch, so the reports outlive hibernation and every other rebuild.
 */
export interface StrandOfflineListeners {
  onOfflineStatus?: (event: StrandOfflineStatus) => void;
  onQueueState?: (event: StrandQueueState) => void;
}

/** Thrown by `CadreNode.setStrandOfflineMode` on a node configured without `strandOffline`. */
export class StrandOfflineUnavailableError extends Error {
  readonly strandId: string;

  constructor(strandId: string) {
    super(
      `Cannot put strand ${strandId} in offline mode: this node has no offline journal ` +
      '(CadreNodeConfig.strandOffline is not configured), and a queue lost with the process would ' +
      'break the promise a local commit makes.'
    );
    this.name = 'StrandOfflineUnavailableError';
    this.strandId = strandId;
  }
}

/** Options for leaving a strand: `CadreNode.forgetJoinedStrand` and `CadreNode.unpublishStrand`. */
export interface StrandLeaveOptions {
  /**
   * Withdraw the strand's queued offline transactions that were never sent, then leave. Without
   * it a leave refuses with {@link StrandQueueNotEmptyError} while the queue holds any: the app was
   * told each of them was acknowledged, so dropping them is the user's choice to make.
   */
  discardQueued?: boolean;
}

/**
 * Thrown by a leave ({@link StrandLeaveOptions}) while the strand's offline queue holds
 * transactions and `discardQueued` was not given. Nothing was left or removed.
 */
export class StrandQueueNotEmptyError extends Error {
  readonly strandId: string;
  /** The queued transactions, by the `StampId()` each one's statements returned. */
  readonly transactionIds: readonly string[];

  constructor(strandId: string, transactionIds: readonly string[]) {
    super(
      `Cannot leave strand ${strandId}: its offline queue holds ${transactionIds.length} transaction(s) its ` +
      `members have not taken yet (${transactionIds.join(', ')}), so nothing was left or removed. Show the user ` +
      'the unsent changes, then leave again with { discardQueued: true } to drop them, or once ' +
      'strand.database.offline.whenDrained() resolves.'
    );
    this.name = 'StrandQueueNotEmptyError';
    this.strandId = strandId;
    this.transactionIds = transactionIds;
  }
}

/**
 * Withdraw every transaction in `queue` that was never sent, for a leave the app confirmed
 * ({@link StrandLeaveOptions.discardQueued}). Returns the ones Optimystic refuses to withdraw
 * (`EntryNotDiscardableError`): each was sent, or is being sent or restored, and the strand's
 * members may already hold it, so it stays in the journal. One that settled meanwhile, or failed
 * with a transaction it depended on, is already gone.
 */
export function discardQueued(queue: Pick<StrandOfflineController, 'entries' | 'discard'>): string[] {
  const kept: string[] = [];
  for (const { transactionId } of queue.entries()) {
    try {
      queue.discard(transactionId);
    } catch (error) {
      if (error instanceof EntryNotDiscardableError) {
        kept.push(transactionId);
      } else if (!(error instanceof UnknownEntryError)) {
        throw error;
      }
    }
  }
  return kept;
}

/**
 * Whether a status shows the queue sending, which counts as strand activity for hibernation. A
 * transaction waiting for its cohort (`queued`) is not, or an offline phone would never hibernate.
 */
// NOTE: a send that keeps failing transiently while the cohort reads as reachable is re-tried at
// least every 60 s (Optimystic's re-check cap), so such a strand never idles. If a phone is found
// kept awake that way, count only `committed`, `partially-committed` and `failed`.
export function isSendingStatus(status: QueuedTransactionStatus): boolean {
  return status.kind === 'submitting' || status.kind === 'committed'
    || status.kind === 'partially-committed' || status.kind === 'failed';
}

/**
 * What one strand database reports about its offline queue. Built once `connectToStrand` has
 * returned (a restored transaction's `queued` status was delivered during its `hydrate`, before this
 * subscribes: {@link published} reports the queue's state for that reason) and released first when
 * the database closes, so nothing from a closing connection reaches the app.
 */
export class StrandOfflineReport {
  private wasPublished = false;
  private released = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly strandId: string,
    private readonly listeners: StrandOfflineListeners,
    private readonly queue: StrandOfflineController | undefined
  ) {
    const unsubscribeStatus = queue?.onStatus((status) => listeners.onOfflineStatus?.({ strandId, status }));
    const unsubscribeState = queue?.onQueueState((state) => listeners.onQueueState?.({ strandId, state }));
    this.unsubscribe = () => {
      unsubscribeStatus?.();
      unsubscribeState?.();
    };
  }

  /** The database was handed to the app: report the queue's state. */
  published(): void {
    if (this.released || this.wasPublished) {
      return;
    }
    this.wasPublished = true;
    if (this.queue) {
      this.listeners.onQueueState?.({ strandId: this.strandId, state: this.queue.queueState() });
    }
  }

  release(): void {
    this.released = true;
    this.unsubscribe();
  }
}
