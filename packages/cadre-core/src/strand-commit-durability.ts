import debug from 'debug';
import { durabilityRank } from '@optimystic/db-core';
import type { WriteDurability } from '@optimystic/db-core';
import type { CommitFullyHeld, SqlCommitDurability } from '@serfab/quereus-plugin-sereus';

const log = debug('sereus:cadre:strand-commit-durability');

/** What one commit on a strand wrote, and whether it survives this machine stopping for good. */
export interface StrandCommitDurability {
  readonly strandId: string;
  /** `StampId()` inside the committed transaction. */
  readonly transactionId: string;
  /**
   * Another member holds every block the commit wrote: the overall answer is `majority` or `full`.
   * False for `local`, `unrouted`, or an unknown overall. Becomes true once `strand:commit-held`
   * fires for the commit.
   */
  readonly heldElsewhere: boolean;
  /**
   * When {@link heldElsewhere} is false: `strand:commit-held` will fire for this commit if it
   * reaches the others while this database stays open. False means nothing will say so.
   */
  readonly followed: boolean;
  /** The plugin's report, for per-table detail. */
  readonly report: SqlCommitDurability;
}

/** A commit that was held only below full replication is now held by every member of its cohort. */
export interface StrandCommitHeld {
  readonly strandId: string;
  readonly transactionId: string;
}

/** Where a strand database forwards each commit's durability and each held commit. */
export interface StrandCommitListeners {
  onCommitDurability?: (commit: StrandCommitDurability) => void;
  onCommitHeld?: (event: StrandCommitHeld) => void;
}

// NOTE: if an app reads a commit's durability later than 256 commits after it, raise this or let
// the app pass the id up front.
const RECENT_COMMIT_LIMIT = 256;

/**
 * `majority` counts: a strict majority of a cohort of at least two is at least two machines, so
 * the write survives this one stopping. The one place this rule lives; apps read the field.
 */
function isHeldElsewhere(overall: WriteDurability | undefined): boolean {
  return overall !== undefined && durabilityRank(overall.quorum) >= durabilityRank('majority');
}

/**
 * The durability of the most recent commits on one strand database, by transaction id. The
 * plugin reports a commit — and a `covered` commit is held — before the statement that made it
 * resolves, so an app that learns its id from `returning StampId()` reads the answer from here
 * afterwards. Each entry is frozen and replaced when the commit becomes held, so a value read
 * from {@link get} never changes under its reader.
 */
export class StrandCommitRecord {
  private readonly commits = new Map<string, StrandCommitDurability>();

  constructor(
    private readonly strandId: string,
    private readonly listeners: StrandCommitListeners
  ) {}

  get(transactionId: string): StrandCommitDurability | undefined {
    return this.commits.get(transactionId);
  }

  /** A plugin `onCommitDurability` report: record it, then forward it. */
  reportCommit(report: SqlCommitDurability): void {
    const commit = Object.freeze({
      strandId: this.strandId,
      transactionId: report.transactionId,
      heldElsewhere: isHeldElsewhere(report.durability.overall),
      followed: report.followed,
      report
    });
    this.remember(commit);
    this.forward('durability', report.transactionId, () => this.listeners.onCommitDurability?.(commit));
  }

  /** A plugin `onCommitFullyHeld` event: mark the commit held, then forward it — also for one no longer recorded. */
  reportHeld({ transactionId }: CommitFullyHeld): void {
    const recorded = this.commits.get(transactionId);
    if (recorded) {
      this.commits.set(transactionId, Object.freeze({ ...recorded, heldElsewhere: true }));
    }
    this.forward('held', transactionId, () => this.listeners.onCommitHeld?.({ strandId: this.strandId, transactionId }));
  }

  private remember(commit: StrandCommitDurability): void {
    this.commits.set(commit.transactionId, commit);
    if (this.commits.size > RECENT_COMMIT_LIMIT) {
      const oldest = this.commits.keys().next().value!;
      this.commits.delete(oldest);
    }
  }

  /**
   * Run an app's handler isolated: it runs inside the commit, and a throw reaching the plugin
   * would be logged there as the plugin's own listener failing.
   */
  private forward(kind: string, transactionId: string, deliver: () => void): void {
    try {
      deliver();
    } catch (error) {
      log('strand %s: %s handler threw for transaction %s: %O', this.strandId, kind, transactionId, error);
    }
  }
}
