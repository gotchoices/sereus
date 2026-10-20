/**
 * cadre-web.ts — the browser reference's cadre node: `@serfab/cadre-core/edge-node`'s edge node
 * over IndexedDB (`web-edge-platform.ts`), built once here ({@link edgeNode}), and the tab's own
 * surface over it. The browser counterpart of `reference-app-rn/src/cadre-phone.ts`.
 *
 * The edge node owns the lifecycle: starting the party the saved start names (`store.svelte.ts`
 * → `start`), owner genesis on a party the tab founded, the start saved for the next load, joining
 * another cadre by invitation or owner grant with the founded party's strands carried along,
 * dissolving the cadre left, redeeming an owner grant, and acting on an owner's removal of this
 * tab (docs/architecture.md → "The edge node"). It runs those one at a time, re-applies the
 * store's event handlers to every node it builds before that node starts, and bounds the owner
 * step.
 *
 * This module keeps what is the tab's: the diagnostics getters (the control and node-local
 * database handles, the control storage, when the identity was first seen, the relay posture),
 * the signed open chat strand, strand formation (the consent / invitation flow: relay-backed
 * dialability, responder-side `createOpenInvitation` / `encodeInvitation`, initiator-side
 * `decodeInvitation` / `formStrand` + closed-strand `addStrand`), cadre invitations, the
 * `CadreControl` authorization gates ("RBAC") surfaced to diagnostics, the formed-strand e2e hooks
 * and the `__cadre` debug hook, plus pass-throughs to the edge node's owner-key and owner-grant
 * calls.
 *
 * Browser specifics vs the phone: WebSocket + circuit-relay + WebRTC(+direct) transports (no TCP
 * in a tab); a database per storage scope opened on first use; a plaintext key store, the identity
 * and owner key in the node-local database, origin-scoped (`node-local-slots.ts`).
 */

import { generateStrandMemberKey, controlStorageScope } from '@serfab/cadre-core';
import type {
	CadreNode,
	CadreInviteStatus,
	CadreOwnerKey,
	CreateCadreInvitationOptions,
	CreateCadreInvitationResult,
	CreateOwnerGrantOptions,
	CreateOwnerGrantResult,
	ExportedOwnerKey,
	FormStrandResult,
	ImportedOwnerKey,
	OpenInvitation,
	OwnerGrantStatus,
	OwnerKeyExportOptions,
	OwnerKeyRemovalPlan,
	OwnerKeyRemovalResult,
	RelayReservationState,
	RemoveOwnerOptions,
	StrandFormationDisclosure,
	StrandInstance,
} from '@serfab/cadre-core';
import type { EdgeNode, OwnerGenesisResult } from '@serfab/cadre-core/edge-node';
import type { Libp2p } from '@libp2p/interface';
import type { IRawStorage } from '@optimystic/db-p2p';
import { multiaddr } from '@multiformats/multiaddr';
import type { Database } from '@quereus/quereus';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import { createWebEdgeNode } from './web-edge-platform.js';
import { getStoreHandle, getStoreStorage, NODE_LOCAL_STORE_KEY } from './strand-storage.js';
import { getChatSAppConfig, CHAT_STRAND_ID, CHAT_SAPP_ID } from './chat-strand.js';
import { insertChatMessage, newChatMessageId, selectChatMessages } from './chat-dml.js';

/** The tab's edge node. One per tab: a development reload re-runs this module, which replaces a stopped one. */
export const edgeNode: EdgeNode = createWebEdgeNode();

/**
 * How the start settled this tab's owner key (`EdgeNodeStatus.owner`): `enrolled` when a key
 * the tab holds is an owner and wired for signing (a founded party's genesis, or a joined party
 * listing it), `member` when the party lists none, `failed` and `timed-out` for an owner step that
 * failed (logged by the edge node) or did not settle within its bound. `pending` while no node runs.
 */
export type OwnerStanding = OwnerGenesisResult | 'pending';

/**
 * Relay-reservation posture for the dialable side of formation — cadre-core owns
 * both the drive and the status derivation (`relay-reservation.ts`); this app
 * only supplies the relay addrs and renders the result. Re-exported under the
 * local names the store/diagnostics already use.
 */
export type RelayState = RelayReservationState;

/**
 * The posture of a tab with no node running (or no relay configured). A FACTORY,
 * not a shared const: the store assigns whatever `getRelayState()` returns into a
 * Svelte `$state` object, which proxies it — a write through that proxy would
 * otherwise mutate the singleton every later caller receives.
 */
