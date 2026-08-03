/**
 * self-test — network-free, agent-runnable checks for the issuer's peer-bound
 * issuance path. Run with `npm run selftest` (builds, then `node dist/self-test.js`).
 *
 * Two things are locked here:
 *
 *  1. **The wire format**, against a pinned test vector derived from a fixed seed.
 *     The client signers (`ice-config-peer-assertion-client`) pin the SAME values,
 *     so any drift on either side fails a test rather than silently failing to
 *     authenticate in production.
 *
 *  2. **The admission ladder** — every row of the README's admission table drives
 *     `decideIceServers` directly (no socket) and asserts its documented HTTP
 *     status, `peerAuth` value, and coturn `<id>` label.
 *
 * Sibling: `ops/test/check-turn-creds.mjs --self-test` mirrors (rather than
 * imports) the credential scheme from the operator-tooling side.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateKeyPair, generateKeyPairFromSeed, publicKeyToProtobuf } from '@libp2p/crypto/keys';

import {
	decideIceServers,
	fatalConfigError,
	mintTurnCredential,
	FixedWindowRateLimiter,
	RATE_LIMIT_WINDOW_MS,
	type AdmissionResult,
	type IceConfigManifest,
	type IssuerConfig,
	type PeerAuthMode,
	type RequestContext,
} from './main.js';
import {
	HEADER_AUDIENCE,
	HEADER_KEY,
	HEADER_NONCE,
	HEADER_SIGNATURE,
	HEADER_TIMESTAMP,
	ReplayCache,
	parsePeerAssertion,
	peerAssertionMessage,
	verifyPeerAssertion,
} from './peer-assertion.js';

import type { RawPeerAssertion } from './peer-assertion.js';
import type { PrivateKey } from '@libp2p/interface';
import type { IncomingHttpHeaders } from 'node:http';

// --- Pinned vector ----------------------------------------------------------
// Recomputed independently by anyone implementing a client. If any of these change,
// the wire format changed and the domain tag must be bumped.

const PINNED = {
	seedByte: 0x01,
	peerId: '12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5',
	publicKeyB64: 'CAESIIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29c',
	audience: 'https://issuer.example/ice-servers.json',
	issuedAt: 1735689600,
	nonce: '00112233445566778899aabbccddeeff',
	message:
		'sereus.turn-issuer.v1\nhttps://issuer.example/ice-servers.json\n' +
		'12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5\n1735689600\n00112233445566778899aabbccddeeff',
	signatureB64:
		'6jvguqhDOhK9ZahdAYb3aYnzz1dJaJBJtVCFcLCWMwCdupTUClWMJzXoS7yujjr7V3XA-htohz-VCl8GQQFcDg',
	/** `CRED_TTL_SECONDS=300` → expiry 1735689900, `<expiry>:<peerId>`. */
	credentialUsername: '1735689900:12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5',
} as const;

const TURN_SECRET = 'test-secret-do-not-use';
const STUN_URL = 'stun:stun.sereus.org:3478';
const TURN_URL = 'turn:turn.sereus.org:3478?transport=udp';
const SKEW_SECONDS = 60;

function seededKey(byte: number): Promise<PrivateKey> {
	return generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(byte));
}

const pinnedKey = await seededKey(PINNED.seedByte);
const otherKey = await seededKey(0x02);

// --- Assertion construction (mirrors what a client signer does) --------------

