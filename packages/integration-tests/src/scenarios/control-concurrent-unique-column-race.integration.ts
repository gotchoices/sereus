/**
 * Concurrent insert of DIFFERENT primary keys sharing one `unique` COLUMN value across two
 * machines: the loser is refused, and the loser's row lands nowhere.
 *
 * Sibling of `control-concurrent-same-pk-insert.integration.ts` (the same race on the
 * PRIMARY key) and of `control-cross-machine-unique-column.integration.ts` (a SEQUENTIAL
 * duplicate on the same column). This file holds the one shape neither of those covers:
 * two rows with different primary keys, carrying the same secondary-unique value, offered
 * in the same tick.
 *
 * Why it is pinned: a table row and each of its indexes are separate structures, and
 * until 2026-09-17 the storage engine's default commit mode saved them one at a time, each
 * save final as soon as it completed. Two same-tick writers with different primary keys
 * both passed the table save; only the second to reach the unique index was refused, and
 * by then its table row was durable. Measured 6 of 6 rounds on 2026-09-17 under the ticket
 * slug `concurrent-unique-value-race-commits-both-rows`: the loser was told it failed, and
 * BOTH machines read BOTH rows under the one stamp. Upstream (`../optimystic`) now pends
 * every structure of a multi-tree commit before committing any of them, so the unique
 * index refuses the loser before anything is stored. Nothing in sereus would notice a
 * regression of that, and the defect was only ever visible through a real two-machine
 * race, so it is pinned here.
 *
 * Topology: `bootConnectedPair` — two `CadreNode`s of ONE party (A owner/storage, B plain
 * member/transaction), connected, with a two-member control cohort confirmed on BOTH
 * sides before the first control write. A write offered to a one-member cohort commits on
 * the writer's own vote and proves nothing about two machines.
 *
 * The race is on `CadreControl.Strand.StampId` (`text not null unique`), with each row
 * correctly owner-signed over its own `(Id, Type, MemberPrivateKey, StampId)`, so the
 * shared stamp is the ONLY thing that can refuse either row. Honest writers mint a fresh
 * stamp per write and never hit this; an application schema with a natural unique column
 * (a username, an email address) claimed by two members at once does.
 *
 * WHICH NODE WINS IS NOT DETERMINISTIC. Every assertion is a one-to-one correspondence —
 * one fulfilment, one rejection, one row — never a fixed winner. Several rounds run in
 * one pair because the pre-fix outcome was reproducible without timing help; a single
 * round could pass on the two writes simply not overlapping.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	buildAuthorizationMessage,
	isRetriableControlWriteFailure,
} from '@serfab/cadre-core';
import type { ControlDatabase } from '@serfab/cadre-core';
import { bootConnectedPair, describeOutcomes, errorChainText, waitUntil } from '../harness/index.js';
import type { ConnectedPair } from '../harness/index.js';

/** Cross-node pull-on-read convergence budget; the wait's timeout is the failure. */
const CONVERGE_MS = 30_000;

/**
 * Per-round budget. A round issues two {@link CONVERGE_MS} waits on top of the race itself
 * and one fence write — sized so a round fails on the wait (which names WHICH node's view
 * is wrong) rather than on vitest's clock.
 */
const ROUND_TIMEOUT_MS = 120_000;

/** Same-tick rounds per pair. */
const ROUNDS = 3;

