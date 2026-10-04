/**
 * Strand change notifications (`CadreNodeConfig.strandReactivity`) wake a `Database.watch` on
 * the OTHER machines of a strand when one machine commits — including the machine outside the
 * storage group of the collection's log tail block.
 *
 * WHY THREE MACHINES AT BREADTH TWO. At or below the strand's replication breadth every machine
 * stores every block, and a machine whose storage applies a commit wakes its watchers through
 * the plugin's LOCAL change path with or without the option, so a two-machine scenario passes
 * with the feature broken. Here every block lives on two of the three machines, so exactly one
 * machine is outside the storage group of the log tail block — the group a notification is
 * rooted at (`../optimystic/docs/reactivity.md` §Origination point). That machine does not
 * apply the tail, so nothing on it announces the commit; it hears it only by a pushed
 * notification or by the watch service's own tail read at each renewal (30 s on a core host).
 * It may still store other blocks of the commit and wake locally from those, which is why a
 * wake alone proves nothing (see ATTRIBUTION). The scenario names the outsider from the
 * delivered notification's tail but does not need it in advance: three rounds, each with a
 * different committer, make it a watcher in two of them.
 *
 * ATTRIBUTION. Each strand node's `reactivitySubscribers.deliver` (an untyped attachment from
 * db-p2p's `createLibp2pNode`) is where every notification for a watched collection reaches
 * this node's subscribers: socket-delivered ones, and a root-group member's own announcement
 * handed to itself in-process. The scenario wraps it to timestamp each call, so "pushed" means a
 * notification for the watched table reached that machine's subscribers and a wake followed it.
 *
 * REGISTRATION, ONE MACHINE AT A TIME. The table is tagged in the sApp schema, and the scenario
 * first checks that the tag opened a network watch on every machine. That watch opened while
 * the collection was still empty, so nothing registers until a renewal tick (30 s) reads a
 * committed tail — on every machine at nearly the same moment. Optimystic's cohort-topic root
 * reads a burst of registrations as growth and stops accepting new ones (see the NOTE at
 * {@link REGISTRATION_SPACING_MS}). So the scenario turns the tag off, commits a seed row, and
 * turns the tag back on one machine at a time: each reopened watch reads the seed's tail at once
 * and registers — a cold root after a proof of work (0.3-17 s on Node, optimystic
 * `bug-first-registration-proof-of-work-freezes-the-node-for-seconds`). Only then does each
 * machine open its app-level `Database.watch`: a tag change is a schema change, which ends every
 * Quereus watch on the table, and the watch service's one wake for its first tail read
 * (`collection-watch.ts` module doc) has by then already fired, so no measured round counts it.
 *
 * Commits are sequential, never `Promise.all` across machines (simultaneous writers block each
 * other; see `convergence-stress.integration.ts`). A machine that both stores and watches can
 * wake twice for one commit, so every assertion is "at least one".
 */

import { describe, it, expect } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import { b64urlToBytes, bytesToB64url, reactivityRootCoord, type NotificationV1 } from '@optimystic/db-core';
import {
	reactivityCollectionIdBytes,
	type OptimysticNodeAttachments,
	type ReactivitySubscriberRegistry,
} from '@optimystic/db-p2p';
import { defaultCollectionUri } from '@optimystic/quereus-plugin-optimystic';
import type { Database } from '@quereus/quereus';
import type { StrandInstance } from '@serfab/cadre-core';
import {
	bootTopology,
	joinStrandOn,
	createSignedSAppConfig,
	waitUntil,
	sleep,
	type Topology,
	type TopologyMachine,
} from '../harness/index.js';

/** One tagged table: the only collection on the strand with a network watch. */
const TAGGED_SCHEMA = `
table Data (
    Key text primary key,
    Val text
) with tags ("optimystic.network_watch" = true);
`;

