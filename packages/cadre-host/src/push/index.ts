/**
 * Push (FCM/APNs) credential storage + resolution for cadre-host.
 *
 * The platform-push secrets a self-hosted deployment provisions live in the host
 * secret store (keytar with file-store fallback — the same store DDNS tokens use);
 * the non-secret app-config bits (APNs bundle id / sandbox toggle, cooldown /
 * debounce) live in `host.config.json` (`PushSettings`). At node-spawn time the
 * orchestrator's `pushResolver` calls {@link resolvePushCredentials}, which reads
 * BOTH and merges them into the `PushCredentials` block written into the spawned
 * node's `cadre.json`.
 *
 * Secret hygiene: the FCM service-account fields and the APNs `.p8` key are stored
 * ONLY in the secret store, never in `host.config.json` and never in `state.json`.
 * They are re-read on every spawn so a restart picks up rotated keys, and the
 * resolver redacts on any log line. A partial credential set (a present platform
 * missing required fields) is rejected — fail fast, not at first push.
 */

import debug from 'debug';

import type { PushCredentials, FcmCredentials, ApnsCredentials } from '@serfab/cadre-core';
import { validatePushCredentials } from '@serfab/cadre-core';

import type { SecretsStore } from '../nat/secrets/index.js';
import type { PushSettings } from '../installer/config.js';

const log = debug('cadre:host:push');

/** Push platform whose secret bundle lives in the secret store. */
export type PushSecretPlatform = 'fcm' | 'apns';

/** Build the secret-store account key for a platform's credential bundle. */
export function pushAccount(platform: PushSecretPlatform): string {
  return `push:${platform}`;
}

/** FCM secret bundle persisted in the secret store (the whole set is sensitive). */
export interface FcmSecret {
  projectId: string;
  clientEmail: string;
  /** Service-account RSA private key, PEM. */
  privateKey: string;
}

/**
 * APNs secret bundle persisted in the secret store. `bundleId` / `production` are
 * NOT here — they are non-secret app-config in {@link PushSettings}.
 */
export interface ApnsSecret {
  keyId: string;
  teamId: string;
  /** `.p8` ES256 private key, PEM. */
  privateKey: string;
}

/** Store (or replace) the FCM service-account secret bundle. */
export async function setFcmSecret(secrets: SecretsStore, secret: FcmSecret): Promise<void> {
  await secrets.set(pushAccount('fcm'), JSON.stringify(secret));
}

/** Store (or replace) the APNs auth-key secret bundle. */
export async function setApnsSecret(secrets: SecretsStore, secret: ApnsSecret): Promise<void> {
  await secrets.set(pushAccount('apns'), JSON.stringify(secret));
}

/** Remove a platform's secret bundle. Returns true if one was present. */
export async function clearPushSecret(secrets: SecretsStore, platform: PushSecretPlatform): Promise<boolean> {
  return secrets.delete(pushAccount(platform));
}

/** Read a platform's stored secret bundle, or null when unset. */
async function readSecret<T>(secrets: SecretsStore, platform: PushSecretPlatform): Promise<T | null> {
  const raw = await secrets.get(pushAccount(platform));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Stored ${platform} push secret is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Resolve the full {@link PushCredentials} block to inject into a spawned node,
 * merging the secret-store bundles with the non-secret {@link PushSettings}.
 *
 * Returns `undefined` when NO platform is configured (push is opt-in — the node
 * then constructs no fan-out). Throws when a configured platform is incomplete
 * (e.g. APNs secret present but `bundleId` unset), so a misconfig surfaces at the
 * spawn boundary rather than silently at first push.
 */
export async function resolvePushCredentials(
  secrets: SecretsStore,
  settings: PushSettings | undefined,
): Promise<PushCredentials | undefined> {
  const fcmSecret = await readSecret<FcmSecret>(secrets, 'fcm');
  const apnsSecret = await readSecret<ApnsSecret>(secrets, 'apns');

  if (!fcmSecret && !apnsSecret) return undefined;

  const push: PushCredentials = {};
  if (fcmSecret) {
    const fcm: FcmCredentials = {
      projectId: fcmSecret.projectId,
      clientEmail: fcmSecret.clientEmail,
      privateKey: fcmSecret.privateKey,
    };
    push.fcm = fcm;
  }
  if (apnsSecret) {
    const apns: ApnsCredentials = {
      keyId: apnsSecret.keyId,
      teamId: apnsSecret.teamId,
      bundleId: settings?.apns?.bundleId ?? '',
      privateKey: apnsSecret.privateKey,
      ...(settings?.apns?.production !== undefined ? { production: settings.apns.production } : {}),
    };
    push.apns = apns;
  }
  if (settings?.cooldownMs !== undefined) push.cooldownMs = settings.cooldownMs;
  if (settings?.debounceMs !== undefined) push.debounceMs = settings.debounceMs;

  const errors = validatePushCredentials(push);
  if (errors.length > 0) {
    throw new Error(`Invalid push credentials: ${errors.join('; ')}`);
  }
  log('resolved push credentials (fcm=%s apns=%s)', !!push.fcm, !!push.apns);
  return push;
}

/**
 * A description of which push platforms are configured, for the `push status` CLI
 * and any UI — derived without exposing any secret material.
 */
export interface PushStatus {
  fcm: boolean;
  apns: boolean;
}

/** Report which platforms have a stored secret bundle (no secret material). */
export async function pushStatus(secrets: SecretsStore): Promise<PushStatus> {
  const accounts = await secrets.list();
  return {
    fcm: accounts.includes(pushAccount('fcm')),
    apns: accounts.includes(pushAccount('apns')),
  };
}
