/**
 * Cross-machine uniqueness on a `unique` COLUMN: a value one machine has already committed
 * is refused to the other, and the refused row lands nowhere.
 *
 * Every `unique` column in `schemas/control.qsql` — the `StampId` of each owner-signed table
 * (`OwnerKey`, `ValidationKey`, `Strand`, `StrandPartyKey`, `CadrePeer`, `DeviceToken`,
 * `FormationInvite`), plus `Strand.MemberPrivateKey` — is enforced by the storage engine
 * through a secondary index (the `_uniq_N` sub-collections), not by the table's own tree.
 * That is the same machinery a declared `index` uses, and it was measurably broken across
 * machines between 2026-08-04 and 2026-08-25: a descent on a second machine returned only
 * the rows THAT machine had written, so a row a sibling committed was invisible to the
 * check that should have refused a duplicate. The schema leans on these columns for
 * anti-replay — a removed row's stamp is retired so its never-expiring approval cannot
 * re-seat it — so a uniqueness check that cannot see a sibling's row is an authorization
 * hole, not a performance problem.
 *
 * Nothing in the suite pinned that. The engine defect was fixed upstream and re-measured
 * here on 2026-09-17 (`complete/restore-formation-usage-token-index`); this file is the
 * permanent guard, so a recurrence is a red test rather than a rediscovery.
 *
 * Topology: `bootConnectedPair` — two `CadreNode`s of ONE party (A owner/storage, B plain
 * member/transaction), connected with a two-member control cohort confirmed on BOTH sides
 * before the first control write. A write offered to a one-member cohort commits on the
 * writer's own vote and would prove nothing about two machines.
 *
 * Two cases, mirror images, both on `CadreControl.Strand.StampId`: A seats a stamp and B is
 * refused it, then B seats a stamp and A is refused it. Each runs in ONE direction at a
 * time and waits for the rival's own view to hold the seated row first, so what is under
 * test is a uniqueness DECISION made against a converged view.
 *
 * DELIBERATELY SEQUENTIAL — do not widen this into a same-tick race. This file asserts a
 * uniqueness DECISION made against a converged view; the same-tick shape is a different
 * property (no converged view exists yet when the race starts) and has its own guard,
 * `control-concurrent-unique-column-race.integration.ts`. Folding the two together would
 * bury which property failed if either ever regresses.
 *
 * Sibling of `control-concurrent-same-pk-insert.integration.ts`, which pins the same
 * refusal on a PRIMARY key. Separate files because the two are enforced by different
 * structures — the table's own tree there, a secondary index here — and only the secondary
 * one has a history of missing a sibling's rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	buildAuthorizationMessage,
	isRetriableControlWriteFailure,
} from '@serfab/cadre-core';
import type { ControlDatabase } from '@serfab/cadre-core';
import { bootConnectedPair, errorChainText, waitUntil } from '../harness/index.js';
import type { ConnectedPair } from '../harness/index.js';

/** Cross-node pull-on-read convergence budget; the wait's timeout is the failure. */
const CONVERGE_MS = 30_000;

/**
 * Per-case budget. A case issues at most two {@link CONVERGE_MS} waits on top of three
 * control writes — sized so a case fails on the wait (which names WHICH view is wrong)
 * rather than on vitest's clock.
 */
const CASE_TIMEOUT_MS = 90_000;