/** Every block on two of the three machines, so one machine is outside any block's storage group. */
const STRAND_BREADTH = 2;
const MACHINE_COUNT = 3;

/** One core-host renewal (30 s, when the watch service's own tail read runs) plus 5 s slack. */
const WAKE_BOUND_MS = 35_000;

/**
 * One registration's budget once its machine's tag is on. Measured: 1.5-41 s for the first
 * registration at a root (the proof of work, and a first attempt that backs off waits for the next
 * 30 s renewal tick), 52-68 ms for each one after it.
 */
const REGISTRATION_BUDGET_MS = 75_000;

/**
 * Gap between one machine's registration landing and the next machine's tag going on.
 *
 * NOTE: workaround for an Optimystic defect, reported via
 * `blocked/report-optimystic-reactivity-registration-burst-on-a-small-strand`. The cohort-topic root
 * pre-promotes when the growth slope of its registrations predicts 64 participants within 30 s,
 * which two registrations under ~0.5 s apart (three under ~1 s) already do, and a root never
 * demotes. A machine registering after that is sent to a child tier that needs 14 signatures and
 * cannot form on three machines, so it never registers. With every machine's tag on from the
 * schema, all three register on the same renewal tick, and in 5 of 8 runs one never did; the
 * registered machines then also lost pushes (one stopped being pushed ~90 s after registering)
 * and the unregistered one's renewal tail reads stopped. With this gap at 0 the third machine
 * never registered (2 of 2 runs); at 1 s every machine has (20 of 20). Once that is fixed, drop
 * the tag toggling and wait for the schema-opened watches to register on their own.
 */
const REGISTRATION_SPACING_MS = 1_000;

/**
 * Wait after the last registration before the first measured commit: two rounds of db-p2p's
 * cohort gossip (`DEFAULT_GOSSIP_INTERVAL_MS`, 5 s).
 *
 * NOTE: a registration is held by the root-group member it lands on and reaches the other members
 * by that gossip. A commit announced only by a member that has not heard of it yet reaches nobody,
 * and the watchers wait for the 30 s tail read: with round 1 starting ~1 s after the last
 * registration that happened in 3 of 13 runs (a probe saw the one announcing member deliver to no
 * one, itself included), and in none of 7 runs with this wait. An app pays this only in the
 * seconds after a machine registers; recorded in docs/strands.md → "What a watcher sees".
 */
const RECORD_GOSSIP_SETTLE_MS = 10_000;

/** Bring-up (~6 libp2p nodes, ~4 s), three registration budgets, the settle, and three rounds at the bound. */
const TEST_TIMEOUT_MS = 420_000;

/**
 * The collection id the plugin opens `App.Data`'s network watch under: the table's default
 * collection URI without its `tree://` scheme (`collection-factory.ts` → `parseCollectionId`).
 * The schema name is Quereus's canonical lowercase one (`table-identity.ts`).
 */
const WATCHED_COLLECTION_ID = defaultCollectionUri('app', 'Data').slice('tree://'.length);
/** The same id as a notification carries it. */
const WATCHED_COLLECTION_B64 = bytesToB64url(reactivityCollectionIdBytes(WATCHED_COLLECTION_ID));

const WATCHED_SQL = 'select Key, Val from App.Data';

/** db-p2p attaches the registry untyped; this is the slice of it the spy needs. */
interface ReactivitySubscribersAttachment {
	reactivitySubscribers?: Pick<ReactivitySubscriberRegistry, 'deliver'>;
}

type ReactiveStrandNode = Libp2p
	& Partial<Pick<OptimysticNodeAttachments, 'keyNetwork' | 'reactivityWatch'>>
	& ReactivitySubscribersAttachment;

interface Delivery {
	at: number;
	notification: NotificationV1;
}

