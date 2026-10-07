import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import {
  NatError,
  type ManualForward,
  type ManualForwardPatch,
  type NatDdnsSettings,
  type NatSettingsFile,
  type PortKind,
} from './types.js';
import { isDnsHostname } from './address-resolver.js';

const log = debug('cadre:host:nat-store');

const FILE_VERSION = 1;

/** Default DDNS update interval (5 minutes). */
const DEFAULT_DDNS_INTERVAL_MS = 5 * 60 * 1000;

const PORT_KINDS: ReadonlyArray<PortKind> = ['tcp', 'ws'];

/**
 * Atomic JSON store for `nat.json` — write to `<path>.tmp`, then rename.
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
    const settings = fromParsed(parsed);
    if (!settings) {
      throw new NatError(
        'storage_error',
        `nat file at ${this.path} has unexpected shape`,
      );
    }
    this.cache = settings;
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
    log('saved nat.json (upnp=%s, forwards=%d, ddns=%s) to %s',
      next.upnpEnabled,
      Object.keys(next.forwards).length,
      next.ddns.providerId ?? '(none)',
      this.path);
  }

  /** Patch and persist (validation lives here). `forwards` is edited through `setForward`. */
  update(patch: Partial<Omit<NatSettingsFile, 'version' | 'forwards'>>): NatSettingsFile {
    const current = this.load();
    const merged: NatSettingsFile = {
      ...current,
      ...patch,
      ddns: { ...current.ddns, ...(patch.ddns ?? {}) },
      forwards: current.forwards,
      version: FILE_VERSION,
    };
    validate(merged);
    this.save(merged);
    return merged;
  }

  /**
   * Apply a manual-forward patch for one node: a number sets that port's
   * external port, `null` clears it, an absent key leaves it alone. An entry
   * with no ports left is removed.
   */
  setForward(nodeId: string, patch: ManualForwardPatch): NatSettingsFile {
    const current = this.load();
    const next: ManualForward = { ...(current.forwards[nodeId] ?? {}) };
    for (const kind of PORT_KINDS) {
      const value = patch[kind];
      if (value === undefined) continue;
      if (value === null) delete next[kind];
      else next[kind] = value;
    }
    const forwards = { ...current.forwards };
    if (Object.keys(next).length === 0) delete forwards[nodeId];
    else forwards[nodeId] = next;
    const merged: NatSettingsFile = { ...current, forwards };
    validate(merged);
    this.save(merged);
    return merged;
  }

  /** Drop a node's manual forward entry. No-op (no write) when there is none. */
  deleteForward(nodeId: string): NatSettingsFile {
    const current = this.load();
    if (!(nodeId in current.forwards)) return current;
    const forwards = { ...current.forwards };
    delete forwards[nodeId];
    const merged: NatSettingsFile = { ...current, forwards };
    this.save(merged);
    return merged;
  }
}

function defaultSettings(): NatSettingsFile {
  return {
    version: FILE_VERSION,
    upnpEnabled: true,
    forwards: {},
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

/**
 * Build the settings from the known fields of a parsed file, or null when the
 * shape is wrong. Unknown fields — including the `externalPort`/`internalPort`
 * an older build wrote — are dropped, so the next save removes them.
 */
function fromParsed(v: unknown): NatSettingsFile | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return null;
  if (typeof obj.upnpEnabled !== 'boolean') return null;
  const ddns = obj.ddns as Record<string, unknown> | undefined;
  if (!ddns || typeof ddns !== 'object') return null;
  if (ddns.providerId !== null && typeof ddns.providerId !== 'string') return null;
  if (ddns.hostname !== null && typeof ddns.hostname !== 'string') return null;
  if (typeof ddns.externallyManaged !== 'boolean') return null;
  if (typeof ddns.intervalMs !== 'number') return null;
  const forwards = parseForwards(obj.forwards);
  if (!forwards) return null;
  return {
    version: FILE_VERSION,
    upnpEnabled: obj.upnpEnabled,
    forwards,
    ddns: {
      providerId: ddns.providerId as string | null,
      hostname: ddns.hostname as string | null,
      externallyManaged: ddns.externallyManaged,
      intervalMs: ddns.intervalMs,
    },
  };
}

/** `forwards` is absent in a file written before manual forwards existed; that reads as none. */
function parseForwards(v: unknown): Record<string, ManualForward> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, ManualForward> = {};
  for (const [nodeId, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') return null;
    const rec = entry as Record<string, unknown>;
    const forward: ManualForward = {};
    for (const kind of PORT_KINDS) {
      if (rec[kind] === undefined) continue;
      if (typeof rec[kind] !== 'number') return null;
      forward[kind] = rec[kind];
    }
    out[nodeId] = forward;
  }
  return out;
}

function validate(s: NatSettingsFile): void {
  for (const [nodeId, forward] of Object.entries(s.forwards)) {
    if (nodeId.length === 0) {
      throw new NatError('invalid_config', 'a manual forward needs a node id');
    }
    for (const kind of PORT_KINDS) {
      const port = forward[kind];
      if (port === undefined) continue;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new NatError('invalid_config', `${kind} forward for ${nodeId} must be 1-65535, got ${port}`);
      }
    }
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
  if (s.ddns.hostname !== null && !isDnsHostname(s.ddns.hostname)) {
    throw new NatError('invalid_config', `ddns.hostname must be a DNS name such as foo.duckdns.org or null, got "${s.ddns.hostname}"`);
  }
}
