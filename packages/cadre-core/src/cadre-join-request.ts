/**
 * The join request: the text an app that wants to join a cadre copies (or shows as a QR code)
 * so the app that manages the cadre can mint an invitation for it alone
 * (`CadreNode.createCadreInvitation({ peerId: request.peerId, grantsOwner })`).
 *
 * `sereus-join-request:1.<base64url of canonical JSON>` where the JSON is
 * `{ appName, peerId, reply?, v }`. Nothing in it is secret or signed: the peer id is public, and
 * the name is only what the requester calls itself, shown in the owner's approval prompt. The
 * safety is in the response: an invitation targeted at that peer id can be redeemed only by
 * the key behind it.
 *
 * `reply` is present only on a request opened as a link from another app on the same phone
 * (`@serfab/cadre-rn/app-link`): the owner app answers by opening `<reply.scheme>://…`, a link it
 * builds itself, so the scheme is restricted to an app's own custom scheme and never a web or
 * system one, which would send the invitation's machine addresses off the phone.
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

/**
 * What every owner-key export begins with, plain or passphrase-locked, any version
 * (`owner-key-export.ts`). Declared here for the reason {@link CADRE_INVITATION_PREFIX} is: the
 * invitation and join-request decoders refuse an owner key by name, so a private key pasted into
 * the wrong field is never sent to a member.
 */
export const OWNER_KEY_EXPORT_STEM = 'sereus-owner-key';

/**
 * Version 1 of an encoded owner grant (`encodeOwnerGrant` in `owner-grant-protocol.ts`). Declared
 * here for the same reason: whoever holds a grant can become an owner, so one pasted where an
 * invitation, a join request or an owner key belongs is refused by name, never sent to a member.
 */
export const OWNER_GRANT_PREFIX = 'sereus-owner-grant:1.';

/** Longest `appName` a request carries: one line in an approval prompt. */
export const CADRE_JOIN_REQUEST_MAX_APP_NAME = 64;

/**
 * Schemes a reply may not name, though they match {@link CADRE_JOIN_REPLY_SCHEME}: each opens a
 * web page, a file, a system action or another app's content rather than a Sereus app.
 */
const REFUSED_REPLY_SCHEMES: ReadonlySet<string> = new Set([
	'http', 'https', 'ws', 'wss', 'ftp', 'file', 'content', 'data', 'blob',
	'javascript', 'about', 'intent', 'mailto', 'tel', 'sms',
]);

/**
 * The form of a reply's scheme: lowercase, as an app's custom URL scheme is declared.
 * NOTE: `@serfab/cadre-rn`'s CommonJS config plugin keeps a copy (`APP_SCHEME`) to check extra
 * apps' schemes; change it with this one.
 */
const CADRE_JOIN_REPLY_SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/;

/** The form of a reply's nonce: base64url, long enough that it cannot be guessed. */
const CADRE_JOIN_REPLY_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** Where and how the owner app answers a request that arrived as a link. */
export interface CadreJoinReply {
	/** The requesting app's own custom URL scheme; the owner app opens `<scheme>://cadre-join-response/<response>`. */
	scheme: string;
	/** Echoed in the response, so the requesting app takes only an answer to a request it has open. */
	nonce: string;
}

export interface CadreJoinRequest {
	v: 1;
	/** The requesting node's peer id: an Ed25519 peer id, since the invitation targets that key. */
	peerId: string;
	/** What the requester calls itself, for the owner's approval prompt. Unverified; at most 64 characters, trimmed, non-empty. */
	appName: string;
	/** Present only on a request opened as a link: where and how the owner app answers. */
	reply?: CadreJoinReply;
}

/** Encode a request as the text the requesting app copies. Refuses what {@link decodeCadreJoinRequest} would. */
export function encodeCadreJoinRequest(request: CadreJoinRequest): string {
	const checked = requireCadreJoinRequest(request);
	// canonicalJson drops an undefined `reply`, so a request without one encodes as it always has.
	const json = canonicalJson({ appName: checked.appName, peerId: checked.peerId, reply: checked.reply, v: checked.v });
	return `${CADRE_JOIN_REQUEST_PREFIX}${uint8ArrayToString(new TextEncoder().encode(json), 'base64url')}`;
}

