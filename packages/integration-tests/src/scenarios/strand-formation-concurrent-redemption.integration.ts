/**
 * Concurrent invitation redemption across two machines.
 *
 * The acceptance test for the nonce-keyed `FormationUsage` design
 * (`formation-unique-token-redesign`): every acceptance writes under its own joiner-minted
 * `UsageStampId`, the invite's `TotalUses` cap is a count against the committed snapshot,
 * and two nodes racing the same invitation therefore never contend for a row key. Two
 * failure modes only a real two-machine race can produce are pinned here:
 *
 *   1. a joiner told its join succeeded whose consent row then vanishes (measured
 *      2026-08-02 under the old per-token sequence-number key, where concurrent writers
 *      fought over one row and last-write-wins merge silently dropped a landed write);
 *   2. a human approver asked to approve the same join twice because a node discarded an
 *      approval it already held (the retry loop is gone, so the hook count is now a plain
 *      hard equality, not a property recovered by machinery).
 *
 * Topology: ONE inviting party with TWO live cadre nodes (A owner/storage, B plain
 * member/transaction — `bootConnectedPair`, which connects and confirms a two-machine
 * control cohort on BOTH sides before the first control write), each registered as a
 * formation responder over its own DB-backed `ControlFormationUsageRecorder`. Two joiner
 * nodes (separate parties) redeem the SAME token in the same tick, one dialing A, the
 * other dialing B — so the two `FormationUsage` writes race across the distributed
 * control collection, not through one node's serializing write queue (which is why this
 * cannot live in cadre-core's unit suite).
 *
 * The single-use race (case 2) is deliberately non-deterministic BY DESIGN: two nodes
 * racing the last seat may BOTH land, over-admitting by the number of concurrent
 * redeemers. That is the accepted trade recorded at the schema site
 * (`schemas/control.qsql` → `FormationUsage.Authorized`) — visible in the append-only
 * record, reversible by owner-gated removal — chosen over a fought-over shared key whose
 * failure mode was the SILENT loss of a consented join. Case 2 asserts the invariant
 * (approved responses and surviving rows correspond one-to-one, on both nodes' views),
 * never a fixed winner count. Case 3 is the arm of the cap that stays strict: once the
 * cohort agrees the invite is spent, a later redemption is refused terminally.
 *
 * Sibling of `strand-formation-e2e.integration.ts` rather than another phase inside it —
 * that file's header caps it at its current size and asks new phases to land as sibling
 * files. Nothing is shared: this scenario runs on bare `CadreNode`s (no
 * `TestCadreNetwork` parties), so the e2e file's party-shaped helpers do not apply.
 *
 * CURRENTLY RED (2026-08-12, deterministic): a sibling node's index-seek never sees
 * `FormationUsage` rows written on the other node (a full scan does), so the both-views
 * assertions time out. Upstream defect, tracked in
 * `tickets/blocked/secondary-index-seek-blind-to-sibling-rows` and listed in
 * `tickets/.pre-existing-known.md` — this file is the re-measurement instrument for that
 * ticket's unblock condition; do not weaken its assertions to get a green run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	verifyFormationConsent,
	ed25519PublicKeyB64FromPeerId,
} from '@serfab/cadre-core';
import type { ControlDatabase, OpenInvitation } from '@serfab/cadre-core';
import {
	bootConnectedPair,
	controlNodeConfig,
	startApprovalHook,
	waitUntil,
} from '../harness/index.js';
import type { ApprovalHookServer, ConnectedPair } from '../harness/index.js';

const SAPP_ID = 'sapp-concurrent-redemption';
const YEAR_MS = 365 * 24 * 3600_000;
/** Cross-node pull-on-read convergence budget; the wait's timeout is the failure. */
const CONVERGE_MS = 30_000;
/**
 * Per-case budget, sized so a case can spend EVERY {@link CONVERGE_MS} wait it may issue
 * (case 1: publish + both nodes' views = 3) plus two 30 s formation sessions and still
 * fail on the wait rather than on vitest's clock — a bare per-test timeout loses the
 * both-nodes diagnostic those waits raise, which is the whole point of this scenario.
 */
const CASE_TIMEOUT_MS = 180_000;

/** One redemption attempt: which joiner, dialed through which responder node. */
interface Attempt {
	joiner: CadreNode;
	via: CadreNode;
	purpose: string;
}

