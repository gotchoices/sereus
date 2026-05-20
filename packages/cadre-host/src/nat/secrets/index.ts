import debug from 'debug';

import { NatError } from '../types.js';
import { KeytarSecretsStore } from './keytar-store.js';
import { FileSecretsStore } from './file-store.js';

const log = debug('cadre:host:nat-secrets');

/** Service name used as the keytar collection. */
export const KEYTAR_SERVICE = 'sereus-cadre-host';

/**
 * Abstract credential store. Keys are opaque to the store
 * (e.g. "ddns:duckdns:token").
 */
export interface SecretsStore {
  set(account: string, value: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export { KeytarSecretsStore, FileSecretsStore };

/**
 * Try the OS keychain (keytar) first; fall back to a 0600 JSON file in the
 * cadre-host rootDir. The fallback path is documented in `docs/cadre-host.md`.
 *
 * `keytar` is loaded via dynamic import inside a try/catch so a missing native
 * dependency never crashes package import. The same applies to runtime errors
 * (some Linux desktops have keytar installed but no DBus secret service).
 */
export async function createSecretsStore(rootDir: string): Promise<SecretsStore> {
  // First, try to load keytar.
  let keytarMod: unknown;
  try {
    keytarMod = await import('keytar');
  } catch (err) {
    log('keytar unavailable (%s); using file fallback', (err as Error).message);
    return makeFileFallback(rootDir, `keytar not installed: ${(err as Error).message}`);
  }

  // `keytar` is a CJS package; under Node's ESM interop the dynamic import
  // yields a Module Namespace whose `default` is the real `module.exports`.
  // Unwrap before handing it to KeytarSecretsStore.
  const keytar = resolveKeytarLike(keytarMod);
  if (!keytar) {
    log('keytar module loaded but API surface missing; using file fallback');
    return makeFileFallback(rootDir, 'keytar module loaded but API surface missing');
  }

  // Probe with a sentinel write — some installs load but throw at runtime.
  const ks = new KeytarSecretsStore(KEYTAR_SERVICE, keytar);
  const probeAccount = '__cadre_host_probe__';
  try {
    await ks.set(probeAccount, '1');
    await ks.delete(probeAccount);
    log('using keytar for DDNS credentials (service=%s)', KEYTAR_SERVICE);
    return ks;
  } catch (err) {
    log('keytar probe failed (%s); using file fallback', (err as Error).message);
    return makeFileFallback(rootDir, `keytar runtime error: ${(err as Error).message}`);
  }
}

/**
 * Return the first candidate in `[mod, mod.default]` that satisfies the
 * `KeytarLike` shape — or `null` if neither does. Handles the CJS-via-ESM
 * interop case where the dynamic import yields `{ default: keytar }` rather
 * than the keytar surface directly.
 */
export function resolveKeytarLike(mod: unknown): KeytarLike | null {
  const candidates: unknown[] = [mod, (mod as { default?: unknown } | null)?.default];
  for (const c of candidates) {
    if (
      c &&
      typeof (c as KeytarLike).setPassword === 'function' &&
      typeof (c as KeytarLike).getPassword === 'function' &&
      typeof (c as KeytarLike).deletePassword === 'function' &&
      typeof (c as KeytarLike).findCredentials === 'function'
    ) {
      return c as KeytarLike;
    }
  }
  return null;
}

function makeFileFallback(rootDir: string, reason: string): SecretsStore {
  const store = new FileSecretsStore(rootDir);
  // eslint-disable-next-line no-console
  console.warn(
    `[cadre-host] DDNS credentials will be stored UNENCRYPTED at ` +
    `${store.filePath()} (${reason}). Install keytar's native dependencies ` +
    `for OS keychain protection.`,
  );
  return store;
}

/** Subset of keytar's surface that KeytarSecretsStore uses. */
export interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

/** Build the keytar account key for a DDNS credential. */
export function ddnsAccount(providerId: string, fieldKey: string): string {
  if (!providerId || !fieldKey) {
    throw new NatError('invalid_config', 'providerId and fieldKey are required');
  }
  return `ddns:${providerId}:${fieldKey}`;
}
