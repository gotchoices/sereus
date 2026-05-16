import { describe, expect, it } from 'vitest';

import { duckDnsProvider } from '../ddns/duckdns.js';
import { NatError } from '../types.js';

function makeFetch(responses: Array<{ ok: boolean; status?: number; body: string }>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const r = responses[i++] ?? { ok: false, body: '' };
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? 'OK' : 'Server Error',
      async text() { return r.body; },
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('duckDnsProvider', () => {
  it('exposes metadata', () => {
    expect(duckDnsProvider.id).toBe('duckdns');
    expect(duckDnsProvider.displayName).toBe('DuckDNS');
    expect(duckDnsProvider.configFields).toHaveLength(1);
    expect(duckDnsProvider.configFields[0]).toMatchObject({ key: 'token', secret: true });
  });

  it('OK response → resolves', async () => {
    const f = makeFetch([{ ok: true, body: 'OK' }]);
    await expect(
      duckDnsProvider.update({ token: 'T' }, 'foo.duckdns.org', '1.2.3.4', { fetch: f.fetch }),
    ).resolves.toBeUndefined();
    expect(f.calls[0]).toContain('domains=foo');
    expect(f.calls[0]).toContain('token=T');
    expect(f.calls[0]).toContain('ip=1.2.3.4');
  });

  it('KO response → throws ddns_update_failed', async () => {
    const f = makeFetch([{ ok: true, body: 'KO' }]);
    await expect(
      duckDnsProvider.update({ token: 'T' }, 'foo', '1.2.3.4', { fetch: f.fetch }),
    ).rejects.toMatchObject({ code: 'ddns_update_failed' });
  });

  it('HTTP error → throws ddns_update_failed', async () => {
    const f = makeFetch([{ ok: false, status: 503, body: '' }]);
    await expect(
      duckDnsProvider.update({ token: 'T' }, 'foo', '1.2.3.4', { fetch: f.fetch }),
    ).rejects.toMatchObject({ code: 'ddns_update_failed' });
  });

  it('strips trailing .duckdns.org from hostname', async () => {
    const f = makeFetch([{ ok: true, body: 'OK' }]);
    await duckDnsProvider.update({ token: 'T' }, 'MyHost.DuckDNS.ORG', '1.2.3.4', { fetch: f.fetch });
    expect(f.calls[0]).toContain('domains=myhost');
  });

  it('missing token → ddns_credentials_missing', async () => {
    const f = makeFetch([]);
    await expect(
      duckDnsProvider.update({}, 'foo', '1.2.3.4', { fetch: f.fetch }),
    ).rejects.toMatchObject({ code: 'ddns_credentials_missing' });
  });

  it('empty hostname → invalid_config', async () => {
    const f = makeFetch([]);
    await expect(
      duckDnsProvider.update({ token: 'T' }, '   ', '1.2.3.4', { fetch: f.fetch }),
    ).rejects.toBeInstanceOf(NatError);
  });

  it('network error → ddns_update_failed', async () => {
    const f = (async () => { throw new Error('ENETUNREACH'); }) as typeof fetch;
    await expect(
      duckDnsProvider.update({ token: 'T' }, 'foo', '1.2.3.4', { fetch: f }),
    ).rejects.toMatchObject({ code: 'ddns_update_failed' });
  });
});
