import { describe, expect, it } from 'vitest';

import { ExternalIpDetector, isPlausibleIp } from '../external-ip.js';

function makeFetchSequence(responses: Array<{ ok: boolean; body: string }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++] ?? { ok: false, body: '' };
    return {
      ok: r.ok,
      status: r.ok ? 200 : 500,
      async text() { return r.body; },
    } as unknown as Response;
  }) as typeof fetch;
}

describe('isPlausibleIp()', () => {
  it('accepts IPv4', () => {
    expect(isPlausibleIp('1.2.3.4')).toBe(true);
    expect(isPlausibleIp('255.255.255.255')).toBe(true);
  });
  it('rejects bad IPv4', () => {
    expect(isPlausibleIp('256.0.0.1')).toBe(false);
    expect(isPlausibleIp('1.2.3')).toBe(false);
  });
  it('accepts IPv6 liberally', () => {
    expect(isPlausibleIp('::1')).toBe(true);
    expect(isPlausibleIp('2001:db8::1')).toBe(true);
  });
  it('rejects junk', () => {
    expect(isPlausibleIp('not an ip')).toBe(false);
    expect(isPlausibleIp('')).toBe(false);
  });
});

describe('ExternalIpDetector', () => {
  it('returns null routerIp when no probe configured', async () => {
    const det = new ExternalIpDetector({
      fetch: makeFetchSequence([{ ok: true, body: '1.2.3.4' }]),
      publicIpUrls: ['https://example.test'],
    });
    const r = await det.detect();
    expect(r.routerIp).toBeNull();
    expect(r.publicIp).toBe('1.2.3.4');
    expect(r.cgnat).toBe(false);
  });

  it('detects CGNAT when router and public IP disagree', async () => {
    const det = new ExternalIpDetector({
      routerProbe: async () => '100.64.0.5',  // CGNAT space — fine for testing
      fetch: makeFetchSequence([{ ok: true, body: '203.0.113.10' }]),
      publicIpUrls: ['https://example.test'],
    });
    const r = await det.detect();
    expect(r.routerIp).toBe('100.64.0.5');
    expect(r.publicIp).toBe('203.0.113.10');
    expect(r.cgnat).toBe(true);
  });

  it('does NOT flag CGNAT when IPs agree', async () => {
    const det = new ExternalIpDetector({
      routerProbe: async () => '1.2.3.4',
      fetch: makeFetchSequence([{ ok: true, body: '1.2.3.4' }]),
      publicIpUrls: ['https://example.test'],
    });
    const r = await det.detect();
    expect(r.cgnat).toBe(false);
  });

  it('does NOT flag CGNAT when one probe fails', async () => {
    const det = new ExternalIpDetector({
      routerProbe: async () => '1.2.3.4',
      fetch: makeFetchSequence([{ ok: false, body: '' }]),
      publicIpUrls: ['https://example.test'],
    });
    const r = await det.detect();
    expect(r.routerIp).toBe('1.2.3.4');
    expect(r.publicIp).toBeNull();
    expect(r.cgnat).toBe(false);
  });

  it('falls through public probe URLs until one succeeds', async () => {
    const det = new ExternalIpDetector({
      fetch: makeFetchSequence([
        { ok: false, body: '' },
        { ok: true, body: '8.8.8.8' },
      ]),
      publicIpUrls: ['https://a.test', 'https://b.test'],
    });
    const r = await det.detect();
    expect(r.publicIp).toBe('8.8.8.8');
  });

  it('treats router probe throw as null', async () => {
    const det = new ExternalIpDetector({
      routerProbe: async () => { throw new Error('upnp not reachable'); },
      fetch: makeFetchSequence([{ ok: true, body: '1.2.3.4' }]),
      publicIpUrls: ['https://a.test'],
    });
    const r = await det.detect();
    expect(r.routerIp).toBeNull();
    expect(r.publicIp).toBe('1.2.3.4');
    expect(r.cgnat).toBe(false);
  });

  it('rejects implausible router-probe IP', async () => {
    const det = new ExternalIpDetector({
      routerProbe: async () => 'not-an-ip',
      fetch: makeFetchSequence([{ ok: true, body: '1.2.3.4' }]),
      publicIpUrls: ['https://a.test'],
    });
    const r = await det.detect();
    expect(r.routerIp).toBeNull();
  });

  it('rejects non-IP public-service body', async () => {
    const det = new ExternalIpDetector({
      fetch: makeFetchSequence([{ ok: true, body: '<html>error</html>' }]),
      publicIpUrls: ['https://a.test'],
    });
    const r = await det.detect();
    expect(r.publicIp).toBeNull();
  });
});