export function noRelayState(): RelayState {
	return { status: 'none', addrs: [], circuitAddrs: [], error: null, retryAtMs: null };
}

/** A strand this tab joined via the consent/invitation formation flow. */
export interface FormedStrand {
	strandId: string;
	/**
	 * The closed strand's read-gating membership key (`MemberPrivateKey`) this tab
	 * attached with. Host and joiner record the **same** secret, so
	 * {@link getFormedStrands} surfaces both sides symmetrically (e.g. an e2e
	 * convergence check can assert the two memberKeys match).
	 */
	memberKey: string;
	/** Membership type — formed strands are closed (`'c'`). */
	type: 'o' | 'c';
}

/** Result of an attempted unauthorized control write (the RBAC gate demo). */
export interface OwnerGateProbe {
	/** True when the `CadreControl` constraint rejected the write (gate working). */
	rejected: boolean;
	/** The rejection message (when `rejected`), else null. */
	error: string | null;
}

/** A `FormationInvite` row, as surfaced to diagnostics. */
export interface FormationInviteRow {
	token: string;
	sAppId: string | null;
	expiresAt: string | null;
	totalUses: number | null;
}

/** A `FormationUsage` row, as surfaced to diagnostics. */
export interface FormationUsageRow {
	token: string;
	usageStampId: string;
	strandId: string | null;
}

/** A control-network `Strand` row (membership type + member-key presence). */
export interface ControlStrandRow {
	id: string;
	type: 'o' | 'c';
	hasMemberKey: boolean;
}

/** Control-network authorization ("RBAC") state, for the diagnostics surface. */
export interface ControlAuthorizationState {
	ownerKeyCount: number;
	validationKeyCount: number;
	formationInvites: FormationInviteRow[];
	formationUsage: FormationUsageRow[];
	strands: ControlStrandRow[];
}

/** Node-local record of when this tab's identity was first seen; an app record beside the saved start, so dot-free. */
const IDENTITY_FIRST_SEEN_KEY = 'identity-first-seen';

let activeStrandId: string | null = null;
let identityFirstSeenMs: number | null = null;
// NOTE: accepted tradeoff — joins live only here. The node is built over the tab's key store, so
// cadre-core keeps a record of every strand joined from another party there
// (`KeyStoreJoinedStrandStore`) and the records survive a reload, but the tab registers no
// `strand:discovered` handler that opens them, so after a reload they are carried, not opened, as
// are the strands a join moves into the party the tab joined (their rows, party keys and
// invitations reach that party, and the strands sit in the node's discovered map). Revisit if the
// web app is expected to survive a reload as a joiner.
const formedStrands = new Map<string, FormedStrand>();

// The tab's own state follows the edge node's status: the debug hook and the identity's first-seen
// time exist while a node runs; the chat strand and the formed strands die with it.
edgeNode.onStatus((status) => {
	if (status.state === 'running') {
		exposeDebugHook(status.node);
		void trackIdentityFirstSeen();
	} else if (status.state === 'stopped') {
		clearDebugHook();
		activeStrandId = null;
		identityFirstSeenMs = null;
		formedStrands.clear();
	}
});

// ── Getters (read by the store + diagnostics) ─────────────────────────────────

/** The running node, or null; null as soon as a stop, restart, join or dissolve begins tearing it down. */
export function getCadreNode(): CadreNode | null {
	return edgeNode.node;
}

/** The underlying control-network libp2p node — feeds the existing diagnostics. */
export function getControlNode(): Libp2p | null {
	return edgeNode.node?.getControlNode() ?? null;
}

export function getPartyId(): string | null {
	return edgeNode.options?.partyId ?? null;
}

export function getChatStrandId(): string | null {
	return activeStrandId;
}

export function getChatStrand(): StrandInstance | undefined {
	const node = edgeNode.node;
	if (!node || !activeStrandId) return undefined;
	return node.getStrand(activeStrandId);
}

/**
 * The control BLOCK store's IndexedDB handle — used by diagnostics for per-store row
 * counts. Party-scoped and opened on the node's first control read, so it is null until
 * then. NOT the node-local `kv` database (`NODE_LOCAL_STORE_KEY`), which holds the key store
 * and the node-local records rather than blocks.
 */
export function getControlDbHandle(): OptimysticWebDBHandle | null {
	const partyId = getPartyId();
	return partyId ? getStoreHandle(controlStorageScope(partyId)) : null;
}

