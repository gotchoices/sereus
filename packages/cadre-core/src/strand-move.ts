/**
 * Moving a party's strands into another party of the same owner.
 *
 * A party's participation in a strand is control-database state: its `Strand` row (a strand
 * it founded) or `JoinedStrand` row (one it joined), carrying the strand's shared read secret,
 * and its `StrandPartyKey` row, the membership identity whose public half seats the party's
 * `Member` / `Manager` rows in the strand database. Nothing in the strand database names a
 * party, so a strand follows those rows: re-seated in another party under the same member key,
 * on the same peer, the strand's other members see the same member on the same peer and
 * nothing on the strand side changes.
 *
 * The case this serves is a phone app that founded a one-node cadre of its own (party B) and
 * then joins the user's main cadre (party A) by switching its one node across
 * (docs/architecture.md → "An app joins an existing cadre" → "Moving the app's strands"). Two
 * nodes never run at once, so the move has two ends: {@link exportStrandBundle} reads everything
 * B's node knows about its strands while it still runs, the embedder carries the bundle across
 * the switch as data, and {@link adoptStrandBundle} seats it on A's node once the app's key is
 * an owner there. Nothing is deleted in B; dissolving it is the embedder's later step.
 *
 * Built over `CadreNode`'s public surface, so `cadre-node.ts` does not grow by the feature.
 */
import debug from 'debug';
import { sign } from '@optimystic/quereus-plugin-crypto';
import type { PersistedNetworkState } from '@optimystic/db-p2p';
import type { CadreNode } from './cadre-node.js';
import {
	isPendingJoinConflict,
	isStrandIdConflict,
	pendingJoinId,
	type ControlDatabase,
	type JoinRequestFields
} from './control-database.js';
import { joinedStrandRow } from './joined-strand-store.js';
import type { PendingJoin, StrandRow } from './types.js';

const log = debug('sereus:cadre:strand-move');

/**
 * Everything one party knows about its strands, as read from a running node of that party.
 * Carries secrets: every read secret, every party key and every bearer invitation. JSON-safe,
 * so an embedder can keep it in its secure store across a node switch.
 */
export interface StrandBundle {
	v: 1;
	/** The exporting party. */
	partyId: string;
	/** Epoch ms. */
	exportedAt: number;
	strands: StrandBundleEntry[];
	/** Every row `queryPendingJoins` returned, outcome included. */
	pendingJoins: PendingJoin[];
	/** The invitations still redeemable at export. */
	formationInvites: FormationInviteEntry[];
}

export interface StrandBundleEntry {
	/** A `Strand` row, or a `JoinedStrand` row / machine-local unpublished join. */
	kind: 'own' | 'joined';
	row: Pick<StrandRow, 'Id' | 'Type' | 'MemberPrivateKey'>;
	/** `StrandPartyKey.PrivateKey` when the party holds one. */
	partyKey: string | null;
	/** The strand's saved routing table, opaque here; absent when the node held none. */
	networkState?: PersistedNetworkState;
	/** The addresses the strand's formation carried, in memory on the exporting node. */
	carriedAddrs: string[];
}

export interface FormationInviteEntry {
	token: string;
	sAppId: string;
	expiresAtMs: number | null;
	/** `TotalUses` minus the usage recorded so far; null is unlimited. */
	usesLeft: number | null;
	validationUrl: string | null;
	/** A bound invitation's host strand. */
	strandId: string | null;
}

/** One item an adoption could not seat this time; retrying the same bundle will. */
export interface StrandMoveFailure {
	kind: 'strand' | 'invitation' | 'pending-join';
	/** The strand id, the join request id, or the id a join request for the invitation would carry (never the bearer token). */
	id: string;
	reason: string;
}

export interface StrandMoveReport {
	fromPartyId: string;
	/** Strand ids now seated in this party, those already there included. */
	moved: string[];
	/** Permanent: retrying will not help. */
	refused: Array<{ strandId: string; reason: string }>;
	/** Transient: adopt the same bundle again. */
	failed: StrandMoveFailure[];
	invitationsMoved: number;
	invitationsDropped: number;
	pendingJoinsMoved: number;
}

/** {@link adoptStrandBundle} refused before any write: the running node's key is not an owner of its party. */
export class StrandMoveNotOwnerError extends Error {
	constructor(readonly partyId: string) {
		super(`Cannot adopt strands into party ${partyId}: this node's key is not one of its owners, and every re-seated row is owner-signed`);
		this.name = 'StrandMoveNotOwnerError';
	}
}

