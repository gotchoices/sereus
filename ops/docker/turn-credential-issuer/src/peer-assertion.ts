/**
 * peer-assertion — verify that the caller of `/ice-servers.json` controls a known
 * libp2p node identity, so a minted TURN credential can be *attributed* to a peer
 * id instead of to nobody.
 *
 * The client signs a short, domain-separated statement with its libp2p Ed25519
 * identity key and presents it in five request headers. This module parses those
 * headers, derives the peer id from the presented public key (it never trusts a
 * client-supplied peer id), rebuilds the signed message with the *derived* id and
 * checks the signature, the acceptance window, the audience binding, and a replay
 * cache.
 *
 * Wire format (normative — mirrored by the client signers):
 *
 *   X-Sereus-Peer-Key    base64url of the libp2p protobuf-encoded Ed25519 public key
 *   X-Sereus-Peer-Aud    the audience string the client signed
 *   X-Sereus-Peer-Ts     issued-at, unix seconds, decimal digits
 *   X-Sereus-Peer-Nonce  exactly 32 lowercase hex chars (16 random bytes)
 *   X-Sereus-Peer-Sig    base64url Ed25519 signature over the signed message
 *
 * The signed message is the UTF-8 bytes of exactly five LF-separated lines, no
 * trailing newline:
 *
 *   sereus.turn-issuer.v1
 *   <audience>
 *   <peerId>
 *   <issuedAtUnixSeconds>
 *   <nonce>
 *
 * The encoding is injective because no field can contain an LF: the peer id is
 * base58btc, the timestamp is digits, the nonce is hex, and an audience carrying
 * anything outside printable ASCII is rejected before it is used.
 *
 * See `README.md` → "Peer-bound issuance" and `ops/docs/ice-servers.md`.
 */
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';

import type { PublicKey } from '@libp2p/interface';
import type { IncomingHttpHeaders } from 'node:http';

// --- Wire constants ---------------------------------------------------------

/** Domain separation tag. Bump the version if any line's meaning changes. */
const ASSERTION_DOMAIN = 'sereus.turn-issuer.v1';

/** Lowercase header names — Node lowercases incoming header keys. */
const HEADER_KEY = 'x-sereus-peer-key';
const HEADER_AUDIENCE = 'x-sereus-peer-aud';
const HEADER_TIMESTAMP = 'x-sereus-peer-ts';
const HEADER_NONCE = 'x-sereus-peer-nonce';
const HEADER_SIGNATURE = 'x-sereus-peer-sig';

/** All five, in wire-doc order. All-or-nothing: a partial set is malformed. */
const PEER_HEADER_NAMES = [HEADER_KEY, HEADER_AUDIENCE, HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE] as const;

/** The same names, canonically cased, for `Access-Control-Allow-Headers`. */
const PEER_HEADER_NAMES_CANONICAL = [
	'X-Sereus-Peer-Key',
	'X-Sereus-Peer-Aud',
	'X-Sereus-Peer-Ts',
	'X-Sereus-Peer-Nonce',
	'X-Sereus-Peer-Sig',
] as const;

// Length caps, enforced BEFORE decoding or logging so one request cannot become a
// megabyte log line. Generous vs. the real sizes: a protobuf Ed25519 public key is
// 48 base64url chars and an Ed25519 signature is 86.
const MAX_KEY_CHARS = 128;
const MAX_AUDIENCE_CHARS = 512;
const MAX_TIMESTAMP_CHARS = 12;
const NONCE_CHARS = 32;
const MAX_SIGNATURE_CHARS = 128;

/** Ed25519 signatures are always exactly 64 bytes. */
const ED25519_SIGNATURE_BYTES = 64;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const DIGITS_RE = /^[0-9]+$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
/** Printable ASCII only — this is what makes CR/LF (and every other control char) impossible in the audience line. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;

// --- Types ------------------------------------------------------------------

/** A syntactically well-formed assertion. Nothing here is trusted yet. */
interface RawPeerAssertion {
	publicKeyB64: string;
	audience: string;
	issuedAtSec: number;
	nonce: string;
	signatureB64: string;
}

type ParsedPeerAssertion =
	| { kind: 'absent' }
	| { kind: 'malformed'; reason: string }
	| { kind: 'present'; assertion: RawPeerAssertion };

/**
 * What verification itself can conclude. `overloaded` exists because a full replay
 * cache must fail closed (503) rather than accept an unrecorded nonce — silently
 * dropping replay protection exactly when the service is under pressure.
 */
type PeerAssertionVerdict =
	| { kind: 'invalid'; reason: string }
	| { kind: 'overloaded'; reason: string }
	| { kind: 'verified'; peerId: string };

