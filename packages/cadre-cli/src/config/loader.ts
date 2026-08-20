import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import debug from 'debug';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { StrandFilter } from '@serfab/cadre-core';
import { validatePushCredentials } from '@serfab/cadre-core';
import type { CliConfigFile, ResolvedConfig} from './types.js';
import { ENV_MAPPINGS } from './types.js';

const log = debug('cadre:cli:config');

/**
 * Load configuration from a YAML or JSON file
 */
export async function loadConfigFile(configPath: string): Promise<CliConfigFile> {
  const fullPath = path.resolve(configPath);
  log('Loading config from: %s', fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const ext = path.extname(fullPath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(content) as CliConfigFile;
  } else if (ext === '.json') {
    return JSON.parse(content);
  } else {
    // Try YAML first, fall back to JSON
    try {
      return yaml.load(content) as CliConfigFile;
    } catch {
      return JSON.parse(content);
    }
  }
}

/**
 * Apply environment variable overrides to config
 */
export function applyEnvironmentOverrides(config: CliConfigFile): CliConfigFile {
  rejectRetiredIdentityEnv();
  const result = { ...config };

  for (const [envVar, configPath] of Object.entries(ENV_MAPPINGS)) {
    const value = process.env[envVar];
    // An empty value means "not specified" — a docker-compose default like
    // `${CADRE_ENABLE_RELAY:-}` must leave the config file's value (or the
    // profile default) alone rather than forcing false / [] / etc.
    if (value === undefined || value.trim() === '') continue;

    log('Applying env override: %s=%s', envVar, value);
    setNestedValue(result, configPath, parseEnvValue(envVar, value));
  }

  return result;
}

function parseEnvValue(envVar: string, value: string): unknown {
  // Handle array values (comma-separated)
  // NOTE: a separators-only value (e.g. `,`) survives the loop's empty check but
  // yields [], clobbering the file's list. If that shape ever shows up in a real
  // launcher, treat an all-empty split as unspecified here too.
  if (envVar.endsWith('_NODES') || envVar.endsWith('_ADDRS')) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Handle boolean values
  if (envVar.includes('_ENABLED') || envVar.includes('_RELAY')) {
    return value.toLowerCase() === 'true' || value === '1';
  }
  // The strand filter may be a scalar (`all`/`none`) or a JSON object form,
  // so it needs dedicated parsing rather than passing the raw string through.
  if (envVar === 'CADRE_STRAND_FILTER') {
    return parseStrandFilterEnv(value);
  }
  // Push credentials are a nested object (FCM/APNs blocks). The provider injects
  // them as a single JSON env var — the same explicit-encoding precedent the
  // `_NODES`/`_ADDRS`/strand-filter vars set — rather than as many dotted leaves.
  if (envVar === 'CADRE_PUSH') {
    return parsePushEnv(value);
  }
  return value;
}

/**
 * Parse the `CADRE_PUSH` environment value into a `PushCredentials` object.
 *
 * The value MUST be a JSON object (e.g. `{"fcm":{...},"apns":{...}}`) — the
 * override loop already skips empty values, so a call here is always
 * non-empty. A value that fails to parse throws — a misconfigured push block
 * must fail loudly at start, not silently disable wake delivery.
 */
function parsePushEnv(value: string): unknown {
  const trimmed = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Invalid CADRE_PUSH: expected a JSON object (e.g. {"fcm":{...}} / {"apns":{...}})`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid CADRE_PUSH: expected a JSON object, got ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

/**
 * Parse the `CADRE_STRAND_FILTER` environment value into the shape
 * {@link parseStrandFilter} expects. The override loop already skips empty
 * values, so a call here is always non-empty.
 *
 * Bare `all`/`none` (case-insensitive, trimmed) are kept as scalar strings.
 * Object filters must be supplied as **JSON** — e.g. `{"sAppId":"myapp"}` or
 * `{"strandId":"<id>"}` — mirroring the explicit encoding precedent of the
 * `_NODES`/`_ADDRS` vars. A `{`-leading value that fails to parse throws,
 * rather than degrading to a raw string that {@link parseStrandFilter} would
 * later reject.
 */
function parseStrandFilterEnv(value: string): unknown {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'all' || lower === 'none') return lower;

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    if (trimmed.startsWith('{')) {
      throw new Error(
        `Invalid CADRE_STRAND_FILTER ${JSON.stringify(value)}: expected JSON object ` +
        `(e.g. {"sAppId":"myapp"} or {"strandId":"<id>"})`,
        { cause: err },
      );
    }
    // Any other unrecognized scalar passes through for parseStrandFilter to
    // reject loudly with the full list of accepted forms.
    return trimmed;
  }
}

/**
 * Write `value` at a dotted path, copying each intermediate object on the way
 * down. {@link applyEnvironmentOverrides} only shallow-copies its input, so
 * writing straight through would mutate the caller's own nested objects (e.g. a
 * shared `network` block) rather than only the returned config.
 */
function setNestedValue(obj: Record<string, unknown>, pathStr: string, value: unknown): void {
  const parts = pathStr.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    current[parts[i]] = cloneBranch(current[parts[i]]);
    current = current[parts[i]] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/** Shallow-copy an intermediate config object, replacing any non-object with a fresh one. */
function cloneBranch(existing: unknown): Record<string, unknown> {
  return existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing as Record<string, unknown> }
    : {};
}

/**
 * Load the node identity from a libp2p protobuf-encoded private key file.
 *
 * This is the ONE on-disk identity format: what `cadre enroll create` writes, what cadre-host's
 * installer writes to `identity.key`, and what the docker entrypoint mints into `cadre-peer.key`.
 * See `@serfab/cadre-host`'s `installer/identity.ts` for why the protobuf form rather than raw
 * key bytes.
 */
export function loadIdentityKey(keyPath: string): PrivateKey {
  const fullPath = path.resolve(keyPath);
  log('Loading identity key from: %s', fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Identity key file not found: ${fullPath}`);
  }

  const bytes = fs.readFileSync(fullPath);
  try {
    // NOTE: no fallback decoder here, deliberately. `privateKeyFromRaw` accepts ANY 64 bytes as an
    // Ed25519 key without validating them, so a truncated protobuf used to decode as a *different,
    // valid* identity and the node came up under a PeerId nobody expected.
    // NOTE: this catches structural damage only. A single flipped byte INSIDE the 64-byte payload
    // still decodes, and still yields a different PeerId, because the payload carries no checksum.
    // Closing that needs a recorded peer id to verify against —
    // backlog/debt-identity-key-file-has-no-integrity-check.
    return privateKeyFromProtobuf(new Uint8Array(bytes));
  } catch (err) {
    throw new Error(
      `Invalid identity key file ${fullPath}: not a libp2p protobuf-encoded private key. ` +
      `Regenerate it with 'cadre enroll create', or point identity.keyFile at the correct file.`,
      { cause: err },
    );
  }
}