/** Control raw storage — used by diagnostics for the backend label + byte estimate; null until the node has opened it. */
export function getControlStorage(): IRawStorage | null {
	const partyId = getPartyId();
	return partyId ? getStoreStorage(controlStorageScope(partyId)) : null;
}

/**
 * The node-local IndexedDB handle — the tab's key store and node-local records
 * (`node-local-slots.ts`). Separate from {@link getControlDbHandle} since the control
 * block store became party-scoped: diagnostics counts the block object stores on that
 * one and the `kv` object store on this one. Null until the edge node's first read opens it.
 */
export function getNodeLocalDbHandle(): OptimysticWebDBHandle | null {
	return getStoreHandle(NODE_LOCAL_STORE_KEY);
}

export function getIdentityFirstSeenMs(): number | null {
	return identityFirstSeenMs;
}

/** How the running node's start settled the tab's owner key; `pending` while no node runs. */
export function getOwnerState(): OwnerStanding {
	const status = edgeNode.status;
	return status.state === 'running' ? status.owner : 'pending';
}

/** Whether this tab's key is wired for owner signing on the running node. */
export function ownerKeyWired(): boolean {
	return getOwnerState() === 'enrolled';
}

/**
 * Relay-reservation posture (dialability for formation). Read LIVE from the node
 * on every call — a reservation lost after start (relay restart, dropped
 * connection) shows up as `error` here, so nothing mints an invitation carrying
 * circuit addresses that no longer route.
 */
export function getRelayState(): RelayState {
	return edgeNode.node?.getRelayReservationState() ?? noRelayState();
}

/** Strands joined this session via the consent/invitation formation flow. */
export function getFormedStrands(): FormedStrand[] {
	return [...formedStrands.values()];
}

function requireNode(): CadreNode {
	const node = edgeNode.node;
	if (!node) throw new Error('CadreNode not started');
	return node;
}

// ── Identity first seen (a node-local record of the tab's own) ─────────────────

/**
 * Read when this identity was first seen, recording now when nothing is recorded yet. A failure
 * is logged: the age is a diagnostics figure, not something a start depends on. (On an upgrade
 * where the key predates tracking, "first seen" understates age.)
 */
async function trackIdentityFirstSeen(): Promise<void> {
	const records = edgeNode.nodeLocalRecords();
	try {
		const stored = await records.get(IDENTITY_FIRST_SEEN_KEY);
		const parsed = stored === undefined ? Number.NaN : Number(stored);
		if (Number.isFinite(parsed)) {
			identityFirstSeenMs = parsed;
			return;
		}
		const now = Date.now();
		await records.set(IDENTITY_FIRST_SEEN_KEY, String(now));
		identityFirstSeenMs = now;
	} catch (err) {
		console.warn('[reference-app-web] could not read or record when this identity was first seen:', err);
	}
}

// ── Owner keys and owner grants (the Cadre page's Owner keys card) ──────────────
// Pass-throughs to the edge node, which runs them in turn with its transitions: genesis creates
// the owner slot's key inside a start, and the slot's check-then-set must not race an import.

/** The cadre's live owner keys (`CadreNode.listOwnerKeys`); throws while no node runs. */
export function listOwnerKeys(): Promise<CadreOwnerKey[]> {
	return edgeNode.listOwnerKeys();
}

/**
 * This tab's own owner key as export text: the key in the tab's owner slot, the only key the node
 * signs with when the tab is an owner; throws when the tab holds none of its own. Works with no
 * node running.
 */
export function exportOwnerKey(options: OwnerKeyExportOptions = {}): Promise<ExportedOwnerKey> {
	return edgeNode.exportOwnerKey(options);
}

/**
 * Import owner-key text into the tab's owner slot, wiring the key when the running party lists
 * it; the edge node then reports `running` again with the owner `enrolled`, which the store follows.
 */
export function importOwnerKey(text: string, passphrase?: string): Promise<ImportedOwnerKey> {
	return edgeNode.importOwnerKey(text, passphrase);
}

/** What `removeOwner(key)` would do, for the confirmation step. */
export function planOwnerKeyRemoval(key: string): Promise<OwnerKeyRemovalPlan> {
	return edgeNode.planOwnerKeyRemoval(key);
}

/** Remove an owner key, re-vouching first the dependents `options.revouch` keeps. */
export function removeOwner(key: string, options: RemoveOwnerOptions = {}): Promise<OwnerKeyRemovalResult> {
	return edgeNode.removeOwner(key, options);
}

