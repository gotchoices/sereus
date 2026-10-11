/**
 * The join request: the text an app that wants to join a cadre copies (or shows as a QR code)
 * so the app that manages the cadre can mint an invitation for it alone
 * (`CadreNode.createCadreInvitation({ peerId: request.peerId, grantsOwner })`).
 *
 * `sereus-join-request:1.<base64url of canonical JSON>` where the JSON is
 * `{ appName, peerId, v }`. Nothing in it is secret or signed: the peer id is public, and the
 * name is only what the requester calls itself, shown in the owner's approval prompt. The
 * safety is in the response: an invitation targeted at that peer id can be redeemed only by
 * the key behind it.
 *
 * Imports only `@libp2p/peer-id` and `uint8arrays`, so it loads on React Native and in the
 * browser.
 */
import { peerIdFromString } from '@libp2p/peer-id';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { canonicalJson } from './canonical-json.js';

/** Version 1 of the join request; the only one either side reads. */
export const CADRE_JOIN_REQUEST_PREFIX = 'sereus-join-request:1.';

/**
 * Version 1 of an encoded cadre invitation (`encodeCadreInvitation`). Declared here, beside
 * the request's prefix, so each decoder can name the other kind of text when it is pasted in
 * the wrong place without this codec importing the redemption protocol.
 */
export const CADRE_INVITATION_PREFIX = 'sereus-invite:1.';

/** Longest `appName` a request carries: one line in an approval prompt. */
export const CADRE_JOIN_REQUEST_MAX_APP_NAME = 64;

export interface CadreJoinRequest {
	v: 1;
	/** The requesting node's peer id: an Ed25519 peer id, since the invitation targets that key. */
	peerId: string;
	/** What the requester calls itself, for the owner's approval prompt. Unverified; at most 64 characters, trimmed, non-empty. */
	appName: string;
}

/** Encode a request as the text the requesting app copies. Refuses what {@link decodeCadreJoinRequest} would. */
export function encodeCadreJoinRequest(request: CadreJoinRequest): string {
	const checked = requireCadreJoinRequest(request);
	const json = canonicalJson({ appName: checked.appName, peerId: checked.peerId, v: checked.v });
	return `${CADRE_JOIN_REQUEST_PREFIX}${uint8ArrayToString(new TextEncoder().encode(json), 'base64url')}`;
}

/**
 * Decode the text the owner's app was given. Refuses, naming the problem: an invitation
 * pasted here, any prefix but version 1's, a body that is not base64url JSON of the request's
 * shape, a peer id that does not parse or is not Ed25519, and an `appName` that is empty or
 * longer than {@link CADRE_JOIN_REQUEST_MAX_APP_NAME} characters once trimmed.
 */
export function decodeCadreJoinRequest(text: string): CadreJoinRequest {
	const trimmed = text.trim();
	if (trimmed.startsWith(CADRE_INVITATION_PREFIX)) {
		throw new Error('This is a cadre invitation, not a join request; paste it where the app asks for an invitation');
	}
	if (!trimmed.startsWith(CADRE_JOIN_REQUEST_PREFIX)) {
		throw new Error(`A join request must start with "${CADRE_JOIN_REQUEST_PREFIX}" (this one starts with "${trimmed.slice(0, CADRE_JOIN_REQUEST_PREFIX.length)}")`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(uint8ArrayFromString(trimmed.slice(CADRE_JOIN_REQUEST_PREFIX.length), 'base64url')));
	} catch (error) {
		throw new Error('A join request must carry base64url-encoded JSON after its prefix', { cause: error });
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('A join request must decode to a JSON object');
	}
	const { v, peerId, appName } = parsed as Record<string, unknown>;
	if (v !== 1) throw new Error(`A join request must be version 1 (this one says ${JSON.stringify(v)})`);
	if (typeof peerId !== 'string') throw new Error('A join request must name the requesting node\'s peer id');
	if (typeof appName !== 'string') throw new Error('A join request must carry the requesting app\'s name');
	return requireCadreJoinRequest({ v, peerId, appName });
}

/** The shape rules both directions apply. Returns the request with its fields trimmed. */
function requireCadreJoinRequest(request: CadreJoinRequest): CadreJoinRequest {
	const peerId = requireEd25519PeerId(request.peerId);
	const appName = request.appName.trim();
	if (appName.length === 0) throw new Error('A join request must name the requesting app');
	if (appName.length > CADRE_JOIN_REQUEST_MAX_APP_NAME) {
		throw new Error(`A join request's app name must be at most ${CADRE_JOIN_REQUEST_MAX_APP_NAME} characters (this one has ${appName.length})`);
	}
	return { v: 1, peerId, appName };
}

/** An invitation targeted at the peer id names its key, so only an Ed25519 id could ever redeem one. */
function requireEd25519PeerId(text: string): string {
	let parsed: ReturnType<typeof peerIdFromString>;
	try {
		parsed = peerIdFromString(text.trim());
	} catch (error) {
		throw new Error(`A join request's peer id does not parse ("${text}")`, { cause: error });
	}
	if (parsed.type !== 'Ed25519') {
		throw new Error(`A join request's peer id must be an Ed25519 peer id (this one is ${parsed.type})`);
	}
	return parsed.toString();
}
