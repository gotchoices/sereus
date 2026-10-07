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
	it('is loading until the role is known', () => {
		expect(deriveOverallStatus(null, REACHABLE, [node('running')], null)).toBe('loading');
	});

	it('is loading in either role until connectivity has arrived', () => {
		expect(deriveOverallStatus('donor', null, [node('running')], null)).toBe('loading');
		expect(deriveOverallStatus('founder', null, [node('running')], null)).toBe('loading');
	});

	it('is ok for a healthy donor', () => {
		expect(deriveOverallStatus('donor', REACHABLE, [node('running')], null)).toBe('ok');
	});

	it('warns either role when the host is unreachable from outside', () => {
		expect(deriveOverallStatus('donor', UNREACHABLE, [node('running')], null)).toBe('warn');
		expect(deriveOverallStatus('founder', UNREACHABLE, [node('running')], null)).toBe('warn');
	});

	it('warns a reachable founder about a stopped node', () => {
		expect(deriveOverallStatus('founder', REACHABLE, [node('running'), node('stopped')], null)).toBe('warn');
	});

	it('ignores a donor owner node left stopped by an earlier founder run', () => {
		expect(deriveOverallStatus('donor', REACHABLE, [node('running'), { ...node('stopped'), owner: true }], null)).toBe('ok');
	});
});
