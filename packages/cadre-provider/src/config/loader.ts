/**
 * Configuration loader for the Cadre Provider service.
 *
 * The pipeline: parse the file (YAML or JSON), write the environment over it, check the result
 * strictly, then merge the validator's output over `DEFAULT_CONFIG` and apply programmatic
 * overrides. Only what the validator accepted is merged, so an unknown key, a `null` block or an
 * ill-typed value can never reach the server or the push block handed to a tenant's node.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import debug from 'debug';
import {
  type DeepPartial,
  type PartialProviderConfig,
  type ProviderConfig,
  DEFAULT_CONFIG,
} from './types.js';
import { applyEnvironmentOverrides } from './env.js';
import { validateProviderConfig } from './schema.js';
import { validateAuthConfig, validatePushConfig, redactPushConfig } from './validate.js';

const log = debug('cadre:provider:config');

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

/**
 * Parse a YAML or JSON config file. Parse only: the result is whatever the file says, checked
 * by nothing yet; {@link loadConfig} is the entry point that hands back a `ProviderConfig`.
 * A parse error names the file, the way a validation problem does.
 */
export function loadConfigFile(filePath: string): unknown {
  const resolvedPath = path.resolve(filePath);
  log('Loading config from file: %s', resolvedPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const ext = path.extname(resolvedPath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return parseNaming(resolvedPath, () => yaml.load(content));
  } else if (ext === '.json') {
    return parseNaming(resolvedPath, (): unknown => JSON.parse(content));
  } else {
    throw new Error(`Unsupported config file format: ${ext}`);
  }
}

function parseNaming(resolvedPath: string, parse: () => unknown): unknown {
  try {
    return parse();
  } catch (err) {
    throw new Error(`Config ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** Load configuration options */
export interface LoadConfigOptions {
  /** Path to config file (optional) */
  configFile?: string;
  /** Override values, applied after the file and the environment; typed, not validated. */
  overrides?: PartialProviderConfig;
  /** Where `PROVIDER_*` and `STRIPE_*` are read from (default `process.env`); tests pass their own. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * With no config file, every key in the tree was written by a variable, which a problem at that
 * key names instead. This label is printed only for a key no variable wrote — a cross-field rule
 * a variable tripped, such as `PROVIDER_STORAGE_TYPE=file` with no `PROVIDER_STORAGE_PATH`.
 */
const NO_CONFIG_FILE = '(no file; environment only)';

/**
 * Load the complete configuration: file, then environment, then overrides, over the defaults.
 * Throws one `Error` listing every problem in the file or the environment, each naming the key
 * and its source; then the auth acknowledgement and push completeness rules, which also cover
 * `overrides`.
 */
export function loadConfig(options: LoadConfigOptions = {}): ProviderConfig {
  const raw = options.configFile ? loadConfigFile(options.configFile) : undefined;
  const { tree, provenance } = applyEnvironmentOverrides(raw, options.env ?? process.env);
  const configPath = options.configFile ? path.resolve(options.configFile) : NO_CONFIG_FILE;
  const checked = validateProviderConfig(tree, provenance, configPath);

  let config = deepMerge(DEFAULT_CONFIG, checked);
  if (options.overrides) {
    config = deepMerge(config, options.overrides);
  }

  // Fail closed: reject an implicit/unacknowledged fully-open auth config.
  validateAuthConfig(config.auth);

  // Reject a partial push credential set up front rather than at first push.
  validatePushConfig(config.push);

  log('Loaded configuration: %O', redactConfigSecrets(config));
  return config;
}

const REDACTED = '[redacted]';

// NOTE: any field marked `secretString` in schema.ts must also be redacted here; the mark carries no metadata, so the two lists can drift apart.
/** The config with every secret replaced: for the debug dump and for `check`'s printout. */
export function redactConfigSecrets(config: ProviderConfig): ProviderConfig {
  const billing = { ...config.billing };
  if (billing.stripeSecretKey !== undefined) billing.stripeSecretKey = REDACTED;
  if (billing.stripeWebhookSecret !== undefined) billing.stripeWebhookSecret = REDACTED;
  return {
    ...config,
    billing,
    ...(config.push ? { push: redactPushConfig(config.push) } : {}),
  };
}
