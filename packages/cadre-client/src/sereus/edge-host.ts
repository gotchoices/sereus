/**
 * A ready-made host over cadre-core's edge node: `edgeNodeHost(edge)`.
 *
 * An `EdgeNode` is what an app on a phone or in a browser runs: on React Native it is what
 * `@serfab/cadre-rn`'s `createPhoneNode` returns; on the web and NativeScript the app builds
 * it with `createEdgeNode` from `@serfab/cadre-core/edge-node`. This adapts one to
 * `CadreHost`, so an app on the edge node needs no host code of its own:
 *
 *   const cadre = createCadreClient(edgeNodeHost(phone, { ownerKeyStore }));
 *
 * An app with its own node service writes its own `CadreHost` instead (a dozen thin members).
 */
import type { CadreNode, KeyStore } from '@serfab/cadre-core';
import type { EdgeNode } from '@serfab/cadre-core/edge-node';
import type { CadreHost } from './host.js';

export interface EdgeNodeHostOptions {
	/** Where this device keeps its owner key, for `exportOwnerKey`; on React Native, the kit's `SecureStoreKeyStore`. */
	ownerKeyStore?: KeyStore;
	/** Where the cadron preferences are kept (`CadreHost.preferences`); absent, for the session only. */
	preferences?: CadreHost['preferences'];
}

export function edgeNodeHost(edge: EdgeNode, opts: EdgeNodeHostOptions = {}): CadreHost {
	async function relayAddrs(): Promise<string[]> {
		if (edge.options) return [...edge.options.relayAddrs];
		return [...((await edge.loadSavedStart())?.options.relayAddrs ?? [])];
	}

	/** Re-read when the control node's own addresses change (a reservation granted, lost or moved). */
	function watchAddrs(node: CadreNode | null, onChange: () => void): () => void {
		const control = node?.getControlNode();
		if (!control) return () => {};
		let last = node!.getMultiaddrs().join(' ');
		const onSelf = () => {
			const now = node!.getMultiaddrs().join(' ');
			if (now === last) return;
			last = now;
			onChange();
		};
		control.addEventListener('self:peer:update', onSelf);
		return () => control.removeEventListener('self:peer:update', onSelf);
	}

	return {
		ownerKeyStore: opts.ownerKeyStore,
		preferences: opts.preferences,
		node: {
			get node() { return edge.node; },
			on: (event, handler) => edge.on(event, handler),
			getRelayAddrs: relayAddrs,
			/**
			 * Relays are read when a node is BUILT (`network.relayAddrs`), which is what gives the
			 * control node and every strand node a circuit listener; so a new set restarts the node.
			 * An unchanged set does nothing. A stopped node cannot take them: start it first.
			 */
			async applyRelays(addrs) {
				const next = [...addrs];
				const current = await relayAddrs();
				if (next.length === current.length && next.every((a, i) => a === current[i])) return;
				if (!edge.options || edge.status.state !== 'running') {
					throw new Error('The node is not running; start it before changing its relays.');
				}
				await edge.restart({ ...edge.options, relayAddrs: next });
			},
			partyId: () => edge.options?.partyId ?? null,
			ownerEnrolled: () => edge.status.state === 'running' && edge.status.owner === 'enrolled',
			relayStatus: () => edge.node?.getRelayReservationState().status ?? null,
			onReachabilityChange(onChange) {
				let unwatch = watchAddrs(edge.node, onChange);
				// A start, stop or rebuild replaces the node: watch the new one, and say so.
				const offStatus = edge.onStatus(() => {
					unwatch();
					unwatch = watchAddrs(edge.node, onChange);
					onChange();
				});
				return () => { offStatus(); unwatch(); };
			},
		},
	};
}
