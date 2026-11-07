import { describe, it, expect, vi } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { ControlDatabase } from '../src/control-database.js';
import { freshKeyPair } from './control-constraint-helpers.js';
import { createControlNode, freshPartyId } from './control-db-node-helpers.js';

/**
 * `ControlDatabase.close()` stops Quereus and waits for it before shutting storage down: a
 * statement still running when close starts must not reach a stopped control node, and close
 * must not resolve while Quereus is still unwinding it. The collection factory's shutdown stops
 * the injected node, so the node's `stop` is the observable storage shutdown.
 */
describe('ControlDatabase.close', () => {
	it('closes Quereus, and waits for it, before stopping the control node', async () => {
		const partyId = freshPartyId('control-close');
		const node = await createControlNode(partyId, new MemoryRawStorage());
		const controlDb = new ControlDatabase({ partyId, libp2pNode: node, coordinatedRepo: node.coordinatedRepo });
		try {
			await controlDb.initialize();
			expect(await controlDb.ensureOwnerKey(freshKeyPair().publicKey)).toBe(true);

			const db = controlDb.getDatabase();
			let quereusClosed = false;
			const closeQuereus = db.close.bind(db);
			vi.spyOn(db, 'close').mockImplementation(() => {
				const closing = closeQuereus();
				void closing.then(() => { quereusClosed = true; });
				return closing;
			});
			let quereusClosedAtNodeStop: boolean | undefined;
			const stopNode = node.stop.bind(node);
			vi.spyOn(node, 'stop').mockImplementation(async () => {
				quereusClosedAtNodeStop ??= quereusClosed;
				await stopNode();
			});

			const rows = db.eval('select Key from CadreControl.OwnerKey')[Symbol.asyncIterator]();
			expect((await rows.next()).done).toBe(false);

			await controlDb.close();

			expect(quereusClosed).toBe(true);
			expect(quereusClosedAtNodeStop).toBe(true);
			await expect(rows.next()).rejects.toThrow('Database is closed');
		} finally {
			await controlDb.close();
			await node.stop();
		}
	}, 60_000);
});
