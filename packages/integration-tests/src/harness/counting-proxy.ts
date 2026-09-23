/**
 * A counting TCP proxy to put in front of a relay's WebSocket port, plus the
 * connection gater that stops the measured node from dialing around it.
 *
 * This is the per-LINK instrument. `ws-latency.ts` swaps the process's global
 * WebSocket constructor, so it delays and counts for EVERY node in the process at
 * once; this one sees only the node whose `relayAddrs` name the proxy port. That is
 * what makes "exchanges on A's link" a measurement of one party's relay traffic
 * rather than the whole process's, and what lets one party be slow while the other
 * is not.
 *
 * An EXCHANGE is a direction change on one socket pair: bytes from the dialing node
 * after bytes from the relay, or the reverse. Roughly one request plus its response
 * per two exchanges. It is a stand-in for round trips, and a coarse one — several
 * concurrent streams are multiplexed over the one socket, so a burst of requests
 * answered in a burst counts as two exchanges, not two per request. Read it as a
 * relative number between runs of the same scenario, not as an absolute round-trip
 * count.
 *
 * With `delayMs`, each chunk is forwarded that long after it arrived, so chunks stay
 * overlapped in flight — the same `pipelined` model `ws-latency.ts` documents, and
 * one-way per direction, so a round trip costs 2 × `delayMs`. It is not a bandwidth
 * or loss model, and it is not a frame-rate cap.
 */

import net from 'node:net';
import type { ConnectionGater } from '@libp2p/interface';

export interface CountingProxyOptions {
	/** Port every accepted socket is forwarded to — the relay's real WebSocket port. */
	targetPort: number;
	/** Host to forward to (default `127.0.0.1`). */
	targetHost?: string;
	/** Hold each chunk this long before forwarding it, each way (default 0). */
	delayMs?: number;
}

export interface CountingProxy {
	/** The loopback port to dial instead of the relay's own. */
	readonly port: number;
	/**
	 * Direction changes across every socket pair since the proxy started. Monotonic:
	 * a window is the difference between two readings, so one reading can serve
	 * several overlapping windows.
	 */
	exchanges(): number;
	/** Bytes forwarded in both directions since the proxy started. */
	bytes(): number;
	/** Sockets accepted since the proxy started — how many links the node opened. */
	socketCount(): number;
	/** Close the listener and destroy every socket still open. */
	stop(): Promise<void>;
}

/**
 * Start a counting proxy on an ephemeral loopback port. Caller owns shutdown
 * (`proxy.stop()`); a delayed chunk still in flight at that point is dropped.
 */
export async function startCountingProxy(opts: CountingProxyOptions): Promise<CountingProxy> {
	const { targetPort, targetHost = '127.0.0.1', delayMs = 0 } = opts;
	let exchanges = 0;
	let bytes = 0;
	let sockets = 0;
	const open = new Set<net.Socket>();

	const server = net.createServer((client) => {
		sockets += 1;
		const upstream = net.connect(targetPort, targetHost);
		open.add(client);
		open.add(upstream);
		// Per PAIR, not per proxy: two nodes' links through the same proxy must not
		// count each other's turns as their own direction changes.
		let lastDirection: 'out' | 'in' | undefined;
		const pump = (from: net.Socket, to: net.Socket, direction: 'out' | 'in'): void => {
			from.on('data', (chunk: Buffer) => {
				if (lastDirection !== undefined && lastDirection !== direction) exchanges += 1;
				lastDirection = direction;
				bytes += chunk.length;
				// Counted on ARRIVAL, forwarded later: the delay models the link, and
				// counting it at the far end would fold the delay into the count.
				if (delayMs > 0) setTimeout(() => { if (!to.destroyed) to.write(chunk); }, delayMs);
				else to.write(chunk);
			});
			from.on('close', () => { open.delete(from); to.destroy(); });
			// A half-open link is not a measurement condition worth modelling — tear the
			// pair down and let the node re-dial, which the counters will show.
			from.on('error', () => { to.destroy(); });
		};
		pump(client, upstream, 'out');
		pump(upstream, client, 'in');
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => { resolve(); });
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		await new Promise<void>((resolve) => server.close(() => { resolve(); }));
		throw new Error(`counting proxy bound no TCP port (address: ${String(address)})`);
	}

	return {
		port: address.port,
		exchanges: () => exchanges,
		bytes: () => bytes,
		socketCount: () => sockets,
		async stop() {
			for (const socket of open) socket.destroy();
			open.clear();
			await new Promise<void>((resolve) => server.close(() => { resolve(); }));
		}
	};
}

/**
 * A gater that refuses every DIRECT dial to `port` — the relay's real WebSocket
 * port — while leaving circuit dials alone.
 *
 * Without it a node routed through {@link startCountingProxy} soon learns the
 * relay's own address (from identify, or from a peer record naming it) and opens a
 * second, direct connection to it; from then on the proxy's counters see a fraction
 * of the traffic, or none, and a delayed run silently measures an undelayed link.
 *
 * Circuit dials must still be allowed: a peer that reserved on the relay directly
 * advertises `/ip4/…/tcp/<real port>/ws/p2p/<relay>/p2p-circuit/p2p/<peer>`, and
 * denying those would cut the node off from that peer entirely rather than route it
 * through the proxy. The circuit dial reuses whatever connection to the relay the
 * node already holds — through the proxy — because the direct leg it would
 * otherwise open is itself a direct dial, which this denies.
 */
export function denyDirectPortGate(port: number): ConnectionGater {
	const isDirectDialTo = (addr: { getComponents(): Array<{ name: string; value?: string }> }): boolean => {
		const components = addr.getComponents();
		if (components.some((c) => c.name === 'p2p-circuit')) return false;
		return components.some((c) => c.name === 'tcp' && c.value === String(port));
	};
	// Only the dial hook. `filterMultiaddrForPeer` would additionally keep the
	// relay's real address out of the address book, which is tempting but changes
	// what the node KNOWS rather than what it may do — and every published
	// measurement so far was taken with the dial hook alone, so adding it would put
	// a scenario difference between this run and those numbers.
	return { denyDialMultiaddr: (ma) => isDirectDialTo(ma) };
}

/** The TCP port of a loopback multiaddr, e.g. a relay's `dialAddr`. */
export function tcpPortOf(multiaddr: string): number {
	const match = /\/tcp\/(\d+)(\/|$)/.exec(multiaddr);
	if (match === null) throw new Error(`no /tcp/ component in multiaddr: ${multiaddr}`);
	return Number(match[1]);
}
