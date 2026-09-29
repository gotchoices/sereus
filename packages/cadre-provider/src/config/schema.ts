/**
 * Strict validation of the provider's configuration tree: the config file with the
 * environment written over it, checked before it is merged over `DEFAULT_CONFIG`.
 *
 * `validateProviderConfig` either returns a `ProviderConfigFile` built only from accepted keys
 * or throws one `Error` listing every problem, each naming the key and its source (the file,
 * or the `PROVIDER_*`/`STRIPE_*` variable that wrote it). Because only its output is merged,
 * nothing it did not accept can reach the server or the `CADRE_PUSH` block handed to a
 * tenant's node — which is how one stray key under `push` used to stop every affected node.
 *
 * The validator owns shape: which keys exist, their types, closed value sets, and that a
 * resource limit is text the orchestrator can read. Two rules stay elsewhere and run after
 * the merge, so they also cover programmatic overrides: `validateAuthConfig` (mode `none` must
 * be acknowledged) and `validatePushConfig` (a present platform block is complete).
 *
 * The checker mechanism is `@serfab/config-check`'s; what is here is the provider's own: one
 * field table per block of `ProviderConfigFile`, typed against it so a key added to a config
 * interface without a checker fails to compile.
 */

import {
  type Checker,
  arrayOf,
  booleanValue,
  nonEmptyString,
  nonNegativeInteger,
  nonNegativeNumber,
  numberWhere,
  objectOf,
  oneOf,
  positiveNumber,
  recordOf,
  refine,
  secretString,
  stringValue,
  validateTree,
} from '@serfab/config-check';
import type {
  ApnsCredentials,
  AuthConfig,
  DockerConfig,
  FcmCredentials,
  LoggingConfig,
  ProviderConfigFile,
  PushCredentials,
  StorageConfig,
} from './types.js';
import { envVarsFor } from './env.js';
import { parseCpuLimit, parseMemoryLimit } from '../service/resource-limits.js';

type Block<K extends keyof ProviderConfigFile> = NonNullable<ProviderConfigFile[K]>;

// ---------------------------------------------------------------------------
// Local checkers
// ---------------------------------------------------------------------------

/** Whether `n` is a TCP port number. 0 is allowed: it asks the OS for a free port. */
export function isPortNumber(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0 && n <= 65535;
}

/** Completes "must be …" for a port, in the validator and in `--port`'s own check. */
export const PORT_EXPECTED = 'a whole number from 0 to 65535';

const portNumber = numberWhere(isPortNumber, PORT_EXPECTED);

const corsOrigin: Checker<string | string[] | boolean> = (value, keyPath, ctx) =>
  typeof value === 'string' || typeof value === 'boolean' || isStringList(value)
    ? value
    : ctx.fail(
      keyPath,
      `${keyPath} must be a string, a list of strings, or true/false, got ${ctx.describe(keyPath, value)}`,
    );

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

