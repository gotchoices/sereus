/**
 * Observe and wait for a **control cohort** — the set of peers a control-database
 * write is offered to.
 *
 * WHAT A CONTROL COHORT IS. Every control-database block is replicated to a set of
 * peers derived by `Libp2pKeyPeerNetwork.findCluster(key)`; the write commits once a
 * super-majority of that set approves. A ONE-MEMBER cohort commits on the writer's own
 * vote (`allowClusterDownsize` defaults to true), so a control write that merely
 * *passes* proves nothing about how many machines took part. Anything asserting
 * multi-machine consensus has to establish the cohort size separately — that is what
 * this module is for.
 *
 * WAITING IS THE DEFAULT TOOL. The owner's FRET peer ring does reach every party
 * member within a few seconds of `createTestParty` resolving (measured: sub-second for a
 * three-node party, about five seconds worst observed). A single-member cohort right
 * after party creation is a START-UP RACE, not a permanent gap, so
 * {@link waitForControlCohort} — not a forced substitution — is the right instrument for
 * almost every scenario.
 *
 * FORCING IS A STOPGAP. `forceFullCohort` in `forced-cluster.ts` substitutes a
 * constant cohort. It buys determinism, and it is the ONLY way to reach a case a wait
 * can never satisfy: drones created by `createTestParty` dial only the owner and never
 * each other, so FRET on a drone can never classify a sibling drone and a
 * drone-coordinated write tops out at a two-member cohort forever. Prefer a wait; reach
 * for a force when the scenario genuinely needs the case a wait cannot produce.
 *
 * WHY ONE PROBE KEY IS ENOUGH. `findCluster` returns the ring's closest-k peers, where
 * k is the node's configured cluster size — `CONTROL_REPLICATION_BREADTH` (16) for
 * every control node the harness builds. In any party smaller than 16 nodes that
 * closest-16 set is simply EVERY peer FRET has classified as serving this network,
 * whatever key is asked about, so {@link CONTROL_COHORT_PROBE_KEY} is representative of
 * what any real control write would see. (The same bound is stated from the other side
 * in the `NOTE:` on `CONTROL_REPLICATION_BREADTH` in
 * `packages/quereus-plugin-sereus/src/cluster-size.ts`.) `findCluster` is also NOT
 * cached — only `findCoordinator` is — so polling one fixed key stays live and needs no
 * cache-busting key rotation.
 *
 * RESTORE ORDERING. {@link observeControlCohorts} patches
 * `Libp2pKeyPeerNetwork.prototype.findCluster`, wrapping whatever is installed at the
 * time — as do `forceFullCohort` and `pinCoordinator`. All three must be restored in
 * REVERSE order of application (last applied, first restored). All three go through
 * `key-network-patch.ts`, which throws naming the rule rather than leaving a patched
 * prototype behind for the rest of the file; the throw does not latch, so a `finally`
 * that unwinds the later patch can then restore the earlier one normally.
 *
 * PROCESS-WIDE CAVEAT. A prototype patch hits every `Libp2pKeyPeerNetwork` in the
 * process, including any strand-network instance a test creates. Vitest isolates test
 * files into their own workers, so the blast radius is one suite — but a suite with
 * live strand traffic should not observe or force while that traffic runs.
 *
 * OBSERVING A FORCED COHORT records the FORCED sizes: the observer wraps the installed
 * `findCluster`, which is the forcer's. An anti-vacuity assertion built on
 * {@link observeControlCohorts} while a force is active therefore proves nothing about
 * the real network. This is not detected at runtime; do not stack them by accident.
 */

