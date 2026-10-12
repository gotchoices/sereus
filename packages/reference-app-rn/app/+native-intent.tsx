/**
 * Rewrites incoming links before expo-router routes them.
 *
 * - A cadre-host node code (`sereus-join:1.…`) opened from the system camera on Android
 *   (app.json registers the scheme there only) becomes `/settings?nodeCode=…`, where the
 *   add-node section reads it like a pasted code.
 * - A join request another Sereus app opened this one with (`@serfab/cadre-rn/app-link`'s
 *   links) becomes `/settings?joinRequest=…`, which Add a device or app answers, and the
 *   answer to this app's own request becomes `/settings?joinResponse=…`.
 * - The link an owner app opens to recommend this one names that app's scheme, and becomes
 *   `/settings?recommendedBy=…`, where Settings offers to join through that app.
 * - A hosting provider's sign-in redirect (`<own scheme>://provider-auth?code=…&state=…`) becomes
 *   `/settings` with no query: the browser session that opened the sign-in owns the result
 *   (`expo-web-browser` resolves with the URL), and the single-use code must not sit in navigation state.
 *
 * A node code carries the node's claim secret, an answer can carry an invitation and the sign-in
 * redirect carries a code: never log the path.
 */

import { parseCadreLink } from '@serfab/cadre-rn/app-link';
import { NODE_CODE_SCHEME } from '../src/node-claim';
import { isProviderAuthRedirect } from '../src/providers';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	if (path.startsWith(NODE_CODE_SCHEME)) return `/settings?nodeCode=${encodeURIComponent(path)}`;
	if (isProviderAuthRedirect(path)) return '/settings';
	const link = parseCadreLink(path);
	if (!link) return path;
	switch (link.kind) {
		case 'join-request': return `/settings?joinRequest=${encodeURIComponent(link.text)}`;
		case 'join-response': return `/settings?joinResponse=${encodeURIComponent(link.text)}`;
		case 'recommended-by': return `/settings?recommendedBy=${encodeURIComponent(link.text)}`;
	}
}
