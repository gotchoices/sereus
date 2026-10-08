/**
 * `node-claim.ts` — what the user is told about a node code they scanned or pasted, and
 * about a claim that failed. The payload is a real one from `encodeNodeClaimPayload` and
 * the errors are the real classes `CadreNode.claimNode` throws, so an `instanceof` that
 * stops matching fails here rather than on a phone.
 */
import { describe, it, expect } from 'vitest';
import {
	ClaimRefusedError,
	PeerUnreachableError,
	encodeNodeClaimPayload,
	type NodeClaimPayload,
} from '@serfab/cadre-core';
import { describeClaimFailure, nodeReach, readNodeCode } from '../src/node-claim';

const PEER_ID = '12D3KooWMwa4jCjcL96kdsfjqxdNKFooX8YxaQZ2SqBNzpWvJsRX';
const LAN_ADDRS = [
	`/ip4/192.168.1.20/tcp/10003/ws/p2p/${PEER_ID}`,
	`/ip4/100.101.102.103/tcp/10003/ws/p2p/${PEER_ID}`,
];
const PUBLIC_ADDR = `/ip4/93.184.216.34/tcp/10004/ws/p2p/${PEER_ID}`;

function payloadWith(multiaddrs: string[]): NodeClaimPayload {
	return { peerId: PEER_ID, multiaddrs, secret: 'A'.repeat(43) };
}

describe('readNodeCode', () => {
	const code = encodeNodeClaimPayload(payloadWith([PUBLIC_ADDR, ...LAN_ADDRS]));

	it('reads a valid code, surrounding whitespace included', () => {
		expect(readNodeCode(`  ${code}\n`)).toEqual({ ok: true, payload: payloadWith([PUBLIC_ADDR, ...LAN_ADDRS]) });
	});

	it.each<[string, string, RegExp]>([
		['text that is not a node code', 'https://example.com/', /not a node code/],
		['a code from a newer cadre-host', code.replace('sereus-join:1.', 'sereus-join:2.'), /newer cadre-host/],
		['a damaged code', code.slice(0, -10), /damaged or incomplete/],
	])('refuses %s', (_label, text, expected) => {
		const reading = readNodeCode(text);
		expect(reading.ok).toBe(false);
		if (!reading.ok) expect(reading.message).toMatch(expected);
	});
});

describe('nodeReach', () => {
	it.each<[string, string[], string]>([
		['LAN, shared-space and loopback addresses only', [...LAN_ADDRS, `/ip4/127.0.0.1/tcp/10003/ws/p2p/${PEER_ID}`], 'home-network'],
		['one public address among LAN ones', [...LAN_ADDRS, PUBLIC_ADDR], 'anywhere'],
		['a DNS name', [`/dns4/node.example.org/tcp/443/wss/p2p/${PEER_ID}`], 'anywhere'],
	])('%s', (_label, addrs, expected) => {
		expect(nodeReach(addrs)).toBe(expected);
	});
});

describe('describeClaimFailure', () => {
	const unreachable = new PeerUnreachableError(PEER_ID, new Error('all dials failed'));

	it.each<[string, unknown, string[], RegExp, boolean]>([
		['an unreachable node with LAN addresses only', unreachable, LAN_ADDRS, /same Wi-Fi/, true],
		['an unreachable node with a public address', unreachable, [PUBLIC_ADDR], /any of its addresses/, true],
		['a node another cadre owns', new ClaimRefusedError(PEER_ID, 'claimed', 'already-claimed'), LAN_ADDRS, /another cadre.*Reset/, false],
		['a wrong or stale code', new ClaimRefusedError(PEER_ID, 'bad proof', 'claim-proof-invalid'), LAN_ADDRS, /code the machine shows now/, false],
		['a rate-limited node', new ClaimRefusedError(PEER_ID, 'slow down', 'claim-rate-limited'), LAN_ADDRS, /Wait a minute/, true],
		['a node that could not save its owner', new ClaimRefusedError(PEER_ID, 'disk full', 'claim-not-persisted'), LAN_ADDRS, /disk space/, true],
		['a refusal without a code', new ClaimRefusedError(PEER_ID, 'policy says no'), LAN_ADDRS, /refused to join/, false],
		['a failure after the node was reached', new Error('stream reset'), LAN_ADDRS, /same code is safe/, true],
	])('describes %s', (_label, error, addrs, expected, canRetrySameCode) => {
		const described = describeClaimFailure(error, payloadWith(addrs));
		expect(described.message).toMatch(expected);
		expect(described.canRetrySameCode).toBe(canRetrySameCode);
	});

	it('gives a refusal without a code the node\'s reason as its detail', () => {
		expect(describeClaimFailure(new ClaimRefusedError(PEER_ID, 'policy says no'), payloadWith(LAN_ADDRS)).detail).toBe('policy says no');
	});
});
