/**
 * Two machines of one party on different releases of the control schema, the way a party's
 * phones take an app update one at a time (docs/architecture.md → "Control schema versions and
 * migrations"). `controlNetwork.schemaPath` chooses each machine's "release", built by
 * `test-harness/control-schema-releases.ts` from the baseline fixture: `previous` is the release
 * the store was written by, and `next` adds a nullable column (`ValidationKey.Note`), changes a
 * CHECK body, adds a table and drops `previous`'s extra column.
 *
 * 1. A and B form a party under `previous`; each writes a row the other reads.
 * 2. A restarts under `next` and starts without error (its apply migrates its catalog) while B
 *    keeps running on `previous`. B reconnects, and the peer-join block catch-up copies A's
 *    blocks, migrated catalog included, into B's store.
 * 3. B writes a row A reads; A writes a row with a value in the new column, which B reads
 *    without the column.
 * 4. B restarts under `previous`, starts, and reads every row from before.
 * 5. B restarts under `next`, starts (its apply migrates its own catalog), and reads every row
 *    from before, the new column's value now included.
 *
 * Steps 4 and 5 are what the phone that updates second gets. Each restart is a fresh `CadreNode`
 * on the same identity key over the same storage capture, as `control-offline-read-after-restart`
 * restarts its joiner. Every machine migrates its OWN catalog lineage: the control database comes
 * up with no control connection open, so every start-time apply commits alone, and B's own cold
 * start committed the catalog collection a second time beside A's (docs/architecture.md → "Every
 * machine migrates its own catalog"). B's restarts hydrate B's lineage, so step 4 starts rather
 * than meeting the `newer-release` refusal `control-store-migration.spec.ts` pins for a lineage a
 * newer release migrated. One lineage per machine is the design
 * (decide-control-catalog-lineage-per-machine).
 *
 * The row with a value in the new column is a `ValidationKey`, written by hand: both releases run
 * this build's `ControlDatabase`, whose writers list the columns they know, so no writer can set a
 * column the schema file added. `ValidationKey` because its insert needs one owner signature over
 * two fields; a hand-written `CadrePeer` insert is refused by lint (it would skip the membership
 * snapshot refresh).
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode, CONTROL_SCHEMA_BASELINE_VERSION, CONTROL_SCHEMA_VERSION_TAG, buildAuthorizationMessage } from '@serfab/cadre-core';
import type { ControlDatabase } from '@serfab/cadre-core';
import { controlSchemaReleases, writeSchemaFile } from '../../../../test-harness/control-schema-releases.js';
import {
	awaitBlockCoverage,
	captureRawStorage,
	connectControlNodes,
	controlNodeConfig,
	createTestOwnerKey,
	makeOwnOwner,
	randomPeerId,
	signMessageEd25519,
	waitForCadrePeerConverged,
	waitUntil,
	type RawStorageCapture,
	type TestOwnerKey,
} from '../harness/index.js';

const NOTE = 'written on the next release';

/** One machine of the party on its own storage capture, declaring the control schema at `schemaPath`. */
function nodeOn(
	partyId: string,
	privateKey: PrivateKey,
	capture: RawStorageCapture,
	profile: 'storage' | 'transaction',
	schemaPath: string,
): CadreNode {
	return new CadreNode(controlNodeConfig({ partyId, privateKey, profile, storageProvider: capture.provider, schemaPath }));
}

const controlDb = (node: CadreNode): ControlDatabase => {
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	return db;
};

/** The control schema version the node's live `OwnerKey` table carries. */
const storeVersionOf = (node: CadreNode): unknown =>
	controlDb(node).getDatabase().schemaManager.getTable('CadreControl', 'OwnerKey')?.tags?.[CONTROL_SCHEMA_VERSION_TAG];

/** An owner-vouched `CadrePeer` row for a machine that never starts, as `authorizePeer` seats one. */
const peerRow = (peerId: string) => ({ peerId, publicKey: null, multiaddr: '', updatedAt: Date.now(), sig: null, profile: null });

