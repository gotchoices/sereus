/**
 * `@serfab/cadre-rn/app-link` — what two Sereus apps on one phone need to hand a join request and
 * its answer to each other by opening each other with a link. See the kit README's "App links"
 * section and docs/architecture.md → "Between apps on one phone".
 *
 * Imports nothing from React Native or Expo: the app passes `Linking.canOpenURL` in, so this runs
 * under a Node test.
 */
export { installedSereusApps, KNOWN_SEREUS_APPS, type SereusApp } from './known-apps.js';
export {
	CADRE_JOIN_RESPONSE_PREFIX,
	decodeCadreJoinResponse,
	encodeCadreJoinResponse,
	type CadreJoinResponse,
	type JoinRefusal,
} from './join-response.js';
export {
	CADRE_LINK_MAX_LENGTH,
	CadreLinkTooLongError,
	joinRequestLink,
	joinResponseLink,
	parseCadreLink,
	type CadreLink,
} from './links.js';
export {
	LINK_REQUEST_TTL_MS,
	LinkRequestStore,
	UnsolicitedJoinResponseError,
	type OpenLinkRequest,
} from './link-request-store.js';
