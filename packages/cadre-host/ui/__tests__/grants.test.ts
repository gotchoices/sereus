import { describe, expect, it } from 'vitest';

import { grantState } from '../src/lib/grants.js';

describe('grantState', () => {
	it('reports revoked before expired, and treats a future or absent expiry as active', () => {
		const now = Date.parse('2026-09-29T12:00:00Z');
		const past = '2026-09-01T00:00:00Z';
		const future = '2026-10-01T00:00:00Z';

		expect(grantState({ expiresAt: past, revokedAt: past }, now)).toBe('revoked');
		expect(grantState({ expiresAt: past }, now)).toBe('expired');
		expect(grantState({ expiresAt: future }, now)).toBe('active');
		expect(grantState({}, now)).toBe('active');
	});
});
