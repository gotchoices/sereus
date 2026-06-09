/**
 * Configuration loader for the Cadre Provider service.
 * Supports YAML/JSON files and environment variable overrides.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import debug from 'debug';
import { type ProviderConfig, type PartialProviderConfig, DEFAULT_CONFIG } from './types.js';
import { validateAuthConfig, validatePushConfig, redactPushConfig } from './validate.js';

const log = debug('cadre:provider:config');

/** Recursively-optional view of T — a config layer may override any leaf without supplying siblings. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends ReadonlyArray<unknown>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** Deep merge two objects, with `source` values overriding `target`. */
function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  const result: Record<string, unknown> = { ...targetRecord };
  for (const key in sourceRecord) {
    const sourceVal = sourceRecord[key];
    const targetVal = targetRecord[key];
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as T;
}

/** Load configuration from a file */
export function loadConfigFile(filePath: string): PartialProviderConfig {
  log('Loading config from file: %s', filePath);
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content) as PartialProviderConfig;
  } else if (ext === '.json') {
    return JSON.parse(content) as PartialProviderConfig;
  } else {
    throw new Error(`Unsupported config file format: ${ext}`);
  }
}

/** Load configuration from environment variables */
export function loadEnvConfig(): PartialProviderConfig {
  const config: PartialProviderConfig = {};

  // Server config
  if (process.env.PROVIDER_HOST || process.env.PROVIDER_PORT || process.env.PROVIDER_BASE_PATH) {
    config.server = {};
    if (process.env.PROVIDER_HOST) config.server.host = process.env.PROVIDER_HOST;
    if (process.env.PROVIDER_PORT) config.server.port = parseInt(process.env.PROVIDER_PORT, 10);
    if (process.env.PROVIDER_BASE_PATH) config.server.basePath = process.env.PROVIDER_BASE_PATH;
  }

  // Auth config
  if (process.env.PROVIDER_AUTH_MODE) {
    config.auth = { mode: process.env.PROVIDER_AUTH_MODE as 'none' | 'api-key' | 'oauth' };
    if (process.env.PROVIDER_ALLOW_INSECURE_NO_AUTH === 'true') config.auth.allowInsecureNoAuth = true;
    if (process.env.PROVIDER_JWKS_URI) config.auth.jwksUri = process.env.PROVIDER_JWKS_URI;
    if (process.env.PROVIDER_ISSUER) config.auth.issuer = process.env.PROVIDER_ISSUER;
    if (process.env.PROVIDER_AUDIENCE) config.auth.audience = process.env.PROVIDER_AUDIENCE;
  }

  // Docker config
  if (process.env.PROVIDER_DOCKER_SOCKET || process.env.PROVIDER_DOCKER_IMAGE) {
    config.docker = {} as PartialProviderConfig['docker'];
    if (process.env.PROVIDER_DOCKER_SOCKET) config.docker!.socketPath = process.env.PROVIDER_DOCKER_SOCKET;
    if (process.env.PROVIDER_DOCKER_IMAGE) config.docker!.image = process.env.PROVIDER_DOCKER_IMAGE;
    if (process.env.PROVIDER_DOCKER_NETWORK) config.docker!.network = process.env.PROVIDER_DOCKER_NETWORK;
  }

  // Billing config
  if (process.env.PROVIDER_BILLING_ENABLED) {
    config.billing = { enabled: process.env.PROVIDER_BILLING_ENABLED === 'true' };
    if (process.env.STRIPE_SECRET_KEY) config.billing.stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (process.env.STRIPE_WEBHOOK_SECRET) config.billing.stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  }

  // Storage config
  if (process.env.PROVIDER_STORAGE_TYPE || process.env.PROVIDER_STORAGE_PATH) {
    config.storage = {};
    if (process.env.PROVIDER_STORAGE_TYPE) {
      config.storage.type = process.env.PROVIDER_STORAGE_TYPE as 'memory' | 'file';
    }
    if (process.env.PROVIDER_STORAGE_PATH) config.storage.path = process.env.PROVIDER_STORAGE_PATH;
  }

  // Logging config
  if (process.env.PROVIDER_LOG_LEVEL) {
    config.logging = { level: process.env.PROVIDER_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' };
  }

  return config;
}

/** Load configuration options */
export interface LoadConfigOptions {
  /** Path to config file (optional) */
  configFile?: string;
  /** Override values */
  overrides?: PartialProviderConfig;
}

/** Load complete configuration from file, env, and overrides */
export function loadConfig(options: LoadConfigOptions = {}): ProviderConfig {
  let config: ProviderConfig = { ...DEFAULT_CONFIG };

  // Load from file if provided
  if (options.configFile) {
    const fileConfig = loadConfigFile(options.configFile);
    config = deepMerge(config, fileConfig);
  }

  // Apply environment variables
  const envConfig = loadEnvConfig();
  config = deepMerge(config, envConfig);

  // Apply overrides
  if (options.overrides) {
    config = deepMerge(config, options.overrides);
  }

  // Fail closed: reject an implicit/unacknowledged fully-open auth config.
  validateAuthConfig(config.auth);

  // Reject a partial push credential set up front rather than at first push.
  validatePushConfig(config.push);

  // Redact push private keys before the debug dump — they are secrets.
  log('Loaded configuration: %O', config.push ? { ...config, push: redactPushConfig(config.push) } : config);
  return config;
}

