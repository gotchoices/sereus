/**
 * An in-memory copy of one small control table's rows, kept until the table changes, so the
 * membership, owner, peer-record and admission-chain reads that every flow repeats cost nothing
 * after the first.
 * `ControlDatabase` keeps one per cached table and drops it from its table-change subscription
 * (`docs/architecture.md` → "Membership rows view"); this class holds only the caching rules, so
 * they are testable without a database.
 */
import { DEFAULT_CONTROL_COHORT_RECONCILE_MS } from './control-cohort.js';

/**
 * How long installed rows are served before the next read reloads them, change or no change.
 * The reload is the only path for a change that reaches this node with no storage event.
 *
 * NOTE: two cases depend on this bound: a machine outside the block's cohort (a cadre larger
 * than its replication breadth), and a machine that was offline when a sibling committed and
 * has not re-read the block since. Both were bounded by the reconcile pass's re-read before the
 * view existed, so this follows the default reconcile interval; lengthening that interval
 * lengthens this too, which the reconcile pass's own change decides.
 */
export const MEMBERSHIP_VIEW_MAX_AGE_MS = DEFAULT_CONTROL_COHORT_RECONCILE_MS;

/** One load's rows, and whether the view may keep them. */
export interface MembershipViewLoad<Row> {
	rows: readonly Row[];
	/**
	 * False when no later change event is guaranteed to reach the view for these rows (the
	 * read that produced them did not arm the table's change bridge), so they serve only the
	 * callers of this load.
	 */
	installable: boolean;
}

/**
 * Reads the whole table. `retry` is the caller's: false from a caller holding the control
 * write lock, whose read must not sleep a retry backoff.
 */
export type MembershipViewLoader<Row> = (retry: boolean) => Promise<MembershipViewLoad<Row>>;

export interface MembershipViewOptions {
	/** Default {@link MEMBERSHIP_VIEW_MAX_AGE_MS}. */
	maxAgeMs?: number;
	/** Monotonic clock in milliseconds; default `performance.now`. */
	now?: () => number;
}

export class MembershipView<Row> {
	private rows: readonly Row[] | undefined;
	/** When the load that produced {@link rows} started: the rows are no older than this. */
	private loadedAt = 0;
	/** Bumped by every {@link invalidate}; a load installs only if it is unchanged since the load began. */
	private generation = 0;
	/**
	 * The load each `retry` flag's callers share, current generation only. Separate per flag
	 * so a caller under the write lock never awaits a retrying load's backoff sleep.
	 */
	private readonly inFlight = new Map<boolean, Promise<readonly Row[]>>();
	private readonly maxAgeMs: number;
	private readonly now: () => number;

	constructor(private readonly loader: MembershipViewLoader<Row>, options: MembershipViewOptions = {}) {
		this.maxAgeMs = options.maxAgeMs ?? MEMBERSHIP_VIEW_MAX_AGE_MS;
		this.now = options.now ?? (() => performance.now());
	}

	/**
	 * The table's rows: the installed copy while it is younger than the maximum age, otherwise a
	 * load, shared with every caller of the same `retry` flag that arrives while it runs. A load
	 * that raced an {@link invalidate} answers its own callers with what it read, as an uncached
	 * read would have, and keeps nothing. A failed load keeps nothing and rejects.
	 */
	read(retry: boolean): Promise<readonly Row[]> {
		if (this.rows !== undefined && this.now() - this.loadedAt < this.maxAgeMs) {
			return Promise.resolve(this.rows);
		}
		return this.inFlight.get(retry) ?? this.startLoad(retry);
	}

	/** Read the table without serving, joining or keeping anything. */
	async readThrough(retry: boolean): Promise<readonly Row[]> {
		return (await this.loader(retry)).rows;
	}

	/**
	 * Drop the installed rows and every load in flight, so the next read loads afresh and no
	 * earlier load installs. Synchronous and flag-setting only: the table-change handler calls
	 * it inside the committing call.
	 */
	invalidate(): void {
		this.generation++;
		this.rows = undefined;
		this.inFlight.clear();
	}

	private startLoad(retry: boolean): Promise<readonly Row[]> {
		const load = this.load(retry, this.generation, this.now());
		this.inFlight.set(retry, load);
		const forget = (): void => {
			if (this.inFlight.get(retry) === load) {
				this.inFlight.delete(retry);
			}
		};
		// Both arms handled, so a failed load rejects only for the callers awaiting it.
		void load.then(forget, forget);
		return load;
	}

	private async load(retry: boolean, generation: number, startedAt: number): Promise<readonly Row[]> {
		const { rows, installable } = await this.loader(retry);
		if (installable && generation === this.generation) {
			this.rows = rows;
			this.loadedAt = startedAt;
		}
		return rows;
	}
}
