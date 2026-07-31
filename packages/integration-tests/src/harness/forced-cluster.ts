/**
 * Force a deterministic multi-peer control cohort onto a set of running
 * `CadreNode`s by replacing `findCluster` on each node's key network.
 *
 * Why this exists: FRET's routing table is not warm inside a test's lifetime,
 * so the real `Libp2pKeyPeerNetwork.findCluster` returns a self-only cohort for
 * essentially every control write a test can issue (see the measurement note in
 * `test-party.ts` — 213/213 single-peer cohorts across a happy-path run). A
 * self-only cohort never reaches the super-majority branch of
 * `ClusterCoordinator`, so any test about multi-member write consensus is
 * vacuous without this patch.
 *
 * What the patch substitutes — and what it deliberately does NOT touch:
 * `createLibp2pNode` attaches the SAME `Libp2pKeyPeerNetwork` instance to the
 * returned node (`node.keyNetwork`) that the coordinator repo captured, so an
 * own-property override of `findCluster` on that instance substitutes cohort
 * *discovery* only. The real `ClusterClient` (with its production dial/response
 * deadlines), the real libp2p transports, and the real `ClusterMember` on every
 * peer all stay in place. `findCoordinator` is intentionally left unpatched.
 *
 * The patch must be applied to EVERY node in the cohort, not only the writer:
 * each member independently re-derives its own view through the same
 * `findCluster` (`deriveExpectedCluster` → `ClusterMember.admitMembership`) and
 * gates the coordinator's declared peer set against it. With only the writer
 * patched, the members' self-only derived views make admission depend on FRET's
 * network-size confidence — which a test does not control.
 */

import { toString as u8ToString } from 'uint8arrays';
import type { ClusterPeers } from '@optimystic/db-core';
import type { CadreNode } from '@serfab/cadre-core';

/** The seam this helper patches on each control node's key network. */
interface PatchableKeyNetwork {
	findCluster(key: Uint8Array): Promise<ClusterPeers>;
}

export interface ForcedCohortHandle {
	/**
	 * Remove the override from every patched node (delete the own property, so
	 * the prototype's real `findCluster` shows through again). Idempotent.
	 */
	restore(): void;
	/** Total forced `findCluster` calls across all patched nodes since forcing. */
	callCount(): number;
	/**
	 * Cohort size returned by each forced call, in call order — the anti-vacuity
	 * record: a write that consulted the forced cohort shows calls of size N here.
	 */
	cohortSizes(): number[];
}

/**
 * Replace `findCluster` on EVERY supplied node's key network with a constant
 * cohort spanning all of them, built from each node's live control-network
 * state (its current listen multiaddrs and its peer id's public key — the same
 * fields the real `findCluster` emits).
 *
 * Every node must be started and must hold at least one control multiaddr: an
 * addressless forced entry would surface as `no valid addresses` dial failures
 * downstream, which look exactly like the degradation such tests inject.
 */
export function forceFullCohort(nodes: readonly CadreNode[]): ForcedCohortHandle {
	if (nodes.length === 0) throw new Error('forceFullCohort: empty node set');

	// Build the shared cohort map from live node state, failing loudly on any
	// entry that could not actually be dialled.
	const cohort: ClusterPeers = {};
	for (const node of nodes) {
		const controlNode = node.getControlNode();
		if (!controlNode) throw new Error('forceFullCohort: node has no started control node');
		const peerIdStr = controlNode.peerId.toString();
		const multiaddrs = controlNode.getMultiaddrs().map((ma) => ma.toString());
		if (multiaddrs.length === 0) {
			throw new Error(`forceFullCohort: node ${peerIdStr} has no control multiaddrs — a forced addressless entry would masquerade as a dial failure`);
		}
		const raw = controlNode.peerId.publicKey?.raw;
		if (!raw || raw.length === 0) {
			throw new Error(`forceFullCohort: node ${peerIdStr} exposes no public key`);
		}
		cohort[peerIdStr] = { multiaddrs, publicKey: u8ToString(raw, 'base64url') };
	}

	let calls = 0;
	const sizes: number[] = [];

	const patched: PatchableKeyNetwork[] = [];
	for (const node of nodes) {
		const keyNetwork = (node.getControlNode() as unknown as { keyNetwork?: PatchableKeyNetwork }).keyNetwork;
		if (!keyNetwork) throw new Error('forceFullCohort: control node exposes no keyNetwork');
		// Own-property override shadows the prototype method; restore() deletes it
		// (never reassign the unbound original — it belongs to the prototype).
		keyNetwork.findCluster = async (_key: Uint8Array): Promise<ClusterPeers> => {
			calls++;
			sizes.push(Object.keys(cohort).length);
			// Fresh copy per call: callers may mutate the returned map.
			return Object.fromEntries(Object.entries(cohort).map(([id, p]) =>
				[id, { multiaddrs: [...p.multiaddrs], publicKey: p.publicKey }]));
		};
		patched.push(keyNetwork);
	}

	let restored = false;
	return {
		restore(): void {
			if (restored) return;
			restored = true;
			for (const keyNetwork of patched) {
				delete (keyNetwork as { findCluster?: unknown }).findCluster;
			}
		},
		callCount: () => calls,
		cohortSizes: () => [...sizes]
	};
}
