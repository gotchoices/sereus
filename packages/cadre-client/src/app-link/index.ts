/**
 * `@serfab/cadre-client/app-link` — what two Sereus apps on one device need to hand a join request
 * and its answer to each other by opening each other with a link, and for one to recommend another.
 * See docs/cadre/apps.md → "Between apps on one phone".
 *
 * Platform-neutral: the app passes its platform's pieces in (`Linking.canOpenURL` on React Native,
 * a storage slot), so this runs anywhere, a Node test included. Listening for incoming links and
 * registering the URL schemes stay with the platform (on React Native, `@serfab/cadre-rn`'s config
 * plugin and the app's linking handler).
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
	recommendedByLink,
	type CadreLink,
} from './links.js';
export {
	LINK_REQUEST_TTL_MS,
	LinkRequestStore,
	UnsolicitedJoinResponseError,
	type OpenLinkRequest,
} from './link-request-store.js';
export {
	AppRecommendationStore,
	RECOMMENDATION_TTL_MS,
	type AppRecommendation,
} from './recommendation-store.js';
export {
	RECOMMENDED_BY_REFERRER_PREFIX,
	recommendedByReferrer,
	recommendedBySchemeFromReferrer,
	storePageLink,
	type StorePlatform,
} from './recommend-links.js';
