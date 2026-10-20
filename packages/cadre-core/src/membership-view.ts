/**
 * An in-memory copy of one small control table's rows, kept until the table changes, so the
 * membership, owner, peer-record and admission-chain reads that every flow repeats cost nothing
 * after the first.
 * `ControlDatabase` keeps one per cached table and drops it from its table-change subscription
 * (`docs/architecture.md` → "Membership rows view"); this class holds only the caching rules, so
 * they are testable without a database.
 */
/**
 * How long installed rows are served before the next read reloads them, change or no change.
 * The reload is the only path for a change that reaches this node with no storage event: a
 * machine outside the block's cohort (a cadre larger than its replication breadth), or one in
 * the cohort that the writer could not reach when it committed (one side of a NAT pair; the
 * cohort auto-connect scenarios). Longer than Optimystic's read-repair window
 * ({@link OPTIMYSTIC_READ_REPAIR_WINDOW_MS}), so the reload's storage read starts the cohort
 * consult that brings such a change in instead of being served from the local copy, and
 * shorter than any reconcile backstop (`DEFAULT_CONTROL_COHORT_RECONCILE_MS`, 2 minutes), so
 * the backstop pass, the only reader on an idle party, reloads rather than serving kept rows.
 * The reload rate on an idle party is therefore the pass rate, and the staleness bound for
 * such a change is the backstop, not this value.
 *
 * A machine that was offline when a sibling committed is covered sooner than either:
 * `CadreNode` drops every view when a sibling becomes reachable (its identify on a new
 * connection; `ControlDatabase.invalidateMembershipViews`), so the pass that starts then reads
 * storage.
 */
export const MEMBERSHIP_VIEW_MAX_AGE_MS = 15_000;

/**
 * Optimystic's lazy read-repair window (`clusterPolicy.readRepairWindowMs`, which cadre does
 * not set, so this is Optimystic's default): a read of a held block checked less than this
 * long ago is served from the local copy without asking the cohort. A read after it is
 * served locally too, but starts a cohort consult whose landing raises a table change.
 *
 * NOTE: a copy, since db-p2p exports no default for it. If cadre ever sets
 * `readRepairWindowMs` in its cluster policy, derive this from that value.
 */
const OPTIMYSTIC_READ_REPAIR_WINDOW_MS = 10_000;

/**
 * How long after a sibling becomes reachable (its identify on a new connection) `CadreNode`
 * drops the views a second time: one read-repair window, plus a second for timer slop. The
 * drop at the identify is not enough by itself. A node's reads before the sibling arrived
 * (its start pass, with no cohort to ask) stamp the window, so the reload the identify
 * starts is served from the local copy without a consult and the view would keep the
 * pre-connection rows until {@link MEMBERSHIP_VIEW_MAX_AGE_MS}. The reload past the window
 * starts the consults that bring in what the sibling committed while this node was away.
 */
export const MEMBERSHIP_VIEW_RECONNECT_RELOAD_MS = OPTIMYSTIC_READ_REPAIR_WINDOW_MS + 1_000;

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
