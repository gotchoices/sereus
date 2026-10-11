import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { PERSISTED_STATE_VERSION, type PersistedNetworkState } from '@optimystic/db-p2p';
import type { CadreNode } from '../src/cadre-node.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { adoptStrandBundle, exportStrandBundle, type StrandBundle, type StrandBundleEntry } from '../src/strand-move.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';

/**
 * `adoptStrandBundle` on a real self-owner node: the contract a crash between rows depends
 * on (adopting the same bundle twice leaves one row per table per strand, under the bundle's
 * keys) and the one permanent refusal (a strand this party already participates in under its
 * own identity), which must not stop the other strands. Export's three sources and the
 * invitation arithmetic are checked by inspection and by the `strand-moves-between-cadres`
 * integration scenario.
 */
describe('adoptStrandBundle', () => {
	let node: CadreNode | undefined;

	afterEach(async () => {
		await node?.stop();
		node = undefined;
	});

	const rand = (): string => Math.random().toString(36).slice(2);

	/** A routing table distinguishable by its high-water mark; the move never looks inside it. */
	function stateWith(networkHighWaterMark: number): PersistedNetworkState {
		return { version: PERSISTED_STATE_VERSION, networkHighWaterMark, lastConnectedTimestamp: 0, consecutiveIsolatedSessions: 0 };
	}

	/** A strand address naming a destination peer, as a formation carries them. */
	async function carriedAddr(): Promise<string> {
		return `/ip4/127.0.0.1/tcp/4001/ws/p2p/${peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()}`;
	}

	/** One closed strand the exporting party founded and one it joined, each with a party key. */
	async function twoClosedStrands(): Promise<{ own: StrandBundleEntry; joined: StrandBundleEntry }> {
		return {
			own: {
				kind: 'own',
				row: { Id: 'moved-own-' + rand(), Type: 'c', MemberPrivateKey: await generateStrandMemberKey() },
				partyKey: await generateStrandMemberKey(),
				networkState: stateWith(7),
				carriedAddrs: [await carriedAddr()]
			},
			joined: {
				kind: 'joined',
				row: { Id: 'moved-joined-' + rand(), Type: 'c', MemberPrivateKey: await generateStrandMemberKey() },
				partyKey: await generateStrandMemberKey(),
				carriedAddrs: []
			}
		};
	}

	function bundleOf(...strands: StrandBundleEntry[]): StrandBundle {
		return { v: 1, partyId: 'former-party-' + rand(), exportedAt: Date.now(), strands, pendingJoins: [], formationInvites: [] };
	}

	async function rowCount(table: 'Strand' | 'JoinedStrand' | 'StrandPartyKey', strandId: string): Promise<number> {
		const row = await node!.getControlDatabase()!.getDatabase().get(`select count(1) as c from CadreControl.${table} where Id = ?`, [strandId]);
		return Number(row?.c ?? 0);
	}

	it('adopts the same bundle twice onto one row per table per strand, seating the party key and peers before the row', async () => {
		({ node } = await startSelfOwnerNode('strand-move-'));
		const db = node.getControlDatabase()!;
		const { own, joined } = await twoClosedStrands();
		const bundle = bundleOf(own, joined);
		const partyKeyInsert = vi.spyOn(db, 'insertStrandPartyKey');
		const strandInsert = vi.spyOn(db, 'insertStrand');
		const joinedInsert = vi.spyOn(db, 'insertJoinedStrand');

		const first = await adoptStrandBundle(node, bundle);
		const second = await adoptStrandBundle(node, bundle);

		expect(first).toEqual({
			fromPartyId: bundle.partyId,
			moved: [own.row.Id, joined.row.Id],
			refused: [],
			failed: [],
			invitationsMoved: 0,
			invitationsDropped: 0,
			pendingJoinsMoved: 0
		});
		expect(second).toEqual(first);
		for (const entry of [own, joined]) {
			expect(await rowCount('StrandPartyKey', entry.row.Id)).toBe(1);
			expect(await db.queryStrandPartyKey(entry.row.Id)).toBe(entry.partyKey);
		}
		expect(await rowCount('Strand', own.row.Id)).toBe(1);
		expect(await rowCount('JoinedStrand', own.row.Id)).toBe(0);
		expect(await rowCount('JoinedStrand', joined.row.Id)).toBe(1);
		expect(await rowCount('Strand', joined.row.Id)).toBe(0);
		expect(await db.queryStrand(own.row.Id)).toMatchObject(own.row);
		expect(await db.queryJoinedStrand(joined.row.Id)).toMatchObject(joined.row);

		// The watcher race: the party key must be seated before the row it would launch, and
		// the strand's peers before both.
		expect(partyKeyInsert.mock.invocationCallOrder[0]).toBeLessThan(strandInsert.mock.invocationCallOrder[0]!);
		expect(partyKeyInsert.mock.invocationCallOrder[1]).toBeLessThan(joinedInsert.mock.invocationCallOrder[0]!);
		expect(node.getStrandNetworkStateStore()!.load(own.row.Id)).toEqual(own.networkState);
		expect(node.getCarriedStrandAddrs(own.row.Id)).toEqual(own.carriedAddrs);

		// What was adopted is what a move out of this party would export.
		const exported = await exportStrandBundle(node);
		expect(exported.partyId).toBe(node.partyId);
		expect(exported.strands).toEqual(expect.arrayContaining([own, joined]));
	}, 60_000);

	it('refuses a strand this party already participates in under its own identity, and still moves the others', async () => {
		({ node } = await startSelfOwnerNode('strand-move-'));
		const db = node.getControlDatabase()!;
		const { own, joined } = await twoClosedStrands();
		const existingKey = await generateStrandMemberKey();
		await node.ensureStrandPartyKey(own.row.Id, existingKey);

		const report = await adoptStrandBundle(node, bundleOf(own, joined));

		expect(report.refused).toEqual([{ strandId: own.row.Id, reason: expect.stringContaining('keeps that membership') }]);
		expect(report.moved).toEqual([joined.row.Id]);
		expect(report.failed).toEqual([]);
		expect(await db.queryStrandPartyKey(own.row.Id)).toBe(existingKey);
		expect(await db.queryStrand(own.row.Id)).toBeNull();
		expect(await db.queryJoinedStrand(joined.row.Id)).toMatchObject(joined.row);
	}, 60_000);
});
