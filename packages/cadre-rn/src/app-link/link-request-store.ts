/**
 * `LinkRequestStore`: the asking app's record of the join request it opened as a link, so it
 * takes only the answer to that request, once. The record is saved before the owner app opens,
 * in the app-private node-local database (`PhoneNode.linkRequestSlot()`), so an asking app the
 * OS killed while the owner app was in front still takes the answer when the link starts it.
 *
 * The nonce is the security contract: an answer carrying any other nonce, a second answer to the
 * same request, and an answer after {@link LINK_REQUEST_TTL_MS} are refused with
 * {@link UnsolicitedJoinResponseError}, so a link no request asked for cannot hand the app an
 * invitation.
 */
import type { DurableSlot } from '@serfab/cadre-core';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { decodeCadreJoinResponse, type CadreJoinResponse } from './join-response.js';

/** How long an open request takes an answer: long enough to unlock the owner app and confirm. */
export const LINK_REQUEST_TTL_MS = 30 * 60_000;

/** The slot's text while no request is open: the slot cannot be deleted, only written. */
const NO_OPEN_REQUEST = '';

/** Random bytes in a nonce: 128 bits, 22 base64url characters. */
const NONCE_BYTES = 16;

/** The join request the app opened as a link and has not taken an answer to. */
export interface OpenLinkRequest {
	/** The request's `reply.nonce`; the answer must carry it. */
	nonce: string;
	/** The owner app opened (iOS), for the app's messages; null when the Android chooser picked it. */
	ownerAppName: string | null;
	startedAtMs: number;
}

/** An answer that is not to the request this app has open: none is open, it expired, it was answered already, or the nonce differs. */
export class UnsolicitedJoinResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsolicitedJoinResponseError';
	}
}

/**
 * Create one per app, over `PhoneNode.linkRequestSlot()`: its calls run one at a time, so two
 * deliveries of the same answer (the launch URL and a `url` event) cannot both take it.
 */
export class LinkRequestStore {
	private turn: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly slot: DurableSlot,
		private readonly now: () => number = Date.now,
	) {}

	/** Open a request, or return the open one unchanged (same nonce) so an answer to an earlier tap still lands. */
	begin(ownerAppName: string | null): Promise<OpenLinkRequest> {
		return this.inTurn(async () => {
			const open = await this.readOpen();
			if (open) return open;
			const request: OpenLinkRequest = { nonce: newLinkNonce(), ownerAppName, startedAtMs: this.now() };
			await this.slot.save(JSON.stringify(request));
			return request;
		});
	}

	/** The open request, or null when none is open or it is older than {@link LINK_REQUEST_TTL_MS}. A slot read that fails throws. */
	current(): Promise<OpenLinkRequest | null> {
		return this.inTurn(() => this.readOpen());
	}

	cancel(): Promise<void> {
		return this.inTurn(() => this.slot.save(NO_OPEN_REQUEST));
	}

	/**
	 * The decoded response when its nonce is the open request's, clearing the request; else throws
	 * {@link UnsolicitedJoinResponseError}. A malformed response throws the codec's error and leaves
	 * the request open; a slot read that fails throws, rather than reading as no request.
	 */
	take(responseText: string): Promise<CadreJoinResponse> {
		return this.inTurn(async () => {
			const response = decodeCadreJoinResponse(responseText);
			const open = await this.readOpen();
			if (!open) {
				throw new UnsolicitedJoinResponseError('This answer is not to a join request this app has open: none is open, it expired, or it was answered already');
			}
			if (open.nonce !== response.nonce) {
				throw new UnsolicitedJoinResponseError('This answer is to a different join request than the one this app has open');
			}
			await this.slot.save(NO_OPEN_REQUEST);
			return response;
		});
	}

	private inTurn<T>(op: () => Promise<T>): Promise<T> {
		const result = this.turn.then(op);
		this.turn = result.catch(() => undefined);
		return result;
	}

	private async readOpen(): Promise<OpenLinkRequest | null> {
		const text = await this.slot.load();
		if (text === undefined || text === NO_OPEN_REQUEST) return null;
		const request = parseOpenLinkRequest(text);
		if (!request) return null;
		return this.now() - request.startedAtMs > LINK_REQUEST_TTL_MS ? null : request;
	}
}

/** The saved record, or null, logged, when it is not one: a record no answer can match is no open request. */
function parseOpenLinkRequest(text: string): OpenLinkRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.warn('[cadre-rn/app-link] the open link request record is not JSON; reading it as none:', err);
		return null;
	}
	const { nonce, ownerAppName, startedAtMs } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
	if (typeof nonce !== 'string' || (ownerAppName !== null && typeof ownerAppName !== 'string') || typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) {
		console.warn('[cadre-rn/app-link] the open link request record has the wrong shape; reading it as none:', text);
		return null;
	}
	return { nonce, ownerAppName, startedAtMs };
}

/** 16 random bytes, base64url: the form a join request's `reply.nonce` takes. */
function newLinkNonce(): string {
	return uint8ArrayToString(globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES)), 'base64url');
}
