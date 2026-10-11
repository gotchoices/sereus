/**
 * add-device.svelte.ts — state of the Cadre page's "Add a device or app" card: an owner of
 * this cadre makes an invitation another app redeems to join it (docs/architecture.md →
 * "Handing an invitation from app to app"). The browser counterpart of the phone app's
 * `add-device-section.tsx`, with the same flows and wording.
 *
 * **Paste request**: the other app's join request names its peer id, and after the owner
 * approves, only that app can redeem the invitation. **Copy invitation**: an open
 * invitation whoever holds the text can redeem. The cadre holds each invitation's row,
 * which the outstanding list reads and Withdraw retires.
 *
 * Module state, not component state: the router unmounts the page on every route change,
 * and a minted invitation's text exists nowhere else, so it has to survive a visit to Home.
 * The encoded invitation carries its private key: log the row's key only.
 */

import {
	decodeCadreJoinRequest,
	parseNullableStoredDatetimeMs,
	type CadreInvitationReach,
	type CadreInviteStatus,
	type CadreJoinRequest,
	type CreateCadreInvitationOptions,
} from '@serfab/cadre-core';
import {
	createCadreInvitation,
	getRelayState,
	isMemberPeer,
	isOwner,
	listCadreInvitations,
	withdrawCadreInvitation,
} from './cadre-web.js';
import { currentPeerId } from './store.svelte.js';
import { pushError } from './diagnostics.svelte.js';

// Chosen on the relay status, not on which error core threw, so it states only what that
// status shows: the cadre's other machines are not checked here.
const NO_ADDRESS_LINE = 'This tab has no relay address, so an invitation can be made only while an always-on machine of your cadre has one. Home shows the relay status and how to set one.';

/** Whether this tab may mint invitations, which only an owner of the cadre can. */
export type Standing = 'checking' | 'owner' | 'member' | 'unreadable';

/** Which part of the card a {@link Notice} belongs under. */
export type NoticeArea = 'request' | 'open' | 'list';

/** Why the last action did not do what was asked; replaced by the next action's. */
export interface Notice {
	area: NoticeArea;
	title: string;
	message: string;
	/** The underlying error, when the message is this app's own words. */
	detail: string | null;
}

export interface MintedInvitation {
	/** The row's key, which Withdraw names. */
	key: string;
	title: string;
	encoded: string;
	reach: CadreInvitationReach;
	expiresAtMs: number | null;
}

interface AddDeviceState {
	standing: Standing;
	requestText: string;
	/** A read request waiting for the owner's approval; the approval panel shows while it is set. */
	pending: CadreJoinRequest | null;
	requestOwner: boolean;
	openOwner: boolean;
	minting: boolean;
	minted: MintedInvitation | null;
	/** The live invitations, latest expiry first. */
	invitations: CadreInviteStatus[];
	listError: string | null;
	notice: Notice | null;
}

const state = $state<AddDeviceState>({
	standing: 'checking',
	requestText: '',
	pending: null,
	requestOwner: true,
	openOwner: true,
	minting: false,
	minted: null,
	invitations: [],
	listError: null,
	notice: null,
});

export function addDeviceState(): AddDeviceState {
	return state;
}

/** Re-read this tab's owner standing and the outstanding invitations from the running node. */
export async function refreshAddDevice(): Promise<void> {
	await checkStanding();
	await refreshInvitations();
}

async function checkStanding(): Promise<void> {
	try {
		state.standing = (await isOwner()) ? 'owner' : 'member';
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s owner keys:', err);
		state.standing = 'unreadable';
	}
}

async function refreshInvitations(): Promise<void> {
	try {
		state.invitations = outstanding(await listCadreInvitations());
		state.listError = null;
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s invitations:', err);
		state.listError = errorMessage(err);
	}
}

