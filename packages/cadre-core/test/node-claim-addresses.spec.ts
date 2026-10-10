import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { decodeNodeClaimPayload, encodeNodeClaimPayload, selectNodeClaimAddresses } from '../src/node-claim-payload.js';
import { primaryLanAddress } from '../src/primary-lan-address.js';

/**
 * Which addresses a node code carries. A phone dials each in turn on its own timeout, so the
 * rule keeps what a phone can use: public names, one LAN address, WebSocket and relay only.
 */
const PEER = '12D3KooWQqAJCA3dguWYHWGzwSrVnsxTcPmL68TPqw4or6SLVkUS';
const RELAY = '12D3KooWQ7wMHcR6Z9zr2qmFyKW6pYp1VzJPfgoTHKGdEfMXz2Ve';
const p2p = (addr: string) => `${addr}/p2p/${PEER}`;

/** What a home server with Docker and a VPN reports, plus its public name. */
const HOME_SERVER = [
	'/dns4/bateman.cc/tcp/51234/ws',
	p2p('/ip4/127.0.0.1/tcp/51233'),
	p2p('/ip4/192.168.2.27/tcp/51233'),
	p2p('/ip4/127.0.0.1/tcp/51234/ws'),
	p2p('/ip4/192.168.2.27/tcp/51234/ws'),
	p2p('/ip4/172.20.0.1/tcp/51234/ws'),
	p2p('/ip4/172.19.0.1/tcp/51234/ws'),
	p2p('/ip4/10.9.9.1/tcp/51234/ws'),
	p2p('/ip4/0.0.0.0/tcp/51234/ws'),
];

describe('selectNodeClaimAddresses', () => {
	it('keeps the public name and the one LAN address on a home server', () => {
		expect(selectNodeClaimAddresses(HOME_SERVER, PEER, { lan: '192.168.2.27' })).toEqual([
			p2p('/dns4/bateman.cc/tcp/51234/ws'),
			p2p('/ip4/192.168.2.27/tcp/51234/ws'),
		]);
	});

	it('keeps every private WebSocket address when the LAN address is unknown', () => {
		expect(selectNodeClaimAddresses(HOME_SERVER, PEER)).toHaveLength(5);
	});

	it('keeps only the public name on a machine reached by name (lan: null), dropping its raw public IP', () => {
		const droplet = ['/dns4/kjeib.com/tcp/4002/ws', p2p('/ip4/203.0.113.7/tcp/4002/ws'), p2p('/ip4/10.10.0.5/tcp/4002/ws')];
		expect(selectNodeClaimAddresses(droplet, PEER, { lan: null })).toEqual([p2p('/dns4/kjeib.com/tcp/4002/ws')]);
	});

	it('keeps a public IP when there is no public name', () => {
		const bare = [p2p('/ip4/203.0.113.7/tcp/4002/ws'), p2p('/ip4/203.0.113.7/tcp/4001')];
		expect(selectNodeClaimAddresses(bare, PEER, { lan: null })).toEqual([p2p('/ip4/203.0.113.7/tcp/4002/ws')]);
	});

	it('keeps TCP with includeTcp, and relay addresses always, last', () => {
		const relayed = `/dns4/relay.example.org/tcp/443/wss/p2p/${RELAY}/p2p-circuit/p2p/${PEER}`;
		const reported = [relayed, p2p('/ip4/192.168.2.27/tcp/51233'), p2p('/ip4/192.168.2.27/tcp/51234/ws')];
		expect(selectNodeClaimAddresses(reported, PEER, { lan: '192.168.2.27' })).toEqual([p2p('/ip4/192.168.2.27/tcp/51234/ws'), relayed]);
		expect(selectNodeClaimAddresses(reported, PEER, { lan: '192.168.2.27', includeTcp: true })).toEqual([
			p2p('/ip4/192.168.2.27/tcp/51233'),
			p2p('/ip4/192.168.2.27/tcp/51234/ws'),
			relayed,
		]);
	});

	it('drops loopback, localhost, link-local IPv6 off the LAN choice, and unparsable entries', () => {
		const reported = ['/dns4/localhost/tcp/1/ws', '/ip6/::1/tcp/1/ws', '/ip6/fe80::1/tcp/1/ws', 'not a multiaddr', '/ip6/2001:db8::5/tcp/1/ws'];
		expect(selectNodeClaimAddresses(reported, PEER, { lan: '192.168.2.27' })).toEqual([p2p('/ip6/2001:db8::5/tcp/1/ws')]);
	});

	it('yields a list the codec accepts and is much smaller than everything', () => {
		const secret = randomBytes(32).toString('base64url');
		const narrowed = selectNodeClaimAddresses(HOME_SERVER, PEER, { lan: '192.168.2.27' });
		const everything = selectNodeClaimAddresses(HOME_SERVER, PEER, { includeTcp: true });
		const small = encodeNodeClaimPayload({ peerId: PEER, multiaddrs: narrowed, secret });
		const big = encodeNodeClaimPayload({ peerId: PEER, multiaddrs: everything, secret });
		expect(decodeNodeClaimPayload(small).multiaddrs).toEqual(narrowed);
		expect(small.length).toBeLessThan(big.length / 2);
	});
});

describe('primaryLanAddress', () => {
	it('returns an IPv4 address, or undefined with no route', async () => {
		const address = await primaryLanAddress();
		if (address !== undefined) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	});
});
