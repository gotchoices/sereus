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
 * WHY THE PROTOTYPE and not the node instances: a node now has exactly ONE
 * `Libp2pKeyPeerNetwork` — the node-attached instance (`createLibp2pNode` →
 * `node.keyNetwork`), which serves the coordinatedRepo (consensus cohort
 * derivation, member admission, `verifyResponsibility`), the cluster client
 * AND the transactor, because `quereus-plugin-optimystic`'s collection factory
 * (`resolveKeyNetwork('libp2p', node)`) prefers the attached instance instead
 * of building a second one from defaults. So an instance patch on
 * `node.keyNetwork` would in principle be enough now.
 *
 * The prototype patch stays because it is SIMPLER, not because it is required:
 * these helpers take a `CohortNodeSource` (a `CadreNode`, a harness
 * `TestCadreNode`, or a bare `Libp2p`) and only some of those expose the key
 * network at all — reaching each node's instance means widening that resolver
 * for no behavioural gain. It also still covers the cold-FRET problem in one
 * shot: the patch has to hold for every instance in the process for the whole
 * suite lifetime regardless, since each cohort member re-derives its own view.
 *
 * Two seams the patch must cover either way, and the reason `pinCoordinator`
 * overrides both: `NetworkTransactor.consolidateCoordinators` assigns each pend
 * batch by per-block `findCluster` and only falls back to `findCoordinator`
 * when that throws — so patching `findCoordinator` alone leaves which peer
 * coordinates each write a key-proximity draw the test does not control,
 * sticky across a suite (the hot control-tree block ids are stable, and the
 * key network also holds a per-key coordinator cache).
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
 *
 * RESTORE ORDERING. Three helpers now patch
 * `Libp2pKeyPeerNetwork.prototype.findCluster`, and two of them (`pinCoordinator`
 * here, `observeControlCohorts` in `control-cohort.ts`) WRAP whatever is
 * installed when they are applied. The rule is therefore: restore in REVERSE
 * order of application — last applied, first restored. Both helpers here patch
 * through `key-network-patch.ts`, so an out-of-order teardown throws naming the
 * rule rather than silently leaving a patched prototype behind for the rest of
 * the file.
 */

import { toString as u8ToString } from 'uint8arrays';
import type { Libp2p, PeerId } from '@libp2p/interface';
import type { ClusterPeers } from '@optimystic/db-core';
import type { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import type { CadreNode } from '@serfab/cadre-core';
import type { TestCadreNode } from './types.js';
import { patchKeyNetwork } from './key-network-patch.js';

type FindCoordinator = Libp2pKeyPeerNetwork['findCoordinator'];

/**
 * Anything these helpers can read a live control libp2p node out of: a
 * `CadreNode` (the `cadre-core` class, whose control node is behind
 * `getControlNode()`), a harness `TestCadreNode` (a bare node in a `TestParty`),
 * or a started `Libp2p` directly.
 */
export type CohortNodeSource = CadreNode | TestCadreNode | Libp2p;

/**
 * Resolve `node` to its started control libp2p node, or throw naming `who` and
 * the shape that was seen.
 *
 * The discrimination order below is unambiguous TODAY because `CadreNode`
 * exposes no `libp2p` property (its control node is the private `controlNode`,
 * reachable only via `getControlNode()`) and `TestCadreNode` has no
 * `getControlNode`. Adding either field to the other type would silently
 * re-route this resolver — so that has to be a conscious change, not a drive-by
 * one.
 */
function resolveControlLibp2p(node: CohortNodeSource, who: string): Libp2p {
	if (node === null || typeof node !== 'object') {
		throw new Error(`${who}: expected a node object; got ${node === null ? 'null' : typeof node}`);
	}
	if ('getControlNode' in node) {
		const controlNode = node.getControlNode();
		if (!controlNode) throw new Error(`${who}: node has no started control node`);
		return controlNode;
	}
	if ('libp2p' in node) {
		return node.libp2p;
	}
	if (!('peerId' in node) || typeof node.getMultiaddrs !== 'function') {
		throw new Error(
			`${who}: unrecognised node shape — expected a CadreNode (getControlNode), a `
			+ `TestCadreNode (libp2p) or a started Libp2p (peerId + getMultiaddrs); got keys `
			+ `[${Object.keys(node).join(', ')}]`);
	}
	return node;
}

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
export function forceFullCohort(nodes: readonly CohortNodeSource[]): ForcedCohortHandle {
	if (nodes.length === 0) throw new Error('forceFullCohort: empty node set');

	// Build the shared cohort map from live node state, failing loudly on any
	// entry that could not actually be dialled.
	const cohort: ClusterPeers = {};
	for (const node of nodes) {
		const controlNode = resolveControlLibp2p(node, 'forceFullCohort');
		const peerIdStr = controlNode.peerId.toString();
		// Two sources resolving to the same libp2p node would collapse into one cohort
		// entry, so the forced cohort would be SMALLER than the caller listed — exactly
		// the vacuous-consensus shape these helpers exist to rule out.
		if (peerIdStr in cohort) {
			throw new Error(`forceFullCohort: node ${peerIdStr} was listed twice — the forced cohort would be smaller than the node set`);
		}
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

	// Substitutes rather than wraps, so the installed `findCluster` is deliberately unused.
	const patch = patchKeyNetwork('forceFullCohort', 'findCluster', () =>
		async function (_key: Uint8Array): Promise<ClusterPeers> {
			calls++;
			sizes.push(Object.keys(cohort).length);
			// Fresh copy per call: callers may mutate the returned map.
			return Object.fromEntries(Object.entries(cohort).map(([id, p]) =>
				[id, { multiaddrs: [...p.multiaddrs], publicKey: p.publicKey }]));
		});

	return {
		restore: () => patch.restore(),
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
export function pinCoordinator(candidates: readonly CohortNodeSource[]): PinnedCoordinatorHandle {
	if (candidates.length === 0) throw new Error('pinCoordinator: empty candidate set');

	const candidatePeerIds: PeerId[] = candidates.map(
		(node) => resolveControlLibp2p(node, 'pinCoordinator').peerId);
	const candidateIdStrs = candidatePeerIds.map((p) => p.toString());

	let calls = 0;

	const coordinatorPatch = patchKeyNetwork('pinCoordinator', 'findCoordinator', () =>
		async function (_key: Uint8Array, options?: Parameters<FindCoordinator>[1]): Promise<PeerId> {
			calls++;
			const excluded = new Set((options?.excludedPeers ?? []).map((p) => p.toString()));
			const pick = candidatePeerIds.find((p) => !excluded.has(p.toString()));
			if (!pick) throw new Error('pinCoordinator: every pinned coordinator candidate is excluded');
			return pick;
		});

	const clusterPatch = patchKeyNetwork('pinCoordinator', 'findCluster', (inner) =>
		async function (this: Libp2pKeyPeerNetwork, key: Uint8Array): Promise<ClusterPeers> {
			const found = await inner.call(this, key);
			// Same members, candidates keyed first — steers set-cover assignment only.
			const reordered: ClusterPeers = {};
			for (const id of candidateIdStrs) {
				const peer = found[id];
				if (peer) reordered[id] = peer;
			}
			for (const [id, peer] of Object.entries(found)) {
				if (!(id in reordered)) reordered[id] = peer;
			}
			return reordered;
		});

	return {
		restore(): void {
			// Reverse order of application, the rule `key-network-patch.ts` enforces.
			clusterPatch.restore();
			coordinatorPatch.restore();
		},
		callCount: () => calls
	};
}
