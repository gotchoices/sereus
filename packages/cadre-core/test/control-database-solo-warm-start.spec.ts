import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
	controlNodeConfig,
	expectNotListening,
	fileStorageProvider,
	freshPartyId,
	mintBlackholePeer,
	scopedWithin,
	short,
	tempStorageDir,
	type OfflinePeer
} from './control-db-node-helpers.js';
import type { CadreNodeConfig, SAppConfig, StrandInstance } from '../src/types.js';

/**
 * A device that WAS in a cadre and is now the only one left, restarting on rows
 * a previous session wrote to DISK — the shape an embedding phone app is in when
 * every other device in the party has gone away for good.
 *
 * Three things make this different from every other control-DB liveness suite,
 * and all three come from a report we could not otherwise reproduce (see the
 * `solo-warm-start-blocks-on-prior-cohort-peers` ticket):
 *
 *  1. **Real files, not a shared heap object.** `control-database-solo.spec.ts`
 *     and `control-database-offline-peers.spec.ts` restart against the SAME
 *     `MemoryRawStorage` instance, so the "restart" keeps a live object across
 *     the boundary. Here each run builds a fresh `FileRawStorage` over the same
 *     directory (see {@link fileStorageProvider}), so nothing but the bytes on
 *     disk crosses from one run to the next.
 *  2. **A non-empty member list with zero reachable peers.** The prior session
 *     left `CadrePeer` rows naming siblings that no longer exist. This flips
 *     `selectStrandMode` from `bootstrap` to `networked` (see
 *     `strand-cohort.ts`) while `resolveCohortSeed` can reach nobody, so the
 *     strand launches into a cluster transactor with an EMPTY bootstrap list —
 *     a combination no cold-boot test can construct.
 *  3. **The embedding app's boot ORDER, not ours.** Every other suite runs
 *     genesis first, then wires seed bootstrap, then reads peers. An embedder
 *     calls `start()` and goes straight to `addStrand()`, whose
 *     `CadreNode.resolveCohortSeed` opens with an unbounded
 *     `controlDatabase.queryCadrePeers()` — so the control DB's first operation
 *     of the process is a read, issued before any owner key exists and before
 *     seed bootstrap is wired.
 *
 * **Result: nothing here hangs.** Every case below passes in seconds. That is
 * the finding this suite records, and the reason it is written as coverage
 * rather than as a regression test for a fixed defect — do not read a passing
 * run as "the interesting case is elsewhere in the file". If a future change to
 * `resolveCohortSeed`, to strand-mode selection, or to control-DB hydration
 * reintroduces a stall on this path, these are the cases that catch it.
 *
 * Companions: `control-database-solo.spec.ts` (cadre of one, cold),
 * `control-database-offline-peers.spec.ts` (cadre of several, all unreachable),
 * `control-database-genesis.spec.ts` (the listening solo shape). Shared harness:
 * `control-db-node-helpers.ts`.
 */

/** Per-operation budget. Every operation here answers from local rows; this only catches hangs. */
const OP_TIMEOUT_MS = 15_000;
/** `start()`/`stop()` bring libp2p up and down — a looser budget, still bounded. */
const LIFECYCLE_TIMEOUT_MS = 30_000;
/**
 * `addStrand` is the whole point of the suite: it resolves the cohort seed and
 * then brings a SECOND libp2p node (the strand's) up. A budget wide enough for
 * an honest launch, narrow enough that the reported freeze could not hide in it.
 */
const ADD_STRAND_TIMEOUT_MS = 60_000;

/** `within` scoped to this spec's failure label: `solo-warm-start control op <label> …`. */
const within = scopedWithin('solo-warm-start');

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

/**
 * A self-consistent signed sApp config: a throwaway key signs the schema and
 * doubles as the sApp id, so the config passes `requireSignedSchemas` if a
 * caller ever turns it on. Same shape as `publish-strand.spec.ts`'s.
 */
function signedSApp(): SAppConfig {
	const priv = generatePrivateKey('ed25519', 'base64url') as string;
	const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
	return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv) };
}

/**
 * One device's persistent identity + block storage, reusable across restarts.
 * `dir` is the caller's to remove — {@link withDevice} does it.
 */
interface Device {
	config: () => CadreNodeConfig;
	dir: string;
}

/**
 * Run `body` against a device whose identity slot and block storage survive
 * every restart inside it, then delete the storage directory. The `keyStore` is
 * shared (same libp2p identity, hence the same PeerId, across restarts) and the
 * storage provider is file-backed under a fresh temp directory.
 */