/** Text `parseMemoryLimit` can read; anything else used to run the container with no limit. */
const memoryLimit: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string' && parseMemoryLimit(value) !== undefined
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a size like 512M or 2G, got ${ctx.describe(keyPath, value)}`);

/** Text `parseCpuLimit` can read. YAML reads an unquoted `0.5` as a number, so say to quote it. */
const cpuLimit: Checker<string> = (value, keyPath, ctx) => {
  if (typeof value === 'number') {
    return ctx.fail(
      keyPath,
      `${keyPath} must be a quoted string like "0.5" (YAML read the unquoted ${value} as a number; quote it)`,
    );
  }
  return typeof value === 'string' && parseCpuLimit(value) !== undefined
    ? value
    : ctx.fail(
      keyPath,
      `${keyPath} must be a number of CPUs written as a string, like "0.5" or "2", got ${ctx.describe(keyPath, value)}`,
    );
};

// ---------------------------------------------------------------------------
// Field tables — one per block of ProviderConfigFile
// ---------------------------------------------------------------------------

const server = objectOf<Block<'server'>>({
  host: nonEmptyString,
  port: portNumber,
  basePath: stringValue,
  cors: objectOf<NonNullable<Block<'server'>['cors']>>({
    origin: corsOrigin,
    credentials: booleanValue,
  }),
});

const auth = objectOf<Block<'auth'>>({
  mode: oneOf<AuthConfig['mode']>({ none: true, 'api-key': true, oauth: true }),
  allowInsecureNoAuth: booleanValue,
  apiKeyHashes: arrayOf(nonEmptyString),
  jwksUri: nonEmptyString,
  issuer: nonEmptyString,
  audience: nonEmptyString,
});

const docker = objectOf<Block<'docker'>>({
  socketPath: nonEmptyString,
  network: nonEmptyString,
  image: nonEmptyString,
  pullPolicy: oneOf<NonNullable<DockerConfig['pullPolicy']>>({ always: true, 'if-not-present': true, never: true }),
  defaultResources: objectOf<NonNullable<Block<'docker'>['defaultResources']>>({
    memoryLimit,
    cpuLimit,
    storageQuotaBytes: nonNegativeInteger,
  }),
  portRange: objectOf<NonNullable<Block<'docker'>['portRange']>>({
    start: portNumber,
    end: portNumber,
  }),
});

const billing = objectOf<Block<'billing'>>({
  enabled: booleanValue,
  stripeSecretKey: secretString,
  stripeWebhookSecret: secretString,
  defaultPlanId: nonEmptyString,
  usageCollectionIntervalSec: positiveNumber,
});

const storage = refine(
  objectOf<Block<'storage'>>({
    type: oneOf<StorageConfig['type']>({ memory: true, file: true }),
    path: nonEmptyString,
  }),
  // Cross-field: a file store needs somewhere to put the files. `createStore` used to answer
  // this with the in-memory store, losing every tenant record on restart.
  (value, keyPath, ctx) =>
    value.type === 'file' && value.path === undefined
      ? ctx.missing(`${keyPath}.path`, `when ${keyPath}.type is 'file'`)
      : value,
);

const logging = objectOf<Block<'logging'>>({
  level: oneOf<NonNullable<LoggingConfig['level']>>({ debug: true, info: true, warn: true, error: true }),
});

// Push sub-fields are type-checked only, against the provider's mirror of cadre-core's
// credential types (see types.ts). That a present platform block carries all its fields stays
// with `validatePushConfig`, after the merge — the same split as cadre-cli's tables.
const fcm = objectOf<FcmCredentials>({
  projectId: stringValue,
  clientEmail: stringValue,
  privateKey: secretString,
});

const apns = objectOf<ApnsCredentials>({
  keyId: stringValue,
  teamId: stringValue,
  bundleId: stringValue,
  privateKey: secretString,
  production: booleanValue,
});

const credentials = objectOf<PushCredentials>({
  fcm,
  apns,
  cooldownMs: nonNegativeNumber,
  debounceMs: nonNegativeNumber,
});

const push = objectOf<Block<'push'>>({
  default: credentials,
  tenants: recordOf(credentials),
});

// No block is required: DEFAULT_CONFIG supplies every key the server needs.
const root = objectOf<ProviderConfigFile>({
  server,
  auth,
  docker,
  billing,
  storage,
  logging,
  push,
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Hand-written blocks holding secrets: a rejected value at or under these is described by kind
 * only, so a private key pasted where a mapping belongs is never echoed into an error.
 */
const SECRET_SUBTREES: readonly (keyof ProviderConfigFile)[] = ['push', 'billing'];

/**
 * Validate the file-plus-environment tree against the field tables above. `provenance` maps
 * each dotted path the environment wrote to the variable that wrote it (`applyEnvironmentOverrides`
 * builds it); `configPath` is named in every problem the environment did not cause. Throws one
 * `Error` whose message lists every problem, one per line.
 */
export function validateProviderConfig(
  tree: unknown,
  provenance: ReadonlyMap<string, string>,
  configPath: string,
): ProviderConfigFile {
  return validateTree(tree, root, { configPath, provenance, suppliersOf: envVarsFor, concealUnder: SECRET_SUBTREES });
}
