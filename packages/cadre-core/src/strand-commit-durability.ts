import debug from 'debug';
import { durabilityRank } from '@optimystic/db-core';
import type { WriteDurability } from '@optimystic/db-core';
import type { CommitFullyHeld, SqlCommitDurability } from '@serfab/quereus-plugin-sereus';
import type { PartyStrandPeer } from './strand-party-peers.js';

const log = debug('sereus:cadre:strand-commit-durability');

/** What one commit on a strand wrote, and whether it survives this machine stopping for good. */
export interface StrandCommitDurability {
  readonly strandId: string;
  /** `StampId()` inside the committed transaction. */
  readonly transactionId: string;
  /**
   * Another member holds every block the commit wrote: the overall answer is `majority` or `full`
   * and no block was abandoned (`torn`). False for `local`, `unrouted`, an unknown overall, or a
   * torn commit. Becomes true once `strand:commit-held` fires for the commit.
   */
  readonly heldElsewhere: boolean;
  /**
   * When {@link heldElsewhere} is false: `strand:commit-held` will fire for this commit if it
   * reaches the others while this database stays open. False means nothing will say so.
   */
  readonly followed: boolean;
  /**
   * The party's other machines known to hold this strand that do not hold this commit yet: those
   * not in `report.durability.overall.cohortPeerIds`, or named in its `unconfirmed`. Empty when
   * {@link heldElsewhere} is true. Absent on a node offering no offline mode, which does not track them.
   * Empty with `heldElsewhere` false does not prove a cadre of one (docs/strands/writes.md → "A commit's durability").
   */
  readonly awaitedMachines?: readonly PartyStrandPeer[];
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
 * the write survives this one stopping. A torn commit does not, though it can succeed as `majority`
 * (Optimystic clamps a torn `full` to it): its abandoned blocks are held by nobody. The one place
 * this rule lives; apps read the field.
 */
function isHeldElsewhere(overall: WriteDurability | undefined): boolean {
  return overall !== undefined
    && durabilityRank(overall.quorum) >= durabilityRank('majority')
    && (overall.torn?.length ?? 0) === 0;
}

const NO_MACHINES: readonly PartyStrandPeer[] = Object.freeze([]);

/**
 * With no `cohortPeerIds` the answering layer could not name the cohort, so no machine is
 * confirmed to hold the commit and every one is listed.
 *
 * NOTE: reads the scalars, which describe the weakest answer, and ignores `otherCohorts`, so a
 * machine that another cohort's answer shows holding one block can be listed although that block
 * reached it. The list over-reports; {@link isHeldElsewhere} stays the answer to survival. If an
 * app ever needs the list per block, walk `otherCohorts` here.
 */
function machinesAwaited(overall: WriteDurability | undefined, machines: readonly PartyStrandPeer[]): readonly PartyStrandPeer[] {
  if (isHeldElsewhere(overall)) {
    return NO_MACHINES;
  }
  const cohort = overall?.cohortPeerIds && new Set(overall.cohortPeerIds);
  const unconfirmed = new Set(overall?.unconfirmed);
  return Object.freeze(machines.filter(({ strandPeerId }) => !cohort?.has(strandPeerId) || unconfirmed.has(strandPeerId)));
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
    private readonly listeners: StrandCommitListeners,
    /**
     * The tracker's last good answer: {@link reportCommit} runs inside the commit and cannot wait for a read.
     *
     * NOTE: a commit does not ask the tracker to retry a failed read; the offline gate's re-check and
     * the next control-table change do. In online mode a failed read can therefore list nobody until
     * the next change. If an app ever shows that, call `refresh()` here when `lastReadFailed()`.
     */
    private readonly partyMachines?: () => readonly PartyStrandPeer[]
  ) {}

  get(transactionId: string): StrandCommitDurability | undefined {
    return this.commits.get(transactionId);
  }

  /** A plugin `onCommitDurability` report: record it, then forward it. */
  reportCommit(report: SqlCommitDurability): void {
    const { overall } = report.durability;
    const commit: StrandCommitDurability = Object.freeze({
      strandId: this.strandId,
      transactionId: report.transactionId,
      heldElsewhere: isHeldElsewhere(overall),
      followed: report.followed,
      ...(this.partyMachines && { awaitedMachines: machinesAwaited(overall, this.partyMachines()) }),
      report
    });
    this.remember(commit);
    this.forward('durability', report.transactionId, () => this.listeners.onCommitDurability?.(commit));
  }

  /**
   * A plugin `onCommitFullyHeld` event: mark the commit held, then forward it — also for one no longer recorded.
   *
   * NOTE: accepted tradeoff — the event fires when the under-replication drain settles the commit,
   * so with two machines out the first to take the copies clears the list while the second still
   * lacks them. The field answers "who was this commit waiting for" until another machine holds it;
   * {@link StrandCommitDurability.heldElsewhere} is the survival answer.
   */
  reportHeld({ transactionId }: CommitFullyHeld): void {
    const recorded = this.commits.get(transactionId);
    if (recorded) {
      this.commits.set(transactionId, Object.freeze({
        ...recorded,
        heldElsewhere: true,
        ...(recorded.awaitedMachines && { awaitedMachines: NO_MACHINES })
      }));
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
