/**
 * @serfab/cadre-provider - Reference provider service for hosting Sereus cadre nodes.
 *
 * This package provides a production-ready provider API that can be deployed
 * independently or embedded in existing applications.
 *
 * @example
 * ```typescript
 * import { createProviderServer, loadConfig } from '@serfab/cadre-provider';
 *
 * const config = loadConfig({ overrides: { server: { port: 8080 } } });
 * const server = await createProviderServer({ config });
 * await server.start();
 * ```
 *
 * @example
 * ```typescript
 * // With custom authentication
 * import { createProviderServer, loadConfig, type AuthHooks } from '@serfab/cadre-provider';
 *
 * const authHooks: AuthHooks = {
 *   async validateJwt(token) {
 *     const user = await verifyJWT(token);
 *     return { customerId: user.id, permissions: user.scopes };
 *   },
 * };
 *
 * const server = await createProviderServer({
 *   config: loadConfig(),
 *   authHooks,
 * });
 * ```
 */

// Configuration
export {
  type ProviderConfig,
  type ProviderConfigFile,
  type PartialProviderConfig,
  type LoadConfigOptions,
  type ServerConfig,
  type AuthConfig,
  type OAuthConfig,
  type OAuthClientConfig,
  type ProviderIdentityConfig,
  type DockerConfig,
  type BillingConfig,
  type StorageConfig,
  type LoggingConfig,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigFile,
  applyEnvironmentOverrides,
  validateProviderConfig,
} from './config/index.js';

// Types
export {
  type Container,
  type ContainerStatus,
  type ContainerResources,
  type ContainerJoin,
  type ContainerJoinRequest,
  type ContainerJoinState,
  type CreateContainerRequest,
  type ContainerStatusResponse,
  type RedactedContainer,
  type UsageMetrics,
  type BillingPlan,
  type CustomerBilling,
  type Subscription,
  type SubscriptionStatus,
  type StopReason,
  type ApiKey,
  type AuthorizationCode,
  type RefreshToken,
  UNCLAIMED_PARTY_ID,
} from './types.js';

// Services
export {
  type ProviderStore,
  MemoryStore,
  FileStore,
  createStore,
} from './service/store.js';

export {
  type ContainerRunState,
  type Orchestrator,
  type OrchestratorCreateRequest,
  type OrchestratorCreateResult,
  type OrchestratorStats,
  type RecoverableOrchestrator,
  MockOrchestrator,
} from './service/orchestrator.js';

export { DockerOrchestrator } from './service/docker-orchestrator.js';

export {
  PortAllocator,
  allocatePortSet,
  reservePortSet,
  releasePortSet,
} from './service/port-allocator.js';

export {
  type NodeEnvPorts,
  type NodeEnvSpec,
  CONTAINER_PORTS,
  buildNodeEnv,
  publicNodeAddrs,
} from './service/container-env.js';

// The node code a claim container is claimed with: its format and address rule.
export {
  type NodeCodePayload,
  NODE_CODE_PREFIX,
  claimAddressesFor,
  encodeNodeCode,
} from './service/node-code.js';

export { type NodeCode, type NodeCodeRefusal } from './service/container-join.js';

export {
  ContainerService,
  type ContainerServiceOptions,
  CONTAINER_ENROLLMENT_TIMEOUT_MS,
  CONTAINER_ENROLLMENT_POLL_MS,
  CONTAINER_PROVISIONING_TTL_MS,
  CONTAINER_ENROLLMENT_TTL_MS,
  CONTAINER_REAP_SWEEP_MS,
} from './service/container-service.js';

// Wire types for a container's live `/status` payload (referenced by
// ContainerStatusResponse.health), plus the helpers that fetch/derive it.
export {
  type ContainerHealthStatus,
  type ContainerInvitationStatus,
  type ContainerStrandCounts,
  fetchContainerHealthStatus,
  statusUrlFromHealthEndpoint,
} from './service/container-health.js';

export {
  BillingService,
  type BillingServiceOptions,
  type BillingHooks,
  type InvoiceLineItem,
  type SubscriptionPatch,
  DEFAULT_PLANS,
  QUOTA_CONSUMING_STATUSES,
} from './service/billing-service.js';

// Server
export {
  createProviderServer,
  type ProviderServer,
  type ProviderServerOptions,
} from './server/server.js';

export {
  type CustomerIdentity,
  type RouteContext,
  registerRoutes,
} from './server/routes.js';

export {
  type AuthHooks,
  type AuthContext,
  type AuthorizationRequest,
  type AuthorizationDecision,
  registerAuth,
  hashApiKey,
} from './server/auth.js';

// The built-in OAuth 2 + PKCE endpoints and the descriptor an app's store screen reads.
export {
  type OAuthRouteContext,
  type TokenResponse,
  DEFAULT_ACCESS_TOKEN_TTL_SEC,
  DEFAULT_REFRESH_TOKEN_TTL_SEC,
  registerOAuthRoutes,
} from './server/oauth.js';

export { codeChallengeFor, verifyCodeVerifier } from './server/pkce.js';

export {
  type ProviderDescriptor,
  buildProviderDescriptor,
  registerDescriptorRoute,
} from './server/descriptor.js';

export {
  Scope,
  hasPermission,
  isKnownScope,
} from './server/permissions.js';