interface AssertionFields {
	audience: string;
	issuedAtSec: number;
	nonce: string;
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

async function signHeaders(key: PrivateKey, fields: AssertionFields): Promise<IncomingHttpHeaders> {
	const peerId = key.publicKey.toString();
	const message = peerAssertionMessage({ ...fields, peerId });
	const signature = await key.sign(new TextEncoder().encode(message));
	return {
		[HEADER_KEY]: base64Url(publicKeyToProtobuf(key.publicKey)),
		[HEADER_AUDIENCE]: fields.audience,
		[HEADER_TIMESTAMP]: String(fields.issuedAtSec),
		[HEADER_NONCE]: fields.nonce,
		[HEADER_SIGNATURE]: base64Url(signature),
	};
}

const PINNED_FIELDS: AssertionFields = {
	audience: PINNED.audience,
	issuedAtSec: PINNED.issuedAt,
	nonce: PINNED.nonce,
};

/** Reparse headers back into the struct `verifyPeerAssertion` consumes. */
function requirePresent(headers: IncomingHttpHeaders): RawPeerAssertion {
	const parsed = parsePeerAssertion(headers);
	assert.equal(parsed.kind, 'present', `expected well-formed headers, got ${parsed.kind}`);
	if (parsed.kind !== 'present') throw new Error('unreachable');
	return parsed.assertion;
}

interface VerifyOverrides {
	expectedAudience?: string;
	skewSeconds?: number;
	nowSec?: number;
	replay?: ReplayCache;
}

function verify(headers: IncomingHttpHeaders, overrides: VerifyOverrides = {}) {
	const nowSec = overrides.nowSec ?? PINNED.issuedAt;
	return verifyPeerAssertion({
		assertion: requirePresent(headers),
		expectedAudience: overrides.expectedAudience ?? PINNED.audience,
		skewSeconds: overrides.skewSeconds ?? SKEW_SECONDS,
		nowSec,
		nowMs: nowSec * 1000,
		replay: overrides.replay ?? new ReplayCache(1000),
	});
}

// --- Test config / context --------------------------------------------------

function baseConfig(overrides: Partial<IssuerConfig> = {}): IssuerConfig {
	return {
		port: 8080,
		stunUrls: [STUN_URL],
		turnEnabled: true,
		turnPolicy: 'gated',
		turnSecret: TURN_SECRET,
		turnUrls: [TURN_URL],
		credTtlSeconds: 300,
		credId: 'web',
		authToken: '',
		rateLimitPerMin: 30,
		trustProxy: false,
		corsAllowOrigin: '*',
		peerAuthMode: 'off',
		peerAuthAudience: PINNED.audience,
		peerAuthSkewSeconds: SKEW_SECONDS,
		peerAllowList: [],
		peerDenyList: [],
		rateLimitPerPeerPerMin: 10,
		replayCacheMax: 50_000,
		...overrides,
	};
}

function makeContext(config: IssuerConfig, replay = new ReplayCache(config.replayCacheMax)): RequestContext {
	return {
		config,
		ipLimiter: new FixedWindowRateLimiter(config.rateLimitPerMin, RATE_LIMIT_WINDOW_MS),
		peerLimiter: new FixedWindowRateLimiter(config.rateLimitPerPeerPerMin, RATE_LIMIT_WINDOW_MS),
		replay,
		nowMs: () => PINNED.issuedAt * 1000,
		nowSec: () => PINNED.issuedAt,
	};
}

function admit(ctx: RequestContext, headers: IncomingHttpHeaders = {}): Promise<AdmissionResult> {
	return decideIceServers({ ip: '198.51.100.7', headers }, ctx);
}

function manifestOf(result: AdmissionResult): IceConfigManifest {
	assert.equal(result.status, 200, `expected a 200 manifest, got ${result.status}`);
	return result.body as IceConfigManifest;
}

function turnEntry(manifest: IceConfigManifest) {
	return manifest.iceServers.find((entry) => entry.urls.some((u) => u.startsWith('turn:')));
}

function stunEntry(manifest: IceConfigManifest) {
	return manifest.iceServers.find((entry) => entry.urls.some((u) => u.startsWith('stun:')));
}

// --- Wire format ------------------------------------------------------------

void test('pinned vector: derived peer id and encoded public key match', () => {
	assert.equal(pinnedKey.publicKey.toString(), PINNED.peerId);
	assert.equal(base64Url(publicKeyToProtobuf(pinnedKey.publicKey)), PINNED.publicKeyB64);
	assert.equal(PINNED.publicKeyB64.length, 48);
});

void test('pinned vector: signed message is the exact five LF-separated lines', () => {
	const message = peerAssertionMessage({ ...PINNED_FIELDS, peerId: PINNED.peerId });
	assert.equal(message, PINNED.message);
	assert.equal(message.split('\n').length, 5);
	assert.ok(!message.endsWith('\n'), 'no trailing newline');
});

void test('pinned vector: the pinned signature verifies', async () => {
	const headers = {
		[HEADER_KEY]: PINNED.publicKeyB64,
		[HEADER_AUDIENCE]: PINNED.audience,
		[HEADER_TIMESTAMP]: String(PINNED.issuedAt),
		[HEADER_NONCE]: PINNED.nonce,
		[HEADER_SIGNATURE]: PINNED.signatureB64,
	};
	assert.deepEqual(await verify(headers), { kind: 'verified', peerId: PINNED.peerId });
});

void test('pinned vector: a freshly signed assertion reproduces the pinned signature', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	assert.equal(headers[HEADER_SIGNATURE], PINNED.signatureB64);
});

