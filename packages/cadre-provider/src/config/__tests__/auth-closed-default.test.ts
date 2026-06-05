import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../loader.js';
import { validateAuthConfig } from '../validate.js';
import { DEFAULT_CONFIG } from '../types.js';

/** Auth-related env vars that loadConfig() consults; cleared per-test for determinism. */
const AUTH_ENV_KEYS = [
  'PROVIDER_AUTH_MODE',
  'PROVIDER_ALLOW_INSECURE_NO_AUTH',
  'PROVIDER_JWKS_URI',
  'PROVIDER_ISSUER',
  'PROVIDER_AUDIENCE',
] as const;

describe('auth closed-by-default config', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of AUTH_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of AUTH_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('default mode is api-key (closed), not none', () => {
    expect(DEFAULT_CONFIG.auth.mode).toBe('api-key');
    const config = loadConfig();
    expect(config.auth.mode).toBe('api-key');
    expect(config.auth.apiKeyHashes).toBeUndefined();
  });

  it("mode 'none' without opt-in throws from loadConfig", () => {
    expect(() => loadConfig({ overrides: { auth: { mode: 'none' } } }))
      .toThrow(/allowInsecureNoAuth/);
  });

  it("mode 'none' with allowInsecureNoAuth override is accepted", () => {
    const config = loadConfig({ overrides: { auth: { mode: 'none', allowInsecureNoAuth: true } } });
    expect(config.auth.mode).toBe('none');
    expect(config.auth.allowInsecureNoAuth).toBe(true);
  });

  it("PROVIDER_AUTH_MODE=none + PROVIDER_ALLOW_INSECURE_NO_AUTH=true is accepted via env", () => {
    process.env.PROVIDER_AUTH_MODE = 'none';
    process.env.PROVIDER_ALLOW_INSECURE_NO_AUTH = 'true';
    const config = loadConfig();
    expect(config.auth.mode).toBe('none');
    expect(config.auth.allowInsecureNoAuth).toBe(true);
  });

  it("PROVIDER_AUTH_MODE=none without the ack env var throws", () => {
    process.env.PROVIDER_AUTH_MODE = 'none';
    expect(() => loadConfig()).toThrow(/allowInsecureNoAuth/);
  });

  describe('validateAuthConfig', () => {
    it("throws for mode 'none' with no ack", () => {
      expect(() => validateAuthConfig({ mode: 'none' })).toThrow(/allowInsecureNoAuth/);
    });

    it("does not throw for mode 'none' with ack", () => {
      expect(() => validateAuthConfig({ mode: 'none', allowInsecureNoAuth: true })).not.toThrow();
    });

    it('does not throw for api-key or oauth modes', () => {
      expect(() => validateAuthConfig({ mode: 'api-key' })).not.toThrow();
      expect(() => validateAuthConfig({ mode: 'oauth' })).not.toThrow();
    });
  });
});
