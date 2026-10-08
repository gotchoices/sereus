/**
 * Rewrites incoming links before expo-router routes them.
 *
 * A cadre-host node code (`sereus-join:1.…`) opened from the system camera on Android
 * (app.json registers the scheme there only) becomes `/settings?nodeCode=…`, where the
 * add-node section reads it like a pasted code. The path carries the node's claim
 * secret: never log it.
 */

import { NODE_CODE_SCHEME } from '../src/node-claim';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	if (!path.startsWith(NODE_CODE_SCHEME)) return path;
	return `/settings?nodeCode=${encodeURIComponent(path)}`;
}
