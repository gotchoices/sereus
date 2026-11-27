import { describe, expect, it } from 'vitest';
import { addressKind } from '../src/address.js';
import { DEFAULT_CADRON_PREFERENCES, normalizePreferences, planBootstrap, type CadronCandidate } from '../src/bootstrap.js';
import { describeInvitation, qrVersionFor } from '../src/invitation-text.js';

const KJEIB = '12D3KooWHA9QDCHrzvezCn4oHuqUfDgdwwQaRdn7bMAyenKmofdM';
const HOME = '12D3KooWQnnujQQD9S1CcXtvWc1jB5h6xGZtaz9zSfgswcXDY7eN';
const PHONE = '12D3KooWBvpz6JpSf4vTeT7v1weVcGJVjhBVHHE4j2VrcKeqDFHS';
const RELAY = '/dns4/relay.sereus.org/tcp/4011/ws/p2p/12D3KooWMD7E7UH4rkCqiFE69n7FNqrKo1Xx3yDUU8JvwtaH39bD';

/** A cadre-host node on a VPS, its record as libp2p and cadre-host make it: interfaces first, TCP before WS, public last. */
const kjeibRecord = [
	...['127.0.0.1', '10.12.0.6', '10.134.0.2', '10.9.10.2'].map(ip => `/ip4/${ip}/tcp/10006/p2p/${KJEIB}`),
	...['127.0.0.1', '10.12.0.6', '10.134.0.2', '10.9.10.2'].map(ip => `/ip4/${ip}/tcp/10007/ws/p2p/${KJEIB}`),
	`/ip4/107.170.255.209/tcp/10006/p2p/${KJEIB}`,
	`/ip4/107.170.255.209/tcp/10007/ws/p2p/${KJEIB}`,
];
const kjeib = (over: Partial<CadronCandidate> = {}): CadronCandidate => ({
	peerId: KJEIB, alwaysOn: true, lastPublishedAt: 1000, addrs: kjeibRecord.map(addr => ({ addr, source: 'record' })), ...over,
});
const phoneRelay = `${RELAY}/p2p-circuit/p2p/${PHONE}`;
const prefs = (over: Partial<typeof DEFAULT_CADRON_PREFERENCES> = {}) => normalizePreferences({ ...DEFAULT_CADRON_PREFERENCES, ...over });

describe('addressKind', () => {
	it('judges an address as a phone dialing it would', () => {
		expect(addressKind(`/ip4/107.170.255.209/tcp/10007/ws/p2p/${KJEIB}`)).toBe('public');
		expect(addressKind(`/dns4/kjeib.com/tcp/443/wss/p2p/${KJEIB}`)).toBe('name');
		expect(addressKind(`/ip4/10.12.0.6/tcp/10007/ws/p2p/${KJEIB}`)).toBe('private');
		expect(addressKind(`/ip4/127.0.0.1/tcp/10007/ws/p2p/${KJEIB}`)).toBe('loopback');
		expect(addressKind(phoneRelay)).toBe('relay');
		expect(addressKind(`${RELAY}/p2p-circuit/webrtc/p2p/${PHONE}`)).toBe('webrtc');
		// Plain TCP: no phone can dial it.
		expect(addressKind(`/ip4/107.170.255.209/tcp/10006/p2p/${KJEIB}`)).toBeNull();
		expect(addressKind('/ip4/0.0.0.0/tcp/1/ws')).toBeNull();
		// A relay reached over plain TCP: no phone can dial the hop.
		expect(addressKind(`/dns4/relay.sereus.org/tcp/4001/p2p/12D3KooWMD7E7UH4rkCqiFE69n7FNqrKo1Xx3yDUU8JvwtaH39bD/p2p-circuit/p2p/${PHONE}`)).toBeNull();
	});
});

