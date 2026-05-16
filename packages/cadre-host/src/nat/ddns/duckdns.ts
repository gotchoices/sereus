import debug from 'debug';

import { NatError } from '../types.js';
import type { DdnsProvider, DdnsProviderDeps } from './index.js';

const log = debug('cadre:host:nat-ddns:duckdns');

/**
 * DuckDNS provider.
 *
 * Update API: HTTPS GET
 *   https://www.duckdns.org/update?domains=<subdomain>&token=<token>&ip=<ip>
 * Response is plain text — `OK` on success, `KO` on failure.
 *
 * `hostname` may be supplied as the bare subdomain (`foo`) or the FQDN
 * (`foo.duckdns.org`); we strip the suffix.
 */
export const duckDnsProvider: DdnsProvider = {
  id: 'duckdns',
  displayName: 'DuckDNS',
  configFields: [
    { key: 'token', label: 'DuckDNS token', secret: true },
  ],
  async update(
    config: Record<string, string>,
    hostname: string,
    ip: string,
    deps: DdnsProviderDeps,
  ): Promise<void> {
    const token = config['token'];
    if (!token) {
      throw new NatError('ddns_credentials_missing', 'DuckDNS requires a `token` config value');
    }
    const subdomain = stripSuffix(hostname);
    if (!subdomain) {
      throw new NatError('invalid_config', `DuckDNS hostname must be a valid subdomain (got: "${hostname}")`);
    }

    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(subdomain)}&token=${encodeURIComponent(token)}&ip=${encodeURIComponent(ip)}`;
    log('DuckDNS update %s → %s', subdomain, ip);

    let res: Response;
    try {
      res = await deps.fetch(url);
    } catch (err) {
      throw new NatError(
        'ddns_update_failed',
        `DuckDNS request failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new NatError(
        'ddns_update_failed',
        `DuckDNS HTTP ${res.status}: ${res.statusText}`,
      );
    }
    const text = (await res.text()).trim();
    if (text !== 'OK') {
      throw new NatError(
        'ddns_update_failed',
        `DuckDNS returned "${text || '(empty)'}" (expected "OK")`,
      );
    }
  },
};

const SUFFIX = '.duckdns.org';

function stripSuffix(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  if (trimmed.endsWith(SUFFIX)) {
    return trimmed.slice(0, -SUFFIX.length);
  }
  return trimmed;
}