/** {@link adoptStrandBundle} refused before any write: the bundle was exported from the party the node runs. */
export class StrandMoveSamePartyError extends Error {
	constructor(readonly partyId: string) {
		super(`Cannot adopt strands into party ${partyId}: the bundle was exported from that same party`);
		this.name = 'StrandMoveSamePartyError';
	}
}

/**
 * Read, from a running node, everything its party knows about its strands: the party's own
 * strands, the strands it joined (party-wide rows and this machine's unpublished records), each
 * with its party key, saved routing table and carried addresses; every pending join with its
 * outcome; and every invitation still redeemable.
 *
 * @throws when the node is not started.
 */
export async function exportStrandBundle(node: CadreNode): Promise<StrandBundle> {
	const database = requireControlDatabase(node, 'export');
	const now = Date.now();
	const bundle: StrandBundle = {
		v: 1,
		partyId: node.partyId,
		exportedAt: now,
		strands: await exportStrands(node, database),
		pendingJoins: await database.queryPendingJoins(),
		formationInvites: await exportFormationInvites(database, now)
	};
	log('export(%s): %d strand(s), %d pending join(s), %d invitation(s)',
		node.partyId, bundle.strands.length, bundle.pendingJoins.length, bundle.formationInvites.length);
	return bundle;
}

/** One entry per strand id, the party's own first: an id in both `Strand` and `JoinedStrand` exports once, as `own`. */
async function exportStrands(node: CadreNode, database: ControlDatabase): Promise<StrandBundleEntry[]> {
	const entries = new Map<string, StrandBundleEntry>();
	for (const row of await database.queryStrands()) {
		entries.set(row.Id, await exportStrand(node, database, 'own', row));
	}
	// Publication needs a control connection, which a one-node party never holds, so its joins
	// are usually machine-local records and its `JoinedStrand` table empty. Both are read.
	const unpublished = (await node.listUnpublishedJoinedStrands()).map(joinedStrandRow);
	for (const row of [...await database.queryJoinedStrands(), ...unpublished]) {
		if (!entries.has(row.Id)) {
			entries.set(row.Id, await exportStrand(node, database, 'joined', row));
		}
	}
	return [...entries.values()];
}

async function exportStrand(
	node: CadreNode,
	database: ControlDatabase,
	kind: StrandBundleEntry['kind'],
	row: StrandRow
): Promise<StrandBundleEntry> {
	const networkState = node.getStrandNetworkStateStore()?.load(row.Id);
	return {
		kind,
		row: { Id: row.Id, Type: row.Type, MemberPrivateKey: row.MemberPrivateKey },
		partyKey: await database.queryStrandPartyKey(row.Id),
		...(networkState !== undefined && { networkState }),
		carriedAddrs: node.getCarriedStrandAddrs(row.Id)
	};
}

/**
 * The invitations still redeemable at export: unexpired, with uses left after the usage
 * recorded so far. `FormationUsage` rows are append-only history and stay behind, so the
 * adopting party's count restarts at zero against the reduced cap. A spent or expired
 * invitation is left out: there is nothing to keep.
 */
async function exportFormationInvites(database: ControlDatabase, now: number): Promise<FormationInviteEntry[]> {
	const entries: FormationInviteEntry[] = [];
	for (const row of await database.queryFormationInvites()) {
		if (isExpired(row.expiresAtMs, now)) {
			continue;
		}
		const usesLeft = row.totalUses === null ? null : row.totalUses - await database.countFormationUsage(row.token);
		if (usesLeft !== null && usesLeft <= 0) {
			continue;
		}
		entries.push({
			token: row.token,
			sAppId: row.sAppId,
			expiresAtMs: row.expiresAtMs,
			usesLeft,
			validationUrl: row.validationUrl,
			strandId: row.strandId
		});
	}
	return entries;
}

/**
 * Seat `bundle` in the running node's party, every row owner-signed by the node's own identity
 * key. Refuses up front, with a typed error and no write, when that key is not an owner of the
 * party ({@link StrandMoveNotOwnerError}) or the bundle came from this very party
 * ({@link StrandMoveSamePartyError}).
 *
 * Strands first, then the invitations, then the pending joins. Every write is idempotent (a row
 * already present with the same content is skipped and counted as moved), so the same bundle
 * can be adopted again after a crash or a transient write failure and finishes what is left.
 * One strand's failure does not stop the others: it is reported under `failed` for the retry.
 * One transaction over the whole bundle was weighed and declined: the per-row writers already
 * carry the stamp, signature and retry policy, and the resumable bundle covers a crash between
 * rows.
 *
 * @throws when the node is not started, beside the two typed refusals.
 */
