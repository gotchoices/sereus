import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeytarSecretsStore } from '../secrets/keytar-store.js';
import { FileSecretsStore } from '../secrets/file-store.js';
import { ddnsAccount, resolveKeytarLike, type KeytarLike } from '../secrets/index.js';
import { NatError } from '../types.js';

function makeFakeKeytar(): {
  keytar: KeytarLike;
  store: Map<string, string>;
  injectThrow: (op: keyof KeytarLike, err: Error) => void;
  clearThrow: () => void;
} {
  const store = new Map<string, string>();
  const throws: Partial<Record<keyof KeytarLike, Error>> = {};
  const key = (svc: string, acct: string) => `${svc}::${acct}`;

  const keytar: KeytarLike = {
    async setPassword(svc, acct, password) {
      if (throws.setPassword) throw throws.setPassword;
      store.set(key(svc, acct), password);
    },
    async getPassword(svc, acct) {
      if (throws.getPassword) throw throws.getPassword;
      return store.get(key(svc, acct)) ?? null;
    },
    async deletePassword(svc, acct) {
      if (throws.deletePassword) throw throws.deletePassword;
      return store.delete(key(svc, acct));
    },
    async findCredentials(svc) {
      if (throws.findCredentials) throw throws.findCredentials;
      const out: Array<{ account: string; password: string }> = [];
      for (const [k, v] of store) {
        const [s, a] = k.split('::');
        if (s === svc) out.push({ account: a!, password: v });
      }
      return out;
    },
  };
  return {
    keytar,
    store,
    injectThrow: (op, err) => { throws[op] = err; },
    clearThrow: () => { for (const k of Object.keys(throws)) delete throws[k as keyof KeytarLike]; },
  };
}

describe('ddnsAccount()', () => {
  it('formats provider + field into a stable key', () => {
    expect(ddnsAccount('duckdns', 'token')).toBe('ddns:duckdns:token');
  });

  it('rejects empty inputs', () => {
    expect(() => ddnsAccount('', 'token')).toThrow(NatError);
    expect(() => ddnsAccount('duckdns', '')).toThrow(NatError);
  });
});

describe('resolveKeytarLike()', () => {
  it('unwraps the CJS-via-ESM default export shape', () => {
    const { keytar } = makeFakeKeytar();
    expect(resolveKeytarLike({ default: keytar })).toBe(keytar);
  });

  it('passes through a direct named-export shape', () => {
    const { keytar } = makeFakeKeytar();
    expect(resolveKeytarLike(keytar)).toBe(keytar);
  });

  it('returns null when the shape is missing methods', () => {
    expect(resolveKeytarLike({})).toBeNull();
    expect(resolveKeytarLike({ default: {} })).toBeNull();
  });

  it('returns null for nullish input without crashing', () => {
    expect(resolveKeytarLike(null)).toBeNull();
    expect(resolveKeytarLike(undefined)).toBeNull();
  });
});

describe('KeytarSecretsStore', () => {
  it('round-trips a credential', async () => {
    const { keytar } = makeFakeKeytar();
    const s = new KeytarSecretsStore('test-svc', keytar);
    await s.set('a', 'v1');
    expect(await s.get('a')).toBe('v1');
    expect(await s.delete('a')).toBe(true);
    expect(await s.get('a')).toBeNull();
  });

  it('lists accounts', async () => {
    const { keytar } = makeFakeKeytar();
    const s = new KeytarSecretsStore('svc-1', keytar);
    await s.set('one', 'v');
    await s.set('two', 'v');
    expect((await s.list()).sort()).toEqual(['one', 'two']);
  });

  it('wraps keytar errors as NatError(secrets_unavailable)', async () => {
    const fake = makeFakeKeytar();
    const s = new KeytarSecretsStore('svc', fake.keytar);
    fake.injectThrow('setPassword', new Error('dbus error'));
    await expect(s.set('a', 'b')).rejects.toMatchObject({ code: 'secrets_unavailable' });

    fake.clearThrow();
    fake.injectThrow('getPassword', new Error('boom'));
    await expect(s.get('a')).rejects.toMatchObject({ code: 'secrets_unavailable' });

    fake.clearThrow();
    fake.injectThrow('deletePassword', new Error('boom'));
    await expect(s.delete('a')).rejects.toMatchObject({ code: 'secrets_unavailable' });

    fake.clearThrow();
    fake.injectThrow('findCredentials', new Error('boom'));
    await expect(s.list()).rejects.toMatchObject({ code: 'secrets_unavailable' });
  });
});

describe('FileSecretsStore', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-secrets-'));
  });
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('round-trips credentials through disk', async () => {
    const s = new FileSecretsStore(tmpRoot);
    await s.set('ddns:duckdns:token', 'TOKEN');
    expect(await s.get('ddns:duckdns:token')).toBe('TOKEN');

    const reread = new FileSecretsStore(tmpRoot);
    expect(await reread.get('ddns:duckdns:token')).toBe('TOKEN');
  });

  it('lists and deletes', async () => {
    const s = new FileSecretsStore(tmpRoot);
    await s.set('a', '1');
    await s.set('b', '2');
    expect((await s.list()).sort()).toEqual(['a', 'b']);
    expect(await s.delete('a')).toBe(true);
    expect(await s.delete('a')).toBe(false);
    expect(await s.list()).toEqual(['b']);
  });

  it('returns null for unknown account', async () => {
    const s = new FileSecretsStore(tmpRoot);
    expect(await s.get('nope')).toBeNull();
  });

  it('throws on malformed file rather than silently wiping', async () => {
    const s = new FileSecretsStore(tmpRoot);
    await s.set('a', '1');
    writeFileSync(s.filePath(), 'not json', 'utf8');
    await expect(s.list()).rejects.toBeInstanceOf(NatError);
  });

  it.runIf(process.platform !== 'win32')('writes secrets file with mode 0600', async () => {
    const s = new FileSecretsStore(tmpRoot);
    await s.set('a', '1');
    expect(existsSync(s.filePath())).toBe(true);
    const mode = statSync(s.filePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('persists version field', async () => {
    const s = new FileSecretsStore(tmpRoot);
    await s.set('a', '1');
    const raw = JSON.parse(readFileSync(s.filePath(), 'utf8'));
    expect(raw.version).toBe(1);
  });
});
