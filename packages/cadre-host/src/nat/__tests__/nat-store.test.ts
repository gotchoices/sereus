import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NatStore } from '../nat-store.js';
import { NatError } from '../types.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-nat-store-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function rawFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpRoot, 'nat.json'), 'utf8')) as Record<string, unknown>;
}

describe('NatStore', () => {
  it('returns defaults when file is missing', () => {
    const store = new NatStore(tmpRoot);
    const s = store.load();
    expect(s.network).toBe('auto');
    expect(s.upnpEnabled).toBe(true);
    expect(s.forwards).toEqual({});
    expect(s.ddns.providerId).toBeNull();
    expect(s.ddns.externallyManaged).toBe(false);
    expect(s.ddns.intervalMs).toBe(5 * 60 * 1000);
  });

  it('persists and reloads settings atomically', () => {
    const store = new NatStore(tmpRoot);
    store.update({ upnpEnabled: false });

    expect(existsSync(join(tmpRoot, 'nat.json'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'nat.json.tmp'))).toBe(false);

    const reread = new NatStore(tmpRoot);
    expect(reread.load().upnpEnabled).toBe(false);
    expect(rawFile().version).toBe(1);
  });

  it('loads a file written by an older build and drops its single-port fields on save', () => {
    writeFileSync(join(tmpRoot, 'nat.json'), JSON.stringify({
      version: 1,
      externalPort: 4001,
      internalPort: 4001,
      upnpEnabled: false,
      ddns: { providerId: null, hostname: null, externallyManaged: false, intervalMs: 300_000 },
    }), 'utf8');
    const store = new NatStore(tmpRoot);
    const s = store.load();
    expect(s.upnpEnabled).toBe(false);
    expect(s.forwards).toEqual({});
    expect('externalPort' in s).toBe(false);
    // Written before network modes existed: reads as `auto`.
    expect(s.network).toBe('auto');

    store.update({ upnpEnabled: true });
    const raw = rawFile();
    expect(raw.externalPort).toBeUndefined();
    expect(raw.internalPort).toBeUndefined();
    expect(raw.forwards).toEqual({});
  });

  it('merges ddns subtree on update', () => {
    const store = new NatStore(tmpRoot);
    store.update({
      ddns: {
        providerId: 'duckdns',
        hostname: 'foo.duckdns.org',
        externallyManaged: false,
        intervalMs: 60_000,
      },
    });

    store.update({ ddns: { externallyManaged: true } as never });

    const s = store.load();
    expect(s.ddns.providerId).toBe('duckdns');
    expect(s.ddns.hostname).toBe('foo.duckdns.org');
    expect(s.ddns.externallyManaged).toBe(true);
    expect(s.ddns.intervalMs).toBe(60_000);
  });

  it('setForward sets, clears and removes per-port entries', () => {
    const store = new NatStore(tmpRoot);
    expect(store.setForward('a', { tcp: 40000, ws: 40001 }).forwards).toEqual({ a: { tcp: 40000, ws: 40001 } });
    expect(store.setForward('a', { tcp: null }).forwards).toEqual({ a: { ws: 40001 } });
    expect(store.setForward('a', { ws: 40002 }).forwards).toEqual({ a: { ws: 40002 } });
    expect(store.setForward('a', { ws: null }).forwards).toEqual({});
    expect(new NatStore(tmpRoot).load().forwards).toEqual({});
  });

  it('deleteForward drops one node and leaves the rest', () => {
    const store = new NatStore(tmpRoot);
    store.setForward('a', { tcp: 40000 });
    store.setForward('b', { ws: 40001 });
    expect(store.deleteForward('a').forwards).toEqual({ b: { ws: 40001 } });
    expect(store.deleteForward('missing').forwards).toEqual({ b: { ws: 40001 } });
  });

  it('throws on malformed JSON rather than silently wiping', () => {
    writeFileSync(join(tmpRoot, 'nat.json'), 'not json', 'utf8');
    const store = new NatStore(tmpRoot);
    expect(() => store.load()).toThrow(NatError);
  });

  it('rejects an out-of-range or non-integer forwarded port', () => {
    const store = new NatStore(tmpRoot);
    expect(() => store.setForward('a', { tcp: 0 })).toThrow(NatError);
    expect(() => store.setForward('a', { ws: 70000 })).toThrow(NatError);
    expect(() => store.setForward('a', { tcp: 1.5 })).toThrow(NatError);
  });

  it('rejects too-small interval', () => {
    const store = new NatStore(tmpRoot);
    expect(() => store.update({ ddns: { intervalMs: 500 } as never })).toThrow(NatError);
  });

  it('rejects empty string providerId/hostname', () => {
    const store = new NatStore(tmpRoot);
    expect(() => store.update({ ddns: { providerId: '' } as never })).toThrow(NatError);
    expect(() => store.update({ ddns: { hostname: '' } as never })).toThrow(NatError);
  });
});
