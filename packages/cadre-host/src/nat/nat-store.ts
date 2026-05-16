import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import { NatError, type NatDdnsSettings, type NatSettingsFile } from './types.js';

const log = debug('cadre:host:nat-store');

const FILE_VERSION = 1;

/** Default port (libp2p TCP default). */
const DEFAULT_PORT = 4001;

/** Default DDNS update interval (5 minutes). */
const DEFAULT_DDNS_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Atomic JSON store for `nat.json`. Mirrors `TrustCircleStore` — write to
 * `<path>.tmp`, then rename.
 *
 * Concurrency assumption: only one cadre-host process owns a given rootDir.
 */
export class NatStore {
  private readonly path: string;
  private cache: NatSettingsFile | null = null;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'nat.json');
  }

  filePath(): string {
    return this.path;
  }

  /** Load (with caching). A missing file returns defaults. */
  load(): NatSettingsFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = defaultSettings();
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new NatError(
        'storage_error',
        `failed to read nat file at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new NatError(
        'storage_error',
        `nat file at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isNatSettingsFile(parsed)) {
      throw new NatError(
        'storage_error',
        `nat file at ${this.path} has unexpected shape`,
      );
    }
    this.cache = parsed;
    return this.cache;
  }

  /** Persist current settings atomically. */
  save(state: NatSettingsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const next: NatSettingsFile = { ...state, version: FILE_VERSION };
    const payload = JSON.stringify(next, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, { encoding: 'utf8' });
    renameSync(tmp, this.path);
    this.cache = next;
    log('saved nat.json (port=%d, ddns=%s) to %s',
      next.externalPort,
      next.ddns.providerId ?? '(none)',
      this.path);
  }

  /** Patch and persist (validation lives here). */
  update(patch: Partial<Omit<NatSettingsFile, 'version'>>): NatSettingsFile {
    const current = this.load();
    const merged: NatSettingsFile = {
      ...current,
      ...patch,
      ddns: { ...current.ddns, ...(patch.ddns ?? {}) },
      version: FILE_VERSION,
    };
    validate(merged);
    this.save(merged);
    return merged;
  }
}

function defaultSettings(): NatSettingsFile {
  return {
    version: FILE_VERSION,
    externalPort: DEFAULT_PORT,
    internalPort: DEFAULT_PORT,
    upnpEnabled: true,
    ddns: defaultDdns(),
  };
}

function defaultDdns(): NatDdnsSettings {
  return {
    providerId: null,
    hostname: null,
    externallyManaged: false,
    intervalMs: DEFAULT_DDNS_INTERVAL_MS,
  };
}

function isNatSettingsFile(v: unknown): v is NatSettingsFile {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (typeof obj.externalPort !== 'number' || typeof obj.internalPort !== 'number') return false;
  if (typeof obj.upnpEnabled !== 'boolean') return false;
  const ddns = obj.ddns as Record<string, unknown> | undefined;
  if (!ddns || typeof ddns !== 'object') return false;
  if (ddns.providerId !== null && typeof ddns.providerId !== 'string') return false;
  if (ddns.hostname !== null && typeof ddns.hostname !== 'string') return false;
  if (typeof ddns.externallyManaged !== 'boolean') return false;
  if (typeof ddns.intervalMs !== 'number') return false;
  return true;
}

function validate(s: NatSettingsFile): void {
  if (!Number.isInteger(s.externalPort) || s.externalPort < 1 || s.externalPort > 65535) {
    throw new NatError('invalid_config', `externalPort must be 1-65535, got ${s.externalPort}`);
  }
  if (!Number.isInteger(s.internalPort) || s.internalPort < 1 || s.internalPort > 65535) {
    throw new NatError('invalid_config', `internalPort must be 1-65535, got ${s.internalPort}`);
  }
  if (!Number.isFinite(s.ddns.intervalMs) || s.ddns.intervalMs < 1000) {
    throw new NatError(
      'invalid_config',
      `ddns.intervalMs must be >= 1000ms, got ${s.ddns.intervalMs}`,
    );
  }
  if (s.ddns.providerId !== null && s.ddns.providerId.length === 0) {
    throw new NatError('invalid_config', 'ddns.providerId must be a non-empty string or null');
  }
  if (s.ddns.hostname !== null && s.ddns.hostname.length === 0) {
    throw new NatError('invalid_config', 'ddns.hostname must be a non-empty string or null');
  }
}