async function withDevice(tag: string, body: (device: Device) => Promise<void>): Promise<void> {
	const dir = tempStorageDir(tag);
	const keyStore = new InMemoryKeyStore();
	const partyId = freshPartyId(tag);
	const storage = fileStorageProvider(dir);
	try {
		await body({ dir, config: () => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage }) });
	} finally {
		// `force` so a case that failed before creating anything still cleans up.
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Start a node in the non-listening posture and assert it really came up that way. */
async function startNode(node: CadreNode, label: string): Promise<void> {
	await within(`${label}.start()`, LIFECYCLE_TIMEOUT_MS, () => node.start());
	expectNotListening(node);
	expect(node.getControlDatabase()).not.toBeNull();
}

/**
 * The FIRST era: this device founds the party, publishes itself, and is joined
 * by `siblingCount` others. Returns the siblings and the device's own peerId.
 *
 * Runs in OUR order (genesis → seed bootstrap → peer writes) deliberately: the
 * embedder's order is what the SECOND era exercises, and a party has to be
 * founded somehow before it can be abandoned.
 */
async function foundCohort(node: CadreNode, siblingCount: number): Promise<{
	siblings: OfflinePeer[];
	selfPeerId: string;
	ownerPublicKey: string;
}> {
	const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
	const db = node.getControlDatabase()!;
	expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db.ensureOwnerKey(publicKeyB64))).toBe(true);
	node.initializeSeedBootstrap(privateKeyB64);
	expect(await within('registerSelf() (genesis)', OP_TIMEOUT_MS, () => node.registerSelf())).toBe('inserted');

	const siblings: OfflinePeer[] = [];
	for (let n = 1; n <= siblingCount; n++) {
		siblings.push(await mintBlackholePeer(node, within, n, OP_TIMEOUT_MS));
	}
	return { siblings, selfPeerId: node.peerId!.toString(), ownerPublicKey: publicKeyB64 };
}

/**
 * The anti-vacuity guard for the whole suite. A warm start that silently came up
 * on an EMPTY control database would pass every liveness assertion below while
 * testing nothing — the very state the suite exists to construct would be
 * missing. So before any case does its real work, it proves the rows the first
 * era wrote are readable again from disk.
 */
async function expectWarmState(
	node: CadreNode,
	expected: { members: ReadonlySet<string>; ownerPublicKey: string }
): Promise<void> {
	const db = node.getControlDatabase()!;
	expect(await within('hasOwnerKey() (warm)', OP_TIMEOUT_MS, () => db.hasOwnerKey())).toBe(true);
	expect(await within('getOwnerKeys() (warm)', OP_TIMEOUT_MS, () => db.getOwnerKeys()))
		.toEqual(new Set([expected.ownerPublicKey]));
	const peers = await within('queryCadrePeers() (warm)', OP_TIMEOUT_MS, () => db.queryCadrePeers());
	expect(new Set(peers.map((p) => p.peerId))).toEqual(new Set(expected.members));
}

/** The embedder's launch call, under its own deadline. */
function addStrand(
	node: CadreNode,
	strandRow: { Id: string; MemberPrivateKey: string | null; Type: 'o' | 'c' }
): Promise<StrandInstance> {
	return within(`addStrand(${strandRow.Type === 'c' ? 'closed' : 'open'})`, ADD_STRAND_TIMEOUT_MS,
		() => node.addStrand({ strandRow, sAppConfig: signedSApp(), founder: true }));
}

const strandId = (tag: string) => `warm-${tag}-${Math.random().toString(36).slice(2)}`;

