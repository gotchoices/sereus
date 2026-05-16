import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import debug from 'debug';

import { NatError } from '../types.js';
import type { SecretsStore } from './index.js';

const log = debug('cadre:host:nat-secrets:file');

const FILE_VERSION = 1;

interface FileShape {
  version: 1;
  /** Account → secret value. */
  entries: Record<string, string>;
}

/**
 * Filesystem fallback for `SecretsStore`. Writes to `<rootDir>/nat-secrets.json`
 * with mode 0o600.
 *
 * This is NOT a substitute for the OS keychain — the file is plain JSON, only
 * protected by POSIX permissions. We use it only when keytar is unavailable
 * and the caller has been warned (see `createSecretsStore`).
 *
 * Windows: chmod is a no-op (mode bits don't apply), so the file is readable
 * by any user on the same machine. This is documented.
 */
export class FileSecretsStore implements SecretsStore {
  private readonly path: string;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.path = join(rootDir, 'nat-secrets.json');
  }

  filePath(): string {
    return this.path;
  }

  async set(account: string, value: string): Promise<void> {
    const data = this.load();
    data.entries[account] = value;
    this.save(data);
  }

  async get(account: string): Promise<string | null> {
    const data = this.load();
    return Object.prototype.hasOwnProperty.call(data.entries, account)
      ? data.entries[account]!
      : null;
  }

  async delete(account: string): Promise<boolean> {
    const data = this.load();
    if (!Object.prototype.hasOwnProperty.call(data.entries, account)) return false;
    delete data.entries[account];
    this.save(data);
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(this.load().entries);
  }

  private load(): FileShape {
    if (!existsSync(this.path)) {
      return { version: FILE_VERSION, entries: {} };
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new NatError(
        'storage_error',
        `failed to read nat-secrets file at ${this.path}: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new NatError(
        'storage_error',
        `nat-secrets file at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isFileShape(parsed)) {
      throw new NatError(
        'storage_error',
        `nat-secrets file at ${this.path} has unexpected shape`,
      );
    }
    return parsed;
  }

  private save(data: FileShape): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = JSON.stringify({ ...data, version: FILE_VERSION }, null, 2);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
    // chmod again after rename — some platforms reset perms on rename.
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.path, 0o600);
      } catch (err) {
        log('chmod 0600 on %s failed: %s', this.path, (err as Error).message);
      }
    }
  }
}

function isFileShape(v: unknown): v is FileShape {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (!obj.entries || typeof obj.entries !== 'object') return false;
  for (const val of Object.values(obj.entries as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}