void test('peer id survives mintTurnCredential sanitization byte-for-byte', () => {
	const cred = mintTurnCredential(TURN_SECRET, PINNED.peerId, 300, PINNED.issuedAt);
	assert.equal(cred.username, PINNED.credentialUsername);
	assert.equal(cred.username.split(':')[1], PINNED.peerId, 'a mangled id would silently break attribution');
	assert.equal(cred.username.split(':').length, 2);
});

// --- Verification failures ---------------------------------------------------

void test('a flipped signature bit fails', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	const bytes = Buffer.from(headers[HEADER_SIGNATURE] as string, 'base64url');
	bytes[0] ^= 0x01;
	headers[HEADER_SIGNATURE] = bytes.toString('base64url');
	assert.deepEqual(await verify(headers), { kind: 'invalid', reason: 'signature_invalid' });
});

void test('a tampered audience fails', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	headers[HEADER_AUDIENCE] = 'https://evil.example/ice-servers.json';
	// Audience binding configured → caught before the signature is even checked.
	assert.deepEqual(await verify(headers), { kind: 'invalid', reason: 'audience_mismatch' });
	// Binding disabled → still caught, because the signature covers the audience line.
	assert.deepEqual(await verify(headers, { expectedAudience: '' }), { kind: 'invalid', reason: 'signature_invalid' });
});

void test('a claimed peer id cannot be swapped for another key', async () => {
	// The issuer derives the peer id from the presented key, so presenting someone
	// else's key against your own signature simply fails verification.
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	headers[HEADER_KEY] = base64Url(publicKeyToProtobuf(otherKey.publicKey));
	assert.deepEqual(await verify(headers), { kind: 'invalid', reason: 'signature_invalid' });
});

void test('the skew bound is inclusive on both sides and exclusive one second past', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	for (const offset of [-SKEW_SECONDS, 0, SKEW_SECONDS]) {
		const outcome = await verify(headers, { nowSec: PINNED.issuedAt + offset });
		assert.equal(outcome.kind, 'verified', `offset ${offset}s should be inside the window`);
	}
	for (const offset of [-(SKEW_SECONDS + 1), SKEW_SECONDS + 1]) {
		assert.deepEqual(await verify(headers, { nowSec: PINNED.issuedAt + offset }), {
			kind: 'invalid',
			reason: 'timestamp_skew',
		});
	}
});

void test('a replayed (peerId, nonce) fails; the same nonce under another peer id passes', async () => {
	const replay = new ReplayCache(1000);
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	assert.deepEqual(await verify(headers, { replay }), { kind: 'verified', peerId: PINNED.peerId });
	assert.deepEqual(await verify(headers, { replay }), { kind: 'invalid', reason: 'replayed_nonce' });

	const otherHeaders = await signHeaders(otherKey, PINNED_FIELDS);
	const outcome = await verify(otherHeaders, { replay });
	assert.equal(outcome.kind, 'verified', 'the nonce is only spent for the peer that used it');
});

void test('an invalid signature does not burn the nonce', async () => {
	const replay = new ReplayCache(1000);
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	const good = headers[HEADER_SIGNATURE] as string;
	const bytes = Buffer.from(good, 'base64url');
	bytes[0] ^= 0x01;
	headers[HEADER_SIGNATURE] = bytes.toString('base64url');
	assert.deepEqual(await verify(headers, { replay }), { kind: 'invalid', reason: 'signature_invalid' });
	assert.equal(replay.size, 0, 'a forged assertion must not pollute the replay cache');

	headers[HEADER_SIGNATURE] = good;
	assert.deepEqual(await verify(headers, { replay }), { kind: 'verified', peerId: PINNED.peerId });
});

