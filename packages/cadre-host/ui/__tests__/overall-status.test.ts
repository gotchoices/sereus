import { describe, expect, it } from 'vitest';

import { deriveOverallStatus } from '../src/lib/overall-status.js';
import type { NatStatusSnapshot, NodeInfo } from '../src/lib/state.svelte.js';

function node(status: NodeInfo['status']): NodeInfo {
	return {
		id: `n-${status}`,
		dockerId: '',
		partyId: 'p',
		profile: 'storage',
		status,
		spawnedAt: '',
		workdir: '',
		ports: { health: 0, metrics: 0, p2p: 0, ws: 0 },
	};
}

const REACHABLE = { directReachability: 'reachable' } as NatStatusSnapshot;
const UNREACHABLE = { directReachability: 'unreachable' } as NatStatusSnapshot;

describe('deriveOverallStatus', () => {
	it('is loading until connectivity has arrived', () => {
		expect(deriveOverallStatus(null, [node('running')], null)).toBe('loading');
	});

	it('is ok for a healthy host', () => {
		expect(deriveOverallStatus(REACHABLE, [node('running')], null)).toBe('ok');
	});

	it('warns when the host is unreachable from outside', () => {
		expect(deriveOverallStatus(UNREACHABLE, [node('running')], null)).toBe('warn');
	});

	it('warns a reachable host about a stopped node', () => {
		expect(deriveOverallStatus(REACHABLE, [node('running'), node('stopped')], null)).toBe('warn');
	});
});
