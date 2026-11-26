import { CohortOutOfSpaceError } from '@optimystic/db-core';
import { causeOf } from './cause-chain.js';

/**
 * The {@link CohortOutOfSpaceError} `err` is or wraps, walking `cause`, so the layers Quereus and the
 * Optimystic plugin add between the cohort's refusal and an app's `catch` cannot hide it.
 *
 * Optimystic gives a full cohort no SQL error of its own, so without this an app sees only a failed
 * `db.exec` whose message it cannot tell apart from contention or an unreachable cohort. The error it
 * finds already carries everything an app needs — `peerIds`, `approvals`, `peerCount`, `needed` — so
 * this classifies and wraps nothing (docs/strands/writes.md → "A write the cohort has no room for").
 */
export function cohortOutOfSpaceOf(err: unknown): CohortOutOfSpaceError | undefined {
	return causeOf(err, CohortOutOfSpaceError);
}
