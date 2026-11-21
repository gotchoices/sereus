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
 * constant cohort. It buys determinism: the selection no longer depends on ring timing.
 * A wait reaches the whole party from every machine — drones created by
 * `createTestParty` dial only the owner, but learn each other's addresses from FRET's
 * neighbour snapshots and dial each other. Prefer a wait; reach for a force when the
 * scenario needs a selection that cannot vary between runs.
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
 * ONE EXCEPTION. {@link waitForCohortAgreement} asks about SEVERAL keys, and not because
 * one is unrepresentative: it needs the selection to VARY between coordinates, which is
 * exactly what the bound above denies. Its own doc carries that argument; do not read this
 * paragraph as covering it.
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
import type { Libp2p } from '@libp2p/interface';
import type { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import { routingKeyForBlock } from '@optimystic/db-core';
import type { ClusterPeers, RoutingKey } from '@optimystic/db-core';
import { waitUntil } from './wait-utils.js';
import type { WaitOptions } from './wait-utils.js';
import type { TestParty, TestCadreNode } from './types.js';
import { patchKeyNetwork } from './key-network-patch.js';

const log = debug('sereus:integration:cohort');

/**
 * The key every probe in this module asks about. See the file header for why the
 * choice does not matter in a party smaller than `CONTROL_REPLICATION_BREADTH` nodes.
 * Treat as immutable — it is shared by every caller.
 *
 * Minted through `routingKeyForBlock` rather than hand-encoded because that is the only
 * sanctioned way to obtain a `RoutingKey`: the key network hashes the key it is handed
 * exactly once, so a probe that pre-hashed (or that was smuggled past the brand with a
 * cast) would land on a different ring coordinate than a real write's and stop being
 * representative of one. The bytes are the same utf8 the previous literal produced.
 */
export const CONTROL_COHORT_PROBE_KEY: RoutingKey =
	routingKeyForBlock('sereus-control-cohort-probe');

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
function resolveKeyNetwork(libp2p: Libp2p, label: string): Libp2pKeyPeerNetwork {
	const attached = (libp2p as Libp2p & NodeWithKeyNetwork).keyNetwork;
	if (!attached) {
		throw new Error(
			`control-cohort: ${label} exposes no attached keyNetwork — `
			+ 'it was not built by createLibp2pNode, or optimystic stopped attaching it');
	}
	return attached;
}

/**
 * One-shot read of the peer ids a libp2p node would currently offer a write to, for ANY
 * Optimystic network — control or strand. The strand case is why this is separate from
 * {@link readControlCohort}: a strand node is a bare libp2p node, not a `TestCadreNode`.
 *
 * The probe-key argument in the file header applies here too, with the strand's own
 * breadth in place of the control one: `findCluster` returns the ring's closest-k peers
 * where k is the node's configured cluster size, so on a strand smaller than
 * `DEFAULT_STRAND_CLUSTER_SIZE` (4) that set is every peer FRET has classified as serving
 * the strand, whatever key is asked about.
 */
export async function readCohort(libp2p: Libp2p, label = 'node'): Promise<string[]> {
	const members = await probeCohort(resolveKeyNetwork(libp2p, label));
	log('%s cohort=%d %o', label, members.length, members);
	return members;
}

/**
 * One-shot read of the peer ids `node` would currently offer a control write to.
 * Defaults to the party's owner node, the only node that can see every party member.
 */
export async function readControlCohort(
	party: TestParty, node: TestCadreNode = party.ownerNode
): Promise<string[]> {
	const members = await readCohort(node.libp2p, `party ${party.name} node ${node.peerId}`);
	return members;
}

/** The one place a probe key is asked about; {@link CONTROL_COHORT_PROBE_KEY} unless one is named. */
async function probeCohort(
	keyNetwork: Libp2pKeyPeerNetwork, key: RoutingKey = CONTROL_COHORT_PROBE_KEY
): Promise<string[]> {
	return Object.keys(await keyNetwork.findCluster(key));
}

/**
 * Poll until `libp2p`'s cohort for the shared probe key holds at least `minPeers`
 * members, and resolve to those member peer ids. Works for ANY node built by
 * `createLibp2pNode` — control or strand — which is why it takes a bare `Libp2p`
 * rather than a `TestParty` (see {@link readCohort} for the same split on the
 * one-shot side). The one-probe-key representativeness bound from the file header
 * carries over: valid below `CONTROL_REPLICATION_BREADTH` (16) on control networks
 * and below `DEFAULT_STRAND_CLUSTER_SIZE` (4) on strands.
 *
 * Throws IMMEDIATELY — never after a timeout — when `minPeers` is below 1. It cannot
 * know the network's size, so an ask larger than the network burns its timeout here;
 * upper-bound validation belongs to wrappers that do know the size
 * ({@link waitForControlCohort}).
 *
 * `options.label` names the node in every failure message; pass something a reader
 * can trace back to a machine ("party alpha machine 2", "strand node of B").
 */
export async function waitForCohortOn(
	libp2p: Libp2p, minPeers: number, options: WaitOptions & { label?: string } = {}
): Promise<string[]> {
	const label = options.label ?? 'node';

	// Validate BEFORE polling: an impossible request must not burn a timeout.
	if (!Number.isInteger(minPeers) || minPeers < 1) {
		throw new Error(
			`waitForCohortOn: minPeers must be an integer >= 1 ("at least N members" has no `
			+ `meaning at zero); ${label} was asked for ${minPeers}`);
	}

	// Resolve up front so a missing attachment throws here rather than being swallowed
	// by the poll loop (which treats a throwing condition as "not yet").
	const keyNetwork = resolveKeyNetwork(libp2p, label);
	const {
		timeoutMs = DEFAULT_COHORT_TIMEOUT_MS,
		intervalMs = DEFAULT_COHORT_INTERVAL_MS,
		description = `cohort of >= ${minPeers} at ${label}`
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
			`waitForCohortOn: ${label} saw a cohort of `
			+ `${observed.length} (members: ${observed.join(', ') || 'none'}) after `
			+ `${Date.now() - startedAt}ms, needed ${minPeers} (budget ${timeoutMs}ms)`
			+ (lastError ? `; every poll FAILED, last error: ${String(lastError)}` : ''),
			{ cause: error });
	}
	return observed;
}

