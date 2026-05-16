import { NatError, type DdnsConfigField } from '../types.js';
import { duckDnsProvider } from './duckdns.js';

/** Per-provider runtime dependencies (fetch override for tests). */
export interface DdnsProviderDeps {
  fetch: typeof fetch;
}

/**
 * DDNS provider interface. Each provider knows:
 *   - Its display name + the fields needed to configure it (which fields are
 *     secrets vs. plain config goes into the SecretsStore / nat.json split).
 *   - How to push an IP update to the provider's API.
 *
 * v1 ships DuckDNS only. New providers drop in by exporting a `DdnsProvider`
 * and adding an entry to `BUILTIN_PROVIDERS`.
 */
export interface DdnsProvider {
  readonly id: string;
  readonly displayName: string;
  readonly configFields: ReadonlyArray<DdnsConfigField>;
  /** Push `ip` for `hostname`. Throws NatError(ddns_update_failed) on failure. */
  update(
    config: Record<string, string>,
    hostname: string,
    ip: string,
    deps: DdnsProviderDeps,
  ): Promise<void>;
}

/** Built-in DDNS providers. */
export const BUILTIN_PROVIDERS: Readonly<Record<string, DdnsProvider>> = {
  duckdns: duckDnsProvider,
};

/** Look up a provider by ID, throwing NatError(ddns_provider_unknown) if missing. */
export function getProvider(providerId: string): DdnsProvider {
  const p = BUILTIN_PROVIDERS[providerId];
  if (!p) {
    throw new NatError(
      'ddns_provider_unknown',
      `Unknown DDNS provider: ${providerId}. Built-in: ${Object.keys(BUILTIN_PROVIDERS).join(', ')}`,
    );
  }
  return p;
}

/** List all built-in providers. */
export function listProviders(): DdnsProvider[] {
  return Object.values(BUILTIN_PROVIDERS);
}

export { duckDnsProvider } from './duckdns.js';
export { DdnsUpdater } from './updater.js';
export type { DdnsUpdaterOptions, DdnsUpdateOutcome } from './updater.js';
