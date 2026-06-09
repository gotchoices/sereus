/**
 * Configuration validation helpers.
 */

import type { AuthConfig, ProviderPushConfig, PushCredentials } from './types.js';

/**
 * Throws when the auth configuration would silently run the provider fully
 * open. Mode 'none' disables authentication and grants every caller a wildcard
 * identity, so it must be explicitly acknowledged via `allowInsecureNoAuth`.
 */
export function validateAuthConfig(auth: AuthConfig): void {
  if (auth.mode === 'none' && auth.allowInsecureNoAuth !== true) {
    throw new Error(
      "auth.mode 'none' disables authentication and runs fully open. " +
        'Set auth.allowInsecureNoAuth=true (or PROVIDER_ALLOW_INSECURE_NO_AUTH=true) ' +
        "to acknowledge, or use 'api-key'/'oauth'."
    );
  }
}

/**
 * Throws when any configured push-credential set is partial — a present platform
 * block must carry all its required fields. Validates the provider-level default
 * and every per-tenant override so a misconfig fails fast at provider start
 * (`loadConfig`) rather than at the first push attempt.
 *
 * (Mirrors `@serfab/cadre-core`'s `validatePushCredentials`; re-implemented here
 * to keep the provider's config layer free of a cadre-core runtime dependency.)
 */
export function validatePushConfig(push: ProviderPushConfig | undefined): void {
  if (!push) return;
  const errors: string[] = [];
  if (push.default) errors.push(...credErrors('push.default', push.default));
  for (const [customerId, creds] of Object.entries(push.tenants ?? {})) {
    errors.push(...credErrors(`push.tenants.${customerId}`, creds));
  }
  if (errors.length > 0) {
    throw new Error(`Invalid push configuration: ${errors.join('; ')}`);
  }
}

/** Per-set field-presence check for a single tenant/default credential bundle. */
function credErrors(path: string, creds: PushCredentials): string[] {
  const errors: string[] = [];
  if (creds.fcm) {
    errors.push(...missing(`${path}.fcm`, creds.fcm as unknown as Record<string, unknown>, ['projectId', 'clientEmail', 'privateKey']));
  }
  if (creds.apns) {
    errors.push(...missing(`${path}.apns`, creds.apns as unknown as Record<string, unknown>, ['keyId', 'teamId', 'bundleId', 'privateKey']));
  }
  return errors;
}

function missing(path: string, obj: Record<string, unknown>, required: string[]): string[] {
  return required
    .filter((f) => typeof obj[f] !== 'string' || (obj[f] as string).trim().length === 0)
    .map((f) => `${path}.${f} is required when that platform block is present`);
}

const REDACTED = '[redacted]';

/**
 * Return a log-safe copy of a push config with every private key replaced. Use
 * before any debug dump — `privateKey` fields are secrets and must never be logged.
 */
export function redactPushConfig(push: ProviderPushConfig): ProviderPushConfig {
  const out: ProviderPushConfig = {};
  if (push.default) out.default = redactCreds(push.default);
  if (push.tenants) {
    out.tenants = Object.fromEntries(
      Object.entries(push.tenants).map(([id, creds]) => [id, redactCreds(creds)]),
    );
  }
  return out;
}

function redactCreds(creds: PushCredentials): PushCredentials {
  const out: PushCredentials = {};
  if (creds.fcm) out.fcm = { ...creds.fcm, privateKey: REDACTED };
  if (creds.apns) out.apns = { ...creds.apns, privateKey: REDACTED };
  if (creds.cooldownMs !== undefined) out.cooldownMs = creds.cooldownMs;
  if (creds.debounceMs !== undefined) out.debounceMs = creds.debounceMs;
  return out;
}