/**
 * Poll until the cohort `options.node` (default: the owner) would offer a control write
 * to holds at least `minPeers` members, and resolve to those member peer ids.
 *
 * Throws IMMEDIATELY — never after a timeout — when `minPeers` is below 1 or above the
 * party's own node count, so an unsatisfiable request is a fast, named failure. The
 * polling core is {@link waitForCohortOn}; this wrapper adds only the upper bound,
 * because only it knows the party's size.
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

	// NOTE: this cap assumes the cohort can never exceed the party, which holds because
	// `findCluster` admits only peers serving THIS network's protocol and the party's
	// control network is named `control-<partyId>`. If a scenario ever puts a node into a
	// party's control network without listing it in `TestParty`, a legitimate wait would
	// throw here — take the count from the network rather than the party at that point.
	// Guarded on integer-ness so a non-integer ask still gets the core's ">= 1" message.
	if (Number.isInteger(minPeers) && minPeers > partyNodeCount) {
		throw new Error(
			`waitForControlCohort: party ${party.name} has ${partyNodeCount} node(s) `
			+ `(1 owner + ${party.droneNodes.length} drone(s)), so a cohort of ${minPeers} can never form`);
	}

	return waitForCohortOn(node.libp2p, minPeers, {
		...options,
		label: `party ${party.name} node ${node.peerId}`
	});
}

/** One node whose cohort view is compared with the others', and the name failures print for it. */
export interface CohortViewer {
	libp2p: Libp2p;
	/** Traceable to a machine ("p[0]", "party alpha machine 2") — it names this node in failures. */
	label: string;
}

/**
 * The keys {@link waitForCohortAgreement} asks about. SEVERAL, unlike the rest of this module, and
 * the count is load-bearing — see that function's "WHY SEVERAL KEYS". Minted the same sanctioned
 * way as {@link CONTROL_COHORT_PROBE_KEY}; the strings are arbitrary, only their number and their
 * fixedness matter. Treat as immutable: a wait compares successive polls of exactly these
 * coordinates.
 */
