/**
 * The join response: the owner app's answer to a join request that arrived as a link, carried in
 * the link it opens back to the asking app. Either an invitation targeted at the request's peer
 * id or the reason there is none.
 *
 * `sereus-join-response:1.<base64url of canonical JSON>`, the join request's own encoding. The
 * nonce is the request's `reply.nonce`, so the asking app takes only an answer to a request it
 * has open (`LinkRequestStore.take`). Nothing in it is signed: `appName` is what the answering
 * app calls itself, for the asking app's messages only.
 */
import {
	CADRE_INVITATION_PREFIX,
	CADRE_JOIN_REQUEST_MAX_APP_NAME,
	CADRE_JOIN_REQUEST_PREFIX,
	canonicalJson,
} from '@serfab/cadre-core';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';

/** Version 1 of the join response; the only one either side reads. */
export const CADRE_JOIN_RESPONSE_PREFIX = 'sereus-join-response:1.';

/**
 * Why the owner app minted no invitation: the user declined (`denied`), it has no cadre
 * (`no-cadre`), it is not an owner of its cadre (`not-owner`), or the request's peer id is
 * already a member (`already-member`).
 */
export type JoinRefusal = 'denied' | 'no-cadre' | 'not-owner' | 'already-member';

const JOIN_REFUSALS: readonly string[] = ['denied', 'no-cadre', 'not-owner', 'already-member'] satisfies JoinRefusal[];

export type CadreJoinResponse =
	/** `invitation` is an encoded `sereus-invite:1.` text; the asking app's join decodes it fully. */
	| { v: 1; nonce: string; appName: string; invitation: string }
	| { v: 1; nonce: string; appName: string; refused: JoinRefusal };

/** Encode a response as the text the owner app's link carries. Refuses what {@link decodeCadreJoinResponse} would. */
export function encodeCadreJoinResponse(response: CadreJoinResponse): string {
	const json = canonicalJson(requireCadreJoinResponse(response));
	return `${CADRE_JOIN_RESPONSE_PREFIX}${uint8ArrayToString(new TextEncoder().encode(json), 'base64url')}`;
}

/**
 * Decode the text an answering link carried. Refuses, naming the problem: a join request,
 * any prefix but version 1's, a body that is not base64url JSON of the response's shape, an
 * empty nonce, an `appName` that is empty or longer than 64 characters once trimmed, an
 * `invitation` that is not an invitation's text, an unknown refusal, and both or neither of
 * `invitation` and `refused`.
 */
export function decodeCadreJoinResponse(text: string): CadreJoinResponse {
	const trimmed = text.trim();
	if (trimmed.startsWith(CADRE_JOIN_REQUEST_PREFIX)) {
		throw new Error('This is a join request, not the answer to one');
	}
	if (!trimmed.startsWith(CADRE_JOIN_RESPONSE_PREFIX)) {
		throw new Error(`A join response must start with "${CADRE_JOIN_RESPONSE_PREFIX}" (this one starts with "${trimmed.slice(0, CADRE_JOIN_RESPONSE_PREFIX.length)}")`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(uint8ArrayFromString(trimmed.slice(CADRE_JOIN_RESPONSE_PREFIX.length), 'base64url')));
	} catch (error) {
		throw new Error('A join response must carry base64url-encoded JSON after its prefix', { cause: error });
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('A join response must decode to a JSON object');
	}
	const { v, nonce, appName, invitation, refused } = parsed as Record<string, unknown>;
	if (v !== 1) throw new Error(`A join response must be version 1 (this one says ${JSON.stringify(v)})`);
	if (typeof nonce !== 'string') throw new Error('A join response must carry its request\'s nonce');
	if (typeof appName !== 'string') throw new Error('A join response must carry the answering app\'s name');
	if (invitation !== undefined && typeof invitation !== 'string') throw new Error('A join response\'s invitation must be text');
	if (refused !== undefined && typeof refused !== 'string') throw new Error('A join response\'s refusal must be text');
	return requireCadreJoinResponse({ nonce, appName, invitation, refused });
}

/** A response's fields before the shape rules settle which of the two kinds it is. */
interface ResponseFields {
	nonce: string;
	appName: string;
	invitation?: string;
	refused?: string;
}

/** The shape rules both directions apply. Returns the response with its name trimmed. */
function requireCadreJoinResponse(fields: ResponseFields): CadreJoinResponse {
	const { nonce, invitation, refused } = fields;
	if (nonce.length === 0) throw new Error('A join response must carry its request\'s nonce');
	const appName = fields.appName.trim();
	if (appName.length === 0) throw new Error('A join response must name the answering app');
	if (appName.length > CADRE_JOIN_REQUEST_MAX_APP_NAME) {
		throw new Error(`A join response's app name must be at most ${CADRE_JOIN_REQUEST_MAX_APP_NAME} characters (this one has ${appName.length})`);
	}
	if ((invitation === undefined) === (refused === undefined)) {
		throw new Error('A join response must carry exactly one of an invitation and a refusal');
	}
	if (invitation !== undefined) {
		if (!invitation.startsWith(CADRE_INVITATION_PREFIX)) {
			throw new Error(`A join response's invitation must start with "${CADRE_INVITATION_PREFIX}"`);
		}
		return { v: 1, nonce, appName, invitation };
	}
	if (!isJoinRefusal(refused)) {
		throw new Error(`A join response's refusal must be one of ${JOIN_REFUSALS.join(', ')} (this one is ${JSON.stringify(refused)})`);
	}
	return { v: 1, nonce, appName, refused };
}

function isJoinRefusal(value: string | undefined): value is JoinRefusal {
	return value !== undefined && JOIN_REFUSALS.includes(value);
}
