import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import debug from 'debug';
import { privateKeyFromRaw, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
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

function setNestedValue(obj: Record<string, unknown>, pathStr: string, value: unknown): void {
  const parts = pathStr.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Load private key from file
 */
export async function loadPrivateKey(keyPath: string): Promise<Uint8Array> {
  const fullPath = path.resolve(keyPath);
  log('Loading private key from: %s', fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Key file not found: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath);
  // If it looks like hex, decode it
  const text = content.toString('utf-8').trim();
  if (/^[0-9a-fA-F]+$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  // Otherwise return raw bytes
  return new Uint8Array(content);
}

/**
 * Decode private-key bytes into a libp2p {@link PrivateKey}, accepting both the
 * protobuf form and a bare raw key.
 *
 * `cadre enroll create` writes `privateKeyToProtobuf(...)` (which carries the
 * key-type tag and therefore begins with the protobuf field-1 tag `0x08`),
 * while older/hand-made key files may hold the raw key bytes. Try the protobuf
 * decoder first (the documented `enroll create` output) and fall back to raw —
 * this is what lets a `keyFile` produced by `enroll create` actually start a
 * node (previously `privateKeyFromRaw` threw `No decoder for tag 8` on it).
 */
function decodePrivateKey(bytes: Uint8Array): PrivateKey {
  try {
    return privateKeyFromProtobuf(bytes);
  } catch {
    return privateKeyFromRaw(bytes);
  }
}

/**
 * Load a libp2p protobuf-encoded private key from disk.
 *
 * This is the format cadre-host's installer writes to `identity.key`
 * (`privateKeyToProtobuf`). Unlike {@link loadPrivateKey} (which expects
 * hex-or-raw seed bytes), the protobuf form carries the key-type tag and is
 * decoded with `privateKeyFromProtobuf`.
 */
export function loadProtobufPrivateKey(keyPath: string): PrivateKey {
  const fullPath = path.resolve(keyPath);
  log('Loading protobuf identity key from: %s', fullPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Identity key file not found: ${fullPath}`);
  }

  const bytes = fs.readFileSync(fullPath);
  return privateKeyFromProtobuf(new Uint8Array(bytes));
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
  let fileConfig = await loadConfigFile(configPath);
  fileConfig = applyEnvironmentOverrides(fileConfig);
  validateResolvedPush(fileConfig.push);

  // Node-local state (bootstrap-peer store, trusted-owner anchor) lives in an
  // explicit directory when configured, else defaults to the directory holding
  // the config file — every launcher already writes a per-node config into
  // that node's own working directory, so that default is node-specific
  // regardless of how the node's identity is sourced.
  const nodeStateDir = fileConfig.nodeState?.dir
    ? path.resolve(fileConfig.nodeState.dir)
    : path.dirname(path.resolve(configPath));

  // Load private key if specified. The protobuf identity (installer-written
  // `identity.key`) takes precedence, then a raw/hex key file, then inline hex.
  let privateKey: PrivateKey | undefined;
  if (fileConfig.identity?.protobufKeyFile) {
    privateKey = loadProtobufPrivateKey(fileConfig.identity.protobufKeyFile);
  } else if (fileConfig.identity?.keyFile) {
    privateKey = decodePrivateKey(await loadPrivateKey(fileConfig.identity.keyFile));
  } else if (fileConfig.identity?.privateKeyHex) {
    privateKey = decodePrivateKey(Buffer.from(fileConfig.identity.privateKeyHex, 'hex'));
  }

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

