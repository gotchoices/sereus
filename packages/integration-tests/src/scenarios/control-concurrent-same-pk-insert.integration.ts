/**
 * Concurrent same-primary-key insert across two machines: the loser is REFUSED, and
 * nothing is lost.
 *
 * The regression anchor for a guarantee `schemas/control.qsql` leans on in several
 * places — the once-ever seating of a strand id, the single-use `StampId` anti-replay
 * columns, the `Revocation` tombstones — all of which read "a duplicate insert is
 * refused". That refusal is produced by `@optimystic/*`, consumed here as build output
 * from the linked `../optimystic` checkout, and it did not always hold: until
 * mid-September 2026 two peers inserting the same primary key in the same tick were BOTH
 * told they had succeeded, and the two commits merged last-writer-wins, silently losing a
 * row (measured 2026-08-02; fixed upstream and re-measured 2026-09-17 under the ticket
 * slug `optimystic-concurrent-same-pk-insert-silent-lww`). Upstream pins the behaviour in
 * its own suite; nothing in sereus would notice a regression, and the defect was only ever
 * visible through a real two-machine race, so it is pinned here.
 *
 * Topology: `bootConnectedPair` — two `CadreNode`s of ONE party (A owner/storage, B plain
 * member/transaction) connected, with a two-member control cohort confirmed on BOTH sides
 * before the first control write. That ordering is what makes the race meaningful: a write
 * offered to a one-member cohort commits on the writer's own vote and proves nothing about
 * two machines.
 *
 * Three cases, all on `CadreControl.Strand`:
 *
 *   1. SAME `Strand.Id` from both nodes through `ControlDatabase.insertStrand`. Each call
 *      mints its own fresh `StampId`, so the primary key is the ONLY thing the two writes
 *      share. Exactly one writer is fulfilled, the other is rejected with
 *      `UNIQUE constraint failed: Strand.Id`, the rejection is NOT retriable, and both
 *      nodes' views converge on exactly one row carrying the WINNER's stamp.
 *   2. DIFFERENT ids, same tick — the control case. Both fulfil and both rows reach both
 *      views, so a red case 1 can be told apart from a cohort that is simply not
 *      converging.
 *   3. The same race driven through `CadreNode.publishStrand` with identical content on
 *      both nodes. That method's "lost a concurrent founding race" branch re-reads the
 *      landed row and no-ops when it matches; before the upstream fix the branch could
 *      never fire, because no error was ever raised. Both calls resolve, to the one row.
 *
 * WHICH NODE WINS IS NOT DETERMINISTIC (the 2026-09-17 measurement saw A win 3 of 5 and B
 * 2 of 5). Every assertion here is a one-to-one correspondence — one fulfilment, one
 * rejection, one row — never a fixed winner. Do not "stabilize" this file by pinning one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	buildAuthorizationMessage,
	isRetriableControlWriteFailure,
} from '@serfab/cadre-core';
import type { CadreNode, ControlDatabase, StrandRow } from '@serfab/cadre-core';
import { bootConnectedPair, waitUntil } from '../harness/index.js';
import type { ConnectedPair } from '../harness/index.js';

/** Cross-node pull-on-read convergence budget; the wait's timeout is the failure. */
const CONVERGE_MS = 30_000;

/**
 * Per-case budget. A case issues at most two {@link CONVERGE_MS} waits on top of the race
 * itself, and the whole-race round took about 5 s when measured — sized so a case fails on
 * the wait (which names WHICH node's view is wrong) rather than on vitest's clock.
 */
const CASE_TIMEOUT_MS = 90_000;

/**
 * Every message in `reason`'s `cause` chain, joined — the surface the production
 * classifiers match on (`isStrandIdConflict`, `isRetriableControlWriteFailure`), because
 * the typed engine error does not survive the trip out of optimystic. A non-`Error` is
 * stringified so a rejection with a non-error reason still names itself in the diff.
 */
function errorChainText(reason: unknown): string {
	if (!(reason instanceof Error)) return String(reason);
	const messages: string[] = [];
	let current: unknown = reason;
	while (current instanceof Error) {
		messages.push(current.message);
		current = (current as { cause?: unknown }).cause;
	}
	return messages.join(' <- ');
}

/**
 * Every settled outcome of a race, in order, rejections carrying their full chain — the
 * assertion-failure message, so a red case names WHAT each writer was told rather than
 * just the shape of the status array.
 */
function describeOutcomes(outcomes: PromiseSettledResult<unknown>[]): string {
	return outcomes
		.map((o) => (o.status === 'rejected' ? `rejected(${errorChainText(o.reason)})` : 'fulfilled'))
		.join(', ');
}

