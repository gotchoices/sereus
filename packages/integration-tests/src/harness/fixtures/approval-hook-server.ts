/**
 * In-process HTTP fixture standing in for an outside formation approver (the endpoint an
 * invitation's `ValidationUrl` names). A redeeming node posts the five signed vouch fields to
 * it and expects a `{ validationKey, validationSignature }` body back; this fixture answers
 * with a real ed25519 signature over exactly the bytes it was posted, so the whole approval
 * path — real socket, real `fetch`, real signature verification, real control-database write —
 * runs unmocked.
 *
 * Scenario-level counterpart to `test/formation-approval-real-fetch.spec.ts`, which drives the
 * HTTP client alone against its own `startLoopbackHttpServer` handlers. Transport behaviour
 * (redirects, caps, timeouts) belongs there; this fixture exists so a scenario can stand up an
 * approver that approves, refuses, answers broken, or replays a previous sign-off.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import {
	ed25519PublicKeyFromPrivate,
	signFormationApproval,
	type FormationApproval,
	type FormationVouchFields,
} from '@serfab/cadre-core';

import { readRequestBody, startLoopbackHttpServer } from './loopback-http-server.js';

/** Path the fixture publishes in its `validationUrl`; a hook's path is opaque to the client. */
const HOOK_PATH = '/hook';

export interface ApprovalHookServer {
	/** `http://127.0.0.1:<port>/hook` — the exact string to publish as an invite's `ValidationUrl`. */
	readonly validationUrl: string;
	/** Public key (base64url) of the pair this hook signs with — the key to enroll as a `ValidationKey`. */
	readonly validationKey: string;
	/**
	 * How many requests the hook has RECEIVED (counted as soon as the body parses, before
	 * {@link ApprovalHookOptions.beforeAnswer} or `decide` run). Proves the responder really
	 * called out — a held request is counted, an unanswered one still is.
	 */
	readonly requestCount: number;
	/**
	 * How many requests the CLIENT gave up on before the fixture answered — the response
	 * closed with nothing written. A redeeming node that relays its caller-abort onto the
	 * outgoing `fetch` shows up here, so a test can prove the cancellation reached the wire
	 * rather than inferring it from a reply that some unrelated timeout could also produce.
	 */
	readonly abortedCount: number;
	/** The posted body of the most recent request, verbatim, or null if never asked. */
	readonly lastRequest: FormationVouchFields | null;
	/**
	 * Request line + headers of the most recent request. The rest of the wire contract
	 * (`docs/api.md` → Validate Strand Formation) lives here rather than in the body: a hook
	 * operator is promised a `POST`, a JSON content type, and the `ValidationUrl`'s own path
	 * (which may carry a hook secret, so it must arrive unmangled).
	 */
	readonly lastMethod: string | null;
	readonly lastPath: string | null;
	readonly lastHeaders: IncomingHttpHeaders | null;
	/** Closes the listener AND destroys open sockets, so a leaked hook cannot hold the run open. */
	close(): Promise<void>;
}

export interface ApprovalHookOptions {
	/**
	 * Decide each request. Defaults to approving, signing over the posted fields. The three
	 * string verdicts are the hook's three answer classes — yes, no, and broken:
	 * - `'approve'` → 200 + a fresh signature over those fields
	 * - `'refuse'` → 403 (the hook answered, and the answer is no)
	 * - `'unavailable'` → 503 (the hook is up but broken, so it cannot answer either way; the
	 *   client reports `unavailable`, exactly as it does for a hook it never reached at all)
	 * - a {@link FormationApproval} → 200 with exactly that body (used to replay a prior sign-off)
	 */
	decide?: (fields: FormationVouchFields) => 'approve' | 'refuse' | 'unavailable' | FormationApproval;
	/** Sign with this key instead of a freshly generated one — lets a caller pre-sign the same way. */
	privateKeyB64?: string;
	/**
	 * Awaited between the `requestCount` bump and `decide` — the HOLD lever: an approver that
	 * goes quiet (a queue behind a human) rather than answering yes or no. `requestIndex` is
	 * the 1-based value `requestCount` just took, so a caller can hold only the first ask and
	 * let a later retry through the same published `ValidationUrl`.
	 *
	 * A caller that holds MUST release: the fixture never times a hold out. `close()` destroys
	 * open sockets, so a forgotten hold cannot hang teardown, but the held handler then wakes
	 * to an already-dead response — which is why every write below is guarded.
	 */
	beforeAnswer?: (fields: FormationVouchFields, requestIndex: number) => Promise<void>;
}