/**
 * `insertValidationKey` with the next release's `Note` column set. The signature is the one the
 * schema's `ValidationKey.AuthorizedInsert` verifies, over `(Key, StampId)`, so the column the
 * writer does not know is the only difference from the cadre-core writer.
 */
async function insertValidationKeyWithNote(db: ControlDatabase, partyId: string, owner: TestOwnerKey, key: string): Promise<void> {
	const stampId = `stamp-${key}`;
	const signature = signMessageEd25519(buildAuthorizationMessage('CadreControl.ValidationKey', 'add', partyId, [key, stampId]), owner.privateKeyB64);
	await db.withWriteLock(() => db.getDatabase().exec(
		'insert into CadreControl.ValidationKey (Key, StampId, Note) with context OwnerKey = ?, Signature = ? values (?, ?, ?)',
		[owner.publicKey, signature, key, stampId, NOTE],
	));
}

/** The stored `ValidationKey` row for `key`, with whatever columns this node's catalog knows. */
async function validationKeyRow(db: ControlDatabase, key: string): Promise<Record<string, unknown> | undefined> {
	for await (const row of db.getDatabase().eval('select * from CadreControl.ValidationKey where Key = ?', [key])) {
		return row;
	}
	return undefined;
}

/** Wait until `reader` holds the `ValidationKey` row `key` (pull-on-read, as the peer-row waits do). */
function waitForValidationKey(reader: CadreNode, key: string, description: string): Promise<void> {
	return waitUntil(async () => (await controlDb(reader).queryValidationKeys()).includes(key), { timeoutMs: 30_000, intervalMs: 250, description });
}

interface PartyRows {
	x1: string;
	x2: string;
	x3: string;
	v1: string;
	v2: string;
	owner: string;
}

/**
 * Every row written in steps 1 to 3 reads on `node` from its own store (it is alone after a
 * restart): the three peer rows, both validation keys, the owner key, and the new column's value
 * on the release that knows the column.
 */
async function expectEveryRow(node: CadreNode, rows: PartyRows, column: 'with the column' | 'without the column'): Promise<void> {
	const db = controlDb(node);
	expect((await db.queryCadrePeers()).map((peer) => peer.peerId)).toEqual(expect.arrayContaining([rows.x1, rows.x2, rows.x3]));
	expect(await db.queryValidationKeys()).toEqual(expect.arrayContaining([rows.v1, rows.v2]));
	expect((await validationKeyRow(db, rows.v2))?.Note).toBe(column === 'with the column' ? NOTE : undefined);
	expect((await db.getOwnerKeys()).has(rows.owner)).toBe(true);
}

/** Let the node's first address-record publish land before it is stopped (docs/testing.md). */
async function registered(node: CadreNode, label: string): Promise<void> {
	await waitUntil(async () => (await node.registerSelf()) !== 'skipped', { timeoutMs: 30_000, intervalMs: 250, description: `${label} published its address record` });
}

