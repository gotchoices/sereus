/**
 * Real-network coverage for `createHttpFormationApprover()` (`@serfab/cadre-core`).
 *
 * `packages/cadre-core/test/formation-approval.spec.ts` injects a `fetchImpl` stub built to
 * behave the way we *believe* a real `fetch` behaves. Three behaviours the client branches on
 * are never exercised against a real runtime there: how Node's real `fetch` (undici) reports a
 * rejected redirect, whether an abort mid-body-read actually surfaces as the timeout the client
 * expects, and whether the response-body cap actually stops a real socket from streaming past
 * it. This suite drives the client against a real `node:http` server and the real
 * `globalThis.fetch` (no `fetchImpl`) to pin those three, plus the two transport-level outcomes
 * that only exist against a real socket: a connection that is never established, and a caller's
 * abort travelling through a real `fetch`.
 *
 * Does not duplicate the stub suite's coverage of status/shape branching — see that file for
 * the full decision table.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import {
	createHttpFormationApprover,
	ed25519PublicKeyFromPrivate,
	signFormationApproval,
	verifyFormationApproval,
	FormationApprovalError,
	type FormationApprovalFailure,
	type FormationApprovalRequest,
	type FormationVouchFields
} from '@serfab/cadre-core';

function baseRequest(overrides: Partial<FormationApprovalRequest> = {}): FormationApprovalRequest {
	return {
		token: 'invite-abc',
		usageStampId: 'stamp-1',
		strandId: 'strand-1',
		peerKey: '12D3KooWJoiner',
		disclosure: '{"purpose":"real fetch coverage"}',
		validationUrl: 'http://127.0.0.1:1/unset',
		...overrides
	};
}

function approverKeys(): { privateKeyB64: string; validationKey: string } {
	const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
	return { privateKeyB64, validationKey: ed25519PublicKeyFromPrivate(privateKeyB64) };
}

/** Assert a rejection is a {@link FormationApprovalError} of the expected category. */
async function expectFailure(
	promise: Promise<unknown>,
	failure: FormationApprovalFailure
): Promise<FormationApprovalError> {
	const error = await promise.then(
		() => { throw new Error(`expected a ${failure} rejection, but the call resolved`); },
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(FormationApprovalError);
	expect((error as FormationApprovalError).failure).toBe(failure);
	return error as FormationApprovalError;
}

/** Await `promise`, giving up after `ms` — without leaving a live timer behind the test. */
async function settleOrGiveUp(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
	} finally {
		clearTimeout(timer);
	}
}

/** Read a request body to completion before handing it to a `node:http` handler. */
function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

interface TestServer {
	/** `http://127.0.0.1:<port>` — append a path to build a `validationUrl`. */
	readonly baseUrl: string;
	/** Closes the listener AND destroys any still-open sockets (a handler that never `res.end()`s otherwise hangs `server.close()`). */
	close(): Promise<void>;
}

