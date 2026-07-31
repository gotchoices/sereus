/**
 * Force a deterministic multi-peer control cohort — and a deterministic batch
 * coordinator — onto a set of running `CadreNode`s by patching
 * `Libp2pKeyPeerNetwork.prototype` for the suite's lifetime.
 *
 * Why this exists: FRET's routing table is not warm inside a test's lifetime,
 * so the real `Libp2pKeyPeerNetwork.findCluster` returns a self-only cohort for
 * essentially every control write a test can issue (see the measurement note in
 * `test-party.ts` — 213/213 single-peer cohorts across a happy-path run). A
 * self-only cohort never reaches the super-majority branch of
 * `ClusterCoordinator`, so any test about multi-member write consensus is
 * vacuous without this patch.
 *
 * WHY THE PROTOTYPE and not the node instances: every node has TWO
 * `Libp2pKeyPeerNetwork` instances over the same libp2p node —
 *
 *  1. the node-attached instance (`createLibp2pNode` → `node.keyNetwork`),
 *     which serves the coordinatedRepo (consensus cohort derivation, member
 *     admission, `verifyResponsibility`) and the cluster client; and
 *  2. a FRESH default-args instance created by the quereus-plugin collection
 *     factory (`resolveKeyNetwork('libp2p', node)` in
 *     `quereus-plugin-optimystic`'s collection-factory) and cached with the
 *     `NetworkTransactor` — every transactor-level `findCluster` /
 *     `findCoordinator` goes through THIS one.
 *
 * An instance patch on `node.keyNetwork` (this helper's original shape) covers
 * only (1): consensus ran against the forced trio, but the transactor's
 * coordinator ASSIGNMENT — `NetworkTransactor.consolidateCoordinators`, which
 * calls `findCluster` per block on instance (2) and only falls back to
 * `findCoordinator` when that throws — kept following the real (cold-FRET)
 * network, so which peer coordinated each write stayed a key-proximity draw
 * the test did not control, sticky across a suite (the hot control-tree block
 * ids are stable, and instance (2) also holds a per-key coordinator cache).
 * A prototype patch covers both instances on every node at once.
 *
 * What the patch substitutes — and what it deliberately does NOT touch: cohort
 * DISCOVERY only. The real `ClusterClient` (with its production dial/response
 * deadlines), the real libp2p transports, and the real `ClusterMember` on every
 * peer all stay in place. The forced cohort must span EVERY node in the trio
 * because each member independently re-derives its own view through the same
 * `findCluster` (`deriveExpectedCluster` → `ClusterMember.admitMembership`) and
 * gates the coordinator's declared peer set against it — the prototype patch
 * gives all of them the same view by construction.
 *
 * Process-wide caveat: a prototype patch hits every `Libp2pKeyPeerNetwork` in
 * the process — including any strand-network instances a test might create.
 * Vitest isolates test files into their own workers, so the blast radius is
 * one suite; suites that create strand databases should not use these helpers
 * while strand traffic is live.
 */

import { toString as u8ToString } from 'uint8arrays';
import type { PeerId } from '@libp2p/interface';
import type { ClusterPeers } from '@optimystic/db-core';
import { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import type { CadreNode } from '@serfab/cadre-core';

type FindCluster = Libp2pKeyPeerNetwork['findCluster'];
type FindCoordinator = Libp2pKeyPeerNetwork['findCoordinator'];

export interface ForcedCohortHandle {
	/** Restore the real prototype `findCluster`. Idempotent. */
	restore(): void;
	/** Total forced `findCluster` calls (all instances, all nodes) since forcing. */
	callCount(): number;
	/**
	 * Cohort size returned by each forced call, in call order — the anti-vacuity
	 * record: a write that consulted the forced cohort shows calls of size N here.
	 */
	cohortSizes(): number[];
}

/**
 * Replace `Libp2pKeyPeerNetwork.prototype.findCluster` with a constant cohort
 * spanning all of `nodes`, built from each node's live control-network state
 * (its current listen multiaddrs and its peer id's public key — the same fields
 * the real `findCluster` emits). Cohort keys are ordered as `nodes` is.
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

	const original: FindCluster = Libp2pKeyPeerNetwork.prototype.findCluster;
	Libp2pKeyPeerNetwork.prototype.findCluster = async function (_key: Uint8Array): Promise<ClusterPeers> {
		calls++;
		sizes.push(Object.keys(cohort).length);
		// Fresh copy per call: callers may mutate the returned map.
		return Object.fromEntries(Object.entries(cohort).map(([id, p]) =>
			[id, { multiaddrs: [...p.multiaddrs], publicKey: p.publicKey }]));
	};

	let restored = false;
	return {
		restore(): void {
			if (restored) return;
			restored = true;
			Libp2pKeyPeerNetwork.prototype.findCluster = original;
		},
		callCount: () => calls,
		cohortSizes: () => [...sizes]
	};
}

export interface PinnedCoordinatorHandle {
	/** Restore both prototype methods to what they were at pin time. Idempotent. */
	restore(): void;
	/** Total pinned `findCoordinator` calls (all instances, all nodes) since pinning. */
	callCount(): number;
}