/** One machine of the strand: its database, its strand node, and what the spies recorded. */
interface StrandMachine {
	label: string;
	db: Database;
	node: ReactiveStrandNode;
	/** `db.watch` callback times, oldest first. */
	wakes: number[];
	/** `deliver` calls for the watched collection, oldest first. */
	deliveries: Delivery[];
	unwatch?: () => void;
}

/** What one watcher saw in one round, in ms relative to the commit resolving. */
interface WatcherOutcome {
	label: string;
	inTailGroup: boolean | undefined;
	wakeMs: number | undefined;
	deliverMs: number | undefined;
	/** The first wake at or after the first delivery — the wake the push caused. */
	pushWakeMs: number | undefined;
}

interface RoundOutcome {
	round: number;
	committer: string;
	commitMs: number;
	tailGroup: string[] | undefined;
	watchers: WatcherOutcome[];
}

function strandMachine(label: string, instance: StrandInstance | undefined): StrandMachine {
	if (!instance?.database || !instance.libp2pNode) {
		throw new Error(`${label}: joinStrandOn returned no active strand instance`);
	}
	return {
		label,
		db: instance.database.getDatabase(),
		node: instance.libp2pNode as ReactiveStrandNode,
		wakes: [],
		deliveries: [],
	};
}

/**
 * Wrap the strand node's `deliver` to record each call for the watched collection, then call
 * through: it observes, it does not change what is delivered.
 */
function spyOnDeliveries(machine: StrandMachine): void {
	const registry = machine.node.reactivitySubscribers;
	if (!registry) {
		throw new Error(
			`${machine.label}: strand node carries no 'reactivitySubscribers' attachment — either `
			+ 'strandReactivity did not reach the node, or an Optimystic upgrade renamed the attachment '
			+ "(libp2p-node-base.ts); this scenario cannot attribute a wake to a push without it");
	}
	const deliver = registry.deliver.bind(registry);
	registry.deliver = (topicId, notification): void => {
		if (notification.collectionId === WATCHED_COLLECTION_B64) {
			machine.deliveries.push({ at: Date.now(), notification });
		}
		deliver(topicId, notification);
	};
}

/** Render the table the way an app does, then watch the statement's change scope. */
async function watchTable(machine: StrandMachine): Promise<void> {
	for await (const _row of machine.db.eval(WATCHED_SQL)) {
		// The read only has to happen; its rows are not the subject here.
	}
	const statement = machine.db.prepare(WATCHED_SQL);
	try {
		const subscription = machine.db.watch(statement.getChangeScope(), () => {
			machine.wakes.push(Date.now());
		});
		machine.unwatch = () => subscription.unsubscribe();
	} finally {
		await statement.finalize();
	}
}

function isRegistered(machine: StrandMachine): boolean {
	return machine.node.reactivityWatch?.isAttached(WATCHED_COLLECTION_ID) ?? false;
}

function watchedCollections(machine: StrandMachine): number {
	return machine.node.reactivityWatch?.watchedCount ?? 0;
}

/** Turn the table's network-watch tag on or off on one machine, and wait for the watch to follow. */
async function setNetworkWatchTag(machine: StrandMachine, on: boolean): Promise<void> {
	await machine.db.exec(`alter table App.Data set tags ("optimystic.network_watch" = ${on})`);
	await waitUntil(() => watchedCollections(machine) === (on ? 1 : 0), {
		timeoutMs: 10_000, intervalMs: 50,
		description: `${machine.label}: the network watch ${on ? 'opens' : 'closes'} after the tag is set to ${on}`,
	});
}

/** The tag in the sApp schema opened a network watch on every machine (the production path). */
async function awaitSchemaTagWatches(machines: ReadonlyArray<StrandMachine>): Promise<void> {
	try {
		await waitUntil(() => machines.every((m) => watchedCollections(m) === 1), { timeoutMs: 10_000, intervalMs: 50 });
	} catch (error) {
		throw new Error(
			"the sApp schema's network_watch tag did not open a network watch on every machine ("
			+ machines.map((m) => `${m.label}: ${watchedCollections(m)} watched`).join(', ') + ')',
			{ cause: error });
	}
}

