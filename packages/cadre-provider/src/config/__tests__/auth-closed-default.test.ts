import { describe, it, expect } from 'vitest';
import { loadConfig } from '../loader.js';
import { validateAuthConfig } from '../validate.js';
import { DEFAULT_CONFIG } from '../types.js';

/** No config file and nothing in the environment: the defaults alone. */
const NO_ENV = {};

describe('auth closed-by-default config', () => {
  it('default mode is api-key (closed), not none', () => {
    expect(DEFAULT_CONFIG.auth.mode).toBe('api-key');
    const config = loadConfig({ env: NO_ENV });
    expect(config.auth.mode).toBe('api-key');
    expect(config.auth.apiKeyHashes).toBeUndefined();
  });

  it("mode 'none' without opt-in throws from loadConfig", () => {
    expect(() => loadConfig({ env: NO_ENV, overrides: { auth: { mode: 'none' } } }))
      .toThrow(/allowInsecureNoAuth/);
  });

  it("mode 'none' with allowInsecureNoAuth override is accepted", () => {
    const config = loadConfig({ env: NO_ENV, overrides: { auth: { mode: 'none', allowInsecureNoAuth: true } } });
    expect(config.auth.mode).toBe('none');
    expect(config.auth.allowInsecureNoAuth).toBe(true);
  });

  it("PROVIDER_AUTH_MODE=none + PROVIDER_ALLOW_INSECURE_NO_AUTH=true is accepted via env", () => {
    const config = loadConfig({ env: { PROVIDER_AUTH_MODE: 'none', PROVIDER_ALLOW_INSECURE_NO_AUTH: 'true' } });
    expect(config.auth.mode).toBe('none');
    expect(config.auth.allowInsecureNoAuth).toBe(true);
  });

  it("PROVIDER_AUTH_MODE=none without the ack env var throws", () => {
    expect(() => loadConfig({ env: { PROVIDER_AUTH_MODE: 'none' } })).toThrow(/allowInsecureNoAuth/);
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
