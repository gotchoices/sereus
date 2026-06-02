import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import debug from 'debug';
import { privateKeyFromRaw, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { StrandFilter } from '@serfab/cadre-core';
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
    if (value === undefined) continue;

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
  return value;
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
 * Parse strand filter from config format to StrandFilter type
 */
export function parseStrandFilter(filter: CliConfigFile['strandFilter']): StrandFilter {
  if (!filter || filter === 'all') return { mode: 'all' };
  if (filter === 'none') return { mode: 'none' };
  if (typeof filter === 'object') {
    if ('sAppId' in filter) return { mode: 'sAppId', sAppId: filter.sAppId };
    if ('strandId' in filter) return { mode: 'strandId', strandId: filter.strandId };
  }
  return { mode: 'all' };
}

/**
 * Resolve configuration: load file, apply env overrides, load keys
 */
export async function resolveConfig(configPath: string): Promise<ResolvedConfig> {
  let fileConfig = await loadConfigFile(configPath);
  fileConfig = applyEnvironmentOverrides(fileConfig);

  // Load private key if specified. The protobuf identity (installer-written
  // `identity.key`) takes precedence, then a raw/hex key file, then inline hex.
  let privateKey: PrivateKey | undefined;
  if (fileConfig.identity?.protobufKeyFile) {
    privateKey = loadProtobufPrivateKey(fileConfig.identity.protobufKeyFile);
  } else if (fileConfig.identity?.keyFile) {
    privateKey = privateKeyFromRaw(await loadPrivateKey(fileConfig.identity.keyFile));
  } else if (fileConfig.identity?.privateKeyHex) {
    privateKey = privateKeyFromRaw(Buffer.from(fileConfig.identity.privateKeyHex, 'hex'));
  }

  return {
    privateKey,
    controlNetwork: fileConfig.controlNetwork,
    profile: fileConfig.profile,
    strandFilter: parseStrandFilter(fileConfig.strandFilter),
    storage: fileConfig.storage,
    network: fileConfig.network,
    hibernation: fileConfig.hibernation,
    strandWatchInterval: fileConfig.strandWatchInterval,
  };
}

