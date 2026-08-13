import { describe, it, expect } from 'vitest';
import { admitManager, removeManager } from '../src/strand-membership-writer.js';
import { freshKeyPair, tableCount, openStrand } from './strand-spec-helpers.js';

/**
 * **Transactor parity for the strand membership constraints — NOT a re-litigation
 * of the RBAC rules.**
 *
 * Every `strand-membership-*.spec.ts` suite runs on the LOCAL transactor
 * (`openRawStrand`'s default), because that is what a solo test strand launches
 * on today. The deferred, subquery-bearing `CHECK` constraints those suites pin
 * — `Manager.Authorized`, `Manager.MinOneManager` — are what stop an
 * unauthorized party from removing a strand's administrators. Reading the code
 * says enforcement lives in Quereus and the optimystic vtab session, not in the
 * transactor; this spec is the proof, gathered before the strand `bootstrap`
 * mode is retired (`retire-strand-mode-in-cadre-core`) and the NETWORK
 * transactor becomes the only production path.
 *
 * Each case below re-runs one of the strongest existing membership assertions
 * through the network transactor (`openStrand(type, 'network')`), mirroring a
 * named test in `strand-membership-manager-rotation.spec.ts` — which keeps
 * running on the local transactor. Enough, not exhaustive: three cases covering
 * a rejected delete, the deferred post-image floor, and an accepted multi-step
 * flow exercise the constraint machinery's distinct shapes.
 *
 * Every case boots a real (isolated) libp2p node, so the case count stays low
 * and the per-test timeout generous.
 */

describe('strand membership constraints, network transactor parity', () => {
	// Mirrors: `strand-membership-manager-rotation.spec.ts` →
	// "a non-manager removal is rejected (deferred CHECK enforced on delete)".
	// `Manager.Authorized` (deferred, subquery-bearing, on delete) must reject a
	// signer that is neither an existing manager nor the target itself — on this
	// transactor too, or the retirement would ship a strand whose administrators
	// anyone can remove.
	it('rejects an unauthorized Manager delete (Manager.Authorized, deferred, on delete)', async () => {
		const { db, founder } = await openStrand('c', 'network');
		const other = freshKeyPair();
		await admitManager(db, { byManagerKeyPair: founder, newManagerKey: other.publicKeyB64 });
		expect(await tableCount(db, 'Manager')).toBe(2);

		const notAManager = freshKeyPair();
		// Post-delete count would be 1, so the insert-only bootstrap branch cannot
		// waive the signature and MinOneManager is satisfied — Authorized is the
		// constraint doing the rejecting, same as the mirrored local-transactor test.
		await expect(
			removeManager(db, { byManagerKeyPair: notAManager, targetManagerKey: other.publicKeyB64 }),
		).rejects.toThrow(/Authorized/);

		expect(await tableCount(db, 'Manager')).toBe(2); // unchanged — nothing was removed
	}, 60_000);

	// Mirrors: `strand-membership-manager-rotation.spec.ts` →
	// "rejects the SOLE manager resigning (min-one-manager floor)".
	// `Manager.MinOneManager` (`check on delete`, deferred → sees the POST-delete
	// count) must keep a closed strand from reaching zero managers. The signature
	// is a valid self-resignation, so MinOneManager is the only possible rejector
	// — pinning the name proves the floor fired on this transactor.
	it('rejects the sole manager resigning (Manager.MinOneManager, deferred, on delete)', async () => {
		const { db, founder } = await openStrand('c', 'network');
		expect(await tableCount(db, 'Manager')).toBe(1);

		await expect(
			removeManager(db, { byManagerKeyPair: founder, targetManagerKey: founder.publicKeyB64 }),
		).rejects.toThrow(/MinOneManager/);

		expect(await tableCount(db, 'Manager')).toBe(1);
	}, 60_000);

	// Mirrors the acceptance halves of `strand-membership-manager-rotation.spec.ts` →
	// "an existing manager promotes a second manager" + "a manager resigns itself",
	// composed into the documented hand-off order (add the successor FIRST, resign
	// SECOND — see `removeManager`'s doc). Parity must hold for acceptance too: a
	// transactor that over-rejects would freeze a legitimate administrator change.
	it('accepts an authorized add-then-resign hand-off', async () => {
		const { db, founder } = await openStrand('c', 'network');
		const successor = freshKeyPair();

		await admitManager(db, { byManagerKeyPair: founder, newManagerKey: successor.publicKeyB64 });
		expect(await tableCount(db, 'Manager')).toBe(2);

		await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: founder.publicKeyB64 });

		expect(await tableCount(db, 'Manager')).toBe(1);
		expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [successor.publicKeyB64]))
			.toBeTruthy();
		expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64]))
			.toBeUndefined();
	}, 60_000);
});
