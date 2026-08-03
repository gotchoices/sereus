/**
 * `ice-config.ts` — URL resolution, manifest validation, and the peer-assertion
 * client half of peer-bound TURN issuance.
 *
 * Mirrored, case for case, by `reference-app-rn/test/ice-config.spec.ts`: the two
 * `ice-config.ts` copies exist by design (DOM `RTCIceServer` + `localStorage` +
 * `import.meta.env` here; structural `IceServer` + `process.env.EXPO_PUBLIC_*`
 * there) and every helper must behave identically in both. Both specs pin the same
 * assertion vector as `packages/cadre-core/test/identity-key.spec.ts` and the
 * issuer's own self-test, so a drift on any side fails a test rather than silently
 * failing to authenticate in production.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	resolveIceConfigUrl,
	parseIceServers,
	loadIceConfig,
	iceConfigAudience,
	peerAssertionMessage,
	randomNonceHex,
	buildPeerAssertionHeaders,
	exampleIceConfigManifest,
	ICE_CONFIG_URL_STORAGE_KEY,
	type IceConfigPeerSigner,
} from '../src/lib/ice-config';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const URL_UNDER_TEST = 'https://explicit.example/ice.json';

/**
 * The cross-repo pinned vector (seed = 32 bytes of 0x01). `cadre-core`'s
 * `identity-key.spec.ts` proves a real `peerKeySigner` produces exactly these
 * peerId/publicKey/signature values; here we only need the message bytes to match.
 */
const PINNED = {
	peerId: '12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5',
	publicKeyB64: 'CAESIIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29c',
	audience: 'https://issuer.example/ice-servers.json',
	issuedAtSec: 1735689600,
	nonce: '00112233445566778899aabbccddeeff',
	signatureB64: '6jvguqhDOhK9ZahdAYb3aYnzz1dJaJBJtVCFcLCWMwCdupTUClWMJzXoS7yujjr7V3XA-htohz-VCl8GQQFcDg',
} as const;

const PINNED_MESSAGE = [
	'sereus.turn-issuer.v1',
	PINNED.audience,
	PINNED.peerId,
	String(PINNED.issuedAtSec),
	PINNED.nonce,
].join('\n');

/** Stub signer with the pinned identity; records every message it was asked to sign. */
function stubSigner(overrides?: Partial<IceConfigPeerSigner>): IceConfigPeerSigner & { signed: string[] } {
	const signed: string[] = [];
	return {
		signed,
		peerId: PINNED.peerId,
		publicKeyB64: PINNED.publicKeyB64,
		sign: async (message: string) => {
			signed.push(message);
			return PINNED.signatureB64;
		},
		...overrides,
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Stub globalThis.fetch for a single test; restore in afterEach. */
function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
	vi.stubGlobal('fetch', impl);
}

/** Create a fake resolved fetch response. */
function fakeResponse(body: unknown, status = 200): Promise<Response> {
	const json = JSON.stringify(body);
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(JSON.parse(json)),
	} as Response);
}

/** Headers actually sent, as a plain record (the module always passes an object literal). */
function sentHeaders(init?: RequestInit): Record<string, string> {
	return (init?.headers ?? {}) as Record<string, string>;
}

/** Only the five assertion headers, so a test can assert "none present". */
function peerHeaders(init?: RequestInit): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(sentHeaders(init))) {
		if (k.toLowerCase().startsWith('x-sereus-peer-')) out[k] = v;
	}
	return out;
}

/**
 * Record every fetch call's init, answering each with the supplied
 * status/body in order (the last entry repeats).
 */
function recordingFetch(responses: Array<{ status?: number; body?: unknown }>): RequestInit[] {
	const calls: RequestInit[] = [];
	stubFetch((_input, init) => {
		const at = Math.min(calls.length, responses.length - 1);
		calls.push(init ?? {});
		const { status = 200, body = exampleIceConfigManifest } = responses[at];
		return fakeResponse(body, status);
	});
	return calls;
}