describe('control database, solo warm start on a prior cohort (no listen addr, no bootstrap peers)', () => {
	// The headline case: the exact sequence the embedding app runs, against the
	// exact state its device is in.
	it('start() then addStrand() with VANISHED prior-cohort peers on disk', async () => {
		await withDevice('warm-vanished', async ({ config }) => {
			let cohort: Awaited<ReturnType<typeof foundCohort>>;

			const first = new CadreNode(config());
			try {
				await startNode(first, 'first');
				cohort = await foundCohort(first, 1);
			} finally {
				await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
			}

			const second = new CadreNode(config());
			try {
				await startNode(second, 'second');
				// Same key store ⇒ same libp2p identity ⇒ the rows on disk are this node's own.
				expect(second.peerId!.toString()).toBe(cohort.selfPeerId);
				await expectWarmState(second, {
					members: new Set([cohort.selfPeerId, ...cohort.siblings.map((s) => s.peerId)]),
					ownerPublicKey: cohort.ownerPublicKey
				});

				// From here on: the EMBEDDER's order. No genesis re-run, no
				// `initializeSeedBootstrap` — `addStrand` is the next thing called, so
				// `resolveCohortSeed`'s `queryCadrePeers()` is the first control
				// operation of this process that the app actually awaits.
				const instance = await addStrand(second, { Id: strandId('vanished'), MemberPrivateKey: null, Type: 'o' });

				// `networked`, not `bootstrap`: the stale rows are what make this case
				// different from the cold solo one, and the mode is where that
				// difference lands. If this ever reads `bootstrap` the case has
				// degenerated into a rename of `control-database-solo.spec.ts`.
				expect(instance.mode).toBe('networked');
				expect(instance.status).toBe('active');
			} finally {
				await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
			}
		});
	}, 300_000);

	// A prior cohort whose members were REVOKED before the device went solo is a
	// different state from one whose members merely vanished: the rows are still
	// physically present, and it is `queryCadrePeers`'s join against
	// `queryRevokedStamps('CadrePeer')` that hides them. Both the tombstone
	// re-read and the resulting membership collapse happen on the warm-start path.
	it('start() then addStrand() with REVOKED prior-cohort peers on disk', async () => {
		await withDevice('warm-revoked', async ({ config }) => {
			let cohort: Awaited<ReturnType<typeof foundCohort>>;

			const first = new CadreNode(config());
			try {
				await startNode(first, 'first');
				cohort = await foundCohort(first, 2);
				for (const sibling of cohort.siblings) {
					await within(`removePeer(${short(sibling.peerId)})`, OP_TIMEOUT_MS,
						() => first.removePeer(sibling.peerId));
				}
			} finally {
				await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
			}

			const second = new CadreNode(config());
			try {
				await startNode(second, 'second');
				// The revocations survived too, so membership is back down to self alone.
				await expectWarmState(second, {
					members: new Set([cohort.selfPeerId]),
					ownerPublicKey: cohort.ownerPublicKey
				});
				const revoked = await within('queryRevokedStamps(CadrePeer)', OP_TIMEOUT_MS,
					() => second.getControlDatabase()!.queryRevokedStamps('CadrePeer'));
				expect(revoked.size).toBe(cohort.siblings.length);

				const instance = await addStrand(second, { Id: strandId('revoked'), MemberPrivateKey: null, Type: 'o' });
				// Revoked siblings are NOT cohort members, so unlike the vanished case
				// the strand falls back to the local transactor.
				expect(instance.mode).toBe('bootstrap');
				expect(instance.status).toBe('active');
			} finally {
				await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
			}
		});
	}, 300_000);

	// A CLOSED strand whose founder is the only remaining member: the founder
	// bootstrap seats Member #1 and the founding Manager locally while the cohort
	// seed resolves to nobody, so the membership write and the empty seed land in
	// the same launch.
	it('start() then addStrand() founding a CLOSED strand as the last member standing', async () => {
		await withDevice('warm-closed', async ({ config }) => {
			let cohort: Awaited<ReturnType<typeof foundCohort>>;

			const first = new CadreNode(config());
			try {
				await startNode(first, 'first');
				cohort = await foundCohort(first, 1);
			} finally {
				await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
			}

			const second = new CadreNode(config());
			try {
				await startNode(second, 'second');
				await expectWarmState(second, {
					members: new Set([cohort.selfPeerId, ...cohort.siblings.map((s) => s.peerId)]),
					ownerPublicKey: cohort.ownerPublicKey
				});

				const memberPrivateKey = await generateStrandMemberKey();
				const instance = await addStrand(second,
					{ Id: strandId('closed'), MemberPrivateKey: memberPrivateKey, Type: 'c' });
				expect(instance.mode).toBe('networked');
				expect(instance.status).toBe('active');

				// The founder really is seated — a launch that resolved an empty seed
				// and then quietly skipped the membership bootstrap would leave the
				// device unable to admit anyone, which is the same class of stuck as
				// a hang.
				const db = instance.database!.getDatabase();
				const member = await within('select from Strand.Member', OP_TIMEOUT_MS,
					() => db.get('select Key from Strand.Member'));
				expect(member?.Key).toBe(strandMemberKeyPair(memberPrivateKey).publicKeyB64);
			} finally {
				await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
			}
		});
	}, 300_000);

	// Three stale siblings rather than one. `resolveCohortSeed` only RPCs
	// siblings it already holds a connection to (there are none), so this does not
	// multiply any dial cost — it exists because a membership list of three is
	// what a phone + laptop + tablet party leaves behind, and because a future
	// change that starts dialing the seed pass would show up here first as a
	// budget breach rather than in production.
	it('start() then addStrand() with THREE vanished prior-cohort peers on disk', async () => {
		await withDevice('warm-three', async ({ config }) => {
			let cohort: Awaited<ReturnType<typeof foundCohort>>;

			const first = new CadreNode(config());
			try {
				await startNode(first, 'first');
				cohort = await foundCohort(first, 3);
			} finally {
				await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
			}

			const second = new CadreNode(config());
			try {
				await startNode(second, 'second');
				await expectWarmState(second, {
					members: new Set([cohort.selfPeerId, ...cohort.siblings.map((s) => s.peerId)]),
					ownerPublicKey: cohort.ownerPublicKey
				});

				const instance = await addStrand(second, { Id: strandId('three'), MemberPrivateKey: null, Type: 'o' });
				expect(instance.mode).toBe('networked');
				expect(instance.status).toBe('active');
			} finally {
				await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
			}
		});
	}, 300_000);

	// The boot-ORDER hypothesis on its own, with the stale rows removed from the
	// picture: a COLD device that goes straight from `start()` to `addStrand()`,
	// so `resolveCohortSeed`'s `queryCadrePeers()` is the control database's very
	// first operation ever — issued with no owner key enrolled and no seed
	// bootstrap wired. Cheap to test both ways, and the ordering difference was
	// itself one of the two candidate explanations.
	it('COLD boot in the embedder order: addStrand() before any genesis', async () => {
		await withDevice('cold-embedder-order', async ({ config }) => {
			const node = new CadreNode(config());
			try {
				await startNode(node, 'node');
				const db = node.getControlDatabase()!;
				// Nothing has been written yet — this is the pre-genesis state.
				expect(await within('hasOwnerKey() (pre-genesis)', OP_TIMEOUT_MS, () => db.hasOwnerKey())).toBe(false);

				const instance = await addStrand(node, { Id: strandId('cold'), MemberPrivateKey: null, Type: 'o' });
				expect(instance.mode).toBe('bootstrap');
				expect(instance.status).toBe('active');

				// And genesis still works AFTER the strand launched — the out-of-order
				// read must not have left the control DB in a state that refuses the
				// owner-key write it never saw coming.
				const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
				expect(await within('ensureOwnerKey() (post-addStrand)', OP_TIMEOUT_MS,
					() => db.ensureOwnerKey(publicKeyB64))).toBe(true);
				node.initializeSeedBootstrap(privateKeyB64);
				expect(await within('registerSelf() (post-addStrand)', OP_TIMEOUT_MS, () => node.registerSelf()))
					.toBe('inserted');
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
			}
		});
	}, 300_000);

	// Restart DURABILITY, stated rather than assumed: the ticket that prompted
	// this suite asked whether the delete-while-alone re-issue high-water mark
	// participates in the reported freeze. It does not, because it does not
	// persist at all — `CadreNode` passes no `persistence` to its control node, so
	// `pendingRevocations` is rebuilt empty on every launch. Asserted here so the
	// claim stays true rather than remaining a note someone has to re-verify.
	it('the delete-while-alone re-issue queue does NOT survive a restart', async () => {
		await withDevice('warm-queue', async ({ config }) => {
			let cohort: Awaited<ReturnType<typeof foundCohort>>;

			const first = new CadreNode(config());
			try {
				await startNode(first, 'first');
				cohort = await foundCohort(first, 1);
				await within(`removePeer(${short(cohort.siblings[0]!.peerId)})`, OP_TIMEOUT_MS,
					() => first.removePeer(cohort.siblings[0]!.peerId));
				// Removed while alone ⇒ the tombstone IS queued in THIS process.
				expect(pendingRevocations(first).size).toBe(1);
			} finally {
				await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
			}

			const second = new CadreNode(config());
			try {
				await startNode(second, 'second');
				// …and is gone after the restart, while the `Revocation` ROW it was
				// derived from is still on disk. The row is what makes the membership
				// collapse durable; the queue is only the re-broadcast intent.
				expect(pendingRevocations(second).size).toBe(0);
				const revoked = await within('queryRevokedStamps(CadrePeer)', OP_TIMEOUT_MS,
					() => second.getControlDatabase()!.queryRevokedStamps('CadrePeer'));
				expect(revoked.size).toBe(1);
			} finally {
				await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
			}
		});
	}, 300_000);
});

/** Peek the private delete-while-alone tombstone queue (same cast pattern as `control-database-offline-peers.spec.ts`). */
function pendingRevocations(node: CadreNode): Map<string, { tableName: string; rowKey: string; stampId: string }> {
	return (node as unknown as {
		pendingRevocations: Map<string, { tableName: string; rowKey: string; stampId: string }>;
	}).pendingRevocations;
}