/**
 * The full outcome space for a request, parse and verification together — the set
 * `main.ts` maps to HTTP statuses in one place.
 */
type PeerAssertionOutcome = { kind: 'absent' } | { kind: 'malformed'; reason: string } | PeerAssertionVerdict;

interface PeerAssertionMessageFields {
	audience: string;
	peerId: string;
	issuedAtSec: number;
	nonce: string;
}

interface VerifyPeerAssertionOptions {
	assertion: RawPeerAssertion;
	/** Exact audience the issuer requires. Empty string disables audience binding. */
	expectedAudience: string;
	skewSeconds: number;
	nowSec: number;
	nowMs: number;
	replay: ReplayCache;
}

// --- Header parsing ---------------------------------------------------------

/** `present` distinguishes "absent" from "present but ambiguous" (duplicate header lines). */
interface HeaderRead {
	present: boolean;
	value?: string;
}

function readSingleHeader(headers: IncomingHttpHeaders, name: string): HeaderRead {
	const raw = headers[name];
	if (raw === undefined) return { present: false };
	// Node only returns an array for headers it refuses to join (e.g. set-cookie),
	// but treat any array as ambiguous rather than guessing which copy was signed.
	if (Array.isArray(raw)) return { present: true };
	return { present: true, value: raw };
}

function malformed(reason: string): ParsedPeerAssertion {
	return { kind: 'malformed', reason };
}

/** Cap-then-shape check for one field. Returns an error reason, or undefined when valid. */
function checkField(value: string, maxChars: number, pattern: RegExp, label: string): string | undefined {
	if (value.length === 0) return `${label}_empty`;
	if (value.length > maxChars) return `${label}_too_long`;
	if (!pattern.test(value)) return `${label}_charset`;
	return undefined;
}

/**
 * Headers → typed struct, or a typed rejection reason. All five headers absent is
 * `absent` (an unauthenticated caller); anything in between is `malformed`, because
 * a half-configured client must be loud rather than silently downgraded.
 */
export function parsePeerAssertion(headers: IncomingHttpHeaders): ParsedPeerAssertion {
	const reads = PEER_HEADER_NAMES.map((name) => readSingleHeader(headers, name));
	const presentCount = reads.filter((r) => r.present).length;
	if (presentCount === 0) return { kind: 'absent' };
	if (presentCount < reads.length) return malformed('incomplete_headers');
	if (reads.some((r) => r.value === undefined)) return malformed('duplicate_header');

	const [publicKeyB64, audience, timestamp, nonce, signatureB64] = reads.map((r) => r.value as string);

	const fieldError =
		checkField(publicKeyB64, MAX_KEY_CHARS, BASE64URL_RE, 'key') ??
		checkField(audience, MAX_AUDIENCE_CHARS, PRINTABLE_ASCII_RE, 'audience') ??
		checkField(timestamp, MAX_TIMESTAMP_CHARS, DIGITS_RE, 'timestamp') ??
		checkField(nonce, NONCE_CHARS, NONCE_RE, 'nonce') ??
		checkField(signatureB64, MAX_SIGNATURE_CHARS, BASE64URL_RE, 'signature');
	if (fieldError !== undefined) return malformed(fieldError);

	const issuedAtSec = Number.parseInt(timestamp, 10);
	if (!Number.isSafeInteger(issuedAtSec)) return malformed('timestamp_range');

	return { kind: 'present', assertion: { publicKeyB64, audience, issuedAtSec, nonce, signatureB64 } };
}

// --- Signed message ---------------------------------------------------------

/**
 * Build the exact bytes the client signs. The issuer always rebuilds this with the
 * peer id it *derived* from the presented public key, so a client that lies about
 * its peer id simply fails signature verification.
 */
export function peerAssertionMessage(fields: PeerAssertionMessageFields): string {
	return [ASSERTION_DOMAIN, fields.audience, fields.peerId, String(fields.issuedAtSec), fields.nonce].join('\n');
}

// --- Replay cache -----------------------------------------------------------

/**
 * Remembers `(peerId, nonce)` pairs for the whole acceptance window, so a captured
 * assertion cannot be replayed within it. Retention is 2x the skew bound because an
 * assertion stays inside `|now - issuedAt| <= skew` for at most that long.
 *
 * Per-process, like the rate limiters: two replicas each admit a given replay once.
 * Bounded by the per-peer limit and coturn's quotas — see README.
 */
export class ReplayCache {
	private readonly seen = new Map<string, number>();

	constructor(private readonly maxEntries: number) {}

