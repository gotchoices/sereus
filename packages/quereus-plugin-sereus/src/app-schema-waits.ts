import debug from 'debug';
import { TransactionActiveError, type Database, type SqlParameters } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import { classifyCommitFailure } from '@optimystic/db-core';
import { QueuedEntriesBlockSchemaChangeError } from '@optimystic/quereus-plugin-optimystic/plugin';

const log = debug('sereus:plugin:strand');

/** The strand node's peer events, which a retry waiting for the cohort, and the running version check, wake on. */
export type PeerConnectEvents = Pick<Libp2p, 'addEventListener' | 'removeEventListener'>;

/** Why an apply or a version record was refused, when it is a refusal a later retry can get past. */
export type Deferral = { wait: 'queue'; transactionIds: readonly string[] } | { wait: 'cohort' };

/**
 * The refusal `err` is or wraps, when a later retry can get past it: Quereus rewraps an error out of
 * a migration step, keeping it as `cause`.
 *
 * `classifyCommitFailure` refuses to walk `cause` itself, because a commit-phase shortfall nested
 * there means the write is in doubt rather than unsent. Walking it here is safe for both writes it
 * sorts: an apply is a declarative diff, so a retry after a write that did land changes nothing, and
 * a retried version record reads the version again before writing it.
 */
export function deferralOf(err: unknown): Deferral | undefined {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof QueuedEntriesBlockSchemaChangeError) {
			return { wait: 'queue', transactionIds: at.transactionIds };
		}
		if (classifyCommitFailure(at).kind === 'cohort-unreachable') {
			return { wait: 'cohort' };
		}
	}
	return undefined;
}

/**
 * How long a step woken by a peer connect waits first, so the peer is identified and in the ring before
 * the step asks for its cohort.
 */
export const COHORT_CONNECT_SETTLE_MS = 2_000;

/** How long an sApp schema write waits before trying again while another caller's transaction is open. */
const OPEN_TRANSACTION_RETRY_MS = 250;

/**
 * Runs `attempt`, which ends in an atomic batch, until no other caller's open transaction refuses it.
 * Throws the open-transaction refusal when `released` aborts during the wait.
 */
export async function outsideOpenTransaction(attempt: () => Promise<void>, released: AbortSignal): Promise<void> {
	for (;;) {
		try {
			await attempt();
			return;
		} catch (err) {
			if (!(err instanceof TransactionActiveError)) {
				throw err;
			}
			log('sApp schema write waiting for an open transaction to end');
			await abortableDelay(OPEN_TRANSACTION_RETRY_MS, released);
			if (released.aborted) {
				throw err;
			}
		}
	}
}

/** `sql` as one atomic batch, once no other caller holds a transaction open. */
export async function execOutsideOpenTransaction(db: Database, sql: string, params: SqlParameters | undefined, released: AbortSignal): Promise<void> {
	await outsideOpenTransaction(() => db.exec(sql, params, { transaction: true }), released);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}