export async function adoptStrandBundle(node: CadreNode, bundle: StrandBundle): Promise<StrandMoveReport> {
	const database = requireControlDatabase(node, 'adopt');
	if (bundle.partyId === node.partyId) {
		throw new StrandMoveSamePartyError(node.partyId);
	}
	if (!(await node.wireOwnKeyIfOwner())) {
		throw new StrandMoveNotOwnerError(node.partyId);
	}
	const owner = node.getIdentityOwnerKey();
	const signer: OwnerSigner = { ownerKey: owner.publicKeyB64, signMessage: signMessageWith(owner.privateKeyB64) };
	const report: StrandMoveReport = {
		fromPartyId: bundle.partyId,
		moved: [],
		refused: [],
		failed: [],
		invitationsMoved: 0,
		invitationsDropped: 0,
		pendingJoinsMoved: 0
	};
	for (const entry of bundle.strands) {
		await adoptStrand(node, database, signer, entry, report);
	}
	const settled = settledStrands(report);
	const now = Date.now();
	for (const invite of bundle.formationInvites) {
		await adoptFormationInvite(node, database, invite, settled, report, now);
	}
	for (const join of bundle.pendingJoins) {
		await adoptPendingJoin(database, signer, join, report);
	}
	log('adopt(%s ← %s): %d moved, %d refused, %d failed; %d invitation(s) moved, %d dropped; %d pending join(s)',
		node.partyId, bundle.partyId, report.moved.length, report.refused.length, report.failed.length,
		report.invitationsMoved, report.invitationsDropped, report.pendingJoinsMoved);
	return report;
}

interface OwnerSigner {
	ownerKey: string;
	signMessage: (message: Uint8Array) => string;
}

/** The strands an adoption has decided on, by outcome, for the invitations bound to them. */
interface SettledStrands {
	moved: Set<string>;
	failed: Set<string>;
}

function settledStrands(report: StrandMoveReport): SettledStrands {
	return {
		moved: new Set(report.moved),
		failed: new Set(report.failed.filter((entry) => entry.kind === 'strand').map((entry) => entry.id))
	};
}

/**
 * Seat one strand, in the order the adopting node's strand watcher demands. The watcher polls
 * `Strand` and `JoinedStrand` every five seconds and launches, or offers, a new row at once; a
 * closed strand's founder launch resolves the party key and, finding none, mints a fresh one,
 * which would found the strand a second time under a stranger's identity. So the party key is
 * seated before the row, and the strand's peers (its saved routing table and carried addresses)
 * before both, so the launch's cohort seed has somewhere to dial. Every step is
 * insert-if-absent.
 */
async function adoptStrand(
	node: CadreNode,
	database: ControlDatabase,
	signer: OwnerSigner,
	entry: StrandBundleEntry,
	report: StrandMoveReport
): Promise<void> {
	const strandId = entry.row.Id;
	try {
		const live = await readLiveStrand(database, strandId);
		const refusal = strandRefusal(entry, live);
		if (refusal !== null) {
			log('adopt: strand %s refused: %s', strandId, refusal);
			report.refused.push({ strandId, reason: refusal });
			return;
		}
		await seatStrandPeers(node, entry);
		if (entry.partyKey !== null) {
			await node.ensureStrandPartyKey(strandId, entry.partyKey);
		}
		if (entry.kind === 'own') {
			await node.publishStrand(strandId, entry.row.Type, entry.row.MemberPrivateKey ?? undefined);
		} else {
			await seatJoinedStrand(database, signer, entry.row, live.joined);
		}
		report.moved.push(strandId);
	} catch (error) {
		log('adopt: strand %s (%s) not seated this time; adopt the same bundle again: %o', strandId, entry.kind, error);
		report.failed.push({ kind: 'strand', id: strandId, reason: errorText(error) });
	}
}

/** What the adopting party already holds for a strand id. */
interface LiveStrand {
	partyKey: string | null;
	own: StrandRow | null;
	joined: StrandRow | null;
}

async function readLiveStrand(database: ControlDatabase, strandId: string): Promise<LiveStrand> {
	return {
		partyKey: await database.queryStrandPartyKey(strandId),
		own: await database.queryStrand(strandId),
		joined: await database.queryJoinedStrand(strandId)
	};
}

