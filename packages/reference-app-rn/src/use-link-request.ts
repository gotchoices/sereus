/**
 * use-link-request.ts — the part of the join flow behind Settings → "Join my existing cadre" →
 * "Choose the app that holds your cadre": this app opens an owner app on this phone with its join
 * request, and the owner app opens this one back with the answer (docs/architecture.md → "Between
 * apps on one phone"; docs/reference-app-rn.md → "Joining an Existing Cadre"). An invitation in
 * the answer goes through the join flow's `joinExistingCadre`, as a pasted one does.
 *
 * The answer carries an invitation, which holds its private key: log what became of it, never its text.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { CadreJoinResponse, JoinRefusal, OpenLinkRequest, SereusApp } from '@serfab/cadre-rn/app-link';
import { joinRequestText, linkRequests, ownScheme, UnsolicitedJoinResponseError } from './cadre-phone';
import type { JoinFlow } from './join-flow';
import { openOwnerApp } from './join-link';

/** What became of an answer an owner app opened this app with; Settings words each (`join-link.ts`). */
export type JoinResponseOutcome =
	/** The join ran; its steps show as the join flow. */
	| { kind: 'joined' }
	/** The join did not happen, as `joinExistingCadre` throws. */
	| { kind: 'join-failed'; error: unknown }
	| { kind: 'refused'; refusal: JoinRefusal; appName: string }
	/** A join was on screen, so the answer was not taken and the request stays open. */
	| { kind: 'join-under-way' }
	/** No request is open, it expired, it was answered already, or the nonce differs. */
	| { kind: 'unsolicited' }
	/** The answer did not decode, or the open request could not be read. */
	| { kind: 'unreadable'; error: string };

export interface LinkRequestActions {
	/** The request this app opened as a link and has not taken an answer to; read at launch. Null when none is open. */
	linkRequest: OpenLinkRequest | null;
	/** This app's own request opened this app (picked in Android's chooser); set until the next {@link askOwnerApp}. */
	linkRequestReturned: boolean;
	/**
	 * Open an owner app with this app's join request, carrying the reply that brings the answer
	 * back here: `app` by its scheme (iOS), or whichever app the Android chooser offers (null).
	 * False, with the request cancelled, when the system would not open it. Throws, with the
	 * request cancelled, when the request could not be made (the node-local record, this app's
	 * identity or its scheme could not be read).
	 */
	askOwnerApp: (app: SereusApp | null) => Promise<boolean>;
	/** Stop waiting for an answer: one that arrives later is refused as unsolicited. */
	cancelLinkRequest: () => Promise<void>;
	/** Take the answer an owner app opened this app with, and join with its invitation. Never throws. */
	takeJoinResponse: (text: string) => Promise<JoinResponseOutcome>;
	/** This app's own request opened it: cancel the open request and say so in the section. */
	linkRequestCameBack: () => void;
}

/**
 * `joinFlowRef` is the join flow as of now; `joinExistingCadre` the join flow's, which throws
 * when the join does not happen.
 */
export function useLinkRequest(
	joinFlowRef: RefObject<JoinFlow | null>,
	joinExistingCadre: (encoded: string) => Promise<void>,
): LinkRequestActions {
	const [linkRequest, setLinkRequest] = useState<OpenLinkRequest | null>(null);
	const [linkRequestReturned, setLinkRequestReturned] = useState(false);

	// The store's view, read in its turn, so a cancel or a take queued before this read shows.
	// NOTE: read only at mount and after each action, so a request that passes the store's
	// 30 minutes still shows as waiting until the next read; if that confuses users, re-read on a
	// timer while one is open, or on the app coming to the foreground.
	const showOpenRequest = useCallback(async () => {
		try {
			setLinkRequest(await linkRequests.current());
		} catch (err) {
			// No waiting line then; a take reads the record itself and reports the fault.
			console.warn('[use-link-request] could not read the open link request:', err);
			setLinkRequest(null);
		}
	}, []);

	useEffect(() => {
		void showOpenRequest();
	}, [showOpenRequest]);

	const cancelLinkRequest = useCallback(async () => {
		try {
			await linkRequests.cancel();
		} catch (err) {
			console.warn('[use-link-request] could not cancel the open link request:', err);
		}
		await showOpenRequest();
	}, [showOpenRequest]);

	const askOwnerApp = useCallback(async (app: SereusApp | null) => {
		setLinkRequestReturned(false);
		// A second tap reuses the open request's nonce, so an answer to either tap is taken.
		// NOTE: it keeps the first tap's `ownerAppName` too, so on iOS picking another app the
		// second time leaves the waiting line naming the first; if that is reported, have the
		// kit's `begin` update the name of a request it reuses.
		const request = await linkRequests.begin(app?.name ?? null);
		let opened: boolean;
		try {
			opened = await openOwnerApp(await joinRequestText({ scheme: ownScheme(), nonce: request.nonce }), app);
		} catch (err) {
			await cancelLinkRequest();
			throw err;
		}
		if (!opened) {
			await cancelLinkRequest();
			return false;
		}
		// Read back rather than set: on Android this app may have been picked, and its own
		// request may already have cancelled this one.
		await showOpenRequest();
		return true;
	}, [cancelLinkRequest, showOpenRequest]);

	const takeJoinResponse = useCallback(async (text: string): Promise<JoinResponseOutcome> => {
		if (joinFlowRef.current) return { kind: 'join-under-way' };
		let response: CadreJoinResponse;
		try {
			response = await linkRequests.take(text);
		} catch (err) {
			// A request that expired meanwhile stops showing.
			void showOpenRequest();
			return refusedAnswer(err);
		}
		setLinkRequest(null);
		if ('refused' in response) {
			console.info(`[use-link-request] ${response.appName} answered ${response.refused}`);
			return { kind: 'refused', refusal: response.refused, appName: response.appName };
		}
		console.info(`[use-link-request] ${response.appName} answered with an invitation`);
		try {
			await joinExistingCadre(response.invitation);
			return { kind: 'joined' };
		} catch (err) {
			console.warn('[use-link-request] joining with the answer failed:', err);
			return { kind: 'join-failed', error: err };
		}
	}, [joinFlowRef, joinExistingCadre, showOpenRequest]);

	const linkRequestCameBack = useCallback(() => {
		setLinkRequestReturned(true);
		void cancelLinkRequest();
	}, [cancelLinkRequest]);

	return { linkRequest, linkRequestReturned, askOwnerApp, cancelLinkRequest, takeJoinResponse, linkRequestCameBack };
}

/** Why `LinkRequestStore.take` refused an answer. Only the error's message is logged: a decode error's cause can quote the text. */
function refusedAnswer(err: unknown): JoinResponseOutcome {
	const message = err instanceof Error ? err.message : String(err);
	if (err instanceof UnsolicitedJoinResponseError) {
		console.warn(`[use-link-request] refused an answer: ${message}`);
		return { kind: 'unsolicited' };
	}
	console.warn(`[use-link-request] could not take an answer: ${message}`);
	return { kind: 'unreadable', error: message };
}