/**
 * Seed commit with every tag off, then each machine's tag on in turn until its registration
 * lands, then {@link REGISTRATION_SPACING_MS} before the next.
 */
async function seedThenRegisterInTurn(machines: ReadonlyArray<StrandMachine>): Promise<void> {
	for (const machine of machines) {
		await setNetworkWatchTag(machine, false);
	}
	await machines[0]!.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['seed', 'seed']);
	const timings: string[] = [];
	for (const machine of machines) {
		const taggedAt = Date.now();
		await setNetworkWatchTag(machine, true);
		await waitUntil(() => isRegistered(machine), {
			timeoutMs: REGISTRATION_BUDGET_MS, intervalMs: 50,
			description: `${machine.label}: registration once its tag is on`,
		});
		timings.push(`${machine.label} ${Date.now() - taggedAt} ms`);
		await sleep(REGISTRATION_SPACING_MS);
	}
	console.log(`[reactivity] registered, from each tag going on: ${timings.join('; ')}`);
	await sleep(RECORD_GOSSIP_SETTLE_MS);
}

/** The peers the root group of `notification`'s tail resolves to, as machine labels. */
async function tailGroupOf(
	notification: NotificationV1, viewer: StrandMachine, machines: ReadonlyArray<StrandMachine>,
): Promise<string[]> {
	const keyNetwork = viewer.node.keyNetwork;
	if (!keyNetwork) {
		throw new Error(`${viewer.label}: strand node carries no keyNetwork attachment`);
	}
	const peers = await keyNetwork.servingCohortAt(reactivityRootCoord(b64urlToBytes(notification.tailId)));
	return peers.map((peerId) => machines.find((m) => m.node.peerId.toString() === peerId)?.label ?? peerId);
}

function pushedAndWoken(machine: StrandMachine): boolean {
	const firstDelivery = machine.deliveries[0]?.at;
	return firstDelivery !== undefined && machine.wakes.some((at) => at >= firstDelivery);
}

function watcherOutcome(machine: StrandMachine, commitEnd: number, tailGroup: string[] | undefined): WatcherOutcome {
	const firstDelivery = machine.deliveries[0]?.at;
	const pushWake = firstDelivery === undefined ? undefined : machine.wakes.find((at) => at >= firstDelivery);
	const relative = (at: number | undefined): number | undefined => at === undefined ? undefined : at - commitEnd;
	return {
		label: machine.label,
		inTailGroup: tailGroup?.includes(machine.label),
		wakeMs: relative(machine.wakes[0]),
		deliverMs: relative(firstDelivery),
		pushWakeMs: relative(pushWake),
	};
}

/**
 * One commit on `committer`, then wait (up to the bound) until every watcher has been woken by a
 * push. Records rather than asserts, so all three rounds are logged before the test judges any.
 */
async function runRound(
	round: number, committer: StrandMachine, machines: ReadonlyArray<StrandMachine>,
): Promise<RoundOutcome> {
	const watchers = machines.filter((m) => m !== committer);
	for (const machine of machines) {
		machine.wakes.length = 0;
		machine.deliveries.length = 0;
	}
	const commitStart = Date.now();
	await committer.db.exec('insert into App.Data (Key, Val) values (?, ?)', [`round-${round}`, `from-${committer.label}`]);
	const commitEnd = Date.now();

	try {
		await waitUntil(() => watchers.every(pushedAndWoken), { timeoutMs: WAKE_BOUND_MS, intervalMs: 50 });
	} catch {
		// Some watcher was not pushed inside the bound; the outcome below records which.
	}

	const notification = watchers.flatMap((m) => m.deliveries)[0]?.notification;
	const tailGroup = notification ? await tailGroupOf(notification, committer, machines) : undefined;
	const outcome: RoundOutcome = {
		round,
		committer: committer.label,
		commitMs: commitEnd - commitStart,
		tailGroup,
		watchers: watchers.map((m) => watcherOutcome(m, commitEnd, tailGroup)),
	};
	console.log(formatRound(outcome));
	return outcome;
}

