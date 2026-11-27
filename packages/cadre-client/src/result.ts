/**
 * Results and errors. Operations return `CadreResult<T>` and do not throw for failures a
 * screen must handle; a thrown error is a defect.
 *
 * A `CadreError` carries a stable `kind` a UI renders through its own string catalog
 * (`cadre.errors.<kind>`, or `.<kind>.<reason>`), and `retryable`, which says whether
 * trying again can help. `message` is English text for logs, and the words to show when a
 * catalog has none. The shape is a subset of an app's own error type: an app whose error
 * kinds include these can pass a `CadreResult` along as its own.
 */

export type CadreErrorKind =
	/** Nobody can answer an invitation from this device: no address, and no machine of the party's that answers for it. */
	| 'unreachable'
	/** The cadre could not be read or written right now (a peer, the control network, a timeout). */
	| 'unavailable'
	/** A node code that cannot be used; `reason`: `not-node-code`, `newer-version` or `damaged`. */
	| 'invalid-node-code'
	/** Claiming a node: no address answered. `reason`: the node's reach, `anywhere` or `home-network`. */
	| 'node-unreachable'
	/** Claiming a node: it answered and said no. `reason`: its refusal code, when it sent one. */
	| 'claim-refused'
	/** Claiming a node: reached, then the exchange or a local step failed. Safe to repeat. `reason` `busy`: a claim is already running. */
	| 'claim-failed'
	/** This device cannot do that (no owner key held here, say). */
	| 'not-supported'
	/** Anything else. */
	| 'unexpected';

const KINDS: Record<CadreErrorKind, true> = {
	'unreachable': true, 'unavailable': true, 'invalid-node-code': true, 'node-unreachable': true,
	'claim-refused': true, 'claim-failed': true, 'not-supported': true, 'unexpected': true,
};
/** Every kind, for catalogs and tools that must cover them all. */
export const CADRE_ERROR_KINDS = Object.keys(KINDS) as readonly CadreErrorKind[];

export interface CadreError {
	kind: CadreErrorKind;
	retryable: boolean;
	message: string;
	/** A finer, stable code within the kind (a claim refusal, a node's reach), for the UI to choose words. */
	reason?: string;
	/** The underlying error, for logs. */
	cause?: unknown;
}

export type CadreResult<T> = { ok: true; value: T } | { ok: false; error: CadreError };

const RETRYABLE: ReadonlySet<CadreErrorKind> = new Set<CadreErrorKind>(['unreachable', 'unavailable', 'node-unreachable', 'claim-failed']);

export function cadreOk<T>(value: T): CadreResult<T>;
export function cadreOk(): CadreResult<void>;
export function cadreOk<T>(value?: T): CadreResult<T | undefined> {
	return { ok: true, value };
}

export function cadreFail<T = never>(
	kind: CadreErrorKind, message: string, opts: { retryable?: boolean; reason?: string; cause?: unknown } = {},
): CadreResult<T> {
	return {
		ok: false,
		error: { kind, message, retryable: opts.retryable ?? RETRYABLE.has(kind), ...(opts.reason ? { reason: opts.reason } : {}), cause: opts.cause },
	};
}

/** Thrown inside the client to leave an operation with a known kind; `cadreAttempt` turns it into a failed result. */
export class CadreFailure extends Error {
	readonly cadreError: CadreError;
	constructor(kind: CadreErrorKind, message: string, opts: { retryable?: boolean; reason?: string; cause?: unknown } = {}) {
		super(message);
		this.name = 'CadreFailure';
		const failed = cadreFail(kind, message, opts);
		this.cadreError = (failed as { ok: false; error: CadreError }).error;
		Object.setPrototypeOf(this, CadreFailure.prototype);
	}
}

const UNAVAILABLE = /timed out|super-majority|not reachable|no peers|abort/i;

/**
 * A caught value as text. An Error's message unchanged; anything else (a React Native WebSocket
 * failure rejects with its error event, libp2p sometimes with a plain object) by its `message`,
 * `reason` or `type` field, so it never reads `[object Object]`. cadre-core's `describeThrown` does
 * the same; this entry point loads no cadre-core.
 */
export function describeThrown(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'object' && value !== null) {
		const fields = value as { message?: unknown; reason?: unknown; type?: unknown };
		for (const field of [fields.message, fields.reason, fields.type]) {
			if (typeof field === 'string' && field) return field;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return Object.prototype.toString.call(value);
		}
	}
	return `${value as string}`;
}

/** Run one operation: its value, or its failure as a result. Never throws. */
export async function cadreAttempt<T>(operation: () => Promise<T>): Promise<CadreResult<T>> {
	try {
		return { ok: true, value: await operation() };
	} catch (err) {
		if (err instanceof CadreFailure) return { ok: false, error: err.cadreError };
		const message = describeThrown(err);
		const name = err instanceof Error ? err.name : '';
		return cadreFail(UNAVAILABLE.test(`${name} ${message}`) ? 'unavailable' : 'unexpected', message, { cause: err });
	}
}

/** Reject with a clear error if `p` has not settled within `ms`. `p` is left to settle. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(
			value => { clearTimeout(timer); resolve(value); },
			err => { clearTimeout(timer); reject(err); },
		);
	});
}
