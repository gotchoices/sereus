/**
 * Every environment variable the provider reads into its configuration, and how each one's text
 * becomes a config value. Each variable is written on its own over the config file's tree
 * (`applyEnvironmentOverrides`), and the validator then type-checks what it wrote, so a bad
 * value is reported as `Environment variable PROVIDER_PORT: server.port must be …`.
 *
 * Unknown `PROVIDER_*` or `STRIPE_*` names are not rejected, unlike cadre-cli's `CADRE_*`. The
 * provider owns neither prefix: other software in the same environment may use `PROVIDER_`, and
 * `STRIPE_*` certainly is shared, so a check by name would refuse to start for reasons outside
 * this service.
 */

import {
  type EnvOverride,
  type OverrideResult,
  applyEnvOverrides,
  isPathPrefix,
  parseBooleanEnv,
  parseNumberEnv,
} from '@serfab/config-check';
import debug from 'debug';

const log = debug('cadre:provider:config');

/** How a variable's text becomes a config value. */
type EnvKind = 'string' | 'boolean' | 'number';

interface EnvMapping {
  /** The dotted config path the variable writes, over whatever the config file says there. */
  readonly path: string;
  readonly kind: EnvKind;
}

/** Config overrides: each variable writes one config path, and the validator then checks it. */
const ENV_MAPPINGS = {
  PROVIDER_HOST: { path: 'server.host', kind: 'string' },
  PROVIDER_PORT: { path: 'server.port', kind: 'number' },
  PROVIDER_BASE_PATH: { path: 'server.basePath', kind: 'string' },
  PROVIDER_AUTH_MODE: { path: 'auth.mode', kind: 'string' },
  PROVIDER_ALLOW_INSECURE_NO_AUTH: { path: 'auth.allowInsecureNoAuth', kind: 'boolean' },
  PROVIDER_JWKS_URI: { path: 'auth.jwksUri', kind: 'string' },
  PROVIDER_ISSUER: { path: 'auth.issuer', kind: 'string' },
  PROVIDER_AUDIENCE: { path: 'auth.audience', kind: 'string' },
  PROVIDER_DOCKER_SOCKET: { path: 'docker.socketPath', kind: 'string' },
  PROVIDER_DOCKER_IMAGE: { path: 'docker.image', kind: 'string' },
  PROVIDER_DOCKER_NETWORK: { path: 'docker.network', kind: 'string' },
  PROVIDER_BILLING_ENABLED: { path: 'billing.enabled', kind: 'boolean' },
  STRIPE_SECRET_KEY: { path: 'billing.stripeSecretKey', kind: 'string' },
  STRIPE_WEBHOOK_SECRET: { path: 'billing.stripeWebhookSecret', kind: 'string' },
  PROVIDER_STORAGE_TYPE: { path: 'storage.type', kind: 'string' },
  PROVIDER_STORAGE_PATH: { path: 'storage.path', kind: 'string' },
  PROVIDER_LOG_LEVEL: { path: 'logging.level', kind: 'string' },
} as const satisfies Record<string, EnvMapping>;

type ProviderEnvName = keyof typeof ENV_MAPPINGS;

/** Variables whose values are secrets: the debug log shows `[redacted]` for them. */
const SECRET_ENV: readonly string[] = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] satisfies ProviderEnvName[];

// Value parsing — one parser per kind; the text is never empty (an empty variable counts as unset).
const PARSERS: Record<EnvKind, EnvOverride['parse']> = {
  string: (text) => text,
  boolean: parseBooleanEnv,
  number: parseNumberEnv,
};

/** {@link ENV_MAPPINGS} with each kind resolved to its parser, in the form `applyEnvOverrides` takes. */
const ENV_OVERRIDES: Readonly<Record<string, EnvOverride>> = Object.fromEntries(
  Object.entries(ENV_MAPPINGS).map(([name, { path, kind }]) => [name, { path, parse: PARSERS[kind] }]),
);

/**
 * Write every set variable over the parsed file's tree. The tree comes back unchecked, and
 * `provenance` records which variable wrote which path so the validator can blame the variable
 * rather than the file. `env` defaults to `process.env`; tests pass their own.
 */
export function applyEnvironmentOverrides(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): OverrideResult {
  return applyEnvOverrides(raw, env, ENV_OVERRIDES, logOverride);
}

function logOverride(variable: string, text: string): void {
  log('Applying env override: %s=%s', variable, SECRET_ENV.includes(variable) ? '[redacted]' : text);
}

/** Reverse lookup: the variables that write `keyPath` or a key beneath it, for "is required" hints. */
export function envVarsFor(keyPath: string): string[] {
  return Object.entries(ENV_MAPPINGS)
    .filter(([, { path }]) => isPathPrefix(keyPath, path))
    .map(([name]) => name);
}
