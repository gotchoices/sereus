/**
 * push-credentials.ts — pure validation + log-redaction for {@link PushCredentials}.
 *
 * The platform-push credentials a deployment provisions (`cadre-host` from its
 * secret store, `cadre-provider` from per-tenant config) are written into a
 * spawned node's config under `CadreNodeConfig.push`. This module is the
 * dependency-free seam those provisioners share to (a) reject a *partial* set
 * before it reaches a node — a present platform block must carry all its required
 * fields, or it fails fast at provisioning rather than at first push — and (b)
 * produce a log-safe view that never leaks a private key.
 *
 * It imports only the *types* (erased at emit), so it pulls no node:crypto /
 * node:http2 edge — a provisioner can import these functions without dragging in
 * the FCM/APNs senders.
 */

import type { PushCredentials, FcmCredentials, ApnsCredentials } from './types.js';

/** Marker substituted for every secret field by {@link redactPushCredentials}. */
export const REDACTED = '[redacted]';

/**
 * Validate a resolved push-credential bundle, returning human-readable errors
 * (empty ⇒ valid). Each platform block is optional, but a *present* block must
 * carry every required field — a partial set (e.g. APNs `keyId` without
 * `privateKey`) is a misconfiguration that must surface at provisioning time, not
 * silently at the first wake. A bundle with neither platform is valid (push is
 * opt-in); callers that require at least one platform check that separately.
 */
export function validatePushCredentials(push: PushCredentials): string[] {
  const errors: string[] = [];
  if (push.fcm) errors.push(...validateFcm(push.fcm));
  if (push.apns) errors.push(...validateApns(push.apns));
  return errors;
}

function validateFcm(fcm: FcmCredentials): string[] {
  return missingFields('fcm', fcm as unknown as Record<string, unknown>, [
    'projectId',
    'clientEmail',
    'privateKey',
  ]);
}

function validateApns(apns: ApnsCredentials): string[] {
  return missingFields('apns', apns as unknown as Record<string, unknown>, [
    'keyId',
    'teamId',
    'bundleId',
    'privateKey',
  ]);
}

/** Names the required fields of `platform` that are missing or blank. */
function missingFields(platform: string, obj: Record<string, unknown>, required: string[]): string[] {
  return required
    .filter((f) => typeof obj[f] !== 'string' || (obj[f] as string).trim().length === 0)
    .map((f) => `push.${platform}.${f} is required when a ${platform} credential block is present`);
}

/**
 * Return a log-safe shallow copy of a push bundle with every private key replaced
 * by {@link REDACTED}. Use this for ANY debug/log line that touches push config —
 * `privateKey` fields are secrets and must never reach a log sink (the same rule
 * the startup/seed tokens follow).
 */
export function redactPushCredentials(push: PushCredentials): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (push.fcm) {
    out.fcm = { projectId: push.fcm.projectId, clientEmail: push.fcm.clientEmail, privateKey: REDACTED };
  }
  if (push.apns) {
    out.apns = {
      keyId: push.apns.keyId,
      teamId: push.apns.teamId,
      bundleId: push.apns.bundleId,
      ...(push.apns.production !== undefined ? { production: push.apns.production } : {}),
      privateKey: REDACTED,
    };
  }
  if (push.cooldownMs !== undefined) out.cooldownMs = push.cooldownMs;
  if (push.debounceMs !== undefined) out.debounceMs = push.debounceMs;
  return out;
}
