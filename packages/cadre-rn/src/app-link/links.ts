/**
 * The links two Sereus apps on one phone open each other with: the asking app's join request,
 * and the owner app's answer opened back at the asking app's own scheme.
 *
 * - Android: the request text itself (`sereus-join-request:1.…`), which every opted-in Sereus app
 *   registers, so the system app chooser lists every installed owner app.
 * - iOS: `<owner scheme>://cadre-join-request/<request text>`, one owner app chosen by its scheme.
 * - The answer, both platforms: `<reply scheme>://cadre-join-response/<response text>`. The owner
 *   app builds it from the request's `reply.scheme`; it never opens a URL a request supplied.
 */
import { CADRE_JOIN_REQUEST_PREFIX, requireCadreJoinReply } from '@serfab/cadre-core';
import { encodeCadreJoinResponse, type CadreJoinResponse } from './join-response.js';
import type { SereusApp } from './known-apps.js';

/**
 * Longest answering link {@link joinResponseLink} builds. An invitation names at most six machine
 * addresses, which puts a response link at about 4 KB by its shape (not measured); the limit
 * guards against invitations growing past what an intent or a URL reliably carries.
 */
export const CADRE_LINK_MAX_LENGTH = 32_768;

const REQUEST_PATH = 'cadre-join-request';
const RESPONSE_PATH = 'cadre-join-response';

/** `<scheme>://cadre-join-request/<text>` or `…/cadre-join-response/<text>`, for any scheme. */
const SCHEME_LINK = new RegExp(`^[a-z][a-z0-9+.-]*://(${REQUEST_PATH}|${RESPONSE_PATH})/(.+)$`, 'i');

/** What an incoming URL carries: a join request to answer, or the answer to this app's own. */
export type CadreLink = { kind: 'join-request'; text: string } | { kind: 'join-response'; text: string };

/** {@link joinResponseLink} refused to build a link longer than {@link CADRE_LINK_MAX_LENGTH}; show the invitation for copying instead. */
export class CadreLinkTooLongError extends Error {
	constructor(readonly length: number) {
		super(`A join response link of ${length} characters is longer than ${CADRE_LINK_MAX_LENGTH}`);
		this.name = 'CadreLinkTooLongError';
	}
}

/**
 * What an incoming URL is, or null for anything else, a node code (`sereus-join:1.…`) and an
 * invitation included, so an app's other link routing is untouched. Recognizes only the forms
 * this module builds, under any scheme (a second install of an app has a scheme of its own).
 * Returns the text undecoded: decoding, and refusing, is the caller's step.
 */
export function parseCadreLink(url: string): CadreLink | null {
	const trimmed = url.trim();
	if (trimmed.startsWith(CADRE_JOIN_REQUEST_PREFIX)) return { kind: 'join-request', text: trimmed };
	const match = SCHEME_LINK.exec(trimmed);
	if (!match) return null;
	const [, path, text] = match;
	return { kind: path.toLowerCase() === REQUEST_PATH ? 'join-request' : 'join-response', text };
}

/** Android (`ownerApp` null): the request text itself. iOS: `<ownerApp.scheme>://cadre-join-request/<text>`. */
export function joinRequestLink(requestText: string, ownerApp: SereusApp | null): string {
	return ownerApp ? `${ownerApp.scheme}://${REQUEST_PATH}/${requestText}` : requestText;
}

/**
 * `<reply.scheme>://cadre-join-response/<response text>`. Checks the scheme and the nonce again
 * (a web or system scheme throws), and throws {@link CadreLinkTooLongError} above
 * {@link CADRE_LINK_MAX_LENGTH}.
 */
export function joinResponseLink(reply: { scheme: string }, response: CadreJoinResponse): string {
	const { scheme } = requireCadreJoinReply({ scheme: reply.scheme, nonce: response.nonce });
	const link = `${scheme}://${RESPONSE_PATH}/${encodeCadreJoinResponse(response)}`;
	if (link.length > CADRE_LINK_MAX_LENGTH) throw new CadreLinkTooLongError(link.length);
	return link;
}