void test('a full replay cache fails closed rather than skipping replay protection', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	assert.deepEqual(await verify(headers, { replay: new ReplayCache(0) }), {
		kind: 'overloaded',
		reason: 'replay_cache_full',
	});
});

void test('the replay cache evicts entries past their retention', async () => {
	const replay = new ReplayCache(1000);
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	await verify(headers, { replay });
	assert.equal(replay.size, 1);
	// Retention is 2x the skew bound — the whole acceptance window.
	replay.evictExpired(PINNED.issuedAt * 1000 + SKEW_SECONDS * 2 * 1000 - 1);
	assert.equal(replay.size, 1, 'still inside the acceptance window');
	replay.evictExpired(PINNED.issuedAt * 1000 + SKEW_SECONDS * 2 * 1000);
	assert.equal(replay.size, 0);
});

void test('a non-Ed25519 key type is rejected', async () => {
	const secpKey = await generateKeyPair('secp256k1');
	const peerId = secpKey.publicKey.toString();
	const message = peerAssertionMessage({ ...PINNED_FIELDS, peerId });
	const headers: IncomingHttpHeaders = {
		[HEADER_KEY]: base64Url(publicKeyToProtobuf(secpKey.publicKey)),
		[HEADER_AUDIENCE]: PINNED.audience,
		[HEADER_TIMESTAMP]: String(PINNED.issuedAt),
		[HEADER_NONCE]: PINNED.nonce,
		[HEADER_SIGNATURE]: base64Url(await secpKey.sign(new TextEncoder().encode(message))),
	};
	assert.deepEqual(await verify(headers), { kind: 'invalid', reason: 'key_type_unsupported' });
});

void test('garbage key bytes are rejected without throwing out of the handler', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	headers[HEADER_KEY] = base64Url(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
	assert.deepEqual(await verify(headers), { kind: 'invalid', reason: 'key_decode_failed' });
});

void test('a signature of the wrong length is rejected before the primitive sees it', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	headers[HEADER_SIGNATURE] = base64Url(new Uint8Array(63).fill(0x07));
	assert.deepEqual(await verify(headers), { kind: 'invalid', reason: 'signature_length' });
});

// --- Header parsing ----------------------------------------------------------

void test('all five headers absent is `absent`, not an error', () => {
	assert.deepEqual(parsePeerAssertion({}), { kind: 'absent' });
	assert.deepEqual(parsePeerAssertion({ authorization: 'Bearer x' }), { kind: 'absent' });
});

void test('a partial header set is malformed', async () => {
	const complete = await signHeaders(pinnedKey, PINNED_FIELDS);
	for (const name of [HEADER_KEY, HEADER_AUDIENCE, HEADER_TIMESTAMP, HEADER_NONCE, HEADER_SIGNATURE]) {
		const partial = { ...complete };
		delete partial[name];
		assert.deepEqual(parsePeerAssertion(partial), { kind: 'malformed', reason: 'incomplete_headers' }, `missing ${name}`);
	}
});

void test('duplicate header lines are malformed rather than guessed at', async () => {
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	headers[HEADER_NONCE] = [PINNED.nonce, PINNED.nonce];
	assert.deepEqual(parsePeerAssertion(headers), { kind: 'malformed', reason: 'duplicate_header' });
});

