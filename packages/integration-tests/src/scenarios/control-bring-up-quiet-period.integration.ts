/**
 * Regression guard for `control-db-bring-up-runs-before-first-connection`, the
 * `controlNetwork.bootstrapNodes` arm.
 *
 * THE DEFECT. A sereus node builds its control database — the party's shared
 * membership table — as one of the first things it does after its network layer
 * comes up. Building it is not a local operation: every step asks the rest of the
 * party "do you already have this?", and a sibling that has not yet heard this node
 * is a member correctly refuses to answer. The node cannot tell "the party refuses
 * me right now" from "the party is gone", so the first refusal is fatal and
 * `start()` rejects with `BlockUnavailableError`. Retrying cannot converge either:
 * the thing that would clear the refusal is this node's own membership row reaching
 * the sibling, and writing that row needs the database the retry is building.
 *
 * So the fix is ORDERING — build the database while holding zero control
 * connections — and the guard is the connection gate's BRING-UP QUIET PERIOD
 * (`membership-connection-gater.ts`), which refuses control connections in both
 * directions until `ControlDatabase.initialize()` has settled.
 *
 * WHY THIS SCENARIO NEEDS SLOW STORAGE. `controlNetwork.bootstrapNodes` reaches
 * libp2p as `bootstrap({ list })`, whose `@libp2p/bootstrap` 12.x default emits its
 * discovery events one second after `libp2p.start()`; the connection manager
 * auto-dials from there. With the harness's in-memory storage on an idle machine,
 * bring-up finishes in ~100 ms — so the ordering holds by a 10x margin and a test
 * that merely booted such a node would pass with or without the gate. That margin
 * is a function of storage latency, not of code: a cold control start issues a
 * known, pinned number of raw-storage operations (see `control-database.ts`'s
 * `loadSchema` note), at ~1 ms/op on an idle machine but 50-90 ms/op on a loaded
 * disk or a phone's flash under launch contention — i.e. 9-15 s of bring-up, far
 * past the fuse. A phone joining a party is exactly a node whose membership row has
 * not replicated yet, so every ingredient is present in the field.
 *
 * This scenario therefore FORCES the ordering rather than racing it: a storage
 * backend that sleeps per operation (`slow-raw-storage.ts`) puts bring-up
 * deliberately past the fuse, so the bootstrap dial is guaranteed to fire while the
 * database is still being built.
 *
 * NOT VACUOUS — measured. With the quiet period disabled (`bringUpInFlight` forced
 * false) and everything else unchanged, C's `start()` fails inside schema creation:
 *
 *     QuereusError: Failed to execute DDL: create table CadreControl.CadrePeer (...)
 *       Module 'optimystic' create failed for table 'CadrePeer':
 *       Optimystic table 'CadrePeer' already exists in schema 'cadrecontrol'
 *
 * — a different symptom from the `BlockUnavailableError` the relay arm produced, and
 * a sharper statement of the same cause: it is not only that a mid-bring-up sibling
 * REFUSES the probes, it is that bring-up sees a foreign catalog at all. Any
 * connection in this window is the defect; which error surfaces depends on how far
 * bring-up got first.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '@serfab/cadre-core';
import {
	waitUntil,
	controlNodeConfig,
	makeOwnOwner,
	controlAddrs,
} from '../harness/index.js';

/**
 * `@libp2p/bootstrap`'s `DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT` — how long after
 * `libp2p.start()` it emits the discovery events the connection manager auto-dials
 * from. `libp2p-node-base.ts` passes no `timeout` override, so this is the live
 * value. Bring-up must outlast it for this scenario to be testing anything.
 */
const BOOTSTRAP_DISCOVERY_TIMEOUT_MS = 1_000;

/**
 * Sleep per raw-storage operation. A cold control start issues a few hundred
 * operations against the backend, so single-digit milliseconds is already several
 * seconds of bring-up — comfortably past the fuse above without making the suite
 * slow. The assertion on elapsed time below fails loudly if this ever stops being
 * enough, rather than letting the scenario quietly go vacuous.
 */
const STORAGE_OP_DELAY_MS = 12;

describe('E2E control-database bring-up holds no control connections', () => {
	it('a bootstrap-configured node whose party has not authorized it still starts, then converges', async () => {
		const partyId = `bringup-quiet-${Date.now()}`;
		let A: CadreNode | undefined;
		let C: CadreNode | undefined;
		try {
			// ── A: the owner, and C's bootstrap target ──────────────────────────────
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, strandFilter: 'none' }));
			await A.start();
			await makeOwnOwner(A, aKey);
			// One member row, so A's authorized set is non-empty and its gates no
			// longer take the cold-start admit-everyone carve-out. Without this A
			// would happily serve C and there would be no refusal to order around.
			await A.authorizePeer(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());
			// ...but an ENROLLMENT WINDOW is open, which is how a real invitee gets in:
			// the owner minted an invite, so A admits a stranger's CONNECTION for seed
			// delivery while its fail-closed per-stream gate still refuses that stranger
			// every control-DB protocol. That combination — connection admitted, streams
			// refused — is precisely what makes a mid-bring-up connection fatal, and
			// without it A would simply deny C's connection and there would be nothing to
			// order around.
			A.openEnrollmentWindow(Date.now() + 5 * 60_000);
			const aAddr = controlAddrs(A)[0];
			expect(aAddr).toBeDefined();

			// ── C: same party, NOT authorized, and told to dial A at start ──────────
			const cKey = await generateKeyPair('Ed25519');
			const cPeerId = peerIdFromPrivateKey(cKey).toString();
			expect(await A.isAuthorizedMember(cPeerId)).toBe(false);

			C = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: cKey,
				strandFilter: 'none',
				bootstrapNodes: [aAddr!],
				storageOpDelayMs: STORAGE_OP_DELAY_MS,
			}));

			const t0 = Date.now();
			await C.start();
			const startMs = Date.now() - t0;
			console.log('[bringup-quiet] start took %dms (bootstrap fuse %dms)', startMs, BOOTSTRAP_DISCOVERY_TIMEOUT_MS);

			// ANTI-VACUITY: bring-up has to have outlasted the bootstrap fuse, or the
			// dial never fired during the window and this case proved nothing.
			expect(startMs).toBeGreaterThan(BOOTSTRAP_DISCOVERY_TIMEOUT_MS);

			// ── Convergence: the row lands, and C joins its party for real ──────────
			await A.authorizePeer(cPeerId);

			await waitUntil(() => C!.getControlConnectionCount() > 0, {
				timeoutMs: 60_000,
				intervalMs: 500,
				description: 'the late-authorized node forms a control connection once its row lands',
			});

			// It is not merely connected — it can read the party's membership, which is
			// what the refused block probes were reading in the first place.
			await waitUntil(async () => (await C!.listMembers()).some((m) => m.peerId === cPeerId), {
				timeoutMs: 60_000,
				intervalMs: 500,
				description: 'the late-authorized node observes its own membership row',
			});
		} finally {
			await Promise.allSettled([C?.stop(), A?.stop()]);
		}
	}, 180_000);
});