function formatRound(outcome: RoundOutcome): string {
	const ms = (value: number | undefined): string => value === undefined ? 'none' : `${value} ms`;
	const group = outcome.tailGroup ? outcome.tailGroup.join('+') : 'unknown (no delivery)';
	const watchers = outcome.watchers.map((w) =>
		`${w.label}${w.inTailGroup === false ? ' (outside tail group)' : ''}: `
		+ `wake ${ms(w.wakeMs)}, deliver ${ms(w.deliverMs)}, wake after deliver ${ms(w.pushWakeMs)}`);
	return `[reactivity] round ${outcome.round}: ${outcome.committer} commits (${outcome.commitMs} ms), `
		+ `tail group ${group}; relative to the commit resolving — ${watchers.join('; ')}`;
}

function assertRound(outcome: RoundOutcome): void {
	for (const watcher of outcome.watchers) {
		const where = `round ${outcome.round} (${outcome.committer} commits), watcher ${watcher.label}`
			+ (watcher.inTailGroup === false ? ' outside the tail group' : '');
		expect(watcher.wakeMs, `${where}: woken within ${WAKE_BOUND_MS} ms of the commit`).toBeDefined();
		expect(watcher.wakeMs!, `${where}: woken within ${WAKE_BOUND_MS} ms of the commit`).toBeLessThanOrEqual(WAKE_BOUND_MS);
		expect(watcher.pushWakeMs, `${where}: a notification reached its subscribers and woke the watch`).toBeDefined();
	}
}

describe('Strand change notifications wake watchers on other machines', () => {
	it('wakes every watcher by push, the machine outside the tail group included', async () => {
		let topology: Topology | undefined;
		const machines: StrandMachine[] = [];
		try {
			const bootStart = Date.now();
			const machineSpec = { strandClusterSize: STRAND_BREADTH, strandReactivity: { enabled: true } };
			topology = await bootTopology({
				tag: 'strand-reactivity',
				parties: [{ name: 'p', machines: Array.from({ length: MACHINE_COUNT }, () => machineSpec) }],
			});
			const members: TopologyMachine[] = Array.from({ length: MACHINE_COUNT }, (_, i) => topology!.machine('p', i));
			const instances = await joinStrandOn({
				strandId: `strand-reactivity-${Date.now()}`,
				sAppConfig: createSignedSAppConfig(TAGGED_SCHEMA, '1.0.0'),
				members,
				clusterSize: STRAND_BREADTH,
			});
			console.log(`[reactivity] bring-up (3 machines, strand at breadth ${STRAND_BREADTH}) took ${Date.now() - bootStart} ms`);

			machines.push(...instances.map((instance, i) => strandMachine(`p[${i}]`, instance)));
			await awaitSchemaTagWatches(machines);
			await seedThenRegisterInTurn(machines);
			for (const machine of machines) {
				spyOnDeliveries(machine);
				await watchTable(machine);
			}

			const outcomes: RoundOutcome[] = [];
			for (let round = 1; round <= MACHINE_COUNT; round++) {
				outcomes.push(await runRound(round, machines[round - 1]!, machines));
			}
			for (const outcome of outcomes) {
				assertRound(outcome);
			}
			expect(
				outcomes.some((o) => o.watchers.some((w) => w.inTailGroup === false)),
				`some watcher was outside the tail group — otherwise breadth ${STRAND_BREADTH} did not take effect and the outsider claim is vacuous`,
			).toBe(true);
		} finally {
			for (const machine of machines) {
				machine.unwatch?.();
			}
			await topology?.stop();
		}
	}, TEST_TIMEOUT_MS);
});