	private static cacheKey(peerId: string, nonce: string): string {
		// Unambiguous: a peer id is base58btc and a nonce is hex, so neither can contain `|`.
		return `${peerId}|${nonce}`;
	}

	get size(): number {
		return this.seen.size;
	}

	/** True when no further nonce can be recorded — callers must fail closed, not accept. */
	isFull(): boolean {
		return this.seen.size >= this.maxEntries;
	}

	has(peerId: string, nonce: string, nowMs: number): boolean {
		const key = ReplayCache.cacheKey(peerId, nonce);
		const expiresAtMs = this.seen.get(key);
		if (expiresAtMs === undefined) return false;
		if (expiresAtMs <= nowMs) {
			this.seen.delete(key);
			return false;
		}
		return true;
	}

	/** Record a nonce as spent. Returns false when the cap is reached (caller must reject). */
	record(peerId: string, nonce: string, expiresAtMs: number): boolean {
		if (this.isFull()) return false;
		this.seen.set(ReplayCache.cacheKey(peerId, nonce), expiresAtMs);
		return true;
	}

	/** Drop entries past their retention so the Map can't grow unbounded. */
	evictExpired(nowMs: number): void {
		for (const [key, expiresAtMs] of this.seen) {
			if (expiresAtMs <= nowMs) this.seen.delete(key);
		}
	}
}

// --- Verification -----------------------------------------------------------

function invalid(reason: string): PeerAssertionVerdict {
	return { kind: 'invalid', reason };
}

function decodeBase64Url(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** Decode the presented key. Garbage bytes throw inside libp2p — never let that escape the handler. */
function decodePublicKey(publicKeyB64: string): PublicKey | undefined {
	try {
		return publicKeyFromProtobuf(decodeBase64Url(publicKeyB64));
	} catch {
		return undefined;
	}
}

async function signatureVerifies(publicKey: PublicKey, message: string, signature: Uint8Array): Promise<boolean> {
	try {
		return await publicKey.verify(new TextEncoder().encode(message), signature);
	} catch {
		// A malformed signature makes the underlying primitive throw; that is a
		// verification failure, not a server fault.
		return false;
	}
}

/**
 * Decode key → derive peer id → check type, skew, replay, audience → rebuild the
 * message with the derived peer id and verify the signature.
 *
 * The nonce is *checked* before the (comparatively expensive) signature check but
 * only *recorded* after it succeeds, so a caller who cannot produce a valid
 * signature can neither burn a nonce nor pollute the cache.
 */
export async function verifyPeerAssertion(options: VerifyPeerAssertionOptions): Promise<PeerAssertionVerdict> {
	const { assertion, expectedAudience, skewSeconds, nowSec, nowMs, replay } = options;

	const publicKey = decodePublicKey(assertion.publicKeyB64);
	if (!publicKey) return invalid('key_decode_failed');
	if (publicKey.type !== 'Ed25519') return invalid('key_type_unsupported');

	const peerId = publicKey.toString();

	if (Math.abs(nowSec - assertion.issuedAtSec) > skewSeconds) return invalid('timestamp_skew');

	if (replay.isFull()) {
		return { kind: 'overloaded', reason: 'replay_cache_full' };
	}
	if (replay.has(peerId, assertion.nonce, nowMs)) return invalid('replayed_nonce');

	if (expectedAudience.length > 0 && assertion.audience !== expectedAudience) return invalid('audience_mismatch');

	const signature = decodeBase64Url(assertion.signatureB64);
	if (signature.length !== ED25519_SIGNATURE_BYTES) return invalid('signature_length');

	const message = peerAssertionMessage({
		audience: assertion.audience,
		peerId,
		issuedAtSec: assertion.issuedAtSec,
		nonce: assertion.nonce,
	});
	if (!(await signatureVerifies(publicKey, message, signature))) return invalid('signature_invalid');

	if (!replay.record(peerId, assertion.nonce, nowMs + skewSeconds * 2 * 1000)) {
		return { kind: 'overloaded', reason: 'replay_cache_full' };
	}

	return { kind: 'verified', peerId };
}

export {
	ASSERTION_DOMAIN,
	PEER_HEADER_NAMES,
	PEER_HEADER_NAMES_CANONICAL,
	HEADER_KEY,
	HEADER_AUDIENCE,
	HEADER_TIMESTAMP,
	HEADER_NONCE,
	HEADER_SIGNATURE,
};
export type {
	RawPeerAssertion,
	ParsedPeerAssertion,
	PeerAssertionVerdict,
	PeerAssertionOutcome,
	PeerAssertionMessageFields,
	VerifyPeerAssertionOptions,
};
