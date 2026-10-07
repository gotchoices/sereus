import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from '@optimystic/quereus-plugin-crypto';
import { claimSecretTrustPolicy, type SeedTrustContext } from '../src/seed-trust-policy.js';
import { claimProof, parseClaimSecret } from '../src/claim-proof.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore } from '../src/trusted-owner-store.js';

const PARTY = 'party-claim';
const NODE = '12D3KooWClaimedNode';
const DIGEST = 'seed-digest-b64url';
const OWNER_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function freshSecret(): Uint8Array {
	return parseClaimSecret(randomBytes(256, 'base64url') as string);
}

/**
 * The context `verifyAndMergeSeed` would build: the anchor snapshot is taken NOW, so a
 * context built before another evaluation ran does not see what that evaluation anchored.
 */
function contextFor(store: TrustedOwnerStore, signerKey: string, proof?: string): SeedTrustContext {
	return {
		partyId: PARTY,
		signerKey,
		knownOwnerKeys: store.all(),
		localPeerId: NODE,
		seedDigest: DIGEST,
		claimProof: proof,
		remotePeerId: 'phone-peer',
	};
}

describe('claimSecretTrustPolicy', () => {
	it('two claimants racing with valid proofs: one is trusted, the other is already-claimed, the anchor holds one key', async () => {
		const secret = freshSecret();
		const store = new MemoryTrustedOwnerStore(PARTY);
		const policy = claimSecretTrustPolicy({ secret, trustedOwners: store });
		// Both contexts see an empty anchor; only the latch, set before the first await,
		// separates them.
		const a = contextFor(store, OWNER_A, claimProof(secret, NODE, OWNER_A, DIGEST));
		const b = contextFor(store, OWNER_B, claimProof(secret, NODE, OWNER_B, DIGEST));

		const [first, second] = await Promise.all([policy.evaluate(a), policy.evaluate(b)]);

		expect(first).toEqual({ trusted: true });
		expect(second).toMatchObject({ trusted: false, code: 'already-claimed' });
		expect(store.all()).toEqual(new Set([OWNER_A]));
	});

	it('wrong proofs are refused, trip the rate limit at the failure limit, and the limit lifts after the window', async () => {
		const secret = freshSecret();
		const store = new MemoryTrustedOwnerStore(PARTY);
		let clock = 1_000_000;
		const policy = claimSecretTrustPolicy({
			secret, trustedOwners: store, failureLimit: 3, failureWindowMs: 60_000, now: () => clock,
		});
		const wrong = claimProof(freshSecret(), NODE, OWNER_A, DIGEST);
		const right = claimProof(secret, NODE, OWNER_A, DIGEST);

		for (let i = 0; i < 3; i++) {
			expect(await policy.evaluate(contextFor(store, OWNER_A, wrong))).toMatchObject({ trusted: false, code: 'claim-proof-invalid' });
		}
		expect(store.all().size).toBe(0);
		expect(await policy.evaluate(contextFor(store, OWNER_A, right))).toMatchObject({ trusted: false, code: 'claim-rate-limited' });

		clock += 60_000;
		expect(await policy.evaluate(contextFor(store, OWNER_A, right))).toEqual({ trusted: true });
		expect(store.all()).toEqual(new Set([OWNER_A]));
	});

	it('the same owner re-sending after a dropped response is trusted each time and anchored once', async () => {
		const secret = freshSecret();
		const store = new MemoryTrustedOwnerStore(PARTY);
		const trust = vi.spyOn(store, 'trust');
		const onClaimed = vi.fn();
		const policy = claimSecretTrustPolicy({ secret, trustedOwners: store, onClaimed });
		const proof = claimProof(secret, NODE, OWNER_A, DIGEST);
		// The re-send that lands while the first persist is in flight: answered by the latch.
		const first = contextFor(store, OWNER_A, proof);
		const whilePersisting = contextFor(store, OWNER_A, proof);

		expect(await Promise.all([policy.evaluate(first), policy.evaluate(whilePersisting)]))
			.toEqual([{ trusted: true }, { trusted: true }]);
		// The re-send after the anchor holds the key: answered by the anchor, no proof needed.
		expect(await policy.evaluate(contextFor(store, OWNER_A))).toEqual({ trusted: true });

		expect(trust).toHaveBeenCalledTimes(1);
		expect(onClaimed).toHaveBeenCalledTimes(1);
		expect(onClaimed).toHaveBeenCalledWith(OWNER_A);
	});

	it('a claim whose persist fails is rolled back: claim-not-persisted, nothing anchored, and the node can still be claimed', async () => {
		const secret = freshSecret();
		const store = new MemoryTrustedOwnerStore(PARTY);
		let persistFails = true;
		const flaky: TrustedOwnerStore = {
			partyId: PARTY,
			has: (key) => store.has(key),
			all: () => store.all(),
			trust: async (key, source) => {
				await store.trust(key, source);
				if (persistFails) throw new Error('disk full');
			},
			remove: (key) => store.remove(key),
		};
		const onClaimed = vi.fn();
		const policy = claimSecretTrustPolicy({ secret, trustedOwners: flaky, onClaimed });

		const refused = await policy.evaluate(contextFor(flaky, OWNER_A, claimProof(secret, NODE, OWNER_A, DIGEST)));
		expect(refused).toMatchObject({ trusted: false, code: 'claim-not-persisted' });
		expect(store.all().size).toBe(0);
		expect(onClaimed).not.toHaveBeenCalled();

		// The latch cleared with the rollback: a different owner can claim now.
		persistFails = false;
		expect(await policy.evaluate(contextFor(flaky, OWNER_B, claimProof(secret, NODE, OWNER_B, DIGEST)))).toEqual({ trusted: true });
		expect(store.all()).toEqual(new Set([OWNER_B]));
	});

	it('an unclaimed node refuses a seed that carries no proof as claim-proof-invalid', async () => {
		const store = new MemoryTrustedOwnerStore(PARTY);
		const policy = claimSecretTrustPolicy({ secret: freshSecret(), trustedOwners: store });

		expect(await policy.evaluate(contextFor(store, OWNER_A))).toMatchObject({ trusted: false, code: 'claim-proof-invalid' });
		expect(store.all().size).toBe(0);
	});

	it('a claimed node refuses another owner\'s valid proof as already-claimed: the secret is spent', async () => {
		const secret = freshSecret();
		const store = new MemoryTrustedOwnerStore(PARTY);
		await store.trust(OWNER_A, 'claim');
		const policy = claimSecretTrustPolicy({ secret, trustedOwners: store });

		const decision = await policy.evaluate(contextFor(store, OWNER_B, claimProof(secret, NODE, OWNER_B, DIGEST)));

		expect(decision).toMatchObject({ trusted: false, code: 'already-claimed' });
		expect(store.all()).toEqual(new Set([OWNER_A]));
	});
});
