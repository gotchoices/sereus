import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { controlStorageScope } from '../src/storage-scope.js';
import { StrandWatcher, type StrandQueryable } from '../src/strand-watcher.js';
import type { CadreNodeConfig, SAppConfig, StrandRow } from '../src/types.js';
import {
	controlNodeConfig,
	freshPartyId,
	memoryStorageProvider,
	scopedWithin
} from './control-db-node-helpers.js';
import { signedSApp } from './signed-sapp.js';

/**
 * **What this protects: a strand the control network already holds is still
 * claimable by an app that starts listening a moment late.**
 *
 * `CadreNode` learns about the party's strands by polling the control database's
 * `Strand` table. A row it has no `sAppConfig` for is surfaced as
 * `strand:discovered` — once. The watcher then records the strand in its
 * `knownStrands` and no later poll re-offers it, so that single event is the
 * only notice the strand ever gets.
 *
 * sApp configs are in-memory only and are cleared by `stop()`, so after a
 * restart EVERY stored strand takes that branch. And the watcher's first poll
 * runs inside `CadreNode.start()` (deferred 100 ms after the watcher starts),
 * which is well before an embedding app can attach a listener — the React Native
 * app subscribes in an effect that cannot run until its own `startPhoneNode` has
 * resolved. So every discovery fired into an empty listener list and the strands,
 * still present in the database, were never mentioned again: a phone reconnecting
 * to a party it already had strands in showed `0 strand(s)`, permanently.
 *
 * The fix makes the unclaimed set node STATE rather than a one-shot
 * notification: `CadreNode.getDiscoveredStrands()`. The event is unchanged; it
 * is simply no longer the only way to learn about the strand.
 *
 * Four arms, the cheap ones last:
 *  1. **The restart.** A real node founds an open strand, stops, and a second
 *     node comes up on the same party over the same storage. It subscribes only
 *     AFTER `start()` has resolved and the watcher has already offered the
 *     strand — and still attaches it, via the drain.
 *  2. **Party isolation.** The same storage provider, a different party id: the
 *     second node discovers nothing. This is what keeps a phone from joining a
 *     stranger's open strands when two parties share a device, and it is the
 *     property `phone-control-storage-shared-across-parties` bought — asserted
 *     here, at the discovery seam, rather than only at the storage layer.
 *  3. **The bare reproduction.** A real `StrandWatcher` over a fake queryable
 *     driving the real `handleStrandAdded`, with no libp2p node and no database.
 *     It says nothing arm 1 does not, but it says it in a few hundred
 *     milliseconds and names exactly the two objects involved.
 *  4. **The other half of the contract.** A backlog that outlives the event has to
 *     forget a strand whose control row is gone, or a drain would try to launch a
 *     row the party removed. Same bare harness.
 */

/** `within` scoped to this spec's failure label: `discovered-late-subscriber control op <label> …`. */
const within = scopedWithin('discovered-late-subscriber');

/** `start()`/`stop()`/`foundStrand()` bring libp2p nodes up and down; bounded hang detectors. */
const LIFECYCLE_TIMEOUT_MS = 60_000;

/** Control-plane reads/writes that answer from local rows; this only catches hangs. */
const OP_TIMEOUT_MS = 15_000;

/** How long to wait for the watcher's deferred first poll to have offered a strand. */
const FIRST_POLL_TIMEOUT_MS = 15_000;

/** Test-only window onto the private member the poll helpers below drive. */
interface CadreNodeInternals {
	strandWatcher: StrandWatcher | null;
}

const strandId = (tag: string) => `${tag}-${Math.random().toString(36).slice(2)}`;

/** The node's live watcher, with a failure message worth reading when there isn't one. */
function watcherOf(node: CadreNode): StrandWatcher {
	const watcher = (node as unknown as CadreNodeInternals).strandWatcher;
	expect(watcher, 'no strand watcher after start() — there is no poll to observe').not.toBeNull();
	return watcher!;
}

/**
 * Resolve once the watcher's first poll has OFFERED `id` — i.e. once the single
 * `strand:discovered` for it has already fired, with nothing listening.
 *
 * Waiting on the watcher's own `knownStrands` rather than forcing a poll keeps
 * the arm on the production sequence: the 100 ms deferred poll inside `start()`
 * is what runs, and this only observes it. `knownStrands` is set BEFORE the
 * watcher awaits `onStrandAdded`, but `handleStrandAdded`'s no-config branch
 * reaches its emit with no await in between, so an observer in a later task
 * never sees the set without the emit.
 */
