/**
 * `ice-config.ts` — STUN servers derived from the configured relays, and the
 * `VITE_STUN_URLS` override.
 *
 * Mirrored, case for case, by `reference-app-rn/test/ice-config.spec.ts`: the two
 * `ice-config.ts` copies differ only in how they read the override
 * (`import.meta.env` here, `process.env.EXPO_PUBLIC_*` there).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { relayStunUrl, resolveIceServers, RELAY_STUN_PORT } from '../src/lib/ice-config';

const PEER = '12D3KooWMD7E7UH4rkCqiFE69n7FNqrKo1Xx3yDUU8JvwtaH39bD';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('relayStunUrl', () => {
	it('uses the relay host on the STUN port, whatever transport and port the relay is dialed on', () => {
		expect(relayStunUrl(`/dns4/relay.example.org/tcp/4011/ws/p2p/${PEER}`)).toBe(`stun:relay.example.org:${RELAY_STUN_PORT}`);
		expect(relayStunUrl(`/dns4/relay.example.org/tcp/443/tls/ws/p2p/${PEER}`)).toBe('stun:relay.example.org:3478');
		expect(relayStunUrl(`/dns/relay.example.org/tcp/4001/p2p/${PEER}`)).toBe('stun:relay.example.org:3478');
	});

	it('carries IP literals, bracketing IPv6', () => {
		expect(relayStunUrl(`/ip4/203.0.113.7/tcp/4011/ws/p2p/${PEER}`)).toBe('stun:203.0.113.7:3478');
		expect(relayStunUrl(`/ip6/2001:db8::7/tcp/4011/ws/p2p/${PEER}`)).toBe('stun:[2001:db8::7]:3478');
	});

	it('returns undefined for an address that names no host', () => {
		expect(relayStunUrl(`/p2p/${PEER}`)).toBeUndefined();
	});

	it('returns undefined and warns for an address that does not parse', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(relayStunUrl('not-a-multiaddr')).toBeUndefined();
		expect(warn).toHaveBeenCalledOnce();
	});
});

describe('resolveIceServers', () => {
	it('derives one STUN server per distinct relay host', () => {
		const relays = [
			`/dns4/a.example.org/tcp/4011/ws/p2p/${PEER}`,
			`/dns4/a.example.org/tcp/4001/p2p/${PEER}`,
			`/dns4/b.example.org/tcp/4011/ws/p2p/${PEER}`,
		];
		expect(resolveIceServers(relays)).toEqual([
			{ urls: 'stun:a.example.org:3478' },
			{ urls: 'stun:b.example.org:3478' },
		]);
	});

	it('is empty with no relays and no override', () => {
		expect(resolveIceServers([])).toEqual([]);
	});

	it('uses VITE_STUN_URLS instead of the relays when set', () => {
		vi.stubEnv('VITE_STUN_URLS', ' stun:stun.example.net:3479 , stun:b.example.net:3478,');
		expect(resolveIceServers([`/dns4/a.example.org/tcp/4011/ws/p2p/${PEER}`])).toEqual([
			{ urls: 'stun:stun.example.net:3479' },
			{ urls: 'stun:b.example.net:3478' },
		]);
	});

	it('falls back to the relays when VITE_STUN_URLS is empty', () => {
		vi.stubEnv('VITE_STUN_URLS', '');
		expect(resolveIceServers([`/dns4/a.example.org/tcp/4011/ws/p2p/${PEER}`])).toEqual([{ urls: 'stun:a.example.org:3478' }]);
	});

	it('skips relays it cannot derive a host from', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(resolveIceServers(['not-a-multiaddr', `/dns4/a.example.org/tcp/4011/ws/p2p/${PEER}`])).toEqual([{ urls: 'stun:a.example.org:3478' }]);
	});
});
