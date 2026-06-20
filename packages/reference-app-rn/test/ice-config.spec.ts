import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	resolveIceConfigUrl,
	parseIceServers,
	loadIceConfig,
	exampleIceConfigManifest,
	type IceServer,
} from '../src/ice-config';

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

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	// Clear any env-var stubs set during tests
	delete process.env.EXPO_PUBLIC_ICE_CONFIG_URL;
});

// ── resolveIceConfigUrl ────────────────────────────────────────────────────────

describe('resolveIceConfigUrl', () => {
	it('returns an explicit arg over everything else', () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		expect(resolveIceConfigUrl('https://explicit.example/ice.json')).toBe('https://explicit.example/ice.json');
	});

	it('returns the env var when no explicit arg supplied', () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		expect(resolveIceConfigUrl()).toBe('https://env.example/ice.json');
	});

	it('returns undefined when neither explicit arg nor env var are set', () => {
		delete process.env.EXPO_PUBLIC_ICE_CONFIG_URL;
		expect(resolveIceConfigUrl()).toBeUndefined();
	});

	it('treats an empty string explicit arg as "not configured"', () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		expect(resolveIceConfigUrl('')).toBe('https://env.example/ice.json');
	});

	it('treats an empty env var as "not configured"', () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = '';
		expect(resolveIceConfigUrl()).toBeUndefined();
	});
});

// ── parseIceServers ────────────────────────────────────────────────────────────

describe('parseIceServers', () => {
	it('parses the exampleIceConfigManifest fixture without loss', () => {
		const servers = parseIceServers(exampleIceConfigManifest);
		expect(servers).toEqual(exampleIceConfigManifest.iceServers);
	});

	it('returns [] and warns when data is not an object', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(parseIceServers('not-an-object')).toEqual([]);
			expect(parseIceServers(null)).toEqual([]);
			expect(parseIceServers(42)).toEqual([]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('returns [] and warns when iceServers is not an array', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(parseIceServers({ iceServers: 'bad' })).toEqual([]);
			expect(parseIceServers({ iceServers: null })).toEqual([]);
			expect(parseIceServers({})).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('drops malformed entries but keeps valid ones', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const data = {
				iceServers: [
					{ urls: 'stun:good.example:3478' },
					{ urls: 123 }, // malformed — numeric urls
					null, // malformed — not an object
					{ urls: ['stun:also-good.example:3478'] },
				],
			};
			const servers = parseIceServers(data);
			expect(servers).toHaveLength(2);
			expect(servers[0]).toEqual({ urls: 'stun:good.example:3478' });
			expect(servers[1]).toEqual({ urls: ['stun:also-good.example:3478'] });
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('carries through username and credential string fields', () => {
		const data = {
			iceServers: [
				{ urls: 'turn:turn.example:3478', username: 'user1', credential: 'pass1' },
			],
		};
		const servers = parseIceServers(data);
		expect(servers).toHaveLength(1);
		expect(servers[0].username).toBe('user1');
		expect(servers[0].credential).toBe('pass1');
	});

	it('drops non-string username/credential fields (no passthrough)', () => {
		const data = {
			iceServers: [
				{ urls: 'stun:good.example:3478', username: 42, credential: true },
			],
		};
		const servers = parseIceServers(data);
		expect(servers).toHaveLength(1);
		expect(servers[0].username).toBeUndefined();
		expect(servers[0].credential).toBeUndefined();
	});

	it('accepts a single string urls field', () => {
		const data = { iceServers: [{ urls: 'stun:stun.example:3478' }] };
		const servers = parseIceServers(data);
		expect(servers).toHaveLength(1);
		expect(servers[0].urls).toBe('stun:stun.example:3478');
	});

	it('accepts a string[] urls field', () => {
		const data = { iceServers: [{ urls: ['stun:a.example:3478', 'stun:b.example:3478'] }] };
		const servers = parseIceServers(data);
		expect(servers).toHaveLength(1);
		expect(servers[0].urls).toEqual(['stun:a.example:3478', 'stun:b.example:3478']);
	});
});

// ── loadIceConfig ──────────────────────────────────────────────────────────────

describe('loadIceConfig', () => {
	it('returns [] without fetching when no URL is configured', async () => {
		delete process.env.EXPO_PUBLIC_ICE_CONFIG_URL;
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await loadIceConfig();
		expect(result).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('happy path: returns iceServers from the fetched manifest', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		stubFetch(() => fakeResponse(exampleIceConfigManifest));
		const result = await loadIceConfig();
		expect(result).toEqual(exampleIceConfigManifest.iceServers);
	});

	it('explicit-arg URL beats env var', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const calls: string[] = [];
		stubFetch((input) => {
			calls.push(String(input));
			return fakeResponse(exampleIceConfigManifest);
		});
		await loadIceConfig('https://explicit.example/ice.json');
		expect(calls).toEqual(['https://explicit.example/ice.json']);
	});

	it('env var used when no arg supplied', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const calls: string[] = [];
		stubFetch((input) => {
			calls.push(String(input));
			return fakeResponse(exampleIceConfigManifest);
		});
		await loadIceConfig();
		expect(calls).toEqual(['https://env.example/ice.json']);
	});

	it('returns [] on non-OK HTTP status (e.g. 500)', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			stubFetch(() => fakeResponse({ iceServers: [] }, 500));
			const result = await loadIceConfig();
			expect(result).toEqual([]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('returns [] when fetch rejects (network error)', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			stubFetch(() => Promise.reject(new Error('network error')));
			const result = await loadIceConfig();
			expect(result).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('returns [] when body is not an object', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			stubFetch(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve('a plain string'),
				} as Response),
			);
			const result = await loadIceConfig();
			expect(result).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('returns [] when iceServers is not an array', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			stubFetch(() => fakeResponse({ iceServers: 'not-an-array' }));
			const result = await loadIceConfig();
			expect(result).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	it('drops malformed entries among valid ones — partial parse', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const manifest = {
				iceServers: [
					{ urls: 'stun:good.example:3478' },
					{ urls: 123 }, // malformed
					{ urls: 'stun:also-good.example:3478', username: 'u', credential: 'c' },
				],
			};
			stubFetch(() => fakeResponse(manifest));
			const result = await loadIceConfig();
			expect(result).toHaveLength(2);
			const expected: IceServer[] = [
				{ urls: 'stun:good.example:3478' },
				{ urls: 'stun:also-good.example:3478', username: 'u', credential: 'c' },
			];
			expect(result).toEqual(expected);
		} finally {
			warn.mockRestore();
		}
	});

	it('timeout: a never-resolving fetch is aborted within the deadline', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let aborted = false;
			stubFetch((_input, init) => {
				// Return a promise that only settles if the signal aborts
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						signal.addEventListener('abort', () => {
							aborted = true;
							reject(new DOMException('The operation was aborted.', 'AbortError'));
						});
					}
				});
			});

			const promise = loadIceConfig();
			// Advance past the 5-second deadline
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await promise;

			expect(aborted).toBe(true);
			expect(result).toEqual([]);
		} finally {
			warn.mockRestore();
			vi.useRealTimers();
		}
	});

	it('does not log TURN credentials in the warning message on failure', async () => {
		process.env.EXPO_PUBLIC_ICE_CONFIG_URL = 'https://env.example/ice.json';
		const warnings: unknown[][] = [];
		vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args); });
		try {
			stubFetch(() => Promise.reject(new Error('network error')));
			await loadIceConfig();
			for (const args of warnings) {
				const flat = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
				expect(flat).not.toContain('credential');
				expect(flat).not.toContain('password');
			}
		} finally {
			vi.restoreAllMocks();
		}
	});
});