/** A `FormationUsage` row in exactly the shape {@link verifyFormationConsent} takes. */
interface UsageRow {
	token: string;
	usageStampId: string;
	peerKey: string;
	disclosure: string;
	peerSig: string;
}

/** ALL usage rows recorded against `token`, as seen by ONE node's database. */
async function readUsageRows(db: ControlDatabase, token: string): Promise<UsageRow[]> {
	const rows: UsageRow[] = [];
	for await (const row of db.getDatabase().eval(
		'select Token, UsageStampId, PeerKey, PeerSig, Disclosure from CadreControl.FormationUsage where Token = ?',
		[token],
	)) {
		rows.push({
			token: row.Token as string,
			usageStampId: row.UsageStampId as string,
			peerKey: row.PeerKey as string,
			disclosure: row.Disclosure as string,
			peerSig: row.PeerSig as string,
		});
	}
	return rows;
}

/**
 * The raw Ed25519 public key (base64url) behind a joiner's returned member id — the
 * encoding `FormationUsage.PeerKey` stores. Never null for the Ed25519 identities
 * `formStrand` mints; asserted rather than `!`-silenced so a decode failure names itself.
 */
function memberPeerKey(memberKey: string): string {
	const key = ed25519PublicKeyB64FromPeerId(memberKey);
	expect(key, `memberKey ${memberKey} must decode to an Ed25519 public key`).not.toBeNull();
	return key!;
}

