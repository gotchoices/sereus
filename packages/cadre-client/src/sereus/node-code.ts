/**
 * Node codes: the `sereus-join:1.…` text a cadre node shows (as a QR code, a link or plain
 * text) while it waits to be claimed, and how to read one and sort a claim's failure.
 *
 * Descends from reference-app-rn's `src/node-claim.ts`; this one returns codes rather than
 * English, so each app words them in its own catalog.
 *
 * SECURITY: a code carries the node's one-time claim secret. Never log the code text, a
 * link containing one, or a decoded payload — log the peer id only.
 */
import {
	ClaimRefusedError,
	NODE_CLAIM_PAYLOAD_PREFIX,
	PeerUnreachableError,
	decodeNodeClaimPayload,
	describeThrown,
	type NodeClaimPayload,
} from '@serfab/cadre-core';
import type { NodeReach } from '../model.js';
import { NODE_CODE_SCHEME, nodeCodeFromUrl } from '../node-code-text.js';
import { nodeReach } from '../address.js';

/** A code with a version this build does not read: `sereus-join:<n>.` with n ≠ 1. */
const VERSIONED_NODE_CODE = /^sereus-join:(\d+)\./;

export type NodeCodeProblem =
	/** Does not start with `sereus-join:` — some other QR, link or text. */
	| 'not-node-code'
	/** A node code from a newer node than this build reads: the app needs updating. */
	| 'newer-version'
	/** Right prefix, but cut short or corrupted. */
	| 'damaged';

export type NodeCodeReading =
	| { ok: true; payload: NodeClaimPayload }
	| { ok: false; problem: NodeCodeProblem; /** The decoder's words (never the secret), for logs. */ detail?: string };

/** Decode scanned or pasted text, or say which problem it has. */
export function readNodeCode(text: string): NodeCodeReading {
	const trimmed = (nodeCodeFromUrl(text) ?? text).trim();
	if (!trimmed.startsWith(NODE_CODE_SCHEME)) return { ok: false, problem: 'not-node-code' };
	if (!trimmed.startsWith(NODE_CLAIM_PAYLOAD_PREFIX) && VERSIONED_NODE_CODE.test(trimmed)) {
		return { ok: false, problem: 'newer-version' };
	}
	try {
		return { ok: true, payload: decodeNodeClaimPayload(trimmed) };
	} catch (err) {
		// The decoder never echoes the secret, so its message is safe to keep.
		return { ok: false, problem: 'damaged', detail: describeThrown(err) };
	}
}

/** Refusals after which the same code can still succeed. */
const RETRYABLE_REFUSALS: ReadonlySet<string> = new Set(['claim-rate-limited', 'claim-not-persisted']);

export type ClaimFailure =
	/** No connection formed from any address; nothing was sent. */
	| { kind: 'node-unreachable'; reach: NodeReach; retryable: true; detail: string }
	/** The node answered and said no. `refusal` is absent when it gave no (known) code. */
	| { kind: 'claim-refused'; refusal?: string; retryable: boolean; detail: string }
	/** Reached, then the exchange or a local step failed. Repeating with the same code is safe. */
	| { kind: 'claim-failed'; retryable: true; detail: string };

/** Sort an error thrown by `CadreNode.claimNode(payload)` into what to say and whether to keep the code. */
export function classifyClaimFailure(error: unknown, payload: NodeClaimPayload): ClaimFailure {
	const detail = describeThrown(error);
	if (error instanceof PeerUnreachableError) {
		return { kind: 'node-unreachable', reach: nodeReach(payload.multiaddrs), retryable: true, detail };
	}
	if (error instanceof ClaimRefusedError) {
		const refusal = error.code;
		return {
			kind: 'claim-refused',
			refusal,
			retryable: refusal !== undefined && RETRYABLE_REFUSALS.has(refusal),
			detail: error.reason ?? detail,
		};
	}
	return { kind: 'claim-failed', retryable: true, detail };
}
