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

describe('NatStore', () => {
  it('returns defaults when file is missing', () => {
    const store = new NatStore(tmpRoot);
    const s = store.load();
    expect(s.externalPort).toBe(4001);
    expect(s.internalPort).toBe(4001);
    expect(s.upnpEnabled).toBe(true);
    expect(s.ddns.providerId).toBeNull();
    expect(s.ddns.externallyManaged).toBe(false);
    expect(s.ddns.intervalMs).toBe(5 * 60 * 1000);
  });

  it('persists and reloads settings atomically', () => {
    const store = new NatStore(tmpRoot);
    store.update({ externalPort: 4002, upnpEnabled: false });

    expect(existsSync(join(tmpRoot, 'nat.json'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'nat.json.tmp'))).toBe(false);

    const reread = new NatStore(tmpRoot);
    const s = reread.load();
    expect(s.externalPort).toBe(4002);
    expect(s.upnpEnabled).toBe(false);
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

  it('persists version field', () => {
    const store = new NatStore(tmpRoot);
    store.update({ externalPort: 4001 });
    const raw = JSON.parse(readFileSync(join(tmpRoot, 'nat.json'), 'utf8'));
    expect(raw.version).toBe(1);
  });

  it('throws on malformed JSON rather than silently wiping', () => {
    writeFileSync(join(tmpRoot, 'nat.json'), 'not json', 'utf8');
    const store = new NatStore(tmpRoot);
    expect(() => store.load()).toThrow(NatError);
  });

  it('rejects invalid port', () => {
    const store = new NatStore(tmpRoot);
    expect(() => store.update({ externalPort: 0 })).toThrow(NatError);
    expect(() => store.update({ externalPort: 70000 })).toThrow(NatError);
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
