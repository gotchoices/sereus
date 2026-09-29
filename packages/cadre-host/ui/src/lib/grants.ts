/**
 * Pure helpers for the Grants page — kept out of the component so they run in a
 * plain Vitest environment.
 */

import type { DonationStatus, GrantListing } from './state.svelte.js';

export type GrantState = 'active' | 'expired' | 'revoked';

/**
 * Where a grant stands at `now`. Revocation is checked before expiry, matching
 * the server's `GrantService.validate`, so a grant that is both reads as revoked.
 * The browser and the host are the same machine, so their clocks agree.
 */
export function grantState(grant: Pick<GrantListing, 'expiresAt' | 'revokedAt'>, now: number = Date.now()): GrantState {
	if (grant.revokedAt) return 'revoked';
	if (grant.expiresAt) {
		const expiresAt = Date.parse(grant.expiresAt);
		if (Number.isFinite(expiresAt) && now > expiresAt) return 'expired';
	}
	return 'active';
}

const STATE_ORDER: Record<GrantState, number> = { active: 0, expired: 1, revoked: 2 };

/** Active grants first, then expired, then revoked; newest first within each. */
export function sortGrants(grants: readonly GrantListing[], now: number = Date.now()): GrantListing[] {
	return [...grants].sort((a, b) =>
		STATE_ORDER[grantState(a, now)] - STATE_ORDER[grantState(b, now)]
		|| Date.parse(b.createdAt) - Date.parse(a.createdAt),
	);
}

/** Plain words for a donation's status on the Grants page. */
export const DONATION_STATUS_LABEL: Record<DonationStatus, string> = {
	provisioning: 'starting',
	awaiting_seed: 'waiting for their device',
	seeded: 'in use',
	error: 'failed',
	terminated: 'shut down',
};

/**
 * Whether the orchestrator is holding a node for this donation, so its detail
 * page exists. A `provisioning` one may not have a node yet and an `error` one may
 * not any more; linking either would land on a "not found" toast.
 */
export function donationHasNode(status: DonationStatus): boolean {
	return status === 'awaiting_seed' || status === 'seeded';
}
