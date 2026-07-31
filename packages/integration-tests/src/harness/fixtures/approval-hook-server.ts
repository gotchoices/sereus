/**
 * In-process HTTP fixture standing in for an outside formation approver (the endpoint an
 * invitation's `ValidationUrl` names). A redeeming node posts the five signed vouch fields to
 * it and expects a `{ validationKey, validationSignature }` body back; this fixture answers
 * with a real ed25519 signature over exactly the bytes it was posted, so the whole approval
 * path — real socket, real `fetch`, real signature verification, real control-database write —
 * runs unmocked.
 *
 * Scenario-level counterpart to `test/formation-approval-real-fetch.spec.ts`, which drives the
 * HTTP client alone against its own throwaway server. Transport behaviour (redirects, caps,
 * timeouts) belongs there; this fixture exists so a scenario can stand up an approver that
 * approves, refuses, or replays a previous sign-off.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import {
	ed25519PublicKeyFromPrivate,
	signFormationApproval,
	type FormationApproval,
	type FormationVouchFields,
} from '@serfab/cadre-core';

export interface ApprovalHookServer {
	/** `http://127.0.0.1:<port>/hook` — the exact string to publish as an invite's `ValidationUrl`. */
	readonly validationUrl: string;
	/** Public key (base64url) of the pair this hook signs with — the key to enroll as a `ValidationKey`. */
	readonly validationKey: string;
	/** How many requests the hook has answered. Proves the responder really called out. */
	readonly requestCount: number;
	/** The posted body of the most recent request, verbatim, or null if never asked. */
	readonly lastRequest: FormationVouchFields | null;
	/** Closes the listener AND destroys still-open sockets, so a leaked hook cannot hold the run open. */
	close(): Promise<void>;
}

export interface ApprovalHookOptions {
	/**
	 * Decide each request. Defaults to approving, signing over the posted fields.
	 * - `'approve'` → 200 + a fresh signature over those fields
	 * - `'refuse'` → 403 (the hook answered, and the answer is no)
	 * - a {@link FormationApproval} → 200 with exactly that body (used to replay a prior sign-off)
	 */
	decide?: (fields: FormationVouchFields) => 'approve' | 'refuse' | FormationApproval;
	/** Sign with this key instead of a freshly generated one — lets a caller pre-sign the same way. */
	privateKeyB64?: string;
}

/** Read a request body to completion before handing it to the handler. */
function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** Start an approval hook on an OS-assigned loopback port. */
export function startApprovalHook(options: ApprovalHookOptions = {}): Promise<ApprovalHookServer> {
	const privateKeyB64 = options.privateKeyB64 ?? (generatePrivateKey('ed25519', 'base64url') as string);
	const validationKey = ed25519PublicKeyFromPrivate(privateKeyB64);
	const decide = options.decide ?? ((): 'approve' => 'approve');

	let requestCount = 0;
	let lastRequest: FormationVouchFields | null = null;

	const answer = (res: ServerResponse, body: string): void => {
		// The posted `disclosure` is signed verbatim: `fields` is the object `JSON.parse` produced
		// and is handed to `signFormationApproval` untouched, so the approver's digest covers the
		// exact string the redeeming node will insert.
		const fields = JSON.parse(body) as FormationVouchFields;
		requestCount++;
		lastRequest = fields;

		const verdict = decide(fields);
		if (verdict === 'refuse') {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'no' }));
			return;
		}
		const approval = verdict === 'approve'
			? signFormationApproval(fields, validationKey, privateKeyB64)
			: verdict;
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(approval));
	};

	return new Promise((resolve, reject) => {
		const sockets = new Set<Socket>();
		const server: Server = createServer((req, res) => {
			void readRequestBody(req)
				.then((body) => answer(res, body))
				// Without this, a throw in the handler is an unhandled rejection and the client hangs
				// to its own timeout, reporting `unavailable` instead of the real cause.
				.catch((error: unknown) => {
					res.writeHead(500, { 'content-type': 'text/plain' });
					res.end(String(error));
				});
		});
		server.on('connection', (socket: Socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});
		server.once('error', reject);
		// Port 0 on loopback: the OS assigns. Deliberately NOT the harness `allocatePort()`, whose
		// pool is reserved for libp2p listeners — drawing from both invites collisions.
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as AddressInfo | null;
			if (address === null) {
				reject(new Error('approval hook server did not bind a TCP address'));
				return;
			}
			const validationUrl = `http://127.0.0.1:${address.port}/hook`;
			resolve({
				validationUrl,
				validationKey,
				get requestCount(): number { return requestCount; },
				get lastRequest(): FormationVouchFields | null { return lastRequest; },
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
