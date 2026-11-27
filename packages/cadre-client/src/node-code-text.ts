/**
 * Node codes as text: the `sereus-join:` prefix a cadre node's code starts with, and
 * finding one inside a link. Plain string handling, so any screen can recognise a node
 * code (a scanner deciding where a scanned code goes) without loading the stack. Reading
 * one is `readNodeCode` in `@serfab/cadre-client/sereus`.
 */
export const NODE_CODE_SCHEME = 'sereus-join:';

export function isNodeCode(text: string): boolean {
	return text.trim().startsWith(NODE_CODE_SCHEME);
}

/** The node code inside a link (or the text itself, if it is one), else null. */
export function nodeCodeFromUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	const trimmed = url.trim();
	if (isNodeCode(trimmed)) return trimmed;
	let decoded = trimmed;
	try { decoded = decodeURIComponent(trimmed); } catch { /* keep as is */ }
	const at = decoded.indexOf(NODE_CODE_SCHEME);
	if (at <= 0) return null;
	// base64url after the prefix, so it ends at the first character that cannot be part of it.
	const match = /^sereus-join:[A-Za-z0-9._~-]+/.exec(decoded.slice(at));
	return match ? match[0] : null;
}