/** The only key the `identity` block accepts. Anything else is a typo or a retired name. */
const IDENTITY_KEYS = new Set(['keyFile']);

// NOTE: transitional — this map exists only to give old configs a pointed error instead of a
// generic "unknown key". Safe to delete once no config in circulation names either key; the
// IDENTITY_KEYS allowlist above is the permanent guard and must stay.
const RETIRED_IDENTITY_KEYS = new Map<string, string>([
  ['protobufKeyFile', "renamed to 'keyFile' — same libp2p protobuf format, no file change needed"],
  ['privateKeyHex', "removed — write the key to a file ('cadre enroll create') and set 'keyFile'"],
]);

/**
 * Reject anything in the `identity` block that is not the one accepted key.
 *
 * {@link loadConfigFile} is a bare `yaml.load(...) as CliConfigFile` cast — there is no schema
 * validation anywhere — so a retired or merely misspelled key (`keyfile`, `keyPath`) would resolve
 * to *no identity at all*, and the node would silently generate a fresh keypair and come up as a
 * stranger to its own cadre. Fail loudly instead. Whole-config validation is
 * `backlog/debt-cli-config-file-has-no-schema-validation`.
 */
function validateIdentityBlock(identity: unknown, configPath: string): void {
  if (identity === undefined || identity === null) return;
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(
      `Invalid identity block in ${configPath}: expected an object with a 'keyFile' entry`,
    );
  }

  for (const key of Object.keys(identity)) {
    if (IDENTITY_KEYS.has(key)) continue;
    const retired = RETIRED_IDENTITY_KEYS.get(key);
    throw new Error(
      retired
        ? `Config ${configPath}: identity.${key} is no longer supported — ${retired}`
        : `Config ${configPath}: unknown key identity.${key} — the identity block accepts only 'keyFile'`,
    );
  }
}

/**
 * Reject the retired `CADRE_IDENTITY_PROTOBUF` env var by name.
 *
 * It mapped to `identity.protobufKeyFile`, which no longer exists. Silently ignoring it would
 * leave a launcher that still sets it starting the node with no identity — a fresh keypair and a
 * new PeerId, the exact failure this collapse exists to close.
 */