/**
 * Why `entry` can never be seated here, or null. A strand this party already participates in
 * under its own identity keeps that membership: its `StrandPartyKey` is the key its `Member`
 * row was seated under, and the bundle's key is another party's seat. A row for the id of the
 * other kind (the party founded what the bundle joined, or joined what the bundle founded), or
 * of the same kind with different content, is the same refusal. Decided from a read before any
 * write, so a retry reports the refusal again instead of failing on a write; the writes
 * re-check (`ensureStrandPartyKey` and `publishStrand` throw on a mismatch), so a row landing
 * between the read and the write fails the strand this time and is refused on the retry.
 */
function strandRefusal(entry: StrandBundleEntry, live: LiveStrand): string | null {
	const strandId = entry.row.Id;
	if (live.partyKey !== null && live.partyKey !== entry.partyKey) {
		return `this party already holds its own membership identity for strand ${strandId} and keeps that membership`;
	}
	if (entry.kind === 'own' && live.joined !== null) {
		return `this party already participates in strand ${strandId} as a strand it joined and keeps that membership`;
	}
	if (entry.kind === 'joined' && live.own !== null) {
		return `this party already holds strand ${strandId} as its own and keeps that membership`;
	}
	const same = entry.kind === 'own' ? live.own : live.joined;
	if (same !== null && !sameStrandContent(same, entry.row)) {
		return `this party already holds strand ${strandId} as ${entry.kind === 'own' ? 'its own' : 'a join'} with different content`;
	}
	return null;
}

/**
 * The strand's saved routing table and carried addresses, when this node holds none for it: a
 * launch here since an earlier attempt may have saved fresher state than the bundle carries.
 */
async function seatStrandPeers(node: CadreNode, entry: StrandBundleEntry): Promise<void> {
	const strandId = entry.row.Id;
	const store = node.getStrandNetworkStateStore();
	if (entry.networkState !== undefined && store !== null && store.load(strandId) === undefined) {
		await store.save(strandId, entry.networkState);
	}
	if (entry.carriedAddrs.length > 0 && node.getCarriedStrandAddrs(strandId).length === 0) {
		await node.recordCarriedStrandAddrs(strandId, entry.carriedAddrs);
	}
}

/**
 * `insertJoinedStrand`, read as done when the identical row is already there: `existing` from
 * the refusal read (a retry), or one landing between that read and the insert (a sibling's
 * publish; `strandRefusal` has already compared the content of the first, and the second is
 * compared here).
 */
async function seatJoinedStrand(
	database: ControlDatabase,
	signer: OwnerSigner,
	row: StrandBundleEntry['row'],
	existing: StrandRow | null
): Promise<void> {
	if (existing !== null) {
		return;
	}
	try {
		await database.insertJoinedStrand(row, signer.ownerKey, signer.signMessage);
	} catch (error) {
		if (!isStrandIdConflict(error, 'JoinedStrand')) {
			throw error;
		}
		const landed = await database.queryJoinedStrand(row.Id);
		if (landed === null || !sameStrandContent(landed, row)) {
			throw error;
		}
		log('adopt: joined strand %s landed concurrently with identical content; adopted', row.Id);
	}
}

/**
 * Copy one invitation the exporting party handed out. Its envelope names the app's machine,
 * whose peer id and relay address do not change with the party, so the row here is what keeps
 * an envelope already handed out redeemable. Dropped and counted: an invitation with a
 * `ValidationUrl` (its sign-offs verify against a `ValidationKey` row, and which keys may
 * validate here is this party's owners' decision) and one bound to a strand not seated here,
 * whether refused above or no longer held by the exporting party (`unpublishStrand` leaves a
 * bound row behind): the formation recorder would refuse every redemption as a missing host.
 * Dropped silently: one that expired since the export. One bound to a strand that failed this
 * time is left for the retry that seats the strand.
 */
