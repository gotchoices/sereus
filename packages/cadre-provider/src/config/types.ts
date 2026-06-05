/**
 * Configuration types for the Cadre Provider service.
 */

/** Docker orchestrator configuration */
export interface DockerConfig {
  /** Docker socket path (default: /var/run/docker.sock) */
  socketPath?: string;
  /** Docker network to use for containers */
  network?: string;
  /** Image to use for cadre nodes */
  image: string;
  /** Image pull policy: always, if-not-present, never */
  pullPolicy?: 'always' | 'if-not-present' | 'never';
  /** Default resource limits */
  defaultResources?: {
    memoryLimit?: string;
    cpuLimit?: string;
    storageQuotaBytes?: number;
  };
  /** Port range for container allocation */
  portRange?: {
    start: number;
    end: number;
  };
}

/** API server configuration */
export interface ServerConfig {
  /** Host to bind to (default: 0.0.0.0) */
  host?: string;
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Base path for API routes (default: /api/v1) */
  basePath?: string;
  /** CORS configuration */
  cors?: {
    origin?: string | string[] | boolean;
    credentials?: boolean;
  };
}

/** Authentication configuration */
export interface AuthConfig {
  /** Auth mode: none, api-key, oauth */
  mode: 'none' | 'api-key' | 'oauth';
  /**
   * Required to run with mode 'none'. When mode is 'none' and this is not
   * true, the provider refuses to start. 'none' disables authentication and
   * grants every caller a wildcard identity — only for local/dev use.
   */
  allowInsecureNoAuth?: boolean;
  /** For api-key mode: list of valid keys (hashed) */
  apiKeyHashes?: string[];
  /** For oauth mode: JWKS endpoint */
  jwksUri?: string;
  /** For oauth mode: expected issuer */
  issuer?: string;
  /** For oauth mode: expected audience */
  audience?: string;
}

/** Billing configuration */
export interface BillingConfig {
  /** Enable billing features */
  enabled: boolean;
  /** Stripe API key (if using Stripe) */
  stripeSecretKey?: string;
  /** Webhook secret for Stripe events */
  stripeWebhookSecret?: string;
  /** Default plan ID for new customers */
  defaultPlanId?: string;
  /** Usage collection interval in seconds */
  usageCollectionIntervalSec?: number;
}

/** Storage configuration for provider state */
export interface StorageConfig {
  /** Storage type: memory (testing) or file */
  type: 'memory' | 'file';
  /** Path for file storage */
  path?: string;
}

/** Logging configuration */
export interface LoggingConfig {
  /** Log level: debug, info, warn, error */
  level?: 'debug' | 'info' | 'warn' | 'error';
}

/** Full provider configuration */
export interface ProviderConfig {
  /** API server configuration */
  server: ServerConfig;
  /** Authentication configuration */
  auth: AuthConfig;
  /** Docker orchestrator configuration */
  docker: DockerConfig;
  /** Billing configuration */
  billing: BillingConfig;
  /** Storage configuration */
  storage: StorageConfig;
  /** Logging configuration */
  logging: LoggingConfig;
}

/** Partial configuration for overrides */
export type PartialProviderConfig = {
  [K in keyof ProviderConfig]?: Partial<ProviderConfig[K]>;
};

/** Default configuration values */
export const DEFAULT_CONFIG: ProviderConfig = {
  server: {
    host: '0.0.0.0',
    port: 3000,
    basePath: '/api/v1',
    cors: {
      origin: true,
      credentials: true,
    },
  },
  auth: {
    mode: 'api-key',
  },
  docker: {
    socketPath: '/var/run/docker.sock',
    network: 'sereus_provider',
    image: 'sereus-cadre-node:latest',
    pullPolicy: 'if-not-present',
    defaultResources: {
      memoryLimit: '512M',
      cpuLimit: '0.5',
      storageQuotaBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    },
    portRange: {
      start: 10000,
      end: 20000,
    },
  },
  billing: {
    enabled: false,
    usageCollectionIntervalSec: 60,
  },
  storage: {
    type: 'memory',
  },
  logging: {
    level: 'info',
  },
};