import debug from 'debug';
import type { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import type { ClusterPeers } from '@optimystic/db-core';
import { waitUntil } from './wait-utils.js';
import type { WaitOptions } from './wait-utils.js';
import type { TestParty, TestCadreNode } from './types.js';
import { patchKeyNetwork } from './key-network-patch.js';

const log = debug('sereus:integration:cohort');

/**
 * The key every probe in this module asks about. See the file header for why the
 * choice does not matter in a party smaller than `CONTROL_REPLICATION_BREADTH` nodes.
 * Treat as immutable — it is shared by every caller.
 */
export const CONTROL_COHORT_PROBE_KEY: Uint8Array =
	new TextEncoder().encode('sereus-control-cohort-probe');

/** A generous multiple of the measured ring convergence (see the file header). */
const DEFAULT_COHORT_TIMEOUT_MS = 15_000;
const DEFAULT_COHORT_INTERVAL_MS = 250;

export interface ControlCohortOptions extends WaitOptions {
	/** Whose view of the cohort to observe. Default: `party.ownerNode`. */
	node?: TestCadreNode;
}

/**
 * The `Libp2pKeyPeerNetwork` `createLibp2pNode` attaches to the node it builds. Not on
 * libp2p's public `Libp2p` interface, so it is read through this narrow structural
 * shape rather than a cast to `any`.
 */
interface NodeWithKeyNetwork {
	keyNetwork?: Libp2pKeyPeerNetwork;
}

/**
 * The node-attached key network, or a named throw. Returning an empty cohort instead
 * would make {@link waitForControlCohort} poll to its timeout and then blame the
 * network for a wiring fault.
 */
function resolveKeyNetwork(node: TestCadreNode): Libp2pKeyPeerNetwork {
	const attached = (node.libp2p as unknown as NodeWithKeyNetwork).keyNetwork;
	if (!attached) {
		throw new Error(
			`control-cohort: node ${node.peerId} exposes no attached keyNetwork — `
			+ 'it was not built by createLibp2pNode, or optimystic stopped attaching it');
	}
	return attached;
}

/**
 * One-shot read of the peer ids `node` would currently offer a control write to.
 * Defaults to the party's owner node, the only node that can see every party member.
 */
export async function readControlCohort(
	party: TestParty, node: TestCadreNode = party.ownerNode
): Promise<string[]> {
	const members = await probeCohort(resolveKeyNetwork(node));
	log('party %s node %s cohort=%d %o', party.name, node.peerId, members.length, members);
	return members;
}

/** The one place {@link CONTROL_COHORT_PROBE_KEY} is asked about. */
async function probeCohort(keyNetwork: Libp2pKeyPeerNetwork): Promise<string[]> {
	return Object.keys(await keyNetwork.findCluster(CONTROL_COHORT_PROBE_KEY));
}

/**
 * Poll until the cohort `options.node` (default: the owner) would offer a control write
 * to holds at least `minPeers` members, and resolve to those member peer ids.
 *
 * Throws IMMEDIATELY — never after a timeout — when `minPeers` is below 1 or above the
 * party's own node count, so an unsatisfiable request is a fast, named failure.
 *
 * Starts and stops nothing: a party whose wait throws inside `beforeAll` still has all
 * its nodes running, so the caller's teardown must still call `shutdownTestParty` (and
 * hence `releasePorts`) on the failure path.
 */
export async function waitForControlCohort(
	party: TestParty, minPeers: number, options: ControlCohortOptions = {}
): Promise<string[]> {
	const node = options.node ?? party.ownerNode;
	const partyNodeCount = 1 + party.droneNodes.length;

	// Validate BEFORE polling: an impossible request must not burn a timeout.
	if (!Number.isInteger(minPeers) || minPeers < 1) {
		throw new Error(
			`waitForControlCohort: minPeers must be an integer >= 1 ("at least N members" has no `
			+ `meaning at zero); party ${party.name} was asked for ${minPeers}`);
	}
	// NOTE: this cap assumes the cohort can never exceed the party, which holds because
	// `findCluster` admits only peers serving THIS network's protocol and the party's
	// control network is named `control-<partyId>`. If a scenario ever puts a node into a
	// party's control network without listing it in `TestParty`, a legitimate wait would
	// throw here — take the count from the network rather than the party at that point.
	if (minPeers > partyNodeCount) {
		throw new Error(
			`waitForControlCohort: party ${party.name} has ${partyNodeCount} node(s) `
			+ `(1 owner + ${party.droneNodes.length} drone(s)), so a cohort of ${minPeers} can never form`);
	}

	// Resolve up front so a missing attachment throws here rather than being swallowed
	// by the poll loop (which treats a throwing condition as "not yet").
	const keyNetwork = resolveKeyNetwork(node);
	const {
		timeoutMs = DEFAULT_COHORT_TIMEOUT_MS,
		intervalMs = DEFAULT_COHORT_INTERVAL_MS,
		description = `control cohort of >= ${minPeers} at ${node.peerId} (party ${party.name})`
	} = options;

	let observed: string[] = [];
	// `waitUntil` swallows a throwing condition as "not yet" and reports only a generic
	// timeout, so a `findCluster` that fails EVERY poll would otherwise be reported as a
	// network that never converged. Carry the last failure into the message and the cause.
	let lastError: unknown;
	const startedAt = Date.now();
	try {
		await waitUntil(async () => {
			try {
				observed = await probeCohort(keyNetwork);
			} catch (error) {
				lastError = error;
				return false;
			}
			lastError = undefined;
			return observed.length >= minPeers;
		}, { timeoutMs, intervalMs, description });
	} catch (error) {
		// `waitUntil`'s generic message omits the observed size, which is the whole point.
		throw new Error(
			`waitForControlCohort: party ${party.name} node ${node.peerId} saw a cohort of `
			+ `${observed.length} (members: ${observed.join(', ') || 'none'}) after `
			+ `${Date.now() - startedAt}ms, needed ${minPeers} (budget ${timeoutMs}ms)`
			+ (lastError ? `; every poll FAILED, last error: ${String(lastError)}` : ''),
			{ cause: error });
	}
	return observed;
}

export interface ControlCohortObserverHandle {
	/** Restore the `findCluster` captured when observing began. Idempotent. */
	restore(): void;
	/**
	 * Total `findCluster` calls seen since observing began (all instances, all nodes).
	 * A call whose delegate THREW counts here but contributes no {@link cohortSizes}
	 * entry, so the two can legitimately differ in length.
	 */
	callCount(): number;
	/** Cohort size returned by each observed call that succeeded, in call order. */
	cohortSizes(): number[];
}

/**
 * Record — without substituting — every cohort the installed `findCluster` returns.
 *
 * The anti-vacuity instrument for WAIT-based tests, where `forceFullCohort`'s counters
 * do not apply because nothing is forced: it proves a write really consulted an N-peer
 * cohort rather than committing alone. Patches the PROTOTYPE for the same reason the
 * forcer does — each node has two `Libp2pKeyPeerNetwork` instances over the same libp2p
 * node and an instance patch would miss the transactor's (see the header of
 * `forced-cluster.ts`).
 */
export function observeControlCohorts(): ControlCohortObserverHandle {
	let calls = 0;
	const sizes: number[] = [];

	const patch = patchKeyNetwork('observeControlCohorts', 'findCluster', (inner) =>
		async function (this: Libp2pKeyPeerNetwork, key: Uint8Array): Promise<ClusterPeers> {
			calls++;
			const found = await inner.call(this, key);
			sizes.push(Object.keys(found).length);
			return found;
		});

	return {
		restore: () => patch.restore(),
		callCount: () => calls,
		cohortSizes: () => [...sizes]
	};
}