/** Silence + capture console.warn for a test body. */
function withMutedWarn<T>(fn: () => T): T {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		return fn();
	} finally {
		warn.mockRestore();
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// ── resolveIceConfigUrl ────────────────────────────────────────────────────────

describe('resolveIceConfigUrl', () => {
	it('returns an explicit arg over everything else', () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', 'https://env.example/ice.json');
		expect(resolveIceConfigUrl(URL_UNDER_TEST)).toBe(URL_UNDER_TEST);
	});

	it('returns the env var when no explicit arg supplied', () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', 'https://env.example/ice.json');
		expect(resolveIceConfigUrl()).toBe('https://env.example/ice.json');
	});

	it('falls back to the localStorage override when no env var is set', () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', '');
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => (key === ICE_CONFIG_URL_STORAGE_KEY ? 'https://stored.example/ice.json' : null),
		});
		expect(resolveIceConfigUrl()).toBe('https://stored.example/ice.json');
	});

	it('returns undefined when nothing is configured', () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', '');
		expect(resolveIceConfigUrl()).toBeUndefined();
	});

	it('treats an empty string explicit arg as "not configured"', () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', 'https://env.example/ice.json');
		expect(resolveIceConfigUrl('')).toBe('https://env.example/ice.json');
	});
});

// ── parseIceServers ────────────────────────────────────────────────────────────

describe('parseIceServers', () => {
	it('parses the exampleIceConfigManifest fixture without loss', () => {
		expect(parseIceServers(exampleIceConfigManifest)).toEqual(exampleIceConfigManifest.iceServers);
	});

	it('returns [] and warns when data is not an object', () => {
		withMutedWarn(() => {
			expect(parseIceServers('not-an-object')).toEqual([]);
			expect(parseIceServers(null)).toEqual([]);
			expect(parseIceServers(42)).toEqual([]);
		});
	});

	it('returns [] when iceServers is not an array', () => {
		withMutedWarn(() => {
			expect(parseIceServers({ iceServers: 'bad' })).toEqual([]);
			expect(parseIceServers({})).toEqual([]);
		});
	});

	it('drops malformed entries but keeps valid ones', () => {
		withMutedWarn(() => {
			const servers = parseIceServers({
				iceServers: [
					{ urls: 'stun:good.example:3478' },
					{ urls: 123 },
					null,
					{ urls: ['stun:also-good.example:3478'] },
				],
			});
			expect(servers).toHaveLength(2);
			expect(servers[0]).toEqual({ urls: 'stun:good.example:3478' });
			expect(servers[1]).toEqual({ urls: ['stun:also-good.example:3478'] });
		});
	});

	it('carries through username and credential, dropping non-string ones', () => {
		const kept = parseIceServers({
			iceServers: [{ urls: 'turn:turn.example:3478', username: 'user1', credential: 'pass1' }],
		});
		expect(kept[0].username).toBe('user1');
		expect(kept[0].credential).toBe('pass1');

		const dropped = parseIceServers({
			iceServers: [{ urls: 'stun:good.example:3478', username: 42, credential: true }],
		});
		expect(dropped[0].username).toBeUndefined();
		expect(dropped[0].credential).toBeUndefined();
	});

	it('ignores the informational peerAuth / peerId manifest fields', () => {
		const servers = parseIceServers({
			iceServers: [{ urls: 'stun:good.example:3478' }],
			peerAuth: 'verified',
			peerId: PINNED.peerId,
		});
		expect(servers).toEqual([{ urls: 'stun:good.example:3478' }]);
	});
});

// ── Assertion helpers ──────────────────────────────────────────────────────────

describe('iceConfigAudience', () => {
	it('strips a query string', () => {
		expect(iceConfigAudience('https://issuer.example/ice-servers.json?a=b')).toBe(
			'https://issuer.example/ice-servers.json',
		);
	});

	it('strips a fragment', () => {
		expect(iceConfigAudience('https://issuer.example/ice-servers.json#frag')).toBe(
			'https://issuer.example/ice-servers.json',
		);
	});

	it('strips a fragment that precedes a literal "?"', () => {
		expect(iceConfigAudience('https://issuer.example/x#f?a=b')).toBe('https://issuer.example/x');
	});

	it('leaves the path — including a significant trailing slash — untouched', () => {
		expect(iceConfigAudience('https://issuer.example/ice/')).toBe('https://issuer.example/ice/');
		expect(iceConfigAudience('https://issuer.example')).toBe('https://issuer.example');
	});

	// A same-origin deployment configured with a relative URL signs a relative
	// audience — nothing is resolved against the page origin. `PEER_AUTH_AUDIENCE`
	// has to match THIS string (ops/docs/ice-servers.md → "Client side").
	it('does not absolutize a relative URL', () => {
		expect(iceConfigAudience('/ice-servers.json?v=2')).toBe('/ice-servers.json');
	});
});