function rejectRetiredIdentityEnv(): void {
  const retired = process.env.CADRE_IDENTITY_PROTOBUF;
  if (retired !== undefined && retired.trim() !== '') {
    throw new Error(
      `CADRE_IDENTITY_PROTOBUF is no longer supported — set CADRE_KEY_FILE instead ` +
      `(same libp2p protobuf key file, no file change needed)`,
    );
  }
}

/**
 * Parse a strand filter (from a config file or an env override) into a
 * {@link StrandFilter}.
 *
 * This is the single validation point for both env-driven and file-loaded
 * configs, so it takes `unknown`: env overrides inject already-parsed JSON
 * ahead of the narrow {@link CliConfigFile} type. Accepted forms are `all`,
 * `none`, `{ sAppId }`, and `{ strandId }` (each object carrying exactly one
 * discriminant with a non-empty string value). Anything else throws — a
 * misconfigured node must refuse to start rather than silently over-subscribe
 * to every strand.
 */
export function parseStrandFilter(filter: unknown): StrandFilter {
  if (filter === undefined || filter === null || filter === 'all') return { mode: 'all' };
  if (filter === 'none') return { mode: 'none' };
  if (typeof filter === 'object') {
    const obj = filter as Record<string, unknown>;
    const sAppId = obj.sAppId;
    const strandId = obj.strandId;
    const hasSAppId = sAppId !== undefined;
    const hasStrandId = strandId !== undefined;
    if (hasSAppId && !hasStrandId && typeof sAppId === 'string' && sAppId.length > 0) {
      return { mode: 'sAppId', sAppId };
    }
    if (hasStrandId && !hasSAppId && typeof strandId === 'string' && strandId.length > 0) {
      return { mode: 'strandId', strandId };
    }
  }
  throw new Error(
    `Invalid strandFilter ${JSON.stringify(filter)}: expected "all", "none", ` +
    `{"sAppId":"..."}, or {"strandId":"..."} (object forms carry exactly one ` +
    `non-empty string discriminant)`,
  );
}

/**
 * Validate a resolved push block before it reaches `CadreNode.start`.
 *
 * The provisioners (cadre-host's secret store, cadre-provider's per-tenant config)
 * already reject a partial set, but the cli is the common sink for *both* a
 * file-config `push` block and the `CADRE_PUSH` env override — a hand-edited
 * `cadre.json` or a partial env value would otherwise build a notifier that only
 * fails at the first push. Fail fast at start instead, using cadre-core's shared
 * validator (the dependency-free seam built for exactly this).
 */
function validateResolvedPush(push: CliConfigFile['push']): void {
  if (!push) return;
  const errors = validatePushCredentials(push);
  if (errors.length > 0) {
    throw new Error(`Invalid push credentials: ${errors.join('; ')}`);
  }
}

/**
 * Resolve configuration: load file, apply env overrides, load keys
 */
export async function resolveConfig(configPath: string): Promise<ResolvedConfig> {
  const fullConfigPath = path.resolve(configPath);
  let fileConfig = await loadConfigFile(configPath);
  fileConfig = applyEnvironmentOverrides(fileConfig);
  validateIdentityBlock(fileConfig.identity, fullConfigPath);
  validateResolvedPush(fileConfig.push);

  // Node-local state (bootstrap-peer store, trusted-owner anchor) lives in an
  // explicit directory when configured, else defaults to the directory holding
  // the config file — every launcher already writes a per-node config into
  // that node's own working directory, so that default is node-specific
  // regardless of how the node's identity is sourced.
  const nodeStateDir = fileConfig.nodeState?.dir
    ? path.resolve(fileConfig.nodeState.dir)
    : path.dirname(fullConfigPath);

  // Load the node identity if one is configured. One key, one format — an absent `keyFile` means
  // "no identity configured" (CadreNode generates an ephemeral keypair); a present-but-undecodable
  // one throws rather than degrading to that, since a silent regeneration is a new PeerId.
  const privateKey: PrivateKey | undefined = fileConfig.identity?.keyFile
    ? loadIdentityKey(fileConfig.identity.keyFile)
    : undefined;

  return {
    privateKey,
    nodeStateDir,
    controlNetwork: fileConfig.controlNetwork,
    profile: fileConfig.profile,
    strandFilter: parseStrandFilter(fileConfig.strandFilter),
    storage: fileConfig.storage,
    network: fileConfig.network,
    hibernation: fileConfig.hibernation,
    strandWatchInterval: fileConfig.strandWatchInterval,
    push: fileConfig.push,
  };
}

