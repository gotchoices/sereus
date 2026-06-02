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
  type PartialProviderConfig,
  type ServerConfig,
  type AuthConfig,
  type DockerConfig,
  type BillingConfig,
  type StorageConfig,
  type LoggingConfig,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigFile,
  loadEnvConfig,
} from './config/index.js';

// Types
export {
  type Container,
  type ContainerStatus,
  type ContainerResources,
  type CreateContainerRequest,
  type ContainerStatusResponse,
  type UsageMetrics,
  type BillingPlan,
  type CustomerBilling,
  type ApiKey,
} from './types.js';

// Services
export {
  type ProviderStore,
  MemoryStore,
  FileStore,
  createStore,
} from './service/store.js';

export {
  type Orchestrator,
  type OrchestratorCreateRequest,
  type OrchestratorCreateResult,
  type OrchestratorStats,
  MockOrchestrator,
} from './service/orchestrator.js';

export { DockerOrchestrator } from './service/docker-orchestrator.js';

export {
  ContainerService,
  type ContainerServiceOptions,
} from './service/container-service.js';

// Wire types for a container's live `/status` payload (referenced by
// ContainerStatusResponse.health), plus the helpers that fetch/derive it.
export {
  type ContainerHealthStatus,
  type ContainerStrandCounts,
  fetchContainerHealthStatus,
  statusUrlFromHealthEndpoint,
} from './service/container-health.js';

export {
  BillingService,
  type BillingServiceOptions,
  type BillingHooks,
  type InvoiceLineItem,
  DEFAULT_PLANS,
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
  registerAuth,
  hashApiKey,
} from './server/auth.js';