void test('length caps and field shapes are enforced before decoding', async () => {
	const cases: Array<[string, string, string]> = [
		[HEADER_KEY, 'A'.repeat(129), 'key_too_long'],
		[HEADER_KEY, 'not+base64url/', 'key_charset'],
		[HEADER_AUDIENCE, 'x'.repeat(513), 'audience_too_long'],
		[HEADER_AUDIENCE, 'https://issuer.example/\r\nX-Injected: 1', 'audience_charset'],
		[HEADER_TIMESTAMP, '1'.repeat(13), 'timestamp_too_long'],
		[HEADER_TIMESTAMP, '17356896e2', 'timestamp_charset'],
		[HEADER_NONCE, PINNED.nonce.toUpperCase(), 'nonce_charset'],
		[HEADER_NONCE, PINNED.nonce.slice(0, 31), 'nonce_charset'],
		[HEADER_NONCE, `${PINNED.nonce}00`, 'nonce_too_long'],
		[HEADER_SIGNATURE, 'B'.repeat(129), 'signature_too_long'],
		[HEADER_SIGNATURE, 'sig with spaces', 'signature_charset'],
	];
	for (const [name, value, reason] of cases) {
		const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
		headers[name] = value;
		assert.deepEqual(parsePeerAssertion(headers), { kind: 'malformed', reason }, `${name}=${value.slice(0, 24)}`);
	}
});

// --- Admission table ---------------------------------------------------------

void test('PEER_AUTH_MODE=off ignores the peer headers entirely', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'off' }));
	const valid = await signHeaders(pinnedKey, PINNED_FIELDS);
	const rubbish: IncomingHttpHeaders = { [HEADER_KEY]: 'nonsense' };

	for (const headers of [{}, valid, rubbish]) {
		const manifest = manifestOf(await admit(ctx, headers));
		assert.equal(manifest.peerAuth, 'off');
		assert.equal(manifest.peerId, undefined);
		assert.equal(turnEntry(manifest)?.username, `${PINNED.issuedAt + 300}:web`, 'CRED_ID labels the unverified path');
	}
});

void test('no assertion: optional keeps TURN, required serves STUN-only 200', async () => {
	for (const [mode, expectTurn] of [
		['optional', true],
		['required', false],
	] as Array<[PeerAuthMode, boolean]>) {
		const ctx = makeContext(baseConfig({ peerAuthMode: mode }));
		const manifest = manifestOf(await admit(ctx));
		assert.equal(manifest.peerAuth, 'none');
		assert.equal(manifest.peerId, undefined);
		assert.ok(stunEntry(manifest), `${mode} must still advertise STUN`);
		assert.equal(Boolean(turnEntry(manifest)), expectTurn, `${mode} TURN presence`);
	}
});

void test('a valid assertion earns a peer-labelled credential in optional and required', async () => {
	for (const mode of ['optional', 'required'] as PeerAuthMode[]) {
		const ctx = makeContext(baseConfig({ peerAuthMode: mode }));
		const manifest = manifestOf(await admit(ctx, await signHeaders(pinnedKey, PINNED_FIELDS)));
		assert.equal(manifest.peerAuth, 'verified');
		assert.equal(manifest.peerId, PINNED.peerId);
		assert.equal(turnEntry(manifest)?.username, PINNED.credentialUsername);
	}
});

void test('malformed headers are 400 and an invalid assertion is 401', async () => {
	for (const mode of ['optional', 'required'] as PeerAuthMode[]) {
		const partial = await signHeaders(pinnedKey, PINNED_FIELDS);
		delete partial[HEADER_SIGNATURE];
		const malformedResult = await admit(makeContext(baseConfig({ peerAuthMode: mode })), partial);
		assert.equal(malformedResult.status, 400);
		assert.deepEqual(malformedResult.body, { error: 'invalid_peer_assertion' });

		const stale = await signHeaders(pinnedKey, { ...PINNED_FIELDS, issuedAtSec: PINNED.issuedAt - 10_000 });
		const invalidResult = await admit(makeContext(baseConfig({ peerAuthMode: mode })), stale);
		assert.equal(invalidResult.status, 401);
		assert.deepEqual(invalidResult.body, { error: 'invalid_peer_assertion' });
	}
});

void test('a denied peer gets 403 before the per-peer bucket is touched', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'optional', peerDenyList: [PINNED.peerId], rateLimitPerPeerPerMin: 1 }));
	for (const nonce of ['a'.repeat(32), 'b'.repeat(32)]) {
		const result = await admit(ctx, await signHeaders(pinnedKey, { ...PINNED_FIELDS, nonce }));
		assert.equal(result.status, 403);
		assert.deepEqual(result.body, { error: 'peer_denied' });
	}
});