/**
 * Mint an owner grant, signed by this tab's owner key: 15 minutes and one use by default, a
 * backup with no expiry with `expiresInMs: null`. Its text is shown once; the tab keeps none.
 */
export function createOwnerGrant(options: CreateOwnerGrantOptions = {}): Promise<CreateOwnerGrantResult> {
	return edgeNode.createOwnerGrant(options);
}

/** Every owner grant the running node holds, minted here or replicated in, with its standing. */
export function listOwnerGrants(): Promise<OwnerGrantStatus[]> {
	return edgeNode.listOwnerGrants();
}

/** Withdraw an owner grant by its key; false when it is not held here or was already withdrawn. */
export function withdrawOwnerGrant(key: string): Promise<boolean> {
	return edgeNode.withdrawOwnerGrant(key);
}

// ── Strand formation (consent / invitation flow) ──────────────────────────────

/** What {@link createInvitation} returns to the responder UI. */
export interface CreatedInvitation {
	/** Base64url-encoded `OpenInvitation` to copy out-of-band to the initiator. */
	encoded: string;
	token: string;
	sAppId: string;
	expiration: string;
	/**
	 * Id of the host closed strand the invite is bound to. A redeeming
	 * `formStrand` provisions THIS strand and returns its membership key
	 * (provision-then-record), so the host UI can track/render it.
	 */
	strandId: string;
}

/**
 * Host side of closed-strand formation: mint a membership key, publish the
 * `Strand` row (`Type:'c'`) under this node's owner with the `FormationInvite`
 * row for `invitation` bound to it, and attach the local instance against the
 * signed chat schema. Mirrors RN `createClosedChatStrand`
 * (`reference-app-rn/src/chat-strand.ts`), except that the web app assigns no
 * owner/member role: the chat schema's `Participant.Role` column is left at its
 * `'member'` default, so bring-up is one `foundStrand` call.
 *
 * `foundStrand` does both steps (publish + attach as founder, which runs the
 * one-time genesis bootstrap seating Header/Member/Owner from this party's own
 * `StrandPartyKey` identity, minted by the publish — NOT from the shared
 * `MemberPrivateKey`). The publish writes the strand row, that key and the bound
 * invitation in one control transaction under one owner approval, and the call is
 * safe to re-run: a tab closed between publish and attach resumes
 * rather than failing forever on `UNIQUE constraint failed: Strand.Id`. The id
 * here is freshly minted per call, so the resume path is reached only if a caller
 * ever passes a stable id — but going through the one entry point is what keeps
 * this call site off the pattern that bricks when they do.
 *
 * It returns once the row is published (`{ background: true }`), because the
 * invitation needs only the strand id and key; the attach continues behind it. A
 * failed attach only warns: the node keeps retrying the start, and the invitation
 * stays valid, since a joiner redeeming it before the strand runs is refused
 * retryably.
 *
 * Returns the generated strand id + the membership key the strand ACTUALLY runs
 * under (the resolved row's, not necessarily the one minted here) so the caller
 * can track it.
 */
async function createClosedChatStrand(
	cadre: CadreNode,
	invitation: OpenInvitation,
): Promise<{ strandId: string; memberPrivateKey: string }> {
	const strandId = crypto.randomUUID();
	const { strandRow, ready } = await cadre.foundStrand({
		strandId,
		type: 'c',
		memberPrivateKey: await generateStrandMemberKey(),
		sAppConfig: getChatSAppConfig(),
		formationInvite: { token: invitation.token, expiresAtMs: invitation.expiration.getTime() },
	}, { background: true });
	void ready.catch((err: unknown) => {
		console.warn(`[reference-app-web] closed strand ${strandId} did not start; the node keeps retrying it:`, err);
	});
	if (!strandRow.MemberPrivateKey) {
		throw new Error(
			`Closed strand ${strandId} was founded without a MemberPrivateKey — no ` +
				'invitation bound to it could read the strand',
		);
	}
	return { strandId, memberPrivateKey: strandRow.MemberPrivateKey };
}

/**
 * Responder/host side: provision a closed strand bound to a fresh open
 * invitation for the chat sApp, then encode that invitation for out-of-band
 * (copy/paste) delivery. Mirrors RN's `createClosedStrandWithInvite`
 * (`reference-app-rn/src/use-cadre.ts`):
 *
 *   1. mint the `OpenInvitation`, then
 *   2. found the host closed strand (mint member key + publish the `Type:'c'`
 *      row; the local instance starts in the background) with a
 *      `FormationInvite` **bound to that strand id** published beside it, so a
 *      redeeming `formStrand` resolves the host strand and returns its real
 *      membership key (provision-then-record), rather than the responder minting
 *      a fresh one.
 *
 * Requires the tab to be **dialable** — the invitation embeds this cadre's
 * multiaddrs, so `createOpenInvitation` throws when no relay reservation has
 * produced a `/p2p-circuit` address. The dialability guard runs before any
 * strand is published so an undialable tab leaves no dangling host strand.
 */
