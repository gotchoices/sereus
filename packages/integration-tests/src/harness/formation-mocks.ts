/**
 * In-memory stand-ins for the two collaborators strand formation needs: the
 * provisioner that mints strand ids, and the usage recorder that tracks invite
 * tokens. Both are deliberately trivial and deterministic — a scenario asserting
 * on formation wants a predictable strand id and a token ledger it can inspect,
 * not a realistic implementation.
 */

import type { FormationUsageRecorder, StrandProvisioner } from '@serfab/cadre-core';

/**
 * Deterministic strand provisioner: hands out `strand-${prefix}-1`, `-2`, … in call
 * order. `prefix` is required so two scenarios sharing a process never mint the same
 * strand id, and so a failure message names the scenario that minted it.
 */
export function createMockProvisioner(prefix: string): StrandProvisioner {
	let counter = 0;
	return {
		provisionStrand: async (_sAppId, _initiatorKey, _responderKey) => ({
			strandId: `strand-${prefix}-${++counter}`,
		}),
	};
}

/**
 * In-memory usage recorder that tracks tokens. The returned object exposes its two
 * backing collections directly — callers seed `knownTokens` to make a token valid and
 * read `usedTokens` to assert on redemption — so the intersection return type is part
 * of the contract, not an implementation detail.
 */
export function createMockUsageRecorder(): FormationUsageRecorder & {
	knownTokens: Set<string>;
	usedTokens: Map<string, { peerKey: string; strandId: string }>;
} {
	const knownTokens = new Set<string>();
	const usedTokens = new Map<string, { peerKey: string; strandId: string }>();

	return {
		knownTokens,
		usedTokens,
		recordUsage: async ({ token, peerKey, strandId }) => {
			usedTokens.set(token, { peerKey, strandId });
		},
		isTokenUsed: async (token) => usedTokens.has(token),
		isTokenValid: async (token) => ({
			valid: knownTokens.has(token),
		}),
	};
}
