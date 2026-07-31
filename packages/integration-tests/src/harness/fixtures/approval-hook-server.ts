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
 * approver that approves, refuses, or replays a previous sign-off.
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
	/** How many requests the hook has answered. Proves the responder really called out. */
	readonly requestCount: number;
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
	 * Decide each request. Defaults to approving, signing over the posted fields.
	 * - `'approve'` → 200 + a fresh signature over those fields
	 * - `'refuse'` → 403 (the hook answered, and the answer is no)
	 * - a {@link FormationApproval} → 200 with exactly that body (used to replay a prior sign-off)
	 */
	decide?: (fields: FormationVouchFields) => 'approve' | 'refuse' | FormationApproval;
	/** Sign with this key instead of a freshly generated one — lets a caller pre-sign the same way. */
	privateKeyB64?: string;
}

/** Start an approval hook on an OS-assigned loopback port. */
export async function startApprovalHook(options: ApprovalHookOptions = {}): Promise<ApprovalHookServer> {
	const privateKeyB64 = options.privateKeyB64 ?? (generatePrivateKey('ed25519', 'base64url') as string);
	const validationKey = ed25519PublicKeyFromPrivate(privateKeyB64);
	const decide = options.decide ?? ((): 'approve' => 'approve');

	let requestCount = 0;
	let lastRequest: FormationVouchFields | null = null;
	let lastMethod: string | null = null;
	let lastPath: string | null = null;
	let lastHeaders: IncomingHttpHeaders | null = null;

	const answer = (req: IncomingMessage, res: ServerResponse, body: string): void => {
		// The posted `disclosure` is signed verbatim: `fields` is the object `JSON.parse` produced
		// and is handed to `signFormationApproval` untouched, so the approver's digest covers the
		// exact string the redeeming node will insert.
		const fields = JSON.parse(body) as FormationVouchFields;
		requestCount++;
		lastRequest = fields;
		lastMethod = req.method ?? null;
		lastPath = req.url ?? null;
		lastHeaders = req.headers;

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

	const server = await startLoopbackHttpServer((req, res) => {
		void readRequestBody(req)
			.then((body) => answer(req, res, body))
			// Without this, a throw in the handler is an unhandled rejection and the client hangs
			// to its own timeout, reporting `unavailable` instead of the real cause.
			.catch((error: unknown) => {
				res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(String(error));
			});
	});

	return {
		validationUrl: `${server.baseUrl}${HOOK_PATH}`,
		validationKey,
		get requestCount(): number { return requestCount; },
		get lastRequest(): FormationVouchFields | null { return lastRequest; },
		get lastMethod(): string | null { return lastMethod; },
		get lastPath(): string | null { return lastPath; },
		get lastHeaders(): IncomingHttpHeaders | null { return lastHeaders; },
		close: () => server.close(),
	};
}