/**
 * Decode the text the owner's app was given. Refuses, naming the problem: an owner key, an owner
 * grant or an invitation pasted here, any prefix but version 1's, a body that is not base64url JSON of the request's
 * shape, a peer id that does not parse or is not Ed25519, an `appName` that is empty or
 * longer than {@link CADRE_JOIN_REQUEST_MAX_APP_NAME} characters once trimmed, and a `reply`
 * that {@link requireCadreJoinReply} refuses.
 */
export function decodeCadreJoinRequest(text: string): CadreJoinRequest {
	const trimmed = text.trim();
	if (trimmed.startsWith(OWNER_KEY_EXPORT_STEM)) {
		throw new Error('This is an owner key, not a join request; it is private, so import it only where the app asks for an owner key');
	}
	if (trimmed.startsWith(OWNER_GRANT_PREFIX)) {
		throw new Error('This is an owner grant, not a join request; paste it where the app asks for an owner grant');
	}
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
	const { v, peerId, appName, reply } = parsed as Record<string, unknown>;
	if (v !== 1) throw new Error(`A join request must be version 1 (this one says ${JSON.stringify(v)})`);
	if (typeof peerId !== 'string') throw new Error('A join request must name the requesting node\'s peer id');
	if (typeof appName !== 'string') throw new Error('A join request must carry the requesting app\'s name');
	return requireCadreJoinRequest({ v, peerId, appName, ...(reply === undefined ? {} : { reply: replyShape(reply) }) });
}

/**
 * Refuses, naming the problem, a reply whose scheme is not a lowercase URL scheme of at most 64
 * characters or is a web or system scheme (`https`, `file`, `intent`, …), and a nonce that is
 * not 16 to 64 base64url characters. The owner app checks it again before it opens a reply.
 */
export function requireCadreJoinReply(reply: CadreJoinReply): CadreJoinReply {
	const { scheme, nonce } = reply;
	if (!CADRE_JOIN_REPLY_SCHEME.test(scheme)) {
		throw new Error(`A join request's reply scheme must be a lowercase URL scheme of at most 64 characters (this one is ${JSON.stringify(scheme)})`);
	}
	if (REFUSED_REPLY_SCHEMES.has(scheme)) {
		throw new Error(`A join request's reply scheme must be an app's own scheme, not "${scheme}"`);
	}
	if (!CADRE_JOIN_REPLY_NONCE.test(nonce)) {
		throw new Error('A join request\'s reply nonce must be 16 to 64 base64url characters');
	}
	return { scheme, nonce };
}

/** The decoded `reply`'s types, before {@link requireCadreJoinReply} judges its values. */
function replyShape(reply: unknown): CadreJoinReply {
	if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
		throw new Error('A join request\'s reply must be an object');
	}
	const { scheme, nonce } = reply as Record<string, unknown>;
	if (typeof scheme !== 'string' || typeof nonce !== 'string') {
		throw new Error('A join request\'s reply must carry a scheme and a nonce');
	}
	return { scheme, nonce };
}

/** The shape rules both directions apply. Returns the request with its fields trimmed. */
function requireCadreJoinRequest(request: CadreJoinRequest): CadreJoinRequest {
	const peerId = requireEd25519PeerId(request.peerId);
	const appName = request.appName.trim();
	if (appName.length === 0) throw new Error('A join request must name the requesting app');
	if (appName.length > CADRE_JOIN_REQUEST_MAX_APP_NAME) {
		throw new Error(`A join request's app name must be at most ${CADRE_JOIN_REQUEST_MAX_APP_NAME} characters (this one has ${appName.length})`);
	}
	return { v: 1, peerId, appName, ...(request.reply ? { reply: requireCadreJoinReply(request.reply) } : {}) };
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