describe('planBootstrap', () => {
	it('names a VPS cadron by its public WebSocket address, not the loopback and private ones cadre-core leads with', () => {
		const plan = planBootstrap({ cadrons: [kjeib()], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs({ maxAddrs: 2 }) });
		expect(plan.entries.map(e => e.addr)).toEqual([`/ip4/107.170.255.209/tcp/10007/ws/p2p/${KJEIB}`]);
		expect(plan.warnings).toEqual([]);
	});

	it('leaves this device out while a cadron reaches from anywhere, and falls back to it when none does', () => {
		const withRelay = { peerId: PHONE, addrs: [phoneRelay] };
		expect(planBootstrap({ cadrons: [kjeib()], thisDevice: withRelay, prefs: prefs() }).entries.map(e => e.peerId)).toEqual([KJEIB]);
		const lanOnly = kjeib({ addrs: kjeibRecord.filter(a => !a.includes('107.170')).map(addr => ({ addr, source: 'record' as const })) });
		const plan = planBootstrap({ cadrons: [lanOnly], thisDevice: withRelay, prefs: prefs() });
		expect(plan.entries.map(e => e.addr)).toEqual([phoneRelay]);
		expect(plan.warnings).toContain('no-cadron-reachable-from-anywhere');
	});

	it('puts this device in the last slot when asked to always', () => {
		const plan = planBootstrap({ cadrons: [kjeib()], thisDevice: { peerId: PHONE, addrs: [phoneRelay] }, prefs: prefs({ thisDevice: 'always', maxAddrs: 2 }) });
		expect(plan.entries.map(e => e.thisDevice)).toEqual([false, true]);
	});

	it('names preferred cadrons first and gives each cadron one address before any gets a second', () => {
		const home = (): CadronCandidate => ({
			peerId: HOME, alwaysOn: true, lastPublishedAt: 9999,
			addrs: [{ addr: `/dns4/home.example.net/tcp/443/wss/p2p/${HOME}`, source: 'record' }, { addr: `${RELAY}/p2p-circuit/p2p/${HOME}`, source: 'record' }],
		});
		// Newest record first by default: HOME.
		expect(planBootstrap({ cadrons: [kjeib(), home()], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs({ maxAddrs: 3 }) })
			.entries.map(e => e.peerId)).toEqual([HOME, KJEIB, HOME]);
		// Preferred: KJEIB leads.
		expect(planBootstrap({ cadrons: [kjeib(), home()], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs({ maxAddrs: 2, preferred: [KJEIB] }) })
			.entries.map(e => [e.peerId, e.preferred])).toEqual([[KJEIB, true], [HOME, false]]);
	});

	it('uses a just-claimed cadron\'s claim addresses until its record arrives, and says so', () => {
		const fresh = kjeib({ lastPublishedAt: null, alwaysOn: false, addrs: [{ addr: `/ip4/107.170.255.209/tcp/10007/ws/p2p/${KJEIB}`, source: 'claim' }] });
		const plan = planBootstrap({ cadrons: [fresh], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs() });
		expect(plan.entries.map(e => e.source)).toEqual(['claim']);
		expect(plan.warnings).toContain('cadron-record-not-yet-published');
	});

	it('prefers an address a connection proved over the same one from the record', () => {
		const addr = `/ip4/107.170.255.209/tcp/10007/ws/p2p/${KJEIB}`;
		const proven = kjeib({ addrs: [{ addr, source: 'record' }, { addr, source: 'connection' }] });
		expect(planBootstrap({ cadrons: [proven], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs() }).entries[0].source).toBe('connection');
	});

	it('names private addresses only when allowed, and never loopback or plain TCP', () => {
		const lanOnly = kjeib({ addrs: kjeibRecord.filter(a => !a.includes('107.170')).map(addr => ({ addr, source: 'record' as const })) });
		const off = planBootstrap({ cadrons: [lanOnly], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs() });
		expect(off.entries).toEqual([]);
		expect(off.warnings).toContain('unreachable');
		const on = planBootstrap({ cadrons: [lanOnly], thisDevice: { peerId: PHONE, addrs: [] }, prefs: prefs({ allowPrivate: true, maxAddrs: 8 }) });
		expect(on.entries.every(e => e.kind === 'private')).toBe(true);
		expect(on.entries).toHaveLength(3);
	});

	it('keeps preferences whole and in range', () => {
		expect(normalizePreferences({ maxAddrs: 0 }).maxAddrs).toBe(1);
		expect(normalizePreferences({ maxAddrs: 99 }).maxAddrs).toBe(8);
		expect(normalizePreferences({ preferred: [KJEIB, KJEIB, ''] }).preferred).toEqual([KJEIB]);
		expect(normalizePreferences(null)).toEqual(DEFAULT_CADRON_PREFERENCES);
	});
});

describe('describeInvitation', () => {
	it('says which cadron each address reaches, how, and how big the link is', () => {
		const link = `https://sereus.org/chat/invite/#${'x'.repeat(300)}`;
		const text = describeInvitation(
			{ expiration: '2026-12-01T21:04:09.180Z', bootstrap: [`/ip4/107.170.255.209/tcp/10007/ws/p2p/${KJEIB}`, phoneRelay] },
			{ link, names: { [KJEIB]: 'kjeib' }, thisDevicePeerId: PHONE },
		);
		expect(text.addresses.map(a => [a.label, a.kind, a.host, a.port, a.via, a.thisDevice])).toEqual([
			['kjeib', 'public', '107.170.255.209', 10007, 'ws', false],
			['…cKeqDFHS', 'relay', 'relay.sereus.org', 4011, 'relay', true],
		]);
		expect(text.linkLength).toBe(link.length);
		expect(text.qrVersion).toBe(qrVersionFor(link.length));
		expect(qrVersionFor(2331)).toBe(40);
		expect(qrVersionFor(2332)).toBeNull();
	});
});