async function waitForOffered(node: CadreNode, id: string): Promise<void> {
	const watcher = watcherOf(node);
	const deadline = Date.now() + FIRST_POLL_TIMEOUT_MS;
	while (!watcher.getKnownStrands().has(id)) {
		if (Date.now() > deadline) {
			throw new Error(
				`discovered-late-subscriber: the strand watcher never offered ${id} within ${FIRST_POLL_TIMEOUT_MS}ms — ` +
				'the restarted node cannot see the stored Strand row at all, so this arm is not testing the late subscriber'
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Genesis on a fresh party: seat this node's own owner key, the production call. */
async function runGenesis(node: CadreNode): Promise<void> {
	const { publicKeyB64 } = node.getIdentityOwnerKey();
	expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS,
		() => node.getControlDatabase()!.ensureOwnerKey(publicKeyB64))).toBe(true);
}

/** Publish an OPEN strand's row and start it locally, as the founding app does. */
async function foundOpenStrand(node: CadreNode, id: string, sAppConfig: SAppConfig): Promise<void> {
	const { instance, founded } = await within(`foundStrand(${id})`, LIFECYCLE_TIMEOUT_MS,
		() => node.foundStrand({ strandId: id, type: 'o', sAppConfig }));
	expect(instance.status).toBe('active');
	expect(founded, 'this node did not actually found the strand — the row came from elsewhere').toBe(true);
}

describe('discovered strands survive a late subscriber', () => {
	it('a restarted node re-attaches a stored strand even though the app subscribes after start() resolves', async () => {
		const partyId = freshPartyId('discovered-late-subscriber');
		const keyStore = new InMemoryKeyStore();
		const storage = memoryStorageProvider();
		const id = strandId('late');
		// ONE sApp config across both eras: the embedding app's chat config is stable
		// (`CHAT_SAPP_ID`), and a fresh `signedSApp()` per era would mint a new id and
		// make the restart look like a different application attaching.
		const sAppConfig = signedSApp({ latencyHint: 'realtime' });
		// Same key store ⇒ same libp2p identity ⇒ the same owner key across the
		// restart, so the stored row's `FounderOwnerKey` is still this device's own —
		// the phone case, where the strand being re-attached is one it founded itself.
		const config = (): CadreNodeConfig => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage });

		const first = new CadreNode(config());
		try {
			await within('first.start()', LIFECYCLE_TIMEOUT_MS, () => first.start());
			await runGenesis(first);
			await foundOpenStrand(first, id, sAppConfig);
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
		}

		const second = new CadreNode(config());
		try {
			await within('second.start()', LIFECYCLE_TIMEOUT_MS, () => second.start());
			// `stop()` cleared the sApp configs, so nothing auto-launches: the stored
			// strand is unclaimed again and takes the discovery branch.
			expect(second.getStrands().size,
				'the restarted node launched a strand on its own — the sApp config survived stop(), and this arm tests nothing'
			).toBe(0);

			// The race, run to completion BEFORE anything subscribes. Do not hoist the
			// subscription below this line: subscribing late is the whole point.
			await waitForOffered(second, id);

			// Now the app attaches its listener — the shape a React effect is in, one
			// or more ticks after `start()` resolved.
			const events: string[] = [];
			second.on('strand:discovered', (event) => { events.push(event.strandId); });

			const backlog = second.getDiscoveredStrands();
			expect(events,
				'a strand:discovered arrived at the late listener — the watcher re-offered the strand, ' +
				'so this arm is no longer proving that the backlog is what rescues it'
			).toEqual([]);
			expect([...backlog.keys()],
				'the restarted node forgot the stored strand: it was announced once, before the app subscribed, and never again'
			).toEqual([id]);

			const row = backlog.get(id)!;
			expect(row.Type).toBe('o');

			// The drain's whole purpose: the app can still join.
			const instance = await within(`addStrand(${id})`, LIFECYCLE_TIMEOUT_MS,
				() => second.addStrand({ strandRow: row, sAppConfig }));
			expect(instance.status).toBe('active');
			expect(second.getStrands().has(id)).toBe(true);
			// Claimed ⇒ off the backlog, so a second drain cannot launch it twice.
			expect(second.getDiscoveredStrands().has(id),
				'the claimed strand is still on the backlog — a later drain would attempt a second launch'
			).toBe(false);
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
		}
	}, 300_000);

	it('a node starting on a DIFFERENT party over the same storage discovers nothing', async () => {
		const keyStore = new InMemoryKeyStore();
		const storage = memoryStorageProvider();
		const partyA = freshPartyId('discovered-party-a');
		const partyB = freshPartyId('discovered-party-b');
		const id = strandId('party-a');
		const sAppConfig = signedSApp({ latencyHint: 'realtime' });
		// Record every scope the provider is asked for, so the anti-vacuity check below
		// can prove the two parties really shared ONE provider and were separated by the
		// scope key alone — not by two providers that never met.
		const scopes: string[] = [];
		const recordingStorage = (scope: string) => {
			scopes.push(scope);
			return storage(scope);
		};
		const config = (partyId: string): CadreNodeConfig =>
			controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage: recordingStorage });

		const a = new CadreNode(config(partyA));
		try {
			await within('a.start()', LIFECYCLE_TIMEOUT_MS, () => a.start());
			await runGenesis(a);
			await foundOpenStrand(a, id, sAppConfig);
		} finally {
			await within('a.stop()', LIFECYCLE_TIMEOUT_MS, () => a.stop());
		}

		const b = new CadreNode(config(partyB));
		try {
			await within('b.start()', LIFECYCLE_TIMEOUT_MS, () => b.start());
			// A complete poll against party B's `Strand` table, awaited — there is no
			// positive condition to wait for here, so force one rather than sleeping.
			await within('b forcePoll()', OP_TIMEOUT_MS, () => watcherOf(b).forcePoll());

			expect([...b.getDiscoveredStrands().keys()],
				"party B discovered party A's strand — the control databases are sharing a storage scope"
			).toEqual([]);
			expect(b.getStrands().size).toBe(0);
			expect(watcherOf(b).getKnownStrands().size,
				"party B's watcher can read party A's Strand rows"
			).toBe(0);

			// Anti-vacuity: one provider served both parties, at two DIFFERENT scope keys.
			expect(scopes).toContain(controlStorageScope(partyA));
			expect(scopes).toContain(controlStorageScope(partyB));
			expect(controlStorageScope(partyA)).not.toBe(controlStorageScope(partyB));
		} finally {
			await within('b.stop()', LIFECYCLE_TIMEOUT_MS, () => b.stop());
		}
	}, 300_000);

	it('a late subscriber to a real StrandWatcher still finds the strand in getDiscoveredStrands()', async () => {
		// The bare reproduction: a real watcher and the real `handleStrandAdded`, with
		// no libp2p node and no database behind either. Costs a few hundred ms.
		const { node, row, watcher } = bareWatcher('bare');

		try {
			await watcher.start();
			// The one offer, consumed by nobody.
			await watcher.forcePoll();
			expect(watcher.getKnownStrands().has(row.Id)).toBe(true);

			const events: string[] = [];
			node.on('strand:discovered', (event) => { events.push(event.strandId); });
			// Two further polls: the watcher will not offer a known strand again, which
			// is precisely why the event alone cannot rescue a late subscriber.
			await watcher.forcePoll();
			await watcher.forcePoll();

			expect(events).toEqual([]);
			expect([...node.getDiscoveredStrands().keys()]).toEqual([row.Id]);
		} finally {
			await watcher.stop();
		}
	});

	it('drops an unclaimed strand from the backlog once its control row is gone', async () => {
		// The backlog outlives the event, so it needs the other half of the contract:
		// a strand the party removed (`unpublishStrand` on any machine) must not stay
		// on offer here, or a drain would launch a strand whose row no longer exists.
		const { node, row, rows, watcher } = bareWatcher('unpublished');

		try {
			await watcher.start();
			await watcher.forcePoll();
			expect([...node.getDiscoveredStrands().keys()],
				'the strand was never offered, so its removal proves nothing'
			).toEqual([row.Id]);

			// The row disappears, as a sibling's unpublish makes it disappear.
			rows.length = 0;
			await watcher.forcePoll();

			expect([...node.getDiscoveredStrands().keys()],
				'an unpublished strand is still on the backlog — a later drain would try to launch a row that is gone'
			).toEqual([]);
		} finally {
			await watcher.stop();
		}
	});
});