const COHORT_AGREEMENT_PROBE_KEYS: ReadonlyArray<RoutingKey> = Array.from(
	{ length: 8 }, (_, index) => routingKeyForBlock(`sereus-cohort-agreement-probe-${index}`));

/** Peer ids rendered as the callers' machine labels where one matches, so failures stay readable. */
function namedCohort(members: ReadonlyArray<string>, viewers: ReadonlyArray<CohortViewer>): string {
	if (members.length === 0) return 'none';
	return members
		.map((id) => viewers.find((viewer) => viewer.libp2p.peerId.toString() === id)?.label ?? id)
		.join('+');
}

/** One probe key's reading: the set each node answered, in `viewers` order, each sorted. */
type ProbeReading = string[][];

/** The set every node answered for one probe key, or undefined where any two of them differed. */
function agreementOf(reading: ProbeReading): string[] | undefined {
	const first = reading[0];
	if (first === undefined) return undefined;
	const signature = first.join(',');
	return reading.every((members) => members.join(',') === signature) ? first : undefined;
}

/**
 * Why {@link waitForCohortAgreement}'s last poll did not satisfy it, in the terms its reader needs:
 * which nodes disagreed about which probe key, and what each of them answered.
 */
function describeAgreementGap(readings: ProbeReading[], viewers: ReadonlyArray<CohortViewer>): string {
	if (readings.length === 0) return 'no probe key was read';
	const agreed = readings.map(agreementOf);
	const disagreedAt = agreed.findIndex((members) => members === undefined);
	if (disagreedAt >= 0) {
		const reading = readings[disagreedAt]!;
		return `the nodes disagree about probe key ${disagreedAt} — `
			+ viewers.map((viewer, index) =>
				`${viewer.label}: ${namedCohort(reading[index] ?? [], viewers)}`).join('; ');
	}
	const selections = agreed as string[][];
	const rendered = selections.map((members) => namedCohort(members, viewers)).join(', ');
	if (selections.some((members) => members.length === 0)) {
		return 'the nodes agree about every probe key, but on an EMPTY cohort for at least one of '
			+ `them — none of them has classified anybody as serving yet (agreed: ${rendered})`;
	}
	return `the nodes agreed on this poll but not on the one before it (agreed selections: ${rendered})`;
}

/**
 * Poll until every node in `viewers` answers the same cohort as every other node for each of
 * {@link COHORT_AGREEMENT_PROBE_KEYS}, on two consecutive polls.
 *
 * WHAT THIS WAITS FOR, AND WHO WANTS IT. A node's cohort is assembled live from the membership
 * verdict it holds for each peer — `assembleServingCohort` in Optimystic's `libp2p-key-network.ts`
 * keeps only peers verdicted `serves` — so in the seconds after a network's nodes connect every
 * node's answer is correct and still moving. A scenario that measures WHERE something is PLACED
 * (which machines a write or a subscription is handed to) is measuring that answer and must not
 * start while the nodes still answer it differently. A scenario that needs only reachability wants
 * {@link waitForCohortOn}, which is cheaper and resolves sooner.
 *
 * AGREEMENT, NOT SIZE. What is waited for is that the nodes answer the SAME thing, never that they
 * answer a particular number of members. A network where some node is in nobody's cohort is a
 * consistent network and satisfies this wait: every node then places a block in the same place.
 * The one exception is an EMPTY cohort, which says nobody has been classified yet rather than
 * saying who serves, so agreement on one does not count.
 *
 * WHY SEVERAL KEYS, which is NOT the reason the file header gives for its one key. The header's
 * bound — below the configured breadth, closest-k is simply every serving peer — does not hold on,
 * say, three strand machines at breadth two, where a cohort is a two-member SELECTION. A node that
 * has classified only two peers answers that same pair at EVERY coordinate, and at a coordinate
 * whose true nearest two are that pair it agrees with the fully-informed nodes, so a single key
 * would accept it. Across several fixed keys the fully-informed nodes' selections vary with the
 * coordinate while an under-informed node's cannot, so it has to disagree at one of them.
 *
 * STILL A PROXY, for two reasons: a verdict can move after the wait resolves, and a disagreement
 * could in principle hide at coordinates none of these keys hash to. A resolved wait is a narrowed
 * window, not a settled network — a scenario whose assertion depends on it should say so.
 *
 * TWICE IN A ROW, because a view that is still moving can have every node coincide for a single
 * poll on its way through, and a one-poll test would be caught mid-flight.
 *
 * Throws IMMEDIATELY — never after a timeout — for fewer than two nodes, which would otherwise
 * "agree" with itself. On timeout, throws naming what the last poll saw, so the failure reads as
 * which nodes disagreed about which key rather than as a generic convergence timeout. Starts and
 * stops nothing, so a caller whose wait throws still owns its nodes' teardown.
 */
