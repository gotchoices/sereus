import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { createLibp2pNode, MemoryRawStorage } from '@optimystic/db-p2p';
import type { IRawStorage, OptimysticNode } from '@optimystic/db-p2p';
import type { Database } from '@quereus/quereus';
import { ControlDatabase } from '../src/control-database.js';
import { CONTROL_CLUSTER_POLICY, CONTROL_REPLICATION_BREADTH } from '../src/types.js';
import { freshPartyId } from './control-db-node-helpers.js';

/**
 * `ControlDatabase.loadSchema` retries its whole `apply schema CadreControl` statement when it
 * fails transiently, and the safety of that re-run rests on a property of the engine pair
 * underneath: when a migration step fails, Quereus unwinds every step it ran and checks the
 * resulting catalog against a fingerprint taken before the apply, and the optimystic plugin's
 * schema batch hooks carry that unwind through to STORAGE. Without the plugin half, storage
 * would be left holding objects the catalog no longer lists and the re-run would diff against a
 * catalog that disagrees with the blocks. The argument in full is at the `loadSchema` call site;
 * this file pins the property it rests on.
 *
 * NOTE: those batch hooks are unreleased — `../optimystic` HEAD calls itself 1.5.0, the same
 * version the registry serves without them, so `@optimystic/quereus-plugin-optimystic: ^1.5.0`
 * admits both and the range gate cannot tell them apart. This spec is therefore expected to fail
 * under `yarn check:published` (which runs these suites against registry copies of the siblings)
 * until the hooks ship under a version the floor can name. That is a THIRD triage arm beyond the
 * three `docs/testing.md` lists for that script: not a stale range, not a defect, not a spec that
 * assumed the linked install shape — a real upstream capability the published artifact lacks.
 *
 * ONE behaviour, over real optimystic storage: a refused DDL step part-way through the apply
 * leaves storage and the catalog in step, and the next apply reaches the complete schema.
 *
 * ## What this file is NOT
 *
 * It does not exercise the retry LOOP. The refusal injected below is rewritten on its way up into
 * `Block … is unavailable (unmaterializable)`, and `isRetriableSchemaInitFailure` declines that —
 * an unavailable block is a durable convergence fault, not a cohort that stayed silent — so
 * `lockedWithRetry` never fires and the failure propagates on the first attempt. That
 * classification is correct, and it is why nothing here should try to forge a retriable message at
 * the storage seam. The loop itself is covered over a stubbed `exec` in
 * `control-write-retry.spec.ts`. The two files are a matched pair: that one drives the loop and
 * assumes this property, this one proves the property and never reaches the loop.
 *
 * ## Why it builds `ControlDatabase` directly
 *
 * The re-apply has to run on the SAME Quereus `Database` the failed apply ran on, because that is
 * what the retry does. A fresh database would also take the plugin's hydrate path, so it could
 * pass while the unwind had left stale state behind in the live plugin — the shape optimystic's
 * own `schema-batch.spec.ts` covers for a two-table fixture, and the shape this file would lose.
 * `CadreNode` cannot give it: it discards its `ControlDatabase` when `start()` fails. So the node
 * options below are hand-built rather than taken from `CadreNode.buildControlNodeOptions`, naming
 * the subset the apply depends on (control network name, storage, control cluster policy).
 * Nothing checks that they stay in step with `CadreNode`, and nothing needs to — what is under
 * test is the schema apply over optimystic storage, not how a node is configured.
 */

/** The nine `CadreControl` tables `schemas/control.qsql` declares, in name order. */
const CONTROL_TABLE_NAMES = [
	'CadrePeer',
	'DeviceToken',
	'FormationInvite',
	'FormationUsage',
	'OwnerKey',
	'Revocation',
	'Strand',
	'StrandPartyKey',
	'ValidationKey'
] as const;

/**
 * The optimystic collection id of the `CadrePeer` table — `default/<schema>/<table>` with the
 * schema lowercased — which is also that collection's header block id (see
 * `CollectionFactory.getCollectionId`). Refusing this one id fails exactly the
 * `create table CadreControl.CadrePeer` step, four tables into the apply, and leaves every other
 * step's storage untouched.
 */
const CADRE_PEER_BLOCK = 'default/cadrecontrol/CadrePeer';

interface StorageGate {
	storage: IRawStorage;
	/** How many calls the gate has refused so far. */
	refusals(): number;
	/** End the outage: every later call reaches the wrapped storage. */
	heal(): void;
}

/**
 * Wrap `inner` so that, until {@link StorageGate.heal}, every call naming `blockId` throws instead
 * of reaching it. One block's outage, with the rest of the store working normally.
 *
 * A `Proxy` rather than a hand-written delegate: every `IRawStorage` method that names a block
 * takes its id first, so this keeps holding for methods the interface grows later instead of
 * passing them through ungated. The store-wide ones (`getStoreIdentity`, `listBlockIds`,
 * `getApproximateBytesUsed`) name no block and so fall through untouched, which is what they
 * should do — the outage is one block's, not the store's.
 *
 * Refusing until healed rather than spending a fixed budget of refusals, because the number is not
 * a property of the apply: the layer below absorbs the first refused read and retries it, so a
 * budget of one never reaches the DDL at all, and a budget tuned to today's retry count would
 * quietly stop failing the step if that count ever changed.
 */