describe('Concurrent same-unique-column insert across two machines', () => {
	let pair: ConnectedPair | undefined;

	const dbA = (): ControlDatabase => pair!.A.getControlDatabase()!;
	const dbB = (): ControlDatabase => pair!.B.getControlDatabase()!;
	const views = (): [string, ControlDatabase][] => [['A', dbA()], ['B', dbB()]];

	/**
	 * Insert one owner-signed, open `Strand` row under a CHOSEN `StampId` — the same
	 * statement and `buildAuthorizationMessage` field order `ControlDatabase.insertStrand`
	 * uses (Id, Type, MemberPrivateKey-or-empty, StampId), issued through `execWrite`
	 * because `insertStrand` mints its own stamp, which is exactly what this race shares.
	 */
	async function seatStrand(db: ControlDatabase, strandId: string, stampId: string): Promise<void> {
		const { ownerPublicKey, ownerSign } = pair!;
		const signature = ownerSign(
			buildAuthorizationMessage('CadreControl.Strand', 'add', [strandId, 'o', '', stampId]),
		);
		await db.execWrite(`
			insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId, FounderOwnerKey)
				with context OwnerKey = ?, Signature = ?
				values (?, ?, ?, ?, ?)
		`, [ownerPublicKey, signature, strandId, 'o', null, stampId, ownerPublicKey], 'unique-race-probe');
	}

	/** Does this view hold a `Strand` row with this id? A table SCAN, not a seek. */
	async function holdsStrand(db: ControlDatabase, strandId: string): Promise<boolean> {
		return (await db.queryStrands()).some((row) => row.Id === strandId);
	}

	beforeAll(async () => {
		pair = await bootConnectedPair('unique-column-race');

		// Both nodes validate their OWN writes against their OWN view, and every insert below
		// is authorized by the party's one owner key — so B cannot write anything until the
		// owner row `bootConnectedPair` seated on A has reached it.
		await waitUntil(async () => (await Promise.all(views().map(([, db]) => db.countRows('OwnerKey'))))
			.every((count) => count >= 1), {
			timeoutMs: CONVERGE_MS,
			intervalMs: 250,
			description: "both nodes converge on the party's owner key",
		});
	}, 120_000);

	afterAll(async () => {
		const p = pair;
		pair = undefined;
		if (!p) return;
		for (const [label, node] of [['B', p.B], ['A', p.A]] as const) {
			try {
				await node.stop();
			} catch (error) {
				console.error(`[unique-column-race] teardown of node ${label} failed:`, error);
			}
		}
	}, 60_000);

	for (let round = 1; round <= ROUNDS; round++) {
		it(`round ${round}: refuses exactly one of two same-tick inserts sharing a StampId, and stores only the winner's row`, async () => {
			const stampId = `race-shared-stamp-${randomUUID()}`;
			const ids = [`race-stamp-${randomUUID()}-a`, `race-stamp-${randomUUID()}-b`];

			// Same tick, DIFFERENT primary keys, ONE stamp, from two machines.
			const outcomes = await Promise.allSettled(
				views().map(([, db], i) => seatStrand(db, ids[i]!, stampId)),
			);

			const detail = describeOutcomes(outcomes);
			const winnerIndex = outcomes.findIndex((o) => o.status === 'fulfilled');
			const loserIndex = outcomes.findIndex((o) => o.status === 'rejected');
			console.log(`[unique-column-race] round ${round}: A ${outcomes[0]!.status}, B ${outcomes[1]!.status}`);
			if (loserIndex >= 0) {
				const reason = (outcomes[loserIndex] as PromiseRejectedResult).reason as unknown;
				console.log(`[unique-column-race] round ${round}: loser (${views()[loserIndex]![0]}) got `
					+ `${reason instanceof Error ? reason.constructor.name : typeof reason}; `
					+ `retriable=${isRetriableControlWriteFailure(reason)}; chain: ${errorChainText(reason)}`);
			}

			expect(outcomes.filter((o) => o.status === 'fulfilled'), detail).toHaveLength(1);
			expect(outcomes.filter((o) => o.status === 'rejected'), detail).toHaveLength(1);

			const loser = outcomes[loserIndex] as PromiseRejectedResult;
			const loserChain = errorChainText(loser.reason);

			// The refusal names the unique column, so a caller can tell "this value is taken"
			// from a transport failure.
			expect(loserChain).toContain('UNIQUE constraint failed: Strand.StampId');

			// A constraint refusal must be retried ZERO times: re-presenting it can only fail
			// again, and `control-write-retry.ts` classifies it out deliberately.
			expect(
				isRetriableControlWriteFailure(loser.reason),
				`a duplicate-stamp refusal must not be retriable; chain was: ${loserChain}`,
			).toBe(false);

			const winnerId = ids[winnerIndex]!;
			const loserId = ids[loserIndex]!;
			const [loserLabel, loserDb] = views()[loserIndex]!;

			// A row the LOSER writes that SHOULD land, waited out on both views. Without it the
			// "the refused row is nowhere" assertions below would also pass against a pair that
			// had simply stopped replicating — this proves the loser's writes still reach the
			// other machine at the moment those assertions run.
			const fenceId = `race-fence-${randomUUID()}`;
			await seatStrand(loserDb, fenceId, `race-fence-stamp-${randomUUID()}`);
			await waitUntil(
				async () => (await Promise.all(views().map(([, db]) => holdsStrand(db, fenceId)))).every(Boolean),
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 500,
					description: `both nodes hold the row node ${loserLabel} wrote after the refusal (${fenceId})`,
				},
			);

			// `queryStrands` does not project `StampId`, so the winner's stamp is read through
			// the point lookup; the loser's absence is asserted on the table scan.
			await waitUntil(
				async () => (await Promise.all(views().map(([, db]) => db.queryStrandStampId(winnerId))))
					.every((stamp) => stamp === stampId),
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 500,
					description: `both nodes hold the winner's row (${winnerId}) under ${stampId}`,
				},
			);

			for (const [label, db] of views()) {
				expect(
					await db.queryStrandStampId(winnerId),
					`node ${label} must hold the fulfilled writer's row under the shared stamp`,
				).toBe(stampId);
				expect(
					await holdsStrand(db, loserId),
					`node ${label} holds a row that was REFUSED (${loserId})`,
				).toBe(false);
				expect(
					await db.queryStrandStampId(loserId),
					`node ${label} point-lookup must not find the REFUSED row (${loserId})`,
				).toBeNull();
			}
		}, ROUND_TIMEOUT_MS);
	}
});