export async function createInvitation(
	expirationMs: number = 24 * 60 * 60 * 1000,
): Promise<CreatedInvitation> {
	const cadre = requireNode();
	// Live read: a reservation lost since start now fails this guard, so the
	// invitation is refused with a clear message instead of embedding circuit
	// addresses that no longer route.
	const relay = getRelayState();
	if (relay.status !== 'reserved') {
		throw new Error(
			'This tab is not dialable — strand formation needs a circuit-relay ' +
				'reservation. Configure a relay (VITE_RELAY_ADDR or localStorage ' +
				`"relay-addr"). Relay status: ${relay.status}` +
				(relay.error ? ` (${relay.error})` : ''),
		);
	}
	const invitation = await cadre.createOpenInvitation(CHAT_SAPP_ID, expirationMs);
	const { strandId, memberPrivateKey } = await createClosedChatStrand(cadre, invitation);
	// Track the host strand so diagnostics / getFormedStrands() stay consistent
	// with the joiner side (both record `type:'c'` + the gating member key).
	formedStrands.set(strandId, { strandId, memberKey: memberPrivateKey, type: 'c' });
	return {
		encoded: cadre.encodeInvitation(invitation),
		token: invitation.token,
		sAppId: invitation.sAppId,
		expiration: invitation.expiration.toISOString(),
		strandId,
	};
}

/**
 * Initiator side: decode an out-of-band invitation, run the formation protocol
 * against the responder's cadre, then launch the resulting **closed** strand
 * against the same signed chat schema using the host's read-gating membership key
 * (`FormStrandResult.memberPrivateKey`, delivered after consent).
 */
export async function joinViaInvitation(
	encoded: string,
	disclosure: StrandFormationDisclosure = {},
): Promise<FormedStrand> {
	const cadre = requireNode();
	const invitation: OpenInvitation = cadre.decodeInvitation(encoded.trim());
	const result: FormStrandResult = await cadre.formStrand(invitation, {
		partyId: getPartyId() ?? undefined,
		...disclosure,
	});

	// Provision the closed strand locally with the host's read-gating membership
	// key. That key is `memberPrivateKey` — the closed strand's secret the host
	// provisions and returns over the formation protocol after consent
	// (provision-then-record) — NOT `invitePrivateKey` (the initiator's own generated
	// signing key, which is `''` on the manager's dial path and cannot authorize
	// reads). A closed-strand `formStrand` always returns this key; its absence
	// means the host strand was not closed or the responder provisioned none, so
	// fail loudly rather than attach with a key that cannot read. Mirrors RN
	// `joinClosedChatStrandFromFormation` (`reference-app-rn/src/chat-strand.ts`).
	if (!result.memberPrivateKey) {
		throw new Error(
			'formStrand returned no membership key — the host strand is not closed or the ' +
				'responder provisioned no member key; cannot attach a closed chat strand',
		);
	}
	await cadre.addStrand({
		strandRow: {
			Id: result.strandId,
			MemberPrivateKey: result.memberPrivateKey,
			Type: 'c',
			FounderOwnerKey: null,
			FounderPeerId: null,
		},
		sAppConfig: getChatSAppConfig(),
	});

	const formed: FormedStrand = {
		strandId: result.strandId,
		// The read-gating membership key we attached with — the SAME secret the host
		// published (provision-then-record), NOT `result.memberKey` (our own partyId,
		// set on the manager's dial path). Keeps host/joiner `formedStrands` symmetric.
		memberKey: result.memberPrivateKey,
		type: 'c',
	};
	formedStrands.set(result.strandId, formed);
	return formed;
}

// ── Cadre invitations (adding a device or app) ────────────────────────────────

/**
 * Whether this tab can act as an owner of its cadre (`CadreNode.isOwner`: an owner key wired
 * for signing and enrolled in `OwnerKey`): only an owner can mint a cadre invitation.
 */
export async function isOwner(): Promise<boolean> {
	return await requireNode().isOwner();
}

