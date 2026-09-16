import { createServer, type Socket } from 'node:net';

/**
 * A TCP server on loopback that accepts connections and never sends a byte — a
 * deterministic stand-in for an address whose connection attempts are silently
 * dropped (a firewall, an unroutable subnet). A WebSocket dial to it opens the
 * TCP connection and then waits forever for the upgrade response, which is what a
 * dropped address costs a real dial: all of its time limit, with no error.
 *
 * Unroutable IPs (`10.255.255.1`) would be closer to the real case but behave
 * differently per OS — about 10 s to fail on Windows, instantly on some Linux
 * setups — so a spec built on them measures the machine, not the dial.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it.
 */
export interface SilentServer {
	/** The loopback WebSocket address to hand a dialer, without a peer id. */
	wsAddr: string;
	/** How many connections it has accepted — proof an address was really dialed. */
	accepted(): number;
	close(): Promise<void>;
}

export async function startSilentServer(): Promise<SilentServer> {
	const sockets: Socket[] = [];
	let accepted = 0;
	const server = createServer((socket) => {
		accepted++;
		sockets.push(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('silent server has no TCP port');
	}
	return {
		wsAddr: `/ip4/127.0.0.1/tcp/${address.port}/ws`,
		accepted: () => accepted,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