/**
 * ALL `Strand` rows this node's view holds for `strandId` — a LIST, not `queryStrand`'s
 * first match, because "exactly one row survived" is the property under test and a
 * single-row reader cannot see a second one.
 */
async function strandRowsFor(db: ControlDatabase, strandId: string): Promise<StrandRow[]> {
	return (await db.queryStrands()).filter((row) => row.Id === strandId);
}

describe('Concurrent same-primary-key control insert across two machines', () => {
	let pair: ConnectedPair | undefined;

	const dbA = (): ControlDatabase => pair!.A.getControlDatabase()!;
	const dbB = (): ControlDatabase => pair!.B.getControlDatabase()!;
	const dbs = (): ControlDatabase[] => [dbA(), dbB()];

	beforeAll(async () => {
		pair = await bootConnectedPair('same-pk-race');

		// Case 3 publishes from BOTH nodes, and `publishStrand` signs with the node's OWN
		// identity-derived owner key (`getSelfSigningKey`), which for B is not the key
		// `bootConnectedPair` seated. Enroll B's key as a second owner, signed by A under
		// the `OwnerKey.Authorized` "a pre-existing owner authorizes by signing over THIS
		// row" branch — there is no cadre-core writer for a second owner (`insertOwnerKey`
		// only rides the empty-owner-set bootstrap branch), so the digest is built here
		// through the one shared builder every signer must use.
		const bOwnerKey = pair.B.getIdentityOwnerKey().publicKeyB64;
		const stampId = `owner-${randomUUID()}`;
		const signature = pair.ownerSign(
			buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [bOwnerKey, stampId]),
		);
		await dbA().execWrite(`
			insert into CadreControl.OwnerKey (Key, StampId)
				with context OwnerKey = ?, Signature = ?
				values (?, ?)
		`, [pair.ownerPublicKey, signature, bOwnerKey, stampId], 'second-owner-enroll');

		// B validates its own writes against ITS view, so B must see the row before case 3
		// signs anything with that key.
		await waitUntil(async () => (await Promise.all(dbs().map((db) => db.countRows('OwnerKey'))))
			.every((count) => count >= 2), {
			timeoutMs: CONVERGE_MS,
			intervalMs: 250,
			description: "both nodes converge on B's enrolled owner key",
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
				console.error(`[same-pk-race] teardown of node ${label} failed:`, error);
			}
		}
	}, 60_000);

	it('refuses exactly one of two same-tick inserts of the same Strand.Id, and keeps the winner row', async () => {
		const strandId = `race-same-id-${randomUUID()}`;
		const { ownerPublicKey, ownerSign } = pair!;

		// Same tick, same primary key, from two machines. Each insertStrand mints its own
		// fresh StampId, so `Strand.Id` is the only contended value.
		const outcomes = await Promise.allSettled(
			dbs().map((db) => db.insertStrand(strandId, 'o', ownerPublicKey, ownerSign)),
		);

		const detail = describeOutcomes(outcomes);
		expect(outcomes.filter((o) => o.status === 'fulfilled'), detail).toHaveLength(1);
		expect(outcomes.filter((o) => o.status === 'rejected'), detail).toHaveLength(1);

		const winnerIndex = outcomes.findIndex((o) => o.status === 'fulfilled');
		const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;

		// The refusal is the ORDINARY uniqueness error on the primary key — the text
		// `isStrandIdConflict` matches, which is what makes publishStrand's founding-race
		// branch (case 3) reachable at all.
		const loserChain = errorChainText(loser.reason);
		expect(loserChain).toContain('UNIQUE constraint failed: Strand.Id');

		// A constraint refusal must be retried ZERO times: re-presenting it can only fail
		// again, and `control-write-retry.ts` classifies it out deliberately.
		expect(
			isRetriableControlWriteFailure(loser.reason),
			`a duplicate-key refusal must not be retriable; chain was: ${loserChain}`,
		).toBe(false);

		// The surviving row must be the FULFILLED writer's. insertStrand does not return
		// its stamp, so the winner's own view is the source of truth for it.
		const winnerDb = dbs()[winnerIndex]!;
		const winnerStamp = await winnerDb.queryStrandStampId(strandId);
		expect(winnerStamp, "the fulfilled writer's own view must hold the row it wrote").not.toBeNull();

		await waitUntil(async () => {
			for (const db of dbs()) {
				const rows = await strandRowsFor(db, strandId);
				if (rows.length !== 1) return false;
				if ((await db.queryStrandStampId(strandId)) !== winnerStamp) return false;
			}
			return true;
		}, {
			timeoutMs: CONVERGE_MS,
			intervalMs: 500,
			description: `both nodes hold exactly one ${strandId} row, carrying the winner's StampId`,
		});

		for (const [label, db] of [['A', dbA()], ['B', dbB()]] as const) {
			expect(await strandRowsFor(db, strandId), `node ${label} view of ${strandId}`).toHaveLength(1);
			expect(await db.queryStrandStampId(strandId), `node ${label} stamp for ${strandId}`).toBe(winnerStamp);
		}
	}, CASE_TIMEOUT_MS);

	it('commits BOTH of two same-tick inserts under DIFFERENT Strand.Ids', async () => {
		// The control case for the one above: the same two-machine, same-tick shape with no
		// shared key. A red case 1 next to a green case 3 here is a refusal defect; both red
		// together is a cohort that is not converging.
		const run = randomUUID();
		const ids = [`race-diff-id-${run}-a`, `race-diff-id-${run}-b`];
		const { ownerPublicKey, ownerSign } = pair!;

		const outcomes = await Promise.allSettled(
			dbs().map((db, i) => db.insertStrand(ids[i]!, 'o', ownerPublicKey, ownerSign)),
		);
		expect(
			outcomes.map((o) => o.status),
			`both distinct-key writers must be fulfilled; got ${describeOutcomes(outcomes)}`,
		).toEqual(['fulfilled', 'fulfilled']);

		await waitUntil(async () => {
			for (const db of dbs()) {
				for (const id of ids) {
					if ((await strandRowsFor(db, id)).length !== 1) return false;
				}
			}
			return true;
		}, {
			timeoutMs: CONVERGE_MS,
			intervalMs: 500,
			description: `both nodes hold both rows (${ids.join(', ')})`,
		});
	}, CASE_TIMEOUT_MS);

	it('resolves both publishStrand calls of one id to the single landed row', async () => {
		// The loser here takes publishStrand's `isStrandIdConflict` branch: re-read the
		// landed row, no-op because the content matches. Unreachable before the upstream
		// fix — no error was raised to recognise.
		//
		// NOTE: which branch the loser takes is timing, not contract. Both calls issue their
		// read-first `queryStrand` before either insert commits, so today the loser reaches
		// the insert and is refused; if the two calls ever drift apart, the loser would find
		// the row on its READ and no-op through the idempotent branch instead — same
		// assertions, less coverage, and silently so. If that branch ever needs pinning
		// deterministically, drive it from `publish-strand.spec.ts` against an injected
		// conflict rather than adding timing hacks here.
		const strandId = `race-publish-${randomUUID()}`;
		const nodes: CadreNode[] = [pair!.A, pair!.B];

		const outcomes = await Promise.allSettled(nodes.map((node) => node.publishStrand(strandId, 'o')));
		expect(
			outcomes.map((o) => o.status),
			`both publishStrand calls must resolve; got ${describeOutcomes(outcomes)}`,
		).toEqual(['fulfilled', 'fulfilled']);

		// Both callers are handed the same content. `FounderOwnerKey` is deliberately NOT
		// compared by publishStrand (it is provenance, not content), so the loser's returned
		// row is the WINNER's — assert the content, not the publisher.
		for (const outcome of outcomes) {
			const row = (outcome as PromiseFulfilledResult<StrandRow>).value;
			expect(row.Id).toBe(strandId);
			expect(row.Type).toBe('o');
		}

		await waitUntil(async () => {
			for (const db of dbs()) {
				if ((await strandRowsFor(db, strandId)).length !== 1) return false;
			}
			return true;
		}, {
			timeoutMs: CONVERGE_MS,
			intervalMs: 500,
			description: `both nodes hold exactly one ${strandId} row after the publishStrand race`,
		});

		// Exactly one machine's key is on the row, and both views agree on WHICH — the founder
		// derivation (`isSelfFoundedRow`) reads this column, so a race that left the two views
		// naming different publishers would make both machines bootstrap the same strand.
		const founders = await Promise.all(dbs().map(async (db) => (await strandRowsFor(db, strandId))[0]!.FounderOwnerKey));
		const nodeKeys = nodes.map((node) => node.getIdentityOwnerKey().publicKeyB64);
		expect(new Set(founders).size, `both views must agree on one founder; saw ${founders.join(', ')}`).toBe(1);
		expect(nodeKeys, `the founder must be one of the two racing machines; saw ${founders[0]}`).toContain(founders[0]);
	}, CASE_TIMEOUT_MS);
});
