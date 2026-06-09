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

// ============================================================================
// Push credentials (per-tenant FCM/APNs — injected into each tenant's node)
// ============================================================================
//
// These mirror `@serfab/cadre-core`'s `PushCredentials` contract (the shape the
// node reads from `CADRE_PUSH` / `config.push`). They are re-declared locally so
// the provider stays self-contained — it does not pull cadre-core's runtime graph
// just to serialize a JSON env var. Keep these in sync with cadre-core's types.

/** FCM (Android/Firebase) service-account credentials. */
export interface FcmCredentials {
  /** GCP / Firebase project id. */
  projectId: string;
  /** Service-account email. */
  clientEmail: string;
  /** Service-account RSA private key, PEM. Secret — never logged. */
  privateKey: string;
}

/** APNs (Apple) auth-key credentials. */
export interface ApnsCredentials {
  /** APNs key id (the `.p8` key identifier). */
  keyId: string;
  /** Apple team id. */
  teamId: string;
  /** App bundle id → `apns-topic`. */
  bundleId: string;
  /** `.p8` ES256 private key, PEM. Secret — never logged. */
  privateKey: string;
  /** `true` → production APNs host; false/undefined → sandbox. */
  production?: boolean;
}

/** Platform push-delivery credentials injected into one tenant's node. */
export interface PushCredentials {
  fcm?: FcmCredentials;
  apns?: ApnsCredentials;
  /** Per-(peer,strand) anti-spam cooldown (ms). */
  cooldownMs?: number;
  /** Per-strand burst-coalescing window (ms). */
  debounceMs?: number;
}

/**
 * Provider-level push configuration: an optional default applied to every tenant
 * that has no override, plus per-tenant overrides keyed by `customerId`. A tenant
 * with neither a matching override nor a default gets NO push block — and one
 * tenant's credentials are NEVER injected into another tenant's node (the
 * resolution is strictly by the launching tenant's id).
 */
export interface ProviderPushConfig {
  /** Default credentials for tenants without a specific override. */
  default?: PushCredentials;
  /** Per-tenant overrides, keyed by `customerId`. */
  tenants?: Record<string, PushCredentials>;
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
  /**
   * Per-tenant push (FCM/APNs) credentials, injected into each tenant's node so
   * it can deliver strand-wake pushes to that tenant's suspended mobile peers.
   * Optional — absent ⇒ no node gets a push block (control-network wake only).
   */
  push?: ProviderPushConfig;
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

