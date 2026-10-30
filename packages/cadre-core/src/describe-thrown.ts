/** An object's description lands in status payloads and logs, so a huge one is cut to this length. */
const MAX_OBJECT_DESCRIPTION_LENGTH = 500;

/**
 * Text for a caught value, for an error message, a status field or a log line.
 *
 * `String()` reads `[object Object]` for anything that is not an `Error`, and a failed WebSocket on
 * React Native rejects with its error event, so a relay reservation's status could not say why it
 * kept retrying (gotchoices/sereus#54). An `Error` gives its `message` unchanged, because specs and
 * users match on that text; `cause` and `AggregateError.errors` are not walked. Platform-neutral:
 * it is in the root entry every runtime loads.
 */
export function describeThrown(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'object' && value !== null) return bounded(describeObject(value));
	return String(value);
}

/** A caught value as an `Error`, for a status, an event or a list of failures that carries one; anything else keeps it as `cause`. */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(describeThrown(value), { cause: value });
}

function describeObject(value: object): string {
	return describeKnownFields(value) ?? stringifyObject(value) ?? String(value);
}

/**
 * The fields a browser or React Native `Event` / `CloseEvent` carries (`type`, `message`, `code`,
 * `reason`), and libp2p's plain-object rejections (`code`, `message`). Read by property access, so
 * the getters on `Event.prototype` count. Only non-empty strings are used, and a number for `code`
 * (a `CloseEvent`'s); a field holding anything else is skipped.
 */
function describeKnownFields(value: object): string | undefined {
	const fields = value as { readonly type?: unknown; readonly message?: unknown; readonly reason?: unknown; readonly code?: unknown };
	const text = [fields.type, fields.message, fields.reason].filter(isNonEmptyString).join(': ');
	const code = typeof fields.code === 'number' || isNonEmptyString(fields.code) ? String(fields.code) : undefined;
	if (code === undefined) return text === '' ? undefined : text;
	return text === '' ? `code ${code}` : `${text} (code ${code})`;
}

/** The value as JSON, or nothing when that says nothing (`{}`) or cannot be made (a cycle, a BigInt). */
function stringifyObject(value: object): string | undefined {
	try {
		const json: string | undefined = JSON.stringify(value);
		return json === '{}' ? undefined : json;
	} catch {
		// Not reported: the value being described is the failure that matters, and `String()` follows.
		return undefined;
	}
}

function bounded(text: string): string {
	if (text.length <= MAX_OBJECT_DESCRIPTION_LENGTH) return text;
	return `${text.slice(0, MAX_OBJECT_DESCRIPTION_LENGTH - 1)}…`;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}
