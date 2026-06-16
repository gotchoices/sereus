// TEMPORARY review smoke — DELETE after running. Validates the e2e responder
// fixture boots in a Node runtime and produces well-formed outputs.
import { describe, it, expect } from 'vitest';
import { startFormationResponder } from '../../../reference-app-web/e2e/fixtures/formation-responder.js';

describe('formation-responder fixture (review smoke)', () => {
	it('boots and exposes a well-formed handle', async () => {
		const h = await startFormationResponder();
		try {
			expect(h.encoded.length).toBeGreaterThan(0);
			expect(h.expiredEncoded.length).toBeGreaterThan(0);
			expect(h.encoded).not.toEqual(h.expiredEncoded);
			expect(h.strandId.length).toBeGreaterThan(0);

			// Both invitations must decode (well-formed), and the expired one's
			// expiration must actually be in the past.
			const dec = (e: string) => JSON.parse(Buffer.from(e, 'base64url').toString('utf8'));
			const valid = dec(h.encoded);
			const expired = dec(h.expiredEncoded);
			expect(new Date(valid.expiration).getTime()).toBeGreaterThan(Date.now());
			expect(new Date(expired.expiration).getTime()).toBeLessThan(Date.now());

			// control vs strand addr sets are non-empty, all /ws, and disjoint.
			expect(h.controlMultiaddrs.length).toBeGreaterThan(0);
			expect(h.strandMultiaddrs.length).toBeGreaterThan(0);
			expect(h.controlMultiaddrs.every((a) => a.includes('/ws'))).toBe(true);
			expect(h.strandMultiaddrs.every((a) => a.includes('/ws'))).toBe(true);
			const overlap = h.controlMultiaddrs.filter((a) => h.strandMultiaddrs.includes(a));
			expect(overlap).toEqual([]);

			// seed content fixed at boot, id empty until seeded.
			expect(h.seededMessage.content.length).toBeGreaterThan(0);
			expect(h.seededMessage.id).toEqual('');

			// fresh strand + control: nothing seeded, nothing redeemed yet.
			expect(await h.readStrandMessages()).toEqual([]);
			expect(await h.readFormationUsage()).toEqual([]);

			// the valid invitation embeds the responder's control addrs.
			expect(valid.bootstrap).toEqual(h.controlMultiaddrs);
		} finally {
			await h.stop();
		}
	}, 60_000);
});