describe('Control schema migration with mixed releases in one party', () => {
	it('the first machine to update migrates its catalog; the second keeps working across restarts and reads every row once it updates', async () => {
		const partyId = `ctrl-schema-migration-${Date.now()}`;
		const schemaDir = await mkdtemp(join(tmpdir(), 'control-schema-releases-'));
		const releases = await controlSchemaReleases(CONTROL_SCHEMA_BASELINE_VERSION);
		const previous = await writeSchemaFile(schemaDir, 'previous', releases.previous);
		const next = await writeSchemaFile(schemaDir, 'next', releases.next);
		const aKey = await generateKeyPair('Ed25519');
		const bKey = await generateKeyPair('Ed25519');
		const captureA = captureRawStorage();
		const captureB = captureRawStorage();
		// Peers that exist only as rows, and validation keys that are only keys: one of each per writer.
		const [x1, x2, x3] = await Promise.all([randomPeerId(), randomPeerId(), randomPeerId()]);
		const v1 = createTestOwnerKey().publicKey;
		const v2 = createTestOwnerKey().publicKey;

		let A: CadreNode | undefined = nodeOn(partyId, aKey, captureA, 'storage', previous);
		let B: CadreNode | undefined;
		try {
			// ── 1. The party under the previous release; each machine writes a row the other reads ──
			await A.start();
			const owner = await makeOwnOwner(A);
			const sign = (message: Uint8Array): string => signMessageEd25519(message, owner.privateKeyB64);
			B = nodeOn(partyId, bKey, captureB, 'transaction', previous);
			await B.start();
			await A.authorizePeer(B.peerId!.toString());
			await connectControlNodes(B, A);

			await A.authorizePeer(x1);
			await controlDb(A).insertValidationKey(v1, owner.publicKey, sign);
			await waitForCadrePeerConverged(controlDb(B), x1, { timeoutMs: 30_000, description: 'B reads the peer row A wrote under the previous release' });
			// B's first touch of ValidationKey, BEFORE the migration: a table first touched after it
			// has this machine's older description written back over the record (docs bullet).
			await waitForValidationKey(B, v1, 'B reads the validation key A wrote under the previous release');
			expect(await controlDb(B).insertCadrePeer(peerRow(x2), owner.publicKey, sign)).toBe(true);
			await waitForCadrePeerConverged(controlDb(A), x2, { timeoutMs: 30_000, description: 'A reads the peer row B wrote under the previous release' });
			await registered(A, 'A');
			await registered(B, 'B');
			await awaitBlockCoverage(captureA.control(), captureB.control(), { description: "B's store covers A's before A updates" });

			// ── 2. A updates: restarts under the next release and migrates its catalog; B keeps running ──
			await A.stop();
			A = undefined;
			A = nodeOn(partyId, aKey, captureA, 'storage', next);
			await A.start();
			await A.useOwnerSigner(owner.signer);
			expect(storeVersionOf(A)).toBe(releases.nextVersion);
			await connectControlNodes(B, A);
			// The catch-up push copies A's blocks, its migrated catalog lineage included, into B's own
			// store: judged through the raw stores, since a read through B's database would pull the
			// blocks in and mask a push that did not happen.
			await awaitBlockCoverage(captureA.control(), captureB.control(), { description: "the catch-up push copies A's migrated catalog into B's store" });

			// ── 3. Rows cross the two releases ──
			expect(await controlDb(B).insertCadrePeer(peerRow(x3), owner.publicKey, sign)).toBe(true);
			await waitForCadrePeerConverged(controlDb(A), x3, { timeoutMs: 30_000, description: 'A reads the peer row B wrote on the previous release after the migration' });
			await insertValidationKeyWithNote(controlDb(A), partyId, owner, v2);
			expect((await validationKeyRow(controlDb(A), v2))?.Note).toBe(NOTE);
			await waitForValidationKey(B, v2, 'B reads the validation key A wrote with the new column');
			expect(Object.keys((await validationKeyRow(controlDb(B), v2))!)).not.toContain('Note');
			await awaitBlockCoverage(captureA.control(), captureB.control(), { description: "B's store covers A's before B updates" });

			// ── 4. B restarts on the previous release: starts on its own catalog lineage and keeps working ──
			// B's store holds the party's catalog twice: the lineage A's cold start committed, which
			// the catch-up push copied in and A's migration moved, and the one B's own cold start
			// committed alone, which is the one B's restart hydrates (file header). A `readBlockIndex`
			// of each store shows `optimystic/schema` at revision 1 under a different action id.
			await registered(B, 'B');
			await B.stop();
			B = undefined;
			B = nodeOn(partyId, bKey, captureB, 'transaction', previous);
			await B.start();
			expect(storeVersionOf(B)).toBe(releases.baselineVersion);
			await expectEveryRow(B, { x1, x2, x3, v1, v2, owner: owner.publicKey }, 'without the column');
			await B.stop();
			B = undefined;

			// ── 5. B updates: restarts under the next release, migrates its own lineage, and reads every row ──
			B = nodeOn(partyId, bKey, captureB, 'transaction', next);
			await B.start();
			expect(storeVersionOf(B)).toBe(releases.nextVersion);
			await expectEveryRow(B, { x1, x2, x3, v1, v2, owner: owner.publicKey }, 'with the column');
		} finally {
			await B?.stop();
			await A?.stop();
			await rm(schemaDir, { recursive: true, force: true });
		}
	}, 240_000);
});