describe('Concurrent invitation redemption across two machines', () => {
	let pair: ConnectedPair | undefined;
	let J1: CadreNode | undefined;
	let J2: CadreNode | undefined;
	let hook: ApprovalHookServer | undefined;
	let hostStrandId: string;

	// Case 2 hands its outcome to case 3: the spent token and the peer keys of the
	// joiners whose redemption was reported approved (1 or 2 of them).
	let spentSingleUseToken: string | undefined;
	let case2ApprovedKeys: string[] = [];

	const dbA = (): ControlDatabase => pair!.A.getControlDatabase()!;
	const dbB = (): ControlDatabase => pair!.B.getControlDatabase()!;

	/**
	 * Idempotent full teardown, shared by `afterAll` and the `beforeAll` failure path (a
	 * wait that throws mid-setup must not leave four nodes and a socket running).
	 */
	async function teardown(): Promise<void> {
		// Capture instances BEFORE clearing the refs — the closures must not read the
		// (by-then undefined) suite-scope variables.
		const [j1, j2, p, h] = [J1, J2, pair, hook];
		J1 = J2 = pair = hook = undefined;
		const closers: Array<[string, (() => Promise<unknown>) | undefined]> = [
			['joiner J2', j2 && (() => j2.stop())],
			['joiner J1', j1 && (() => j1.stop())],
			['pair node B', p && (() => p.B.stop())],
			['pair node A', p && (() => p.A.stop())],
			['approval hook', h && (() => h.close())],
		];
		for (const [label, close] of closers) {
			if (!close) continue;
			try {
				await close();
			} catch (error) {
				console.error(`[concurrent-redemption] teardown of ${label} failed:`, error);
			}
		}
	}

	beforeAll(async () => {
		try {
			pair = await bootConnectedPair('concurrent-redemption');
			const { A, B, ownerPublicKey, ownerSign } = pair;

			hook = await startApprovalHook();

			// Both nodes answer formation requests through the REAL DB-backed recorder over
			// their OWN database instance — the production responder wiring, and what makes
			// the connection gate's outstanding-invitation carve-out consult the shared
			// control DB on each node.
			A.initializeStrandSolicitation({ formationUsageRecorder: new ControlFormationUsageRecorder(A.getControlDatabase()!) });
			B.initializeStrandSolicitation({ formationUsageRecorder: new ControlFormationUsageRecorder(B.getControlDatabase()!) });

			// One open host strand every invite here binds to (provision-then-record): both
			// redemptions of a token then write ONLY a FormationUsage row, keeping the race
			// on the exact table under test.
			hostStrandId = `strand-concurrent-host-${Date.now()}`;
			await dbA().insertStrand(hostStrandId, 'o', ownerPublicKey, ownerSign);
			await dbA().insertValidationKey(hook.validationKey, ownerPublicKey, ownerSign);

			// A standing UNLIMITED invite that is never redeemed. Every metered invite in
			// this file ends up spent, and the membership connection gate admits a stranger's
			// NEW dial only while some invite is outstanding — without this door, case 3's
			// fresh dials could be refused at the connection layer and misread as the
			// terminal refusal under test.
			const doorToken = `invite-concurrent-door-${Date.now()}`;
			await dbA().insertFormationInvite(doorToken, SAPP_ID, ownerPublicKey, ownerSign, {
				expiresAtMs: Date.now() + YEAR_MS,
			});

			// All three rows were written on A; B answers redemptions from its OWN view, so
			// nothing may race convergence: an unconverged strand row would turn B's
			// redemption into the unrelated 'Host strand not yet available' rejection.
			await waitUntil(async () => (await dbB().queryStrand(hostStrandId)) !== null
				&& (await dbB().queryValidationKeyStampId(hook!.validationKey)) !== null
				&& (await dbB().queryFormationInvite(doorToken)) !== null, {
				timeoutMs: CONVERGE_MS,
				intervalMs: 250,
				description: 'B converges on the host strand, validation key, and door invite',
			});

			// Joiners: two more machines, each its own (single-node) party. They only ever
			// DIAL — their own control networks stay empty.
			const runTag = Date.now();
			J1 = new CadreNode(controlNodeConfig({ partyId: `joiner1-${runTag}` }));
			await J1.start();
			J2 = new CadreNode(controlNodeConfig({ partyId: `joiner2-${runTag}` }));
			await J2.start();
		} catch (error) {
			await teardown();
			throw error;
		}
	}, 180_000);

	afterAll(async () => {
		await teardown();
	}, 60_000);

	/** Owner-signed invite bound to the shared host strand. */
	async function publishBoundInvite(token: string, options: { totalUses: number; validationUrl?: string }): Promise<void> {
		await dbA().insertFormationInvite(token, SAPP_ID, pair!.ownerPublicKey, pair!.ownerSign, {
			totalUses: options.totalUses,
			strandId: hostStrandId,
			...(options.validationUrl ? { validationUrl: options.validationUrl } : {}),
			expiresAtMs: Date.now() + YEAR_MS,
		});
		// Written on A; B must see it before it can validate a redemption of it.
		await waitUntil(async () => (await dbB().queryFormationInvite(token)) !== null, {
			timeoutMs: CONVERGE_MS,
			intervalMs: 250,
			description: `B converges on invite ${token}`,
		});
	}

	/** The invitation envelope pointing a joiner at ONE SPECIFIC responder node. */
	function invitationVia(token: string, responder: CadreNode): OpenInvitation {
		return {
			token,
			sAppId: SAPP_ID,
			expiration: new Date(Date.now() + YEAR_MS),
			bootstrap: responder.getMultiaddrs(),
		};
	}

	/** Same-tick dispatch of every attempt — the race is the same-tick `allSettled`. */
	function redeemConcurrently(token: string, attempts: Attempt[]): Promise<Array<PromiseSettledResult<Awaited<ReturnType<CadreNode['formStrand']>>>>> {
		return Promise.allSettled(attempts.map((a) =>
			a.joiner.formStrand(invitationVia(token, a.via), { purpose: a.purpose })));
	}

	function rejectionMessage(outcome: PromiseSettledResult<unknown>): string {
		if (outcome.status !== 'rejected') return '';
		const reason: unknown = outcome.reason;
		return reason instanceof Error ? reason.message : String(reason);
	}

	/**
	 * Assert ONE node's committed view of `token`: exactly the approved joiners' rows,
	 * each attributable (distinct joiner-minted `UsageStampId`, the joiner's own
	 * `PeerKey`) and re-verifiable from the stored bytes alone.
	 */
	async function assertRowsMatchApprovals(
		db: ControlDatabase, label: string, token: string, approvedKeys: string[],
	): Promise<UsageRow[]> {
		// Convergence lag is not a failure: wait until this node's view CONTAINS every
		// approved joiner's row, and let the wait's timeout be what fails a slow run. The
		// timeout rethrow carries what WAS observed — a lost row, a stale count, and plain
		// slowness all look identical in a bare timeout message.
		try {
			await waitUntil(async () => {
				const converging = await readUsageRows(db, token);
				return approvedKeys.every((k) => converging.some((r) => r.peerKey === k));
			}, {
				timeoutMs: CONVERGE_MS,
				intervalMs: 250,
				description: `${label} view of ${token} contains every approved joiner's row`,
			});
		} catch (error) {
			// Snapshot BOTH nodes: whether the sibling holds the missing row is what tells a
			// lost write apart from one-way convergence failure.
			const describeView = async (viewDb: ControlDatabase, viewLabel: string): Promise<string> => {
				const rows = await readUsageRows(viewDb, token);
				return `${viewLabel} holds ${rows.length} row(s) [${rows.map((r) => r.peerKey).join(', ') || 'none'}], count=${await viewDb.countFormationUsage(token)}`;
			};
			throw new Error(
				`${label}: after ${CONVERGE_MS}ms its view of ${token} is missing approved joiners' rows. `
				+ `${await describeView(dbA(), 'node A')}; ${await describeView(dbB(), 'node B')}; `
				+ `approved joiners: ${approvedKeys.join(', ')}`,
				{ cause: error });
		}

		const rows = await readUsageRows(db, token);
		// One-to-one, both directions: an approved response whose row vanished is the
		// original 2026-08-02 defect; a surviving row nobody was told about would be a
		// seat spent on a joiner that thinks it failed.
		expect(rows.map((r) => r.peerKey).sort(), `${label}: rows must correspond 1:1 with approved responses`)
			.toEqual([...approvedKeys].sort());
		// Attribution, not counting: distinct joiner-minted nonces, and each row
		// re-verifies from its stored bytes alone (key, signature, disclosure verbatim).
		expect(new Set(rows.map((r) => r.usageStampId)).size).toBe(rows.length);
		for (const row of rows) {
			expect(row.token).toBe(token);
			expect(verifyFormationConsent(row), `${label}: stored consent row for ${row.peerKey} must re-verify`).toBe(true);
		}
		// The index-backed count the seat cap rests on agrees with the row scan.
		expect(await db.countFormationUsage(token), `${label}: countFormationUsage agrees with the row scan`).toBe(rows.length);
		return rows;
	}

	it('case 1: concurrent redemption of a multi-use approval-gated invite admits both, asking the hook exactly once each', async () => {
		const token = `invite-concurrent-multi-${Date.now()}`;
		await publishBoundInvite(token, { totalUses: 2, validationUrl: hook!.validationUrl });

		const attempts: Attempt[] = [
			{ joiner: J1!, via: pair!.A, purpose: 'case1-via-A' },
			{ joiner: J2!, via: pair!.B, purpose: 'case1-via-B' },
		];
		const settled = await redeemConcurrently(token, attempts);

		// Both acceptances survive — neither joiner was refused or told to retry.
		for (const [i, outcome] of settled.entries()) {
			expect(outcome.status, `${attempts[i]!.purpose} failed: ${rejectionMessage(outcome)}`).toBe('fulfilled');
		}
		const results = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<CadreNode['formStrand']>>>).value);
		for (const result of results) {
			expect(result.strandId).toBe(hostStrandId);
		}

		// The human behind the hook was asked EXACTLY once per redemption — hard equality.
		// `>= 2` would pass the double-ask regression this scenario exists to catch; with
		// the retry loop gone there is no re-ask path left, so equality is the plain
		// expectation rather than a property recovered by machinery.
		expect(hook!.requestCount).toBe(2);

		// Distinct joiners, by key — a count of 2 would also pass if both rows belonged to
		// one joiner.
		const approvedKeys = results.map((r) => memberPeerKey(r.memberKey));
		expect(new Set(approvedKeys).size).toBe(2);

		// Both rows, on BOTH nodes' views — asserting only the writer's own view is
		// exactly what missed the lost update this line of work uncovered.
		const rowsByNode = [
			await assertRowsMatchApprovals(dbA(), 'node A', token, approvedKeys),
			await assertRowsMatchApprovals(dbB(), 'node B', token, approvedKeys),
		];
		// Each stored disclosure is the joiner's own, verbatim: the purpose that joiner
		// disclosed, under the member identity it generated for this redemption.
		for (const rows of rowsByNode) {
			for (const row of rows) {
				const owner = results.findIndex((r) => memberPeerKey(r.memberKey) === row.peerKey);
				expect(owner).toBeGreaterThanOrEqual(0);
				const disclosed = JSON.parse(row.disclosure) as { purpose?: string; partyId?: string };
				expect(disclosed.purpose).toBe(attempts[owner]!.purpose);
				expect(disclosed.partyId).toBe(results[owner]!.memberKey);
			}
		}
	}, CASE_TIMEOUT_MS);

	it('case 2: concurrent redemption of a single-use invite — approved responses and surviving rows correspond one-to-one', async () => {
		const token = `invite-concurrent-single-${Date.now()}`;
		await publishBoundInvite(token, { totalUses: 1 });

		const attempts: Attempt[] = [
			{ joiner: J1!, via: pair!.A, purpose: 'case2-via-A' },
			{ joiner: J2!, via: pair!.B, purpose: 'case2-via-B' },
		];
		const settled = await redeemConcurrently(token, attempts);

		const approved = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<CadreNode['formStrand']>>> => s.status === 'fulfilled');
		const refused = settled.filter((s) => s.status === 'rejected');

		// The invite is never LOST to the race: at least one joiner got the seat.
		expect(approved.length, `both redemptions failed: ${settled.map(rejectionMessage).join(' | ')}`).toBeGreaterThanOrEqual(1);

		// A refused joiner is refused TERMINALLY: the seat-count check raises the named
		// exhaustion, which the responder maps to the same 'Invalid token' a latecomer
		// sees — never the retryable conflict, which would send the joiner into a retry
		// that can only fail again.
		for (const outcome of refused) {
			const message = rejectionMessage(outcome);
			expect(message).toMatch(/Formation rejected: Invalid token/);
			expect(message).not.toMatch(/retry/i);
		}

		for (const result of approved) {
			expect(result.value.strandId).toBe(hostStrandId);
		}

		// THE invariant (what would have caught the original defect): every joiner that
		// received an approved response has its row present — on both nodes' views — and
		// no other rows exist. Which joiners those are is deliberately non-deterministic.
		const approvedKeys = approved.map((r) => memberPeerKey(r.value.memberKey));
		await assertRowsMatchApprovals(dbA(), 'node A', token, approvedKeys);
		await assertRowsMatchApprovals(dbB(), 'node B', token, approvedKeys);

		if (approved.length === 2) {
			// Both landed: the accepted over-admission. A pass, PROVIDED the overage is
			// observable — the audit story the design traded strict enforcement for.
			const invite = await dbA().queryFormationInvite(token);
			expect(invite?.totalUses).toBe(1);
			expect(await dbA().countFormationUsage(token)).toBeGreaterThan(invite!.totalUses!);
			expect(await dbB().countFormationUsage(token)).toBeGreaterThan(invite!.totalUses!);
			console.log('[concurrent-redemption] case 2 outcome: BOTH landed (accepted over-admission, 2 rows against a 1-use invite)');
		} else {
			console.log('[concurrent-redemption] case 2 outcome: one landed, one refused terminally');
		}

		spentSingleUseToken = token;
		case2ApprovedKeys = approvedKeys;
	}, CASE_TIMEOUT_MS);

	it('case 3: once the cohort agrees the invite is spent, a later redemption is refused terminally on both nodes', async () => {
		// Case 3 exists to redeem the very invite case 2 spent; without it there is
		// nothing to assert against.
		expect(spentSingleUseToken, 'case 2 must have run (it establishes the spent invite)').toBeDefined();
		const token = spentSingleUseToken!;

		// "Once the cohort agrees": both nodes' committed views hold exactly the case-2
		// rows before the third redemption is issued.
		for (const [db, label] of [[dbA(), 'node A'], [dbB(), 'node B']] as const) {
			await waitUntil(async () => (await db.countFormationUsage(token)) === case2ApprovedKeys.length, {
				timeoutMs: CONVERGE_MS,
				intervalMs: 250,
				description: `${label} agrees on the committed case-2 rows`,
			});
		}

		// A reader who watched case 2 pass with two rows will assume the cap is dead —
		// this is the arm that is still strict. Asked through EITHER node, the spent
		// invite is refused with the terminal reason, not a retry hint, and no new row
		// lands.
		await expect(
			J1!.formStrand(invitationVia(token, pair!.A), { purpose: 'case3-via-A' }),
		).rejects.toThrow(/Formation rejected: Invalid token/);
		await expect(
			J2!.formStrand(invitationVia(token, pair!.B), { purpose: 'case3-via-B' }),
		).rejects.toThrow(/Formation rejected: Invalid token/);

		expect(await dbA().countFormationUsage(token)).toBe(case2ApprovedKeys.length);
		expect(await dbB().countFormationUsage(token)).toBe(case2ApprovedKeys.length);
	}, CASE_TIMEOUT_MS);
});
