import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encodeNodeClaimPayload } from '@serfab/cadre-core';
import { isPublicAddress, nodeReach } from '../../src/address.js';
import { isNodeCode, nodeCodeFromUrl } from '../../src/node-code-text.js';
import { readNodeCode } from '../../src/sereus/node-code.js';

describe('node codes', () => {
	const secret = randomBytes(32).toString('base64url');
	const peerId = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
	const code = encodeNodeClaimPayload({ peerId, multiaddrs: [`/dns4/home.example/tcp/4002/ws/p2p/${peerId}`], secret });

	it('reads a code, and refuses what is not one', () => {
		const reading = readNodeCode(code);
		expect(reading.ok && reading.payload.peerId).toBe(peerId);
		expect(readNodeCode(`https://example.com/add#${encodeURIComponent(code)}`).ok).toBe(true);
		expect(readNodeCode('https://sereus.org/chat/invite/#tok')).toMatchObject({ ok: false, problem: 'not-node-code' });
		expect(readNodeCode('sereus-join:2.abc')).toMatchObject({ ok: false, problem: 'newer-version' });
		expect(readNodeCode('sereus-join:1.abc')).toMatchObject({ ok: false, problem: 'damaged' });
	});

	it('finds a code inside a link', () => {
		expect(isNodeCode(code)).toBe(true);
		expect(nodeCodeFromUrl(`https://example.com/add#${encodeURIComponent(code)}`)).toBe(code);
		expect(nodeCodeFromUrl('https://example.com/nothing')).toBeNull();
	});

	it('judges reach by the first host in each address', () => {
		expect(nodeReach(['/ip4/192.168.1.20/tcp/4002/ws'])).toBe('home-network');
		expect(nodeReach(['/ip4/192.168.1.20/tcp/4002/ws', '/dns4/x.example/tcp/443/wss'])).toBe('anywhere');
		expect(isPublicAddress('/ip4/100.70.1.2/tcp/1')).toBe(false); // Tailscale
		expect(isPublicAddress('/ip4/8.8.8.8/tcp/1')).toBe(true);
		expect(isPublicAddress('/ip6/fe80::1/tcp/1')).toBe(false);
	});
});