void test('verified-but-not-allow-listed is a STUN-only 200, not an error', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'optional', peerAllowList: [otherKey.publicKey.toString()] }));
	const manifest = manifestOf(await admit(ctx, await signHeaders(pinnedKey, PINNED_FIELDS)));
	assert.equal(manifest.peerAuth, 'verified');
	assert.equal(manifest.peerId, PINNED.peerId);
	assert.ok(stunEntry(manifest));
	assert.equal(turnEntry(manifest), undefined);
});

void test('an allow-listed peer still gets TURN', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'required', peerAllowList: [PINNED.peerId] }));
	const manifest = manifestOf(await admit(ctx, await signHeaders(pinnedKey, PINNED_FIELDS)));
	assert.equal(turnEntry(manifest)?.username, PINNED.credentialUsername);
});

void test('the per-peer rate limit returns 429 with Retry-After', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'optional', rateLimitPerPeerPerMin: 1 }));
	const first = await admit(ctx, await signHeaders(pinnedKey, { ...PINNED_FIELDS, nonce: 'a'.repeat(32) }));
	assert.equal(first.status, 200);
	const second = await admit(ctx, await signHeaders(pinnedKey, { ...PINNED_FIELDS, nonce: 'b'.repeat(32) }));
	assert.equal(second.status, 429);
	assert.deepEqual(second.body, { error: 'rate_limited' });
	assert.equal(second.headers['Retry-After'], '60');
});

void test('the per-IP limit runs before signature verification', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'required', rateLimitPerMin: 1 }));
	assert.equal((await admit(ctx, {})).status, 200);
	// Over the IP limit → 429 even though the assertion below is perfectly valid,
	// which is the point: no Ed25519 CPU is burned for a flooding caller.
	const second = await admit(ctx, await signHeaders(pinnedKey, PINNED_FIELDS));
	assert.equal(second.status, 429);
});

void test('the shared bearer token still gates ahead of everything else', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'required', authToken: 'sekrit' }));
	const headers = await signHeaders(pinnedKey, PINNED_FIELDS);
	const denied = await decideIceServers({ ip: '198.51.100.7', headers }, ctx);
	assert.equal(denied.status, 401);
	assert.deepEqual(denied.body, { error: 'unauthorized' });

	const allowed = await decideIceServers({ ip: '198.51.100.7', token: 'sekrit', headers }, ctx);
	assert.equal(manifestOf(allowed).peerId, PINNED.peerId);
});

void test('a full replay cache surfaces as 503, not a silent accept', async () => {
	const ctx = makeContext(baseConfig({ peerAuthMode: 'required' }), new ReplayCache(0));
	const result = await admit(ctx, await signHeaders(pinnedKey, PINNED_FIELDS));
	assert.equal(result.status, 503);
	assert.deepEqual(result.body, { error: 'unavailable' });
});

void test('the TURN gating matrix still wins over a valid assertion', async () => {
	for (const overrides of [
		{ turnEnabled: false },
		{ turnSecret: '' },
		{ turnUrls: [] },
		{ turnPolicy: 'off' as const },
	]) {
		const ctx = makeContext(baseConfig({ peerAuthMode: 'required', ...overrides }));
		const manifest = manifestOf(await admit(ctx, await signHeaders(pinnedKey, PINNED_FIELDS)));
		assert.equal(manifest.peerAuth, 'verified');
		assert.equal(turnEntry(manifest), undefined, `TURN must stay off for ${JSON.stringify(overrides)}`);
	}
});

// --- Boot-time config validation ---------------------------------------------

void test('a CR/LF audience is a fatal config error rather than a silent total denial', () => {
	assert.ok(fatalConfigError(baseConfig({ peerAuthMode: 'required', peerAuthAudience: 'a\r\nb' })));
	assert.equal(fatalConfigError(baseConfig({ peerAuthMode: 'off', peerAuthAudience: 'a\r\nb' })), undefined);
	assert.ok(fatalConfigError(baseConfig({ replayCacheMax: 0 })));
	assert.equal(fatalConfigError(baseConfig()), undefined);
});
