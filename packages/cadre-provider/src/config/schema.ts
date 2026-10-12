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
  OAuthClientConfig,
  ProviderConfigFile,
  PushCredentials,
  StorageConfig,
} from './types.js';
import { isIP } from 'node:net';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { envVarsFor } from './env.js';
import { parseCpuLimit, parseMemoryLimit } from '../service/resource-limits.js';
import { hostComponent } from '../service/container-env.js';
import { isKnownScope } from '../server/permissions.js';

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

/** A port the allocator can hand to a container: `PortAllocator` rejects a range starting at 0. */
const allocatablePort = numberWhere((n) => isPortNumber(n) && n >= 1, 'a whole number from 1 to 65535');

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

/**
 * Why `host` cannot be the host part of the addresses `publicNodeAddrs` announces, or
 * `undefined` when it can: it must parse as exactly one multiaddr component. A DNS name must
 * also come back unchanged (`ab/` parses as `/dns4/ab`); an IP address may come back in
 * canonical form, since `isIP` already chose its protocol. Whitespace is refused on its own
 * because the `dns4` codec takes any text.
 */
function publicHostProblem(host: string): string | undefined {
  if (host === '' || /\s/.test(host)) return 'contains whitespace or is empty';
  const component = hostComponent(host);
  let address: Multiaddr;
  try {
    address = multiaddr(component);
  } catch (error) {
    return `is not a multiaddr host (${error instanceof Error ? error.message : String(error)})`;
  }
  const [first, ...rest] = address.getComponents();
  return rest.length === 0 && (isIP(host) !== 0 || first?.value === host)
    ? undefined
    : `does not parse as the single component ${component}`;
}

/**
 * A network the containers' ports can be published from. In `host`, `none` and `container:<id>`
 * mode Docker ignores `PortBindings`: every container would bind the same in-container ports on
 * the host, and the provider, which reaches each one at its allocated host port, would reach none.
 */
const dockerNetwork = refine(nonEmptyString, (value, keyPath, ctx) =>
  value === 'host' || value === 'none' || value.startsWith('container:')
    ? ctx.fail(
        keyPath,
        `${keyPath} must be a network Docker can publish ports from, got ${ctx.describe(keyPath, value)} (port bindings are ignored in host, none and container: modes)`,
      )
    : value,
);

