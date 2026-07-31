/**
 * A real `node:http` listener on an OS-assigned loopback port — the primitive every fixture and
 * spec that needs a genuine socket builds on, so the two non-obvious parts are written once:
 *
 * - `close()` destroys still-open sockets BEFORE closing the listener. A handler that never
 *   `res.end()`s (or a client keep-alive) otherwise leaves `server.close()` pending forever and
 *   the test run hangs at teardown rather than failing.
 * - The `error` listener armed for the bind is REMOVED once the bind succeeds. Left armed, it
 *   absorbs the first post-bind server error into an already-settled promise and loses it; a
 *   logging listener takes its place.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import debug from 'debug';

const log = debug('sereus:integration:loopback-http');

export interface LoopbackHttpServer {
	/** `http://127.0.0.1:<port>` — append a path to build a request URL. */
	readonly baseUrl: string;
	/** Closes the listener AND destroys still-open sockets, so a leaked server cannot hold the run open. */
	close(): Promise<void>;
}

/** Read a request body to completion before handing it to a handler. */
export function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** Start a throwaway HTTP server on an OS-assigned loopback port. */
export function startLoopbackHttpServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackHttpServer> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer(handler);
		const sockets = new Set<Socket>();
		server.on('connection', (socket: Socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});

		const onBindError = (error: Error): void => reject(error);
		server.once('error', onBindError);

		// Port 0 on loopback: the OS assigns. Deliberately NOT the harness `allocatePort()`, whose
		// pool is reserved for libp2p listeners — drawing from both invites collisions.
		server.listen(0, '127.0.0.1', () => {
			server.off('error', onBindError);
			server.on('error', (error: Error) => log('loopback server error after bind: %o', error));

			const address = server.address() as AddressInfo | null;
			if (address === null) {
				reject(new Error('loopback server did not bind a TCP address'));
				return;
			}
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}`,
				close: () => new Promise<void>((resolveClose) => {
					for (const socket of sockets) {
						socket.destroy();
					}
					server.close(() => resolveClose());
				}),
			});
		});
	});
}