export async function waitForCohortAgreement(
	viewers: ReadonlyArray<CohortViewer>, options: WaitOptions = {}
): Promise<void> {
	// Validate BEFORE polling: one node agrees with itself on its second poll, so the wait would
	// pass without having tested anything rather than failing where the mistake is.
	if (viewers.length < 2) {
		throw new Error(
			'waitForCohortAgreement: agreement is between nodes, so it needs at least two; given '
			+ `${viewers.length} (${viewers.map((viewer) => viewer.label).join(', ') || 'none'})`);
	}

	// Resolve up front so a missing attachment throws here rather than being swallowed by the poll
	// loop (which treats a throwing condition as "not yet").
	const keyNetworks = viewers.map((viewer) => resolveKeyNetwork(viewer.libp2p, viewer.label));
	const {
		timeoutMs = DEFAULT_COHORT_TIMEOUT_MS,
		intervalMs = DEFAULT_COHORT_INTERVAL_MS,
		description = `${viewers.length} nodes to answer every probe key alike`
	} = options;

	let readings: ProbeReading[] = [];
	// Set only while the PREVIOUS poll satisfied the condition, so "twice in a row" is a comparison
	// and not a count.
	let heldSignature: string | undefined;
	// `waitUntil` reports only a generic timeout for a condition that always threw, which would read
	// as a network that never converged. Carry the last failure into the message and the cause.
	let lastError: unknown;
	const startedAt = Date.now();
	try {
		await waitUntil(async () => {
			try {
				readings = await Promise.all(COHORT_AGREEMENT_PROBE_KEYS.map(async (key) =>
					Promise.all(keyNetworks.map(async (keyNetwork) =>
						(await probeCohort(keyNetwork, key)).sort()))));
			} catch (error) {
				lastError = error;
				heldSignature = undefined;
				return false;
			}
			lastError = undefined;
			const agreed = readings.map(agreementOf);
			// An empty cohort is not an answer about who serves — nobody has been classified — so
			// agreement on one is agreement about nothing.
			if (agreed.some((members) => members === undefined || members.length === 0)) {
				heldSignature = undefined;
				return false;
			}
			const selections = agreed as string[][];
			const signature = selections.map((members) => members.join(',')).join('|');
			const heldSincePreviousPoll = heldSignature === signature;
			heldSignature = signature;
			return heldSincePreviousPoll;
		}, { timeoutMs, intervalMs, description });
	} catch (error) {
		// `waitUntil`'s generic message omits the views, which are the whole point of this failure.
		throw new Error(
			`waitForCohortAgreement: ${viewers.length} nodes did not settle on one view of each other `
			+ `within ${timeoutMs}ms (waited ${Date.now() - startedAt}ms): `
			+ describeAgreementGap(readings, viewers)
			+ (lastError ? `; every poll FAILED, last error: ${String(lastError)}` : ''),
			{ cause: error });
	}
	log('cohort agreement across %d probe keys after %dms',
		COHORT_AGREEMENT_PROBE_KEYS.length, Date.now() - startedAt);
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
 * forcer does — a node has exactly one `Libp2pKeyPeerNetwork` now (the transactor shares
 * the node-attached instance), but the observation still has to span every node in the
 * process for a whole suite, and these helpers accept node shapes that do not all expose
 * the key network (see the header of `forced-cluster.ts`).
 */
export function observeControlCohorts(): ControlCohortObserverHandle {
	let calls = 0;
	const sizes: number[] = [];

	const patch = patchKeyNetwork('observeControlCohorts', 'findCluster', (inner) =>
		async function (this: Libp2pKeyPeerNetwork, key: RoutingKey): Promise<ClusterPeers> {
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