/**
 * Pin the batch coordinator to `candidates` (in order) on every
 * `Libp2pKeyPeerNetwork` instance in the process. Two prototype overrides,
 * because the transactor picks its coordinator through two seams:
 *
 *  1. `findCoordinator` — the fallback/retry/read seam — returns the first
 *     candidate the caller's `excludedPeers` does not name. Preserves the
 *     transactor's re-coordination semantics (a failed coordinator is excluded
 *     on retry, so the next candidate serves); when every candidate is
 *     excluded it throws, which the transactor treats the same as FRET running
 *     out of coordinators — the original first-attempt error stays
 *     authoritative.
 *  2. `findCluster` — the PRIMARY seam for writes:
 *     `NetworkTransactor.consolidateCoordinators` assigns each pend batch by
 *     greedy set cover over per-block `findCluster` results and never consults
 *     `findCoordinator` when those succeed. The cover keeps the FIRST peer
 *     (in key insertion order) among those tied on coverage, so this override
 *     wraps whatever `findCluster` is in place (apply `forceFullCohort`
 *     first!) and re-keys its result candidates-first. Cohort MEMBERSHIP is
 *     untouched — only the order, i.e. only who coordinates.
 *
 * The set-cover tie-break is an optimystic internal; if it ever stops
 * preferring the first-inserted peer, a degradation suite pinned to a healthy
 * candidate fails loudly (the degraded node starts coordinating and the
 * must-fail cases commit fast — the exact symptom this pin exists to remove).
 *
 * Restore order: `restore()` reinstates the methods captured at pin time, so
 * unpin BEFORE un-forcing the cohort.
 *
 * Use `candidates` = a healthy node to force a degradation scenario down its
 * worst-case branch deterministically (see the file header).
 */
export function pinCoordinator(candidates: readonly CadreNode[]): PinnedCoordinatorHandle {
	if (candidates.length === 0) throw new Error('pinCoordinator: empty candidate set');

	const candidatePeerIds: PeerId[] = candidates.map((node) => {
		const controlNode = node.getControlNode();
		if (!controlNode) throw new Error('pinCoordinator: candidate has no started control node');
		return controlNode.peerId;
	});
	const candidateIdStrs = candidatePeerIds.map((p) => p.toString());

	let calls = 0;

	const originalFindCoordinator: FindCoordinator = Libp2pKeyPeerNetwork.prototype.findCoordinator;
	Libp2pKeyPeerNetwork.prototype.findCoordinator = async function (
		_key: Uint8Array, options?: Parameters<FindCoordinator>[1]
	): Promise<PeerId> {
		calls++;
		const excluded = new Set((options?.excludedPeers ?? []).map((p) => p.toString()));
		const pick = candidatePeerIds.find((p) => !excluded.has(p.toString()));
		if (!pick) throw new Error('pinCoordinator: every pinned coordinator candidate is excluded');
		return pick;
	};

	const innerFindCluster: FindCluster = Libp2pKeyPeerNetwork.prototype.findCluster;
	Libp2pKeyPeerNetwork.prototype.findCluster = async function (key: Uint8Array): Promise<ClusterPeers> {
		const found = await innerFindCluster.call(this, key);
		// Same members, candidates keyed first — steers set-cover assignment only.
		const reordered: ClusterPeers = {};
		for (const id of candidateIdStrs) {
			if (found[id]) reordered[id] = found[id];
		}
		for (const [id, peer] of Object.entries(found)) {
			if (!(id in reordered)) reordered[id] = peer;
		}
		return reordered;
	};

	let restored = false;
	return {
		restore(): void {
			if (restored) return;
			restored = true;
			Libp2pKeyPeerNetwork.prototype.findCoordinator = originalFindCoordinator;
			Libp2pKeyPeerNetwork.prototype.findCluster = innerFindCluster;
		},
		callCount: () => calls
	};
}