/**
 * Whether `peerId` is already a machine of this cadre (a `CadrePeer` row that is not
 * revoked), so an owner is not offered an invitation for an app the cadre holds.
 */
export async function isMemberPeer(peerId: string): Promise<boolean> {
	const controlDb = requireNode().getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	return (await controlDb.queryCadrePeers()).some((row) => row.peerId === peerId);
}

/**
 * Mint an invitation into this cadre, for one app's peer id or for whoever redeems it
 * first. Thin pass-through to `CadreNode.createCadreInvitation`.
 */
export async function createCadreInvitation(
	options: CreateCadreInvitationOptions,
): Promise<CreateCadreInvitationResult> {
	return requireNode().createCadreInvitation(options);
}

/** Every cadre invitation the node holds, with its standing. Thin pass-through to `CadreNode.listCadreInvitations`. */
export async function listCadreInvitations(): Promise<CadreInviteStatus[]> {
	return requireNode().listCadreInvitations();
}

/**
 * Withdraw a cadre invitation by its key; false when it was already withdrawn or is not
 * held here. Thin pass-through to `CadreNode.withdrawCadreInvitation`.
 */
export async function withdrawCadreInvitation(key: string): Promise<boolean> {
	return requireNode().withdrawCadreInvitation(key);
}

// ── RBAC / authorization gate (observability) ─────────────────────────────────

/**
 * Demonstrate the `CadreControl` owner gate: attempt a `Strand` insert that
 * claims an owner it does not hold (a non-enrolled key + bogus signature) and
 * carries no consuming `FormationUsage` row. The `Strand.AuthorizedInsert` constraint
 * satisfies *neither* branch, so the write must be rejected at commit.
 *
 * Returns `{ rejected: true }` when the constraint correctly blocks the write
 * (the RBAC gate is working) and `{ rejected: false }` if it unexpectedly
 * succeeds — a regression worth surfacing.
 */
