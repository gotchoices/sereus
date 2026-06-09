/**
 * push-notifier-fcm.ts — FCM HTTP v1 strand-wake delivery.
 *
 * Server-only: mints a Google OAuth2 access token (RS256 JWT bearer grant signed
 * with `node:crypto`) and POSTs a data message to the FCM v1 endpoint. The legacy
 * server-key `fcm.googleapis.com/fcm/send` API is deprecated, so we use HTTP v1.
 *
 * The network call is behind an injected `fetch`-like seam so unit tests assert
 * the request shape and map every documented response code with no real network
 * and no credentials. Failures are returned as {@link PushSendResult} values.
 *
 * Secret hygiene: the service-account `privateKey`, the minted JWT, and full
 * device tokens are never logged — failure log lines carry only a status/error
 * code and a redacted token prefix.
 */

import { sign } from 'node:crypto';
import debug from 'debug';
import type { FcmCredentials } from './types.js';
import type { PushMessage, PushNotifier, PushSendResult } from './push-notifier.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Re-mint the access token this many ms before its stated expiry. */
const TOKEN_REFRESH_SKEW_MS = 60_000;
/** OAuth2 access tokens are short-lived (≤1h); assume 1h when unstated. */
const DEFAULT_TOKEN_TTL_MS = 3_600_000;
/** Defensive cap on the free-form `reason` carried in the data payload. */
const MAX_REASON_LEN = 256;

const debugFcm = debug('sereus:cadre:push:fcm');

/** Minimal `fetch` Response shape the FCM sender consumes. */
export interface FcmResponseLike {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Injected `fetch`-like transport (default: global `fetch`). */
export type FcmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FcmResponseLike>;

export interface FcmPushDeps {
  /** Network transport. Defaults to global `fetch`. */
  fetch?: FcmFetch;
  /** Monotonic clock (ms). Defaults to `Date.now`. Injected for cache tests. */
  now?: () => number;
  /** Failure log seam (default: `debug('sereus:cadre:push:fcm')`). */
  log?: (line: string) => void;
}

/** A cached OAuth2 access token and the wall-clock ms after which to re-mint. */
interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

export function createFcmPushNotifier(creds: FcmCredentials, deps: FcmPushDeps = {}): PushNotifier {
  const doFetch: FcmFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => debugFcm(line));
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`;

  let cached: CachedAccessToken | null = null;

  async function send(msg: PushMessage): Promise<PushSendResult> {
    let token: string;
    try {
      token = await accessToken(false);
    } catch (err) {
      log(`oauth mint failed: ${errText(err)}`);
      return { ok: false, unregistered: false, error: `fcm oauth mint failed: ${errText(err)}` };
    }

    const first = await postSend(msg, token);
    if (first.status !== 401) return mapResult(first, msg.token);

    // The cached access token was rejected (expired/revoked mid-flight). Re-mint
    // once and retry the single send; a second failure is returned as-is.
    let retryToken: string;
    try {
      retryToken = await accessToken(true);
    } catch (err) {
      log(`oauth re-mint failed: ${errText(err)}`);
      return { ok: false, unregistered: false, error: `fcm oauth re-mint failed: ${errText(err)}` };
    }
    return mapResult(await postSend(msg, retryToken), msg.token);
  }

  async function postSend(msg: PushMessage, token: string): Promise<{ status: number; body: string }> {
    const body = JSON.stringify({
      message: {
        token: msg.token,
        data: {
          type: msg.payload.type,
          strandId: msg.payload.strandId,
          reason: msg.payload.reason.slice(0, MAX_REASON_LEN),
        },
        android: { priority: 'high' },
      },
    });
    const res = await doFetch(sendUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    return { status: res.status, body: await safeText(res) };
  }

  function mapResult(res: { status: number; body: string }, deviceToken: string): PushSendResult {
    if (res.status === 200) return { ok: true };
    const summary = errorSummary(res.status, res.body);
    if (isUnregistered(res.status, res.body)) {
      log(`unregistered token=${redact(deviceToken)} (${summary})`);
      return { ok: false, unregistered: true, error: summary };
    }
    log(`send failed token=${redact(deviceToken)} (${summary})`);
    return { ok: false, unregistered: false, error: summary };
  }

  async function accessToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value;
    cached = null;
    const minted = await mintAccessToken();
    cached = { value: minted.value, expiresAt: now() + minted.ttlMs - TOKEN_REFRESH_SKEW_MS };
    return minted.value;
  }

  async function mintAccessToken(): Promise<{ value: string; ttlMs: number }> {
    const jwt = signOauthJwt();
    const res = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent(JWT_BEARER_GRANT)}&assertion=${encodeURIComponent(jwt)}`,
    });
    if (res.status !== 200) {
      throw new Error(`token endpoint ${res.status}: ${await safeText(res)}`);
    }
    const parsed = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== 'string') {
      throw new Error('token endpoint returned no access_token');
    }
    const ttlMs = typeof parsed.expires_in === 'number' ? parsed.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS;
    return { value: parsed.access_token, ttlMs };
  }

  function signOauthJwt(): string {
    const iat = Math.floor(now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: creds.clientEmail,
      sub: creds.clientEmail,
      scope: FCM_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat,
      exp: iat + 3600,
    };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const sig = sign('RSA-SHA256', Buffer.from(signingInput), creds.privateKey).toString('base64url');
    return `${signingInput}.${sig}`;
  }

  async function close(): Promise<void> {
    cached = null;
  }

  return { send, close };
}

/**
 * Whether an FCM v1 error response names a permanently-invalid registration
 * token: a 404 (`UNREGISTERED`), or a 400 `INVALID_ARGUMENT` whose message names
 * the registration token. A generic 400 (malformed message) is NOT unregistered.
 */
function isUnregistered(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const code = fcmErrorCode(body);
  if (code === 'UNREGISTERED') return true;
  if (code === 'INVALID_ARGUMENT' && /registration[ -]token|not a valid fcm registration/i.test(body)) return true;
  return false;
}

/** Pull the FCM `errorCode` (FcmError detail) or RPC `status` out of the body. */
function fcmErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    };
    const err = parsed.error;
    if (!err) return null;
    const detailCode = err.details?.find((d) => typeof d.errorCode === 'string')?.errorCode;
    return detailCode ?? err.status ?? null;
  } catch {
    return null;
  }
}

/** A secret-free one-line error summary (status + error code, never the token). */
function errorSummary(status: number, body: string): string {
  const code = fcmErrorCode(body);
  return code ? `fcm ${status} ${code}` : `fcm ${status}`;
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function safeText(res: FcmResponseLike): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Redact a device token to a short non-reversible prefix for debug lines. */
function redact(token: string): string {
  return token.length <= 8 ? '…' : `${token.slice(0, 6)}…`;
}
