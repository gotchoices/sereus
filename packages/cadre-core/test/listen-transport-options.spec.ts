import { describe, it, expect } from 'vitest';
import { createLibp2pNode } from '@optimystic/db-p2p';
import { resolveListenAddrs, resolveTransportOptions } from '../src/relay-addrs.js';
import { strandNodeAddrs } from '../src/strand-network-config.js';
import type { NetworkConfig } from '../src/types.js';

/**
 * The one spec here that boots a REAL libp2p node, because the bug this closes was
 * invisible to every unit assertion: a configured `/ws` listen address was accepted,
 * resolved, forwarded to `createLibp2pNode` — and then dropped by libp2p's transport
 * manager, which sorts listen addresses by the transport that claims them, discards
 * the unclaimed ones, and raises only when EVERY address was discarded. Pair a TCP
 * address with a WebSocket one and the TCP address carries the start while nothing
 * reports the missing WebSocket listener.
 *
 * So the assertion that matters is the one taken from the node AFTER it starts:
 * `getMultiaddrs()` either contains a `/ws` entry or it does not. Everything upstream
 * of that can be right while the node still listens on nothing.
 *
 * This also re-verifies the load-bearing assumption behind `wsPort` — that
 * `@optimystic/db-p2p` falls back to its default TRANSPORTS and its default LISTEN
 * ADDRS independently, so passing `wsPort` alongside explicit `listenAddrs` adds the
 * `webSockets()` transport while discarding the address db-p2p synthesized from that
 * port. db-p2p's own doc comment says `wsPort` is "Ignored when
 * `transports`/`listenAddrs` are explicitly provided", which is true of the address
 * half only. If that comment ever becomes true of both halves, the `/ws` assertion
 * below is what fails — see `relay-addrs.ts` → `WS_TRANSPORT_SWITCH_PORT`.
 *
 * The pure classification rules live in `relay-addrs.spec.ts`; the per-node-kind
 * wiring lives in `cadre-node-control-node-options.spec.ts` and
 * `strand-network-config.spec.ts`. Only the libp2p round-trip belongs here.
 */

/** Bringing a libp2p node up and down; generous, and only there to catch a hang. */
const BOOT_TIMEOUT_MS = 30_000;

/** Loopback-only variants of the shipped drone config, so a test binds nothing public. */
const DRONE_LISTEN_ADDRS = ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws'];

/**
 * Start a node on `listenAddrs` with the transports those addresses imply, and return
 * the addresses it actually ended up listening on.
 */
async function boundMultiaddrs(network: NetworkConfig): Promise<string[]> {
	const listenAddrs = resolveListenAddrs(network);
	const node = await createLibp2pNode({
		port: 0,
		bootstrapNodes: [],
		networkName: `listen-transport-${Math.random().toString(36).slice(2)}`,
		...(listenAddrs && { listenAddrs }),
		...resolveTransportOptions(network, listenAddrs)
	});
	try {
		return node.getMultiaddrs().map((addr) => addr.toString());
	} finally {
		await node.stop();
	}
}

describe('a configured listen address reaches a real listener', () => {
	it('binds the WebSocket address the React Native drone config ships alongside its TCP one', async () => {
		const bound = await boundMultiaddrs({ listenAddrs: DRONE_LISTEN_ADDRS });

		// Both halves, not either: the original bug was precisely that the TCP half
		// succeeded and covered for the WebSocket half being dropped.
		expect(bound.some((addr) => addr.includes('/ws/'))).toBe(true);
		expect(bound.some((addr) => /\/tcp\/\d+\/p2p\//.test(addr))).toBe(true);
	}, BOOT_TIMEOUT_MS);

	/**
	 * `--ws-port <port>` (`cadre-cli`'s `start.ts`) does nothing but append
	 * `/ip4/0.0.0.0/tcp/<port>/ws` to `network.listenAddrs`, so this is that flag's
	 * behaviour end to end minus the argument parsing. The port has to survive: it is
	 * the operator's choice, and `wsPort` is only a switch.
	 */
	it('binds the exact port a /ws-only config names, proving wsPort never reaches a bind', async () => {
		const bound = await boundMultiaddrs({ listenAddrs: ['/ip4/127.0.0.1/tcp/4402/ws'] });

		expect(bound.some((addr) => addr.startsWith('/ip4/127.0.0.1/tcp/4402/ws/'))).toBe(true);
		// `wsPort` is passed as 0; if db-p2p's synthesized default address were being
		// honoured instead of discarded, a second OS-assigned `/ws` entry would appear.
		expect(bound.filter((addr) => addr.includes('/ws/'))).toHaveLength(1);
	}, BOOT_TIMEOUT_MS);

	/** A strand node derives its own listen set, and must reach the same listener. */
	it('binds a strand node\'s /ws listener too, at the ephemeral port that path rewrites to', async () => {
		const network: NetworkConfig = { listenAddrs: ['/ip4/127.0.0.1/tcp/4001', '/ip4/127.0.0.1/tcp/4002/ws'] };
		const addrOptions = strandNodeAddrs(network);
		const node = await createLibp2pNode({
			port: 0,
			bootstrapNodes: [],
			networkName: `listen-transport-strand-${Math.random().toString(36).slice(2)}`,
			...addrOptions
		});
		try {
			const bound = node.getMultiaddrs().map((addr) => addr.toString());

			expect(bound.some((addr) => addr.includes('/ws/'))).toBe(true);
			// The operator's fixed 4002 was rewritten to an ephemeral port — two nodes on
			// one machine cannot both bind it (`strand-network-config.ts`).
			expect(bound.some((addr) => addr.includes('/tcp/4002/'))).toBe(false);
		} finally {
			await node.stop();
		}
	}, BOOT_TIMEOUT_MS);
});
