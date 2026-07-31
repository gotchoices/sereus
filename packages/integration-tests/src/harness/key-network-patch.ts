/**
 * Guarded prototype patching for `Libp2pKeyPeerNetwork`.
 *
 * Three cohort helpers substitute or wrap `Libp2pKeyPeerNetwork.prototype.findCluster` /
 * `findCoordinator` (`forceFullCohort` and `pinCoordinator` in `forced-cluster.ts`,
 * `observeControlCohorts` in `control-cohort.ts`), and two of them WRAP whatever is
 * installed at the time. Stacked patches are therefore a last-in-first-out stack and must
 * be restored in reverse order of application.
 *
 * Why this module exists rather than three hand-rolled save/restore pairs: an
 * out-of-order restore used to reinstate a stale method and leave a patch installed for
 * the rest of the suite, and the symptom — some later test quietly seeing a forced cohort,
 * or an observer counting calls nobody made — gives no hint where it came from. Here the
 * restore checks that it is still the top of the stack and throws naming the rule instead.
 * The throw does NOT latch: once the later patch is unwound, the same handle restores
 * normally, so a `finally` block can recover.
 */

import { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';

/** The `Libp2pKeyPeerNetwork` prototype methods the cohort helpers patch. */
export type PatchableMethod = 'findCluster' | 'findCoordinator';

export interface KeyNetworkPatch<M extends PatchableMethod> {
	/**
	 * Whatever was installed when this patch was applied — the real method, or an
	 * outer patch's. A wrapping patch must delegate to this, not to the class method.
	 */
	readonly inner: Libp2pKeyPeerNetwork[M];
	/**
	 * Reinstate {@link inner}. A no-op once it has succeeded; throws (without marking
	 * itself restored) while a later patch is still installed over this one.
	 */
	restore(): void;
}

/**
 * Install `build(inner)` over `Libp2pKeyPeerNetwork.prototype[method]` on behalf of
 * `who`, which names the helper in the out-of-order-restore error.
 */
export function patchKeyNetwork<M extends PatchableMethod>(
	who: string,
	method: M,
	build: (inner: Libp2pKeyPeerNetwork[M]) => Libp2pKeyPeerNetwork[M]
): KeyNetworkPatch<M> {
	const inner: Libp2pKeyPeerNetwork[M] = Libp2pKeyPeerNetwork.prototype[method];
	const patched = build(inner);
	Libp2pKeyPeerNetwork.prototype[method] = patched;

	let restored = false;
	return {
		inner,
		restore(): void {
			if (restored) return;
			if (Libp2pKeyPeerNetwork.prototype[method] !== patched) {
				throw new Error(
					`${who}: cannot restore ${method} — a later patch is still installed over this `
					+ 'one. Restore in reverse order of application (last applied, first restored); '
					+ `${method} is left patched until that happens.`);
			}
			Libp2pKeyPeerNetwork.prototype[method] = inner;
			restored = true;
		}
	};
}