function gateBlock(inner: IRawStorage, blockId: string): StorageGate {
	let shut = true;
	let refused = 0;
	const storage = new Proxy(inner, {
		get(target, prop) {
			const value = Reflect.get(target, prop) as unknown;
			if (typeof value !== 'function') {
				return value;
			}
			return (...args: unknown[]): unknown => {
				if (shut && args[0] === blockId) {
					refused++;
					throw new Error(`storage gate: refusing ${String(prop)} for ${blockId}`);
				}
				return (value as (...rest: unknown[]) => unknown).apply(target, args);
			};
		}
	}) as IRawStorage;
	return { storage, refusals: () => refused, heal: () => { shut = false; } };
}

/**
 * The control node's libp2p node, the way `CadreNode` builds its own: WebSockets-only with no
 * listen address (so it opens no connections and binds no port), this party's control network
 * name, and the control cluster policy — that last because the apply's writes commit through it.
 */
function createControlNode(partyId: string, storage: IRawStorage): Promise<OptimysticNode> {
	return createLibp2pNode({
		port: 0,
		bootstrapNodes: [],
		networkName: `control-${partyId}`,
		storage,
		fretProfile: 'edge',
		clusterSize: CONTROL_REPLICATION_BREADTH,
		clusterPolicy: CONTROL_CLUSTER_POLICY,
		transports: [webSockets()],
		listenAddrs: [],
		arachnode: { enableRingZulu: false }
	});
}

/** `ControlDatabase`'s private apply seam, named so the cast below can reach it. */
interface SchemaApplyInternals {
	db: Database | null;
	loadSchema: () => Promise<void>;
}

/** Every `cadrecontrol` object the live catalog lists, as `type` -> names in name order. */
async function readCatalog(db: Database): Promise<Map<string, string[]>> {
	const byType = new Map<string, string[]>();
	for await (const row of db.eval(`select "type", name from schema() where "schema" = 'cadrecontrol'`)) {
		const type = row.type as string;
		const names = byType.get(type) ?? [];
		names.push(row.name as string);
		byType.set(type, names);
	}
	for (const names of byType.values()) {
		names.sort();
	}
	return byType;
}

describe('apply schema CadreControl, unwound by a refused DDL step', () => {
	it('leaves storage and the catalog in step, and the next apply reaches the whole schema', async () => {
		const partyId = freshPartyId('schema-apply-unwind');
		const gate = gateBlock(new MemoryRawStorage(), CADRE_PEER_BLOCK);
		const node = await createControlNode(partyId, gate.storage);
		const controlDb = new ControlDatabase({
			partyId,
			libp2pNode: node,
			coordinatedRepo: node.coordinatedRepo
		});
		const internals = controlDb as unknown as SchemaApplyInternals;

		try {
			// --- Attempt 1: the CadrePeer create dies on refused storage ----------------
			const failure = await controlDb.initialize().then(
				() => null,
				(err: unknown) => err
			);

			expect(failure, 'the gated apply must fail').toBeInstanceOf(Error);
			const message = (failure as Error).message;
			// The NAMED step, not just "something failed": this is what says the apply died
			// four tables in rather than before it started or after it finished.
			expect(message).toContain('Failed to execute DDL: create table CadreControl.CadrePeer');
			// Anti-vacuity: the gate is what failed it. (Measured 2026-09-25: two refusals —
			// the layer below absorbs the first and retries once. The unwind does not ask for
			// this block at all, so leaving the gate shut across it changes nothing.)
			expect(gate.refusals(), 'the gate must have refused at least once').toBeGreaterThan(0);

			// Quereus reports an unwind that did NOT complete by appending its reason to the
			// original error; the absence of that sentence is the engine's own verdict that
			// the journal ran in reverse and the catalog matched its pre-apply fingerprint.
			expect(message).not.toContain('partially migrated');

			// And the unwind was TOTAL, which is the claim the call-site comment rests on:
			// the four tables that HAD landed are gone from the catalog too, so attempt 2
			// re-emits the whole schema rather than resuming at CadrePeer. Without this the
			// test would also pass on an engine that left them in place, since the re-apply's
			// diff reaches the complete schema either way.
			expect(await readCatalog(internals.db!), 'the failed apply must be taken back whole')
				.toEqual(new Map());

			// --- Attempt 2: the same Database, re-applying the same schema --------------
			// Exactly what `lockedWithRetry` re-runs, minus the classifier that (rightly)
			// declines this particular failure.
			gate.heal();
			await internals.loadSchema();

			// The WHOLE `cadrecontrol` catalog, so a table or index that went missing and one
			// that appeared uninvited both fail here: nine tables and the one index
			// `schemas/control.qsql` declares, and nothing of the plugin's own alongside them
			// (measured 2026-09-25).
			expect(await readCatalog(internals.db!)).toEqual(new Map([
				['table', [...CONTROL_TABLE_NAMES]],
				['index', ['FormationUsageByToken']]
			]));
		} finally {
			// Nested, not sequential: a `close()` that throws must not strand the libp2p node
			// in the worker for the rest of the run.
			try {
				await controlDb.close();
			} finally {
				await node.stop();
			}
		}
	});
});