describe('peerAssertionMessage', () => {
	it('reproduces the pinned message byte for byte', () => {
		expect(peerAssertionMessage(PINNED.audience, PINNED.peerId, PINNED.issuedAtSec, PINNED.nonce))
			.toBe(PINNED_MESSAGE);
	});

	it('is five LF-separated lines with no trailing newline', () => {
		const lines = peerAssertionMessage('aud', 'peer', 1, 'n').split('\n');
		expect(lines).toEqual(['sereus.turn-issuer.v1', 'aud', 'peer', '1', 'n']);
	});
});

describe('randomNonceHex', () => {
	it('returns 32 lowercase hex chars', () => {
		expect(randomNonceHex()).toMatch(/^[0-9a-f]{32}$/);
	});

	it('does not repeat across calls', () => {
		expect(randomNonceHex()).not.toBe(randomNonceHex());
	});

	it('throws when crypto.getRandomValues is unavailable (caller degrades, never crashes)', () => {
		vi.stubGlobal('crypto', {});
		expect(() => randomNonceHex()).toThrow(/getRandomValues/);
	});
});

describe('buildPeerAssertionHeaders', () => {
	it('emits all five headers over the message the signer saw', async () => {
		const signer = stubSigner();
		const headers = await buildPeerAssertionHeaders(signer, PINNED.audience, PINNED.issuedAtSec);

		expect(headers['X-Sereus-Peer-Key']).toBe(PINNED.publicKeyB64);
		expect(headers['X-Sereus-Peer-Aud']).toBe(PINNED.audience);
		expect(headers['X-Sereus-Peer-Ts']).toBe(String(PINNED.issuedAtSec));
		expect(headers['X-Sereus-Peer-Nonce']).toMatch(/^[0-9a-f]{32}$/);
		expect(headers['X-Sereus-Peer-Sig']).toBe(PINNED.signatureB64);

		expect(signer.signed).toEqual([
			peerAssertionMessage(PINNED.audience, PINNED.peerId, PINNED.issuedAtSec, headers['X-Sereus-Peer-Nonce']),
		]);
	});
});

// ── loadIceConfig ──────────────────────────────────────────────────────────────

describe('loadIceConfig', () => {
	it('returns [] without fetching when no URL is configured', async () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', '');
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect(await loadIceConfig()).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('happy path: returns iceServers from the fetched manifest', async () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', 'https://env.example/ice.json');
		stubFetch(() => fakeResponse(exampleIceConfigManifest));
		expect(await loadIceConfig()).toEqual(exampleIceConfigManifest.iceServers);
	});

	it('options.url beats the env var', async () => {
		vi.stubEnv('VITE_ICE_CONFIG_URL', 'https://env.example/ice.json');
		const calls: string[] = [];
		stubFetch((input) => {
			calls.push(String(input));
			return fakeResponse(exampleIceConfigManifest);
		});
		await loadIceConfig({ url: URL_UNDER_TEST });
		expect(calls).toEqual([URL_UNDER_TEST]);
	});

	it('returns [] on non-OK HTTP status (e.g. 500)', async () => {
		await withMutedWarn(async () => {
			stubFetch(() => fakeResponse({ iceServers: [] }, 500));
			expect(await loadIceConfig({ url: URL_UNDER_TEST })).toEqual([]);
		});
	});

	it('returns [] when fetch rejects (network error)', async () => {
		await withMutedWarn(async () => {
			stubFetch(() => Promise.reject(new Error('network error')));
			expect(await loadIceConfig({ url: URL_UNDER_TEST })).toEqual([]);
		});
	});

	it('returns [] when the body is not an object', async () => {
		await withMutedWarn(async () => {
			stubFetch(() =>
				Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve('a plain string') } as Response),
			);
			expect(await loadIceConfig({ url: URL_UNDER_TEST })).toEqual([]);
		});
	});

	it('drops malformed entries among valid ones — partial parse', async () => {
		await withMutedWarn(async () => {
			stubFetch(() =>
				fakeResponse({
					iceServers: [
						{ urls: 'stun:good.example:3478' },
						{ urls: 123 },
						{ urls: 'stun:also-good.example:3478', username: 'u', credential: 'c' },
					],
				}),
			);
			expect(await loadIceConfig({ url: URL_UNDER_TEST })).toEqual([
				{ urls: 'stun:good.example:3478' },
				{ urls: 'stun:also-good.example:3478', username: 'u', credential: 'c' },
			]);
		});
	});

	it('does not log TURN credentials in the warning message on failure', async () => {
		const warnings: unknown[][] = [];
		vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args); });
		try {
			stubFetch(() => Promise.reject(new Error('network error')));
			await loadIceConfig({ url: URL_UNDER_TEST });
			for (const args of warnings) {
				const flat = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
				expect(flat).not.toContain('credential');
				expect(flat).not.toContain('password');
			}
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('timeout: a never-resolving fetch is aborted within the deadline', async () => {
		vi.useFakeTimers();
		await withMutedWarn(async () => {
			let aborted = false;
			stubFetch((_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						aborted = true;
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				}),
			);

			const promise = loadIceConfig({ url: URL_UNDER_TEST });
			await vi.advanceTimersByTimeAsync(5_000);

			expect(aborted).toBe(true);
			expect(await promise).toEqual([]);
		});
	});
});

