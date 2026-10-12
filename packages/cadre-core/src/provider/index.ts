/**
 * Everything an app needs to rent a node from a hosting provider: the provider's descriptor,
 * the sign-in handshake, the typed API client, and `rentNode` / `finishRental`. Every module
 * here loads on React Native and in the browser as well as Node.
 */

export { parseProviderDescriptor, fetchProviderDescriptor, type ProviderDescriptor } from './descriptor.js';
export {
	ProviderAuthError,
	pkceChallenge,
	createPkce,
	createAuthorizationState,
	authorizationUrl,
	readAuthorizationRedirect,
	exchangeAuthorizationCode,
	refreshTokens,
	createTokenSource,
	TOKEN_REFRESH_MARGIN_MS,
	type Pkce,
	type ProviderTokens,
	type AuthorizationUrlOptions,
	type AuthorizationRedirect,
	type ExchangeAuthorizationCodeOptions,
	type RefreshTokensOptions,
	type TokenSource,
	type TokenSourceOptions,
} from './oauth.js';
export {
	createProviderClient,
	ProviderApiError,
	type ProviderClient,
	type ProviderClientOptions,
	type ContainerJoinRequest,
	type ContainerJoinState,
	type ContainerStopReason,
	type RentedContainer,
	type RentedContainerStatus,
	type RentedContainerHealth,
	type RentedContainerStatusReport,
	type CreateContainerBody,
	type SubscriptionStatus,
	type BillingStatus,
	type NodeCodeAnswer,
} from './client.js';
export {
	rentNode,
	finishRental,
	RentNodeError,
	DEFAULT_NODE_CODE_DEADLINE_MS,
	NODE_CODE_POLL_MS,
	RENTAL_INVITATION_TTL_MS,
	type RentNodeJoin,
	type RentNodeStep,
	type RentNodeOptions,
	type RentNodeResult,
	type RentalFailed,
	type RentNodeErrorCode,
	type RentingNode,
} from './rent-node.js';