async function adoptFormationInvite(
	node: CadreNode,
	database: ControlDatabase,
	invite: FormationInviteEntry,
	settled: SettledStrands,
	report: StrandMoveReport,
	now: number
): Promise<void> {
	if (invite.strandId !== null && settled.failed.has(invite.strandId)) {
		return;
	}
	const hostMissing = invite.strandId !== null && !settled.moved.has(invite.strandId);
	if (invite.validationUrl !== null || hostMissing) {
		report.invitationsDropped += 1;
		return;
	}
	if (isExpired(invite.expiresAtMs, now)) {
		return;
	}
	try {
		if (await database.queryFormationInvite(invite.token) === null) {
			await node.publishFormationInvite(invite.token, invite.sAppId, {
				expiresAtMs: invite.expiresAtMs ?? undefined,
				totalUses: invite.usesLeft ?? undefined,
				strandId: invite.strandId ?? undefined
			});
		}
		report.invitationsMoved += 1;
	} catch (error) {
		log('adopt: invitation for sApp %s not seated this time; adopt the same bundle again: %o', invite.sAppId, error);
		report.failed.push({ kind: 'invitation', id: pendingJoinId(invite.token), reason: errorText(error) });
	}
}

/**
 * Re-seat one join the exporting party asked for, with its outcome, under a fresh request
 * stamp. A `joined` outcome's membership invitation matters: for a closed strand it is the seat
 * the party's membership reconciler has not redeemed yet, and this node's retry loop re-stages
 * it from the moved row at its next read. A `failed` outcome is history for the user to
 * dismiss; the seven-day removal cleans it up.
 *
 * A request this party already holds for the invitation is read as done, whether an earlier
 * adoption seated it or the user asked for the same invitation from here. Its outcome is written
 * only when the live request is still pending and is this bundle's own (every request column
 * equal), which closes the crash window between the request insert and its outcome insert
 * without touching a request this party made on its own. A `joined` outcome whose strand was
 * refused above moves too: its invitation is staged like any other, and the reconciler, finding
 * the party's member row already seated, burns it unspent or drops it dead.
 *
 * NOTE: if party-private app tables land in the control database
 * (tickets/blocked/decide-party-private-labels-and-app-state.md), they must move with the
 * strands, and this is the site: one more per-row idempotent write beside the join.
 */
async function adoptPendingJoin(
	database: ControlDatabase,
	signer: OwnerSigner,
	join: PendingJoin,
	report: StrandMoveReport
): Promise<void> {
	const { StampId: _stampId, outcome, ...request } = join;
	try {
		const live = await seatJoinRequest(database, signer, request);
		if (live !== null && outcome !== null && live.outcome === null) {
			await database.recordJoinOutcome(live, outcome, signer.ownerKey, signer.signMessage);
		}
		report.pendingJoinsMoved += 1;
	} catch (error) {
		log('adopt: pending join %s not seated this time; adopt the same bundle again: %o', join.Id, error);
		report.failed.push({ kind: 'pending-join', id: join.Id, reason: errorText(error) });
	}
}

/**
 * The live request for `request` after its insert: the row just written, the identical row
 * already there, or null when the party holds a different request for the invitation (its
 * own ask, left alone) or a dismissed one whose retired stamp is still held until the reap
 * pass (the party chose not to have it).
 */
async function seatJoinRequest(database: ControlDatabase, signer: OwnerSigner, request: JoinRequestFields): Promise<PendingJoin | null> {
	try {
		return await database.insertJoinRequest(request, signer.ownerKey, signer.signMessage);
	} catch (error) {
		if (!isPendingJoinConflict(error)) {
			throw error;
		}
		const existing = await database.queryPendingJoin(request.Id);
		return existing !== null && sameRequest(existing, request) ? existing : null;
	}
}

function sameRequest(live: PendingJoin, request: JoinRequestFields): boolean {
	return live.Invitation === request.Invitation
		&& live.Disclosure === request.Disclosure
		&& live.RequestedAt === request.RequestedAt
		&& live.ExpiresAt === request.ExpiresAt;
}

/** Content only: `Type` and the read secret. `FounderOwnerKey` is provenance, and a moved strand's changes. */
function sameStrandContent(live: StrandRow, desired: StrandBundleEntry['row']): boolean {
	return live.Type === desired.Type && (live.MemberPrivateKey ?? null) === (desired.MemberPrivateKey ?? null);
}

/** The comparison `hasOutstandingFormationInvite` makes, so an invitation the responder would refuse is never copied. */
function isExpired(expiresAtMs: number | null, now: number): boolean {
	return expiresAtMs !== null && expiresAtMs <= now;
}

function requireControlDatabase(node: CadreNode, action: 'export' | 'adopt'): ControlDatabase {
	const database = node.getControlDatabase();
	if (database === null) {
		throw new Error(`CadreNode must be started before it can ${action} a strand bundle`);
	}
	return database;
}

function signMessageWith(privateKeyB64: string): (message: Uint8Array) => string {
	return (message: Uint8Array): string =>
		sign(message, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
