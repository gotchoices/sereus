/**
 * Rewrites incoming links before expo-router routes them.
 *
 * - A cadre-host node code (`sereus-join:1.…`) opened from the system camera on Android
 *   (app.json registers the scheme there only) becomes `/settings?nodeCode=…`, where the
 *   add-node section reads it like a pasted code.
 * - A join request another Sereus app opened this one with (`@serfab/cadre-rn/app-link`'s
 *   links) becomes `/settings?joinRequest=…`, which Add a device or app answers, and the
 *   answer to this app's own request becomes `/settings?joinResponse=…`.
 *
 * A node code carries the node's claim secret and an answer can carry an invitation: never log
 * the path.
 */

import { parseCadreLink } from '@serfab/cadre-rn/app-link';
import { NODE_CODE_SCHEME } from '../src/node-claim';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	if (path.startsWith(NODE_CODE_SCHEME)) return `/settings?nodeCode=${encodeURIComponent(path)}`;
	const link = parseCadreLink(path);
	if (!link) return path;
	switch (link.kind) {
		case 'join-request': return `/settings?joinRequest=${encodeURIComponent(link.text)}`;
		case 'join-response': return `/settings?joinResponse=${encodeURIComponent(link.text)}`;
		// Routed by `reference-app-rn-joins-the-app-that-recommended-it`; until then it opens the app as any other link.
		case 'recommended-by': return path;
	}
}