/** Read the pasted request and, when it names an app this cadre could add, open the approval panel. */
export async function useRequest(): Promise<void> {
	state.notice = null;
	let request: CadreJoinRequest;
	try {
		request = decodeCadreJoinRequest(state.requestText);
	} catch (err) {
		state.notice = notice('request', 'Cannot use this request', errorMessage(err));
		return;
	}
	if (request.peerId === currentPeerId()) {
		state.notice = notice('request', 'Cannot use this request', 'This is this tab\'s own request. Open the other app and copy its request there.');
		return;
	}
	try {
		const owner = await isOwner();
		state.standing = owner ? 'owner' : 'member';
		if (!owner) return;
		if (await isMemberPeer(request.peerId)) {
			state.notice = notice('request', 'Already in this cadre', `${request.appName} is already in this cadre.`);
			return;
		}
	} catch (err) {
		console.warn('[cadre] could not read this cadre\'s owners and machines:', err);
		state.notice = notice('request', 'Cannot use this request right now', 'Could not read this cadre\'s owners and machines. Try again.', errorMessage(err));
		return;
	}
	state.requestOwner = true;
	state.pending = request;
}

export function cancelRequest(): void {
	state.pending = null;
}

/** Mint the invitation the approval panel asked for, for the requesting app alone. */
export async function approveRequest(): Promise<void> {
	const request = state.pending;
	if (!request) return;
	state.pending = null;
	if (await mint({ peerId: request.peerId, grantsOwner: state.requestOwner }, `Invitation for ${request.appName}`, 'request')) {
		state.requestText = '';
	}
}

export async function makeOpenInvitation(): Promise<void> {
	await mint({ grantsOwner: state.openOwner }, 'Open invitation', 'open');
}

/** Take the minted invitation off the card; the cadre still holds its row. */
export function dismissMinted(): void {
	state.minted = null;
}

/** Mint an invitation and show it; false when none was made. */
async function mint(options: CreateCadreInvitationOptions, title: string, area: NoticeArea): Promise<boolean> {
	if (state.minting) return false;
	state.minting = true;
	state.notice = null;
	try {
		const { invitation, encoded, reach } = await createCadreInvitation(options);
		const { key, expiresAt } = invitation.invite;
		console.info(`[cadre] made cadre invitation ${key} (for ${options.peerId ?? 'anyone'}, owner ${options.grantsOwner}, reach ${reach})`);
		state.minted = { key, title, encoded, reach, expiresAtMs: parseNullableStoredDatetimeMs(expiresAt) };
		void refreshInvitations();
		return true;
	} catch (err) {
		console.warn('[cadre] making a cadre invitation failed:', err);
		pushError('createCadreInvitation', err);
		state.notice = mintFailure(area, err);
		return false;
	} finally {
		state.minting = false;
	}
}

/** The core error names the cause; the relay line says why this tab cannot be the address the invitation carries, when that is so. */
function mintFailure(area: NoticeArea, err: unknown): Notice {
	if (getRelayState().status === 'reserved') return notice(area, 'Could not make an invitation', errorMessage(err));
	return notice(area, 'Could not make an invitation', NO_ADDRESS_LINE, errorMessage(err));
}

/** Withdraw an invitation by its row key (the caller has confirmed), then re-read the list. */
export async function withdrawInvitation(key: string): Promise<void> {
	state.notice = null;
	try {
		if (!(await withdrawCadreInvitation(key))) {
			console.info(`[cadre] cadre invitation ${key} was already withdrawn`);
		}
		if (state.minted?.key === key) state.minted = null;
	} catch (err) {
		console.warn(`[cadre] withdrawing cadre invitation ${key} failed:`, err);
		state.notice = notice('list', 'Could not withdraw the invitation', errorMessage(err));
	}
	await refreshInvitations();
}

/**
 * The invitations still redeemable, latest expiry first. A row records no creation time;
 * among invitations of one kind the newest expires last.
 */
function outstanding(statuses: CadreInviteStatus[]): CadreInviteStatus[] {
	const expiry = (status: CadreInviteStatus) => parseNullableStoredDatetimeMs(status.invite.expiresAt) ?? Number.MAX_SAFE_INTEGER;
	return statuses.filter((status) => status.live).sort((a, b) => expiry(b) - expiry(a));
}

function notice(area: NoticeArea, title: string, message: string, detail: string | null = null): Notice {
	return { area, title, message, detail };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
