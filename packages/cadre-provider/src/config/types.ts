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
  /**
   * Port range for container allocation. Each container takes four host ports
   * (health, metrics, libp2p TCP, libp2p WebSocket).
   */
  portRange?: {
    start: number;
    end: number;
  };
  /**
   * DNS name or IP address at which this machine's published container ports are
   * reachable from outside. When set, every container announces its TCP and
   * WebSocket addresses at this host, and a create request may ask for a container
   * that is claimed (a phone dials it with its node code). Unset: containers announce
   * only their in-container addresses, and join by invitation only.
   */
  publicHost?: string;
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

/**
 * One app registered with the provider's built-in OAuth endpoints. A public client (a phone
 * app) has no secret: what identifies it is the exact redirect URI the authorization code is
 * sent to, so the list here is the whole defence against a code being sent elsewhere.
 */
export interface OAuthClientConfig {
  /** The `client_id` the app presents; unique across `clients`. */
  clientId: string;
  /**
   * Every redirect URI the app may name, compared by exact string equality. Absolute, with no
   * fragment; a custom scheme (`sereus-chat://provider-auth`) is the usual form, and `http`
   * is accepted only at a loopback host.
   */
  redirectUris: string[];
  /** The most a token issued to this client may carry; a request for more is `invalid_scope`. */
  scopes: string[];
}

/** The provider's built-in OAuth 2 authorization code + PKCE endpoints (`auth.mode: oauth`). */
export interface OAuthConfig {
  /** The apps that may sign a customer in here; at least one. */
  clients: OAuthClientConfig[];
  /** Access token lifetime in seconds (default 3600). */
  accessTokenTtlSec?: number;
  /** Refresh token lifetime in seconds (default 2592000, 30 days). */
  refreshTokenTtlSec?: number;
  /**
   * Serve the built-in consent form in place of an `authorizeCustomer` hook: anyone who
   * opens the authorize URL may type a customer id and get a token for it. Requires
   * `allowInsecureNoAuth: true`, the same acknowledgement mode `none` needs, and refuses to
   * start beside a hook, which the form would bypass.
   */
  devConsentPage?: boolean;
}

/** Authentication configuration */
export interface AuthConfig {
  /** Auth mode: none, api-key, oauth */
  mode: 'none' | 'api-key' | 'oauth';
  /**
   * Required to run with mode 'none', and with `oauth.devConsentPage: true`. When either
   * is set and this is not true, the provider refuses to start. 'none' disables
   * authentication and grants every caller a wildcard identity; the dev consent page
   * issues a token to anyone for any customer id — both only for local/dev use.
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
  /**
   * For oauth mode: the provider's own authorize and token endpoints. Absent, the provider
   * validates bearers through the `validateJwt` hook alone (an external identity provider).
   */
  oauth?: OAuthConfig;
}

/**
 * What the provider says about itself in `GET /descriptor`, the document an app's store
 * screen renders. Optional: without it the route answers 404 `NOT_CONFIGURED`.
 */
export interface ProviderIdentityConfig {
  /** Stable identifier an app keys its rental records by; never changes once published. */
  id: string;
  /** Display name. */
  name: string;
  /**
   * The origin this API is reached at (`https://nodes.acme.example`). Every URL in the
   * descriptor is this plus `server.basePath` plus the route; `https` except at a loopback host.
   */
  publicUrl: string;
  /** Terms of service page, if any. */
  termsUrl?: string;
  /** Regions the provider hosts nodes in, in the provider's own words. */
  regions?: string[];
  /** Icon URL for the store screen. */
  icon?: string;
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
// just to serialize a JSON env var. Keep these in sync with cadre-core's types:
// they also drive what the provider ACCEPTS in its own config (`config/schema.ts`
// builds its push field tables from them). If cadre-core adds a push field, the
// provider rejects it at start until this mirror and the table gain it (fails
// safe); if cadre-core removes one, the provider would still forward it in
// `CADRE_PUSH` and every tenant node would refuse to boot — so update both together.

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
  /** What `GET /descriptor` says about this provider; absent ⇒ the route answers 404. */
  provider?: ProviderIdentityConfig;
}

/** Partial configuration for programmatic overrides (`loadConfig({ overrides })`). */
export type PartialProviderConfig = {
  [K in keyof ProviderConfig]?: Partial<ProviderConfig[K]>;
};

/**
 * Recursively-optional view of T — a config layer may override any leaf without supplying
 * siblings. An optional block (`provider?: ProviderIdentityConfig`) recurses like a required
 * one: the `undefined` is stripped before the object test, which an indexed access type would
 * otherwise fail and leave the block's own keys required.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends ReadonlyArray<unknown>
    ? T[K]
    : NonNullable<T[K]> extends object
      ? DeepPartial<NonNullable<T[K]>>
      : T[K];
};

/**
 * What a config file plus the environment may contain: every key optional, since
 * `DEFAULT_CONFIG` fills the rest. The validator (`config/schema.ts`) produces
 * exactly this, and only its output is merged over the defaults.
 */
export type ProviderConfigFile = DeepPartial<ProviderConfig>;

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