/** A DNS name or IP address the containers' public addresses can be built from. */
const publicHost: Checker<string> = (value, keyPath, ctx) => {
  if (typeof value !== 'string') {
    return ctx.fail(keyPath, `${keyPath} must be a DNS name or IP address, got ${ctx.describe(keyPath, value)}`);
  }
  const problem = publicHostProblem(value);
  return problem === undefined
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a DNS name or IP address, got ${ctx.describe(keyPath, value)}, which ${problem}`);
};

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

/** Hosts at which plain `http` is accepted: the traffic never leaves the machine. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** A parsed absolute URL, or `undefined` when `text` is not one. */
function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
 * Why `text` cannot be a registered redirect URI, or `undefined`: it must be an absolute URL
 * with no fragment (the code is appended as a query, and a fragment would hide it from a
 * server-side redirect target), and `http` is accepted only at a loopback host, since the
 * authorization code travels in this URL. Any other scheme is the app's own.
 */
function redirectUriProblem(text: string): string | undefined {
  const url = parseUrl(text);
  if (url === undefined) return 'is not an absolute URL';
  if (url.hash !== '' || text.endsWith('#')) return 'has a fragment';
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return 'uses http at a host other than loopback';
  return undefined;
}

const redirectUri: Checker<string> = (value, keyPath, ctx) => {
  if (typeof value !== 'string') {
    return ctx.fail(keyPath, `${keyPath} must be an absolute URL, got ${ctx.describe(keyPath, value)}`);
  }
  const problem = redirectUriProblem(value);
  return problem === undefined
    ? value
    : ctx.fail(keyPath, `${keyPath} must be an absolute URL with no fragment (http only at a loopback host), got ${ctx.describe(keyPath, value)}, which ${problem}`);
};

/** A scope a token may carry (`server/permissions.ts`); the global `*` is not one. */
const scopeName: Checker<string> = (value, keyPath, ctx) =>
  typeof value === 'string' && isKnownScope(value)
    ? value
    : ctx.fail(keyPath, `${keyPath} must be a permission scope such as containers:read or containers:*, got ${ctx.describe(keyPath, value)}`);

/**
 * Why `text` cannot be `provider.publicUrl`, or `undefined`: the origin apps reach this API at,
 * so `https` (plain `http` only at a loopback host, for a dev run), with no query or fragment,
 * since the descriptor appends the base path and a route to it.
 */
function publicUrlProblem(text: string): string | undefined {
  const url = parseUrl(text);
  if (url === undefined) return 'is not an absolute URL';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'is not an http(s) URL';
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return 'uses http at a host other than loopback';
  if (url.search !== '' || url.hash !== '' || /[?#]$/.test(text)) return 'has a query or fragment';
  return undefined;
}

const publicUrl: Checker<string> = (value, keyPath, ctx) => {
  if (typeof value !== 'string') {
    return ctx.fail(keyPath, `${keyPath} must be an https URL, got ${ctx.describe(keyPath, value)}`);
  }
  const problem = publicUrlProblem(value);
  return problem === undefined
    ? value
    : ctx.fail(keyPath, `${keyPath} must be an https URL (http only at a loopback host) with no query or fragment, got ${ctx.describe(keyPath, value)}, which ${problem}`);
};

/** An http(s) URL an app may open: the terms page, the icon. */
const webUrl: Checker<string> = (value, keyPath, ctx) => {
  const url = typeof value === 'string' ? parseUrl(value) : undefined;
  return url !== undefined && (url.protocol === 'https:' || url.protocol === 'http:')
    ? (value as string)
    : ctx.fail(keyPath, `${keyPath} must be an http(s) URL, got ${ctx.describe(keyPath, value)}`);
};

const wholeSeconds = numberWhere((n) => Number.isSafeInteger(n) && n > 0, 'a whole number of seconds above zero');

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

const oauthClient = refine(
  objectOf<OAuthClientConfig>(
    {
      clientId: nonEmptyString,
      redirectUris: arrayOf(redirectUri),
      scopes: arrayOf(scopeName),
    },
    { required: ['clientId', 'redirectUris', 'scopes'] },
  ),
  // A client with nowhere to send a code, or nothing a token may carry, can never sign in.
  (value, keyPath, ctx) => {
    if (value.redirectUris.length === 0) return ctx.fail(`${keyPath}.redirectUris`, `${keyPath}.redirectUris must list at least one URI`);
    if (value.scopes.length === 0) return ctx.fail(`${keyPath}.scopes`, `${keyPath}.scopes must list at least one scope`);
    return value;
  },
);

const oauthClients = refine(arrayOf(oauthClient), (value, keyPath, ctx) => {
  if (value.length === 0) return ctx.fail(keyPath, `${keyPath} must list at least one client`);
  const seen = new Set<string>();
  for (const [i, client] of value.entries()) {
    if (seen.has(client.clientId)) {
      return ctx.fail(`${keyPath}[${i}].clientId`, `${keyPath}[${i}].clientId repeats ${JSON.stringify(client.clientId)}; each clientId must be unique`);
    }
    seen.add(client.clientId);
  }
  return value;
});

const oauth = objectOf<NonNullable<Block<'auth'>['oauth']>>(
  {
    clients: oauthClients,
    accessTokenTtlSec: wholeSeconds,
    refreshTokenTtlSec: wholeSeconds,
    devConsentPage: booleanValue,
  },
  { required: ['clients'] },
);

const auth = refine(
  objectOf<Block<'auth'>>({
    mode: oneOf<AuthConfig['mode']>({ none: true, 'api-key': true, oauth: true }),
    allowInsecureNoAuth: booleanValue,
    apiKeyHashes: arrayOf(nonEmptyString),
    jwksUri: nonEmptyString,
    issuer: nonEmptyString,
    audience: nonEmptyString,
    oauth,
  }),
  // Cross-field: the built-in endpoints serve only `oauth` mode; under another mode the block
  // would be silently ignored, and the operator who wrote it expects sign-in to work.
  (value, keyPath, ctx) =>
    value.oauth !== undefined && value.mode !== 'oauth'
      ? ctx.fail(`${keyPath}.oauth`, `${keyPath}.oauth is allowed only when ${keyPath}.mode is 'oauth', got ${ctx.describe(`${keyPath}.mode`, value.mode)}`)
      : value,
);

const provider = objectOf<Block<'provider'>>(
  {
    id: nonEmptyString,
    name: nonEmptyString,
    publicUrl,
    termsUrl: webUrl,
    regions: arrayOf(nonEmptyString),
    icon: webUrl,
  },
  { required: ['id', 'name', 'publicUrl'] },
);

const docker = objectOf<Block<'docker'>>({
  socketPath: nonEmptyString,
  network: dockerNetwork,
  image: nonEmptyString,
  pullPolicy: oneOf<NonNullable<DockerConfig['pullPolicy']>>({ always: true, 'if-not-present': true, never: true }),
  defaultResources: objectOf<NonNullable<Block<'docker'>['defaultResources']>>({
    memoryLimit,
    cpuLimit,
    storageQuotaBytes: nonNegativeInteger,
  }),
  portRange: refine(
    objectOf<NonNullable<Block<'docker'>['portRange']>>({
      start: allocatablePort,
      end: allocatablePort,
    }),
    // Cross-field, within the file: `PortAllocator` refuses an inverted range, but only when the
    // orchestrator is built, after `check` has said the config is valid.
    (value, keyPath, ctx) =>
      value.start !== undefined && value.end !== undefined && value.end < value.start
        ? ctx.fail(keyPath, `${keyPath}.end must be at least ${keyPath}.start, got ${value.end} and ${value.start}`)
        : value,
  ),
  publicHost,
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
  provider,
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