/** Start an approval hook on an OS-assigned loopback port. */
export async function startApprovalHook(options: ApprovalHookOptions = {}): Promise<ApprovalHookServer> {
	const privateKeyB64 = options.privateKeyB64 ?? (generatePrivateKey('ed25519', 'base64url') as string);
	const validationKey = ed25519PublicKeyFromPrivate(privateKeyB64);
	const decide = options.decide ?? ((): 'approve' => 'approve');

	let requestCount = 0;
	let abortedCount = 0;
	let lastRequest: FormationVouchFields | null = null;
	let lastMethod: string | null = null;
	let lastPath: string | null = null;
	let lastHeaders: IncomingHttpHeaders | null = null;

	/**
	 * True once this response can no longer be written to — the client aborted (or `close()`
	 * destroyed the socket) while the handler was held. Writing anyway throws
	 * `ERR_STREAM_WRITE_AFTER_END` out of a `.then()`, i.e. an unhandled rejection.
	 */
	const isDead = (res: ServerResponse): boolean => res.writableEnded || res.destroyed;

	const answer = async (req: IncomingMessage, res: ServerResponse, body: string): Promise<void> => {
		// The posted `disclosure` is signed verbatim: `fields` is the object `JSON.parse` produced
		// and is handed to `signFormationApproval` untouched, so the approver's digest covers the
		// exact string the redeeming node will insert.
		const fields = JSON.parse(body) as FormationVouchFields;
		const requestIndex = ++requestCount;
		lastRequest = fields;
		lastMethod = req.method ?? null;
		lastPath = req.url ?? null;
		lastHeaders = req.headers;

		if (options.beforeAnswer) {
			await options.beforeAnswer(fields, requestIndex);
			if (isDead(res)) {
				return;
			}
		}

		const verdict = decide(fields);
		if (verdict === 'refuse') {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'no' }));
			return;
		}
		if (verdict === 'unavailable') {
			res.writeHead(503, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'down' }));
			return;
		}
		const approval = verdict === 'approve'
			? signFormationApproval(fields, validationKey, privateKeyB64)
			: verdict;
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(approval));
	};

	const server = await startLoopbackHttpServer((req, res) => {
		// 'close' on the response fires when the connection goes away, answered or not; nothing
		// written by then means the client hung up first.
		res.on('close', () => {
			if (!res.writableEnded) {
				abortedCount++;
			}
		});
		void readRequestBody(req)
			.then((body) => answer(req, res, body))
			// Without this, a throw in the handler is an unhandled rejection and the client hangs
			// to its own timeout, reporting `unavailable` instead of the real cause.
			.catch((error: unknown) => {
				if (isDead(res)) {
					return;
				}
				res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(String(error));
			});
	});

	return {
		validationUrl: `${server.baseUrl}${HOOK_PATH}`,
		validationKey,
		get requestCount(): number { return requestCount; },
		get abortedCount(): number { return abortedCount; },
		get lastRequest(): FormationVouchFields | null { return lastRequest; },
		get lastMethod(): string | null { return lastMethod; },
		get lastPath(): string | null { return lastPath; },
		get lastHeaders(): IncomingHttpHeaders | null { return lastHeaders; },
		close: () => server.close(),
	};
}