/**
 * A real {@link StrandWatcher} driving the real `handleStrandAdded`/`handleStrandRemoved`
 * on an UNSTARTED {@link CadreNode}: no libp2p node, no database, a few hundred ms. Both
 * handlers are reachable on a node that never started — the strand and hibernation
 * managers are built in the constructor — and neither touches the control plane for an
 * unclaimed strand, which is the whole path under test.
 *
 * `rows` is the queryable's live backing array: mutate it to make the control row appear
 * or vanish between polls.
 */
function bareWatcher(tag: string): { node: CadreNode; row: StrandRow; rows: StrandRow[]; watcher: StrandWatcher } {
	const node = new CadreNode({
		controlNetwork: { partyId: freshPartyId(`discovered-${tag}`), bootstrapNodes: [] },
		profile: 'transaction'
	});
	const row: StrandRow = { Id: strandId(tag), MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null };
	const rows: StrandRow[] = [row];
	const queryable: StrandQueryable = { queryStrands: async () => [...rows] };
	const internals = node as unknown as {
		handleStrandAdded(s: StrandRow): Promise<void>;
		handleStrandRemoved(id: string): Promise<void>;
	};
	const watcher = new StrandWatcher(queryable, {
		onStrandAdded: async (strand) => internals.handleStrandAdded(strand),
		onStrandRemoved: async (id) => internals.handleStrandRemoved(id)
	}, { mode: 'all' }, 5_000);
	return { node, row, rows, watcher };
}
