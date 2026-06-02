/**
 * network.svelte.ts — control-network panel state.
 *
 * Phase 1 is a solo single-node cadre: the node self-seeds as its own authority
 * and there is nothing to bootstrap to, so the old Optimystic "paste a bootstrap
 * multiaddr → distributed" flow is gone. This store now holds the **Phase 2**
 * control-network seed input (disabled in the UI) so the panel is forward-ready:
 * Phase 2 (`reference-app-web-strand-formation-consent-rbac`) wires consent
 * formation, joining another party's cadre via a seed, and cross-party strands.
 */

interface NetworkState {
	/** Pasted control-network seed (base64url). Inert until Phase 2. */
	seedInput: string;
}

const state = $state<NetworkState>({
	seedInput: '',
});

export function networkState(): NetworkState {
	return state;
}

export function setSeedInput(value: string): void {
	state.seedInput = value;
}