export async function attemptUnauthorizedStrandWrite(): Promise<OwnerGateProbe> {
	const node = requireNode();
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	const db = controlDb.getDatabase();
	const probeId = `rbac-probe-${node.peerId?.toString() ?? 'anon'}`;
	// Mirror the canonical authorized insert (control-database.ts `insertStrand`):
	// the `Strand` context is exactly `(OwnerKey, Signature)` and `StampId` is a
	// real `not null unique` column supplied in `values`. Providing a fresh StampId
	// keeps the not-null/anti-replay column satisfied so the ONLY failing condition
	// is the `AuthorizedInsert` check — no enrolled owner matches the bogus key and no
	// `FormationUsage` row consents — proving the rejection is the owner gate
	// itself, not an incidental column/context error.
	const stampId = `rbac-probe-stamp-${crypto.randomUUID()}`;
	try {
		await db.exec(
			`insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
				with context OwnerKey = ?, Signature = ?
				values (?, 'o', null, ?)`,
			['not-an-owner-key', 'bogus-signature', probeId, stampId],
		);
		// Reaching here means the gate let an unauthorized write through. Best-effort
		// cleanup is not attempted (the row is itself a regression marker).
		return { rejected: false, error: null };
	} catch (err) {
		return { rejected: true, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Read the control-network authorization ("RBAC") state for diagnostics: counts
 * of owner/validation keys, the `FormationInvite` / `FormationUsage` rows,
 * and each `Strand`'s membership type + member-key presence. Pure read-only SQL
 * over the control database's Quereus handle — no network round-trips.
 */
export async function readControlAuthorizationState(): Promise<ControlAuthorizationState> {
	const controlDb = requireNode().getControlDatabase();
	if (!controlDb) throw new Error('control database unavailable');
	const db = controlDb.getDatabase();

	const ownerKeyCount = await countRows(db, 'CadreControl.OwnerKey');
	const validationKeyCount = await countRows(db, 'CadreControl.ValidationKey');

	const formationInvites: FormationInviteRow[] = [];
	for await (const row of db.eval(
		'select Token, sAppId, ExpiresAt, TotalUses from CadreControl.FormationInvite',
	)) {
		formationInvites.push({
			token: row.Token as string,
			sAppId: (row.sAppId as string | null) ?? null,
			expiresAt: (row.ExpiresAt as string | null) ?? null,
			totalUses: (row.TotalUses as number | null) ?? null,
		});
	}

	const formationUsage: FormationUsageRow[] = [];
	for await (const row of db.eval(
		'select Token, UsageStampId, StrandId from CadreControl.FormationUsage',
	)) {
		formationUsage.push({
			token: row.Token as string,
			usageStampId: row.UsageStampId as string,
			strandId: (row.StrandId as string | null) ?? null,
		});
	}

	const strands: ControlStrandRow[] = (await controlDb.queryStrands()).map((s) => ({
		id: s.Id,
		type: s.Type,
		hasMemberKey: s.MemberPrivateKey != null && s.MemberPrivateKey.length > 0,
	}));

	return { ownerKeyCount, validationKeyCount, formationInvites, formationUsage, strands };
}

/** Count rows in a fully-qualified control table via a scalar aggregate. */
async function countRows(db: Database, table: string): Promise<number> {
	for await (const row of db.eval(`select count(1) as Count from ${table}`)) {
		return (row.Count as number) ?? 0;
	}
	return 0;
}

// ── The chat strand ───────────────────────────────────────────────────────────

/**
 * Add the signed open chat strand. On a solo node the strand's cohort is itself — it
 * coordinates its own writes — so DML lands on the strand's IndexedDB with no other
 * peers needed. Its database opens on first use (`strand-storage.ts`).
 *
 * Local to the tab, whichever party the node runs: `founder: true` with no control row
 * puts it in no strand bundle, so a join does not move it, and its database is keyed by
 * strand id, so after a join it keeps working in the joined party as the same strand.
 *
 * Throws `SchemaVerificationError` if the sApp signature does not match its
 * schema/version — the signature gate the reference is meant to exercise.
 */
export async function addChatStrand(): Promise<StrandInstance> {
	const instance = await requireNode().addStrand({
		strandRow: { Id: CHAT_STRAND_ID, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
		sAppConfig: getChatSAppConfig(),
		founder: true,
	});
	activeStrandId = CHAT_STRAND_ID;
	return instance;
}

// ── Formed-strand connectivity + DML (e2e formation→convergence hooks) ────────
//
// Formation exchanges peer addrs but does NOT persist them as `CadrePeer` rows,
// so the strand cohort seed stays empty and the two strand instances never
// auto-connect (strand peer discovery via the control network is still TODO). The
// e2e test wires the cohort link by hand — dialing one strand's libp2p node at the
// other's strand multiaddr — and reads/writes the FORMED strand (a responder-minted
// UUID strand, distinct from the solo `CHAT_STRAND_ID` the Messages UI renders).
// These helpers back the additive `__cadre` hooks for exactly that.

/**
 * Resolve a strand instance by id, or throw a clear, surfaced error. The strand
 * may be unknown (a strandId this tab never formed) — surfaced as a thrown error
 * rather than a bare `undefined` deref so the test (and devtools) fail loudly.
 * Targets the **strand-level** instance (`getStrand`), never the control node.
 */
function requireStrandInstance(strandId: string): StrandInstance {
	const instance = requireNode().getStrand(strandId);
	if (!instance) {
		throw new Error(`strand ${strandId} not found on this node`);
	}
	return instance;
}

/**
 * Resolve a strand instance's libp2p node, or throw a clear, surfaced error. A
 * strand that is still launching (or has been released) holds no node yet — that
 * surfaces as a thrown error rather than a bare `undefined` deref.
 */
function requireStrandLibp2p(strandId: string): Libp2p {
	const libp2pNode = requireStrandInstance(strandId).libp2pNode;
	if (!libp2pNode) {
		throw new Error(
			`strand ${strandId} has no libp2p node — it is still launching, or it was released`,
		);
	}
	return libp2pNode;
}

/**
 * Resolve a strand instance's attached Quereus database, or throw. Read/write
 * hooks need the DB handle (not the libp2p node), so this guards the strand not
 * yet being active (no attached database) separately. A wrong/unknown strandId
 * errors clearly rather than silently reading an empty solo strand.
 */
function requireStrandDatabase(strandId: string): Database {
	const instance = requireStrandInstance(strandId);
	if (!instance.database) {
		throw new Error(`strand ${strandId} has no database — it is still launching`);
	}
	return instance.database.getDatabase();
}

/**
 * The strand-level libp2p multiaddrs for a formed strand — the cohort peer's
 * dialable addresses, NOT the control node's. The second party dials one of these
 * to join the strand cohort.
 */
export function getStrandMultiaddrs(strandId: string): string[] {
	return requireStrandLibp2p(strandId).getMultiaddrs().map(String);
}

/**
 * Dial a strand-cohort peer's multiaddr from this strand's libp2p node, wiring the
 * cohort link the control network does not yet seed. libp2p handles an
 * already-connected dial idempotently; an unreachable addr surfaces the libp2p
 * error rather than wedging.
 */
export async function dialStrandPeer(strandId: string, addr: string): Promise<void> {
	await requireStrandLibp2p(strandId).dial(multiaddr(addr));
}

/**
 * Live strand-cohort connection count. The test polls this until ≥ 1 before
 * expecting convergence — a 2-member cohort commit needs a super-majority of 2, so
 * a write only lands once both members are connected.
 */
export function getStrandConnectionCount(strandId: string): number {
	return requireStrandLibp2p(strandId).getConnections().length;
}

/**
 * Upsert the author `Participant` row then append an `App.Message` into the FORMED
 * strand's database (`getStrand(strandId)`), NOT the solo chat strand. Returns the
 * new message id. Reuses the shared chat DML so the write is byte-identical to the
 * Messages UI path (including the load-bearing Participant-before-Message FK ordering).
 *
 * Mints the key here rather than holding it across attempts, because nothing re-presents
 * this write: the e2e test calls it once and asserts on the id it returns. The composer,
 * which the user CAN press twice, holds its id instead (`messages.svelte.ts`).
 */
export async function writeChatMessage(
	strandId: string,
	message: { participantName: string; content: string },
): Promise<string> {
	const id = newChatMessageId();
	await insertChatMessage(
		requireStrandDatabase(strandId),
		id,
		message.participantName,
		message.content,
	);
	return id;
}

/**
 * Read all `App.Message` rows from the FORMED strand's database, reduced to the
 * `{ id, participantId, content }` shape the e2e convergence assertion needs.
 */
export async function readChatMessages(
	strandId: string,
): Promise<Array<{ id: string; participantId: string; content: string }>> {
	const rows = await selectChatMessages(requireStrandDatabase(strandId));
	return rows.map((r) => ({ id: r.id, participantId: r.participantId, content: r.content }));
}

// ── Debug hook ────────────────────────────────────────────────────────────────

/**
 * Read-only `__cadre` global for devtools / e2e — installed whenever a node reaches `running`
 * and removed on `stopped`. Surfaces cadre state (party id, the running start, control peer id +
 * connection count, chat strand status, the owner standing) without reaching into module scope.
 */
function exposeDebugHook(cadre: CadreNode): void {
	if (typeof window === 'undefined') return;
	(window as unknown as { __cadre?: unknown }).__cadre = {
		getPartyId: () => getPartyId(),
		// The options the running node was started with, so a test can see how the tab came to
		// its party (`origin`) and which party it left (`formerPartyId`).
		getPartyStart: () => edgeNode.options,
		getControlPeerId: () => cadre.getControlNode()?.peerId.toString() ?? null,
		getConnectionCount: () => cadre.getControlNode()?.getConnections().length ?? 0,
		getStrandStatus: () => getChatStrand()?.status ?? null,
		getOwnerState: () => getOwnerState(),
		// Whether this tab's key is one of the running party's `OwnerKey` rows — what a joined
		// member must NOT be after a reload (genesis on a joined party would insert it).
		isOwner: () => isOwner(),
		// Phase 2 — formation + RBAC, surfaced for e2e drive/assert.
		// Delegate, never capture — the posture is derived live from the node.
		getRelayState: () => getRelayState(),
		getFormedStrands: () => getFormedStrands(),
		createInvitation: (expirationMs?: number) => createInvitation(expirationMs),
		joinViaInvitation: (encoded: string, disclosure?: StrandFormationDisclosure) =>
			joinViaInvitation(encoded, disclosure),
		attemptUnauthorizedStrandWrite: () => attemptUnauthorizedStrandWrite(),
		readControlAuthorizationState: () => readControlAuthorizationState(),
		// Formed-strand cohort connectivity + DML — the test wires the strand peer
		// link by hand and reads/writes the formed (closed) strand directly.
		getStrandMultiaddrs: (strandId: string) => getStrandMultiaddrs(strandId),
		dialStrandPeer: (strandId: string, addr: string) => dialStrandPeer(strandId, addr),
		getStrandConnectionCount: (strandId: string) => getStrandConnectionCount(strandId),
		writeChatMessage: (strandId: string, message: { participantName: string; content: string }) =>
			writeChatMessage(strandId, message),
		readChatMessages: (strandId: string) => readChatMessages(strandId),
	};
}

function clearDebugHook(): void {
	if (typeof window === 'undefined') return;
	delete (window as unknown as { __cadre?: unknown }).__cadre;
}