// ── loadIceConfig — peer assertion ─────────────────────────────────────────────

describe('loadIceConfig peer assertion', () => {
	it('sends no X-Sereus-Peer-* headers without a signer', async () => {
		const calls = recordingFetch([{}]);
		await loadIceConfig({ url: URL_UNDER_TEST });

		expect(calls).toHaveLength(1);
		expect(peerHeaders(calls[0])).toEqual({});
		expect(sentHeaders(calls[0]).accept).toBe('application/json');
	});

	it('sends all five headers with a signer, over the audience it actually fetched', async () => {
		const calls = recordingFetch([{}]);
		const nowSec = Math.floor(Date.now() / 1000);
		const servers = await loadIceConfig({
			url: 'https://issuer.example/ice-servers.json?debug=1#frag',
			signer: stubSigner(),
		});

		expect(servers).toEqual(exampleIceConfigManifest.iceServers);
		const sent = peerHeaders(calls[0]);
		expect(Object.keys(sent).sort()).toEqual([
			'X-Sereus-Peer-Aud',
			'X-Sereus-Peer-Key',
			'X-Sereus-Peer-Nonce',
			'X-Sereus-Peer-Sig',
			'X-Sereus-Peer-Ts',
		]);
		expect(sent['X-Sereus-Peer-Key']).toBe(PINNED.publicKeyB64);
		expect(sent['X-Sereus-Peer-Aud']).toBe('https://issuer.example/ice-servers.json');
		expect(sent['X-Sereus-Peer-Nonce']).toMatch(/^[0-9a-f]{32}$/);
		expect(Number(sent['X-Sereus-Peer-Ts'])).toBeGreaterThanOrEqual(nowSec);
		expect(Number(sent['X-Sereus-Peer-Ts'])).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});

	it('a rejecting signer still issues the request, unauthenticated, and parses it', async () => {
		await withMutedWarn(async () => {
			const calls = recordingFetch([{}]);
			const servers = await loadIceConfig({
				url: URL_UNDER_TEST,
				signer: stubSigner({ sign: () => Promise.reject(new Error('key store locked')) }),
			});

			expect(calls).toHaveLength(1);
			expect(peerHeaders(calls[0])).toEqual({});
			expect(servers).toEqual(exampleIceConfigManifest.iceServers);
		});
	});

	for (const status of [400, 401, 403, 503]) {
		it(`HTTP ${status} with headers retries exactly once, unauthenticated`, async () => {
			await withMutedWarn(async () => {
				const calls = recordingFetch([{ status }, {}]);
				const servers = await loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() });

				expect(calls).toHaveLength(2);
				expect(Object.keys(peerHeaders(calls[0]))).toHaveLength(5);
				expect(peerHeaders(calls[1])).toEqual({});
				expect(servers).toEqual(exampleIceConfigManifest.iceServers);
			});
		});
	}

	for (const status of [429, 500]) {
		it(`HTTP ${status} does NOT retry (one fetch, [])`, async () => {
			await withMutedWarn(async () => {
				const calls = recordingFetch([{ status }, {}]);
				expect(await loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() })).toEqual([]);
				expect(calls).toHaveLength(1);
			});
		});
	}

	it('a 401 on the retry itself yields [] — no third attempt', async () => {
		await withMutedWarn(async () => {
			const calls = recordingFetch([{ status: 401 }]);
			expect(await loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() })).toEqual([]);
			expect(calls).toHaveLength(2);
		});
	});

	it('HTTP 401 with NO signer is a single fetch and [] (no retry loop)', async () => {
		await withMutedWarn(async () => {
			const calls = recordingFetch([{ status: 401 }]);
			expect(await loadIceConfig({ url: URL_UNDER_TEST })).toEqual([]);
			expect(calls).toHaveLength(1);
		});
	});

	// The five custom headers make a cross-origin fetch preflighted; a manifest host
	// that does not answer that OPTIONS fails the request outright, which reaches us
	// as an ordinary network error. Retrying unsigned restores the simple request.
	it('a thrown first attempt retries once, unauthenticated (covers a failed CORS preflight)', async () => {
		await withMutedWarn(async () => {
			const calls: RequestInit[] = [];
			stubFetch((_input, init) => {
				calls.push(init ?? {});
				return calls.length === 1
					? Promise.reject(new TypeError('Failed to fetch'))
					: fakeResponse(exampleIceConfigManifest);
			});

			const servers = await loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() });

			expect(calls).toHaveLength(2);
			expect(Object.keys(peerHeaders(calls[0]))).toHaveLength(5);
			expect(peerHeaders(calls[1])).toEqual({});
			expect(servers).toEqual(exampleIceConfigManifest.iceServers);
		});
	});

	it('a thrown attempt with NO signer stays a single fetch', async () => {
		await withMutedWarn(async () => {
			const calls: RequestInit[] = [];
			stubFetch((_input, init) => {
				calls.push(init ?? {});
				return Promise.reject(new TypeError('Failed to fetch'));
			});

			expect(await loadIceConfig({ url: URL_UNDER_TEST })).toEqual([]);
			expect(calls).toHaveLength(1);
		});
	});

	it('a thrown retry yields [] — no third attempt', async () => {
		await withMutedWarn(async () => {
			const calls: RequestInit[] = [];
			stubFetch((_input, init) => {
				calls.push(init ?? {});
				return Promise.reject(new TypeError('Failed to fetch'));
			});

			expect(await loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() })).toEqual([]);
			expect(calls).toHaveLength(2);
		});
	});

	it('an aborted first attempt does NOT retry (the deadline is already blown)', async () => {
		vi.useFakeTimers();
		await withMutedWarn(async () => {
			const calls: RequestInit[] = [];
			stubFetch((_input, init) => {
				calls.push(init ?? {});
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				});
			});

			const promise = loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() });
			await vi.advanceTimersByTimeAsync(5_000);

			expect(await promise).toEqual([]);
			expect(calls).toHaveLength(1);
		});
	});

	it('names the audience it sent when it takes the fallback (the operator\'s only clue)', async () => {
		const warnings: string[] = [];
		vi.spyOn(console, 'warn').mockImplementation((...args) => {
			warnings.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
		});
		try {
			recordingFetch([{ status: 401 }, {}]);
			await loadIceConfig({ url: 'https://issuer.example/ice-servers.json?x=1', signer: stubSigner() });
			expect(warnings.some((w) => w.includes('https://issuer.example/ice-servers.json') && w.includes('401')))
				.toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('the one deadline covers both attempts', async () => {
		vi.useFakeTimers();
		await withMutedWarn(async () => {
			let aborts = 0;
			let call = 0;
			stubFetch((_input, init) => {
				call += 1;
				if (call === 1) return fakeResponse({ iceServers: [] }, 401);
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						aborts += 1;
						reject(new DOMException('The operation was aborted.', 'AbortError'));
					});
				});
			});

			const promise = loadIceConfig({ url: URL_UNDER_TEST, signer: stubSigner() });
			// 5 s from the START of the call, not 5 s per attempt.
			await vi.advanceTimersByTimeAsync(5_000);

			expect(await promise).toEqual([]);
			expect(call).toBe(2);
			expect(aborts).toBe(1);
		});
	});
});