describe('Cross-machine uniqueness on a unique control column', () => {
	let pair: ConnectedPair | undefined;

	const dbA = (): ControlDatabase => pair!.A.getControlDatabase()!;
	const dbB = (): ControlDatabase => pair!.B.getControlDatabase()!;
	const views = (): [string, ControlDatabase][] => [['A', dbA()], ['B', dbB()]];

	/**
	 * Insert one owner-signed, open `Strand` row under a CHOSEN `StampId`.
	 *
	 * `ControlDatabase.insertStrand` mints its own stamp, which is exactly what this
	 * scenario must control, so the insert is issued here through `execWrite` — the same
	 * statement and the same `buildAuthorizationMessage` field order `insertStrand` uses
	 * (Id, Type, MemberPrivateKey-or-empty, StampId), so a schema change that breaks the
	 * production writer breaks this one too rather than leaving it quietly passing.
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
		`, [ownerPublicKey, signature, strandId, 'o', null, stampId, ownerPublicKey], 'unique-column-probe');
	}

	/** Does this node's view hold a `Strand` row with this id? A table SCAN, not a seek. */
	async function holdsStrand(db: ControlDatabase, strandId: string): Promise<boolean> {
		return (await db.queryStrands()).some((row) => row.Id === strandId);
	}

	/** One direction of the mirror: `writer` seats a stamp, `rival` is refused it. */
	async function refusesASiblingsStamp(
		writer: [string, ControlDatabase],
		rival: [string, ControlDatabase],
	): Promise<void> {
		const [writerLabel, writerDb] = writer;
		const [rivalLabel, rivalDb] = rival;
		const stampId = `uniq-stamp-${randomUUID()}`;
		const seatedId = `uniq-seated-${randomUUID()}`;
		const refusedId = `uniq-refused-${randomUUID()}`;

		await seatStrand(writerDb, seatedId, stampId);

		// The rival must SEE the seated row before it tries the duplicate: otherwise a green
		// case could mean "the stamp was refused" or merely "the two writes did not overlap",
		// and this file is about the first. Read through queryStrands — a table scan, which
		// converged across machines even while the index did not — so the wait cannot be
		// satisfied (or starved) by the very structure under test.
		await waitUntil(() => holdsStrand(rivalDb, seatedId), {
			timeoutMs: CONVERGE_MS,
			intervalMs: 250,
			description: `node ${rivalLabel} sees the row node ${writerLabel} seated (${seatedId})`,
		});

		// A DIFFERENT row key carrying the SAME stamp, so `StampId`'s uniqueness is the only
		// thing that can refuse it.
		const reason = await seatStrand(rivalDb, refusedId, stampId).then(() => null, (e: unknown) => e);
		expect(
			reason,
			`node ${rivalLabel} committed a StampId node ${writerLabel} already holds — `
			+ 'cross-machine uniqueness is not being enforced',
		).not.toBeNull();

		const chain = errorChainText(reason);
		expect(chain).toContain('UNIQUE constraint failed: Strand.StampId');

		// A constraint refusal must be retried ZERO times: re-presenting it can only fail
		// again, and a retriable classification would let the production write funnel spend
		// its whole budget on a doomed write.
		expect(
			isRetriableControlWriteFailure(reason),
			`a duplicate-stamp refusal must not be retriable; chain was: ${chain}`,
		).toBe(false);

		// A row the rival writes that SHOULD land, waited out on both views. Without it the
		// "the refused row is nowhere" assertions below would also pass against a pair that
		// had simply stopped replicating — this proves the rival's writes still reach the
		// other machine at the moment those assertions run.
		const fenceId = `uniq-fence-${randomUUID()}`;
		await seatStrand(rivalDb, fenceId, `uniq-stamp-${randomUUID()}`);
		await waitUntil(
			async () => (await Promise.all(views().map(([, db]) => holdsStrand(db, fenceId)))).every(Boolean),
			{
				timeoutMs: CONVERGE_MS,
				intervalMs: 500,
				description: `both nodes hold the row node ${rivalLabel} wrote after the refusal (${fenceId})`,
			},
		);

		for (const [label, db] of views()) {
			expect(
				await holdsStrand(db, refusedId),
				`node ${label} holds a row that was REFUSED (${refusedId})`,
			).toBe(false);
			// NOTE: queryStrandStampId is a FULL-primary-key point lookup, the one read shape
			// `backlog/debt-composite-pk-point-lookup-unreliable-untracked` has not settled —
			// its question 1 asks whether that shortcut can return zero rows for a row that
			// exists, and whether that is multi-column-key specific (`Strand.Id` is single).
			// If this line alone starts flaking while the `holdsStrand` scans above stay
			// green, that is evidence for that ticket, NOT a uniqueness regression, and the
			// fix is there rather than in this assertion.
			expect(
				await db.queryStrandStampId(seatedId),
				`node ${label} must still see the seated row under the stamp it was written with`,
			).toBe(stampId);
		}
	}

	beforeAll(async () => {
		pair = await bootConnectedPair('cross-machine-unique');

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
				console.error(`[cross-machine-unique] teardown of node ${label} failed:`, error);
			}
		}
	}, 60_000);

	it('refuses B a StampId that A already committed', async () => {
		await refusesASiblingsStamp(['A', dbA()], ['B', dbB()]);
	}, CASE_TIMEOUT_MS);

	it('refuses A a StampId that B already committed', async () => {
		await refusesASiblingsStamp(['B', dbB()], ['A', dbA()]);
	}, CASE_TIMEOUT_MS);
});
