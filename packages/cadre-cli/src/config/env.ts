/**
 * Every `CADRE_*` environment variable the node process may see, and how the config overrides
 * among them are turned into config values.
 *
 * The node refuses to start on a `CADRE_*` variable this module does not know — a misspelled or
 * retired name would otherwise be ignored without a word — so a variable a launcher sets must
 * appear here in one of four groups: a config override ({@link ENV_MAPPINGS}), a variable a
 * command reads itself ({@link COMMAND_ENV}), one read only by a launcher around the CLI, or a
 * retired one with the message naming its replacement.
 */

import {
  type EnvOverride,
  nearestKey,
  parseBooleanEnv,
  parseListEnv,
  parseNumberEnv,
  specifiedEnv,
} from '@serfab/config-check';
import { parseStrandFilterText } from './strand-filter.js';

/** How a variable's text becomes a config value. */
export type EnvKind = 'string' | 'list' | 'boolean' | 'number' | 'strandFilter' | 'json';

export interface EnvMapping {
  /** The dotted config path the variable writes, over whatever the config file says there. */
  readonly path: string;
  readonly kind: EnvKind;
}

/** Config overrides: each variable writes one config path, and the validator then checks it. */
export const ENV_MAPPINGS = {
  CADRE_PARTY_ID: { path: 'controlNetwork.partyId', kind: 'string' },
  CADRE_BOOTSTRAP_NODES: { path: 'controlNetwork.bootstrapNodes', kind: 'list' },
  CADRE_PROFILE: { path: 'profile', kind: 'string' },
  CADRE_KEY_FILE: { path: 'identity.keyFile', kind: 'string' },
  CADRE_STORAGE_PATH: { path: 'storage.path', kind: 'string' },
  CADRE_STORAGE_TYPE: { path: 'storage.type', kind: 'string' },
  CADRE_STORAGE_QUOTA: { path: 'storage.quotaBytes', kind: 'number' },
  CADRE_LISTEN_ADDRS: { path: 'network.listenAddrs', kind: 'list' },
  CADRE_ANNOUNCE_ADDRS: { path: 'network.announceAddrs', kind: 'list' },
  CADRE_APPEND_ANNOUNCE_ADDRS: { path: 'network.appendAnnounceAddrs', kind: 'list' },
  CADRE_RELAY_ADDRS: { path: 'network.relayAddrs', kind: 'list' },
  CADRE_ENABLE_RELAY: { path: 'network.enableRelay', kind: 'boolean' },
  CADRE_HIBERNATION_ENABLED: { path: 'hibernation.enabled', kind: 'boolean' },
  CADRE_LATENCY_HINT: { path: 'hibernation.defaultLatencyHint', kind: 'string' },
  CADRE_STRAND_WATCH_INTERVAL: { path: 'strandWatchInterval', kind: 'number' },
  // The filter may be a scalar (`all`/`none`) or a JSON object form.
  CADRE_STRAND_FILTER: { path: 'strandFilter', kind: 'strandFilter' },
  // Push credentials are a nested object (FCM/APNs blocks), which the provider injects as one
  // JSON value rather than as many dotted leaves.
  CADRE_PUSH: { path: 'push', kind: 'json' },
  CADRE_NODE_STATE_DIR: { path: 'nodeState.dir', kind: 'string' },
} as const satisfies Record<string, EnvMapping>;

/**
 * Variables CLI commands read themselves, outside the config tree. Commands read them through
 * {@link commandEnv}, whose parameter is typed by this list, so a command cannot read a variable
 * the registry lacks.
 */
export const COMMAND_ENV = [
  'CADRE_HEALTH_PORT',
  'CADRE_METRICS_PORT',
  'CADRE_ADMIN_PORT',
  'CADRE_OWNER_KEYS',
  'CADRE_SEED_TOKEN',
  'CADRE_STARTUP_TOKEN',
  'CADRE_CLAIM_SECRET',
] as const;

export type CommandEnvName = (typeof COMMAND_ENV)[number];

export function commandEnv(name: CommandEnvName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[name];
}

/**
 * Read by launchers around the CLI, never by the CLI: the systemd unit (`CADRE_CONFIG`) and the
 * Docker entrypoint (`CADRE_CONFIG_FILE`, `CADRE_DEBUG`). They reach the node's environment, so
 * their presence is not an error.
 */
const LAUNCHER_ENV = ['CADRE_CONFIG', 'CADRE_CONFIG_FILE', 'CADRE_DEBUG'] as const;

/**
 * Retired variables, each with the message saying what replaced it.
 *
 * NOTE: transitional, like the retired identity keys in `schema.ts` — an entry is deletable once
 * no launcher in circulation still exports the variable; after that the unknown-variable check
 * rejects it on its own, only without naming the replacement.
 */
const RETIRED_ENV = new Map<string, string>([
  [
    'CADRE_IDENTITY_PROTOBUF',
    'set CADRE_KEY_FILE instead (same libp2p protobuf key file, no file change needed)',
  ],
]);

const KNOWN_ENV: readonly string[] = [...Object.keys(ENV_MAPPINGS), ...COMMAND_ENV, ...LAUNCHER_ENV];

const ENV_PREFIX = 'CADRE_';

/**
 * cadre-host's own settings (`CADRE_HOST_DATA_DIR`, `CADRE_HOST_PORT`, `CADRE_HOST_UPDATE_*`). A
 * shell or unit that runs both programs may carry them, so the node skips them. cadre-host strips
 * every `CADRE_*` variable from the nodes it spawns, so those never see them either way.
 */
const HOST_PREFIX = 'CADRE_HOST_';

/**
 * Reject every set `CADRE_*` variable that is retired or unknown, in one `Error` listing each.
 * Names under `CADRE_HOST_` are cadre-host's and are skipped, and so is a set-but-empty value
 * (`specifiedEnv`), which the overrides skip too.
 */
export function checkEnvNames(env: NodeJS.ProcessEnv): void {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || name.startsWith(HOST_PREFIX) || specifiedEnv(value) === undefined) continue;
    const problem = nameProblem(name);
    if (problem !== undefined) problems.push(problem);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

function nameProblem(name: string): string | undefined {
  const replacement = RETIRED_ENV.get(name);
  if (replacement !== undefined) {
    return `Environment variable ${name} is no longer supported — ${replacement}`;
  }
  if (KNOWN_ENV.includes(name)) return undefined;
  const nearest = nearestKey(name, KNOWN_ENV);
  return `Unknown environment variable ${name}${nearest ? ` (did you mean ${nearest}?)` : ''}`;
}

// ---------------------------------------------------------------------------
// Value parsing — one parser per kind; `value` is never empty (see specifiedEnv)
// ---------------------------------------------------------------------------

const PARSERS: Record<EnvKind, EnvOverride['parse']> = {
  string: (value) => value,
  list: parseListEnv,
  boolean: parseBooleanEnv,
  number: parseNumberEnv,
  strandFilter: parseStrandFilterText,
  json: parseJsonObject,
};

/** {@link ENV_MAPPINGS} with each kind resolved to its parser, in the form `applyEnvOverrides` takes. */
export const ENV_OVERRIDES: Readonly<Record<string, EnvOverride>> = Object.fromEntries(
  Object.entries(ENV_MAPPINGS).map(([name, { path, kind }]) => [name, { path, parse: PARSERS[kind] }]),
);

/**
 * A JSON object, checked for shape only; the validator checks its keys. The value is never
 * echoed: `CADRE_PUSH` carries private keys.
 */
function parseJsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid ${name}: not valid JSON (expected a JSON object)`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${name}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