/** Start a throwaway `node:http` server on an OS-assigned port for one test. */
function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer(handler);
		const sockets = new Set<Socket>();
		server.on('connection', (socket: Socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as AddressInfo | null;
			if (address === null) {
				reject(new Error('test server did not bind a TCP address'));
				return;
			}
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}`,
				close: () => new Promise<void>((resolveClose) => {
					for (const socket of sockets) {
						socket.destroy();
					}
					server.close(() => resolveClose());
				})
			});
		});
	});
}

describe('createHttpFormationApprover against a real node:http server', () => {
	it('resolves a real 200 JSON approval from a real socket', async () => {
		const { privateKeyB64, validationKey } = approverKeys();
		const server = await startServer((req, res) => {
			void readRequestBody(req)
				.then((body) => {
					const fields = JSON.parse(body) as FormationVouchFields;
					const approval = signFormationApproval(fields, validationKey, privateKeyB64);
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify(approval));
				})
				// Without this, a throw in the handler is an unhandled rejection and the client
				// hangs to its own timeout, reporting `unavailable` instead of the real cause.
				.catch((error: unknown) => {
					res.writeHead(500, { 'content-type': 'text/plain' });
					res.end(String(error));
				});
		});
		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			const approval = await createHttpFormationApprover().requestApproval(request);

			expect(approval.validationKey).toBe(validationKey);
			expect(verifyFormationApproval(request, approval)).toBe(true);
		} finally {
			await server.close();
		}
	});

	it('treats a real HTTP 403 response as refused', async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'no' }));
		});
		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			await expectFailure(createHttpFormationApprover().requestApproval(request), 'refused');
		} finally {
			await server.close();
		}
	});

	it('treats a real HTTP 500 response as unavailable', async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(500, { 'content-type': 'text/plain' });
			res.end('boom');
		});
		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			await expectFailure(createHttpFormationApprover().requestApproval(request), 'unavailable');
		} finally {
			await server.close();
		}
	});

	it('treats a real redirect as unavailable, whichever way the runtime\'s fetch reports it', async () => {
		// The redirect target lives on this same throwaway server, in case some runtime path
		// actually follows it rather than rejecting on `redirect: 'error'`.
		const server = await startServer((req, res) => {
			if (req.url === '/redirect-target') {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ validationKey: 'k', validationSignature: 's' }));
				return;
			}
			res.writeHead(302, { location: '/redirect-target' });
			res.end();
		});
		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			// Not asserting on the message, or on whether fetch rejected vs. resolved with
			// `redirected: true` — the point is that either way, the client lands on `unavailable`.
			await expectFailure(createHttpFormationApprover().requestApproval(request), 'unavailable');
		} finally {
			await server.close();
		}
	});

	// KNOWN INTERMITTENT FAILURE (~1 run in 10 on win32/Node 24): Node's fetch occasionally drops
	// the abort that lands while a stalled body is being read, and the read then stays pending for
	// undici's own 300s body timeout instead of the client's timeoutMs. That is a real defect in
	// the client (its budget is only as good as fetch's abort handling), tracked as
	// `fix/formation-approval-timeout-not-enforced` — do NOT skip or loosen this test to hide it.
	it('times out a real socket that answers headers and then never sends a body', async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.flushHeaders();
			// Deliberately never writes a body or calls res.end() — the client's abort timer must
			// stay armed through the body read, not just through the headers wait. The connection
			// is torn down by the test's `server.close()` in the `finally` below.
		});
		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			const error = await expectFailure(
				createHttpFormationApprover({ timeoutMs: 50 }).requestApproval(request),
				'unavailable'
			);
			expect(error.message).toContain('50ms');
		} finally {
			await server.close();
		}
	});

	it('reports a real connection failure as unavailable, carrying the transport error', async () => {
		// Bind a port and release it, so the address is well-formed but nothing is listening. This
		// is the only case whose classification rests on a real transport error rather than on a
		// response the stub suite can synthesize.
		const server = await startServer((_req, res) => { res.end(); });
		const deadUrl = `${server.baseUrl}/hook`;
		await server.close();

		const error = await expectFailure(
			createHttpFormationApprover().requestApproval(baseRequest({ validationUrl: deadUrl })),
			'unavailable'
		);
		// Neither the abort timer nor a caller cancellation — the hook could not be reached at all.
		expect(error.message).toContain('could not be reached');
		expect(error.cause).toBeDefined();
	});

	it('relays a caller abort into a real in-flight request and reports it as cancelled', async () => {
		const server = await startServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.flushHeaders();
			// Never ends: the caller's signal, not the client's own timer, has to end this one.
		});
		const caller = new AbortController();
		const abortTimer = setTimeout(() => caller.abort(), 25);
		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			// A 30s client budget, so a prompt rejection can only have come from the caller's abort
			// travelling through a real fetch — not from the approver's own timeout.
			const error = await expectFailure(
				createHttpFormationApprover({ timeoutMs: 30_000 }).requestApproval(request, caller.signal),
				'unavailable'
			);
			expect(error.message).toContain('cancelled');
		} finally {
			clearTimeout(abortTimer);
			await server.close();
		}
	});

	it('stops reading a real, undeclared-length body once it passes the 64 KiB cap', async () => {
		const CHUNK_BYTES = 8 * 1024;
		// 1.25 MiB if fully drained -- twenty times the 64 KiB cap. The margin is deliberately
		// wide: the assertion below is that the server did NOT finish, so it must be more than
		// the OS socket buffer plus the client's own receive buffer can swallow before the
		// client's cancel lands. Writes stop the moment the client hangs up, so a wide margin
		// costs nothing in a passing run.
		const PLANNED_CHUNKS = 160;
		const chunk = Buffer.alloc(CHUNK_BYTES, 0x20);

		let chunksWritten = 0;
		let wroteAllChunks = false;
		let resolveServerClosed: () => void;
		const serverClosed = new Promise<void>((resolve) => { resolveServerClosed = resolve; });

		const server = await startServer((_req, res) => {
			// No content-length: writing before end() without setting one forces chunked
			// transfer-encoding, so the client can only cap this by actually streaming, not by
			// reading the declared size up front.
			res.writeHead(200, { 'content-type': 'application/json' });
			res.on('close', () => resolveServerClosed());

			const writeNext = (): void => {
				if (res.writableEnded || res.destroyed) {
					return;
				}
				if (chunksWritten >= PLANNED_CHUNKS) {
					wroteAllChunks = true;
					res.end();
					return;
				}
				chunksWritten++;
				const canWriteMore = res.write(chunk);
				if (canWriteMore) {
					setImmediate(writeNext);
				} else {
					res.once('drain', writeNext);
				}
			};
			writeNext();
		});

		try {
			const request = baseRequest({ validationUrl: `${server.baseUrl}/hook` });

			await expectFailure(createHttpFormationApprover().requestApproval(request), 'malformed');

			// Give the server's connection-close event a moment to land before checking how much
			// it actually got to write -- proves the client hung up rather than reading the whole
			// oversized body and measuring after the fact.
			await settleOrGiveUp(serverClosed, 2_000);

			expect(wroteAllChunks).toBe(false);
			expect(chunksWritten).toBeLessThan(PLANNED_CHUNKS);
		} finally {
			await server.close();
		}
	});
});
