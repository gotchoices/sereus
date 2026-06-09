/**
 * push-notifier-apns.ts — APNs HTTP/2 strand-wake delivery.
 *
 * Server-only: signs a provider JWT (ES256, JOSE raw r‖s via `node:crypto`) and
 * sends a background data push over an HTTP/2 session to Apple's gateway.
 *
 * The HTTP/2 call is behind an injected `Http2Requester` seam (bundled with a
 * `close` into an {@link ApnsTransport}) so unit tests assert the request shape
 * and map every documented response code with no real network and no credentials.
 * The default transport owns a single lazily-(re)established `node:http2` session.
 *
 * Two single-shot retries guard transient failure without a retry storm: a
 * thrown transport error (session death / GOAWAY mid-send) re-establishes the
 * session and retries the one request once; a 403 `ExpiredProviderToken`
 * re-mints the provider JWT and retries once. A second failure is returned as-is.
 *
 * Secret hygiene: the `.p8` `privateKey`, the minted JWT, and full device tokens
 * are never logged — failure log lines carry only a status/reason and a redacted
 * token prefix.
 */

import { sign } from 'node:crypto';
import * as http2 from 'node:http2';
import debug from 'debug';
import type { ApnsCredentials } from './types.js';
import type { PushMessage, PushNotifier, PushSendResult } from './push-notifier.js';
import { MAX_REASON_LEN, b64urlJson, errText, redact } from './push-notifier-shared.js';

const APNS_PROD_HOST = 'https://api.push.apple.com';
const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
/** Apple requires the provider token be 20–60 min old; refresh well inside that. */
const PROVIDER_TOKEN_TTL_MS = 45 * 60_000;

const debugApns = debug('sereus:cadre:push:apns');

/** Raw HTTP/2 response: APNs `:status` and the (possibly empty) JSON body. */
export interface ApnsResponse {
  status: number;
  body: string;
}

/** A single APNs HTTP/2 request — `:path`, headers, and the JSON body. */
export interface ApnsRequest {
  /** `:path`, e.g. `/3/device/{token}`. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Low-level HTTP/2 request seam. Resolves with the `(status, body)` pair; rejects
 * (throws) on a session/transport failure so the caller can re-establish + retry.
 */
export type Http2Requester = (req: ApnsRequest) => Promise<ApnsResponse>;

/** The HTTP/2 request seam plus its session-teardown. */
export interface ApnsTransport {
  request: Http2Requester;
  close(): Promise<void>;
}

export interface ApnsPushDeps {
  /** HTTP/2 transport. Defaults to a real `node:http2` session manager. */
  transport?: ApnsTransport;
  /** Monotonic clock (ms). Defaults to `Date.now`. Injected for token-cache tests. */
  now?: () => number;
  /** Failure log seam (default: `debug('sereus:cadre:push:apns')`). */
  log?: (line: string) => void;
}

/** A cached provider JWT and the wall-clock ms after which to refresh it. */
interface CachedProviderToken {
  value: string;
  expiresAt: number;
}

export function createApnsPushNotifier(creds: ApnsCredentials, deps: ApnsPushDeps = {}): PushNotifier {
  const host = creds.production ? APNS_PROD_HOST : APNS_SANDBOX_HOST;
  const transport = deps.transport ?? createHttp2Transport(host);
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => debugApns(line));

  let cached: CachedProviderToken | null = null;

  async function send(msg: PushMessage): Promise<PushSendResult> {
    let jwt: string;
    try {
      jwt = providerToken(false);
    } catch (err) {
      log(`provider-token mint failed: ${errText(err)}`);
      return { ok: false, unregistered: false, error: `apns jwt mint failed: ${errText(err)}` };
    }

    let res = await tryRequest(msg, jwt);
    if (!res) return { ok: false, unregistered: false, error: `apns transport failed (token=${redact(msg.token)})` };

    // Provider token expired mid-flight — re-mint once and retry the single send.
    if (res.status === 403 && /ExpiredProviderToken/i.test(res.body)) {
      try {
        jwt = providerToken(true);
      } catch (err) {
        log(`provider-token re-mint failed: ${errText(err)}`);
        return { ok: false, unregistered: false, error: `apns jwt re-mint failed: ${errText(err)}` };
      }
      res = await tryRequest(msg, jwt);
      if (!res) return { ok: false, unregistered: false, error: `apns transport failed (token=${redact(msg.token)})` };
    }
    return mapResult(res, msg.token);
  }

  /**
   * Send one request with a single re-establish-on-throw retry. A thrown error is
   * a session death / GOAWAY; the default transport recreates its session lazily
   * on the next call, so a second attempt rides a fresh session. Returns `null`
   * when both attempts throw.
   */
  async function tryRequest(msg: PushMessage, jwt: string): Promise<ApnsResponse | null> {
    const req = buildRequest(msg, jwt);
    try {
      return await transport.request(req);
    } catch (err1) {
      log(`http2 request failed, re-establishing once: ${errText(err1)}`);
      try {
        return await transport.request(req);
      } catch (err2) {
        log(`http2 request failed after re-establish: ${errText(err2)}`);
        return null;
      }
    }
  }

  function mapResult(res: ApnsResponse, deviceToken: string): PushSendResult {
    if (res.status === 200) return { ok: true };
    const reason = apnsReason(res.body);
    const summary = `apns ${res.status}${reason ? ` ${reason}` : ''}`;
    if (res.status === 410 || reason === 'Unregistered' || (res.status === 400 && reason === 'BadDeviceToken')) {
      log(`unregistered token=${redact(deviceToken)} (${summary})`);
      return { ok: false, unregistered: true, error: summary };
    }
    log(`send failed token=${redact(deviceToken)} (${summary})`);
    return { ok: false, unregistered: false, error: summary };
  }

  function buildRequest(msg: PushMessage, jwt: string): ApnsRequest {
    const body = JSON.stringify({
      aps: { 'content-available': 1 },
      type: msg.payload.type,
      strandId: msg.payload.strandId,
      reason: msg.payload.reason.slice(0, MAX_REASON_LEN),
    });
    return {
      path: `/3/device/${msg.token}`,
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': creds.bundleId,
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-expiration': '0',
      },
      body,
    };
  }

  function providerToken(forceRefresh: boolean): string {
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value;
    const iat = Math.floor(now() / 1000);
    const header = { alg: 'ES256', kid: creds.keyId };
    const claims = { iss: creds.teamId, iat };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const sig = sign('SHA256', Buffer.from(signingInput), {
      key: creds.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const jwt = `${signingInput}.${sig}`;
    cached = { value: jwt, expiresAt: now() + PROVIDER_TOKEN_TTL_MS };
    return jwt;
  }

  async function close(): Promise<void> {
    cached = null;
    await transport.close();
  }

  return { send, close };
}

/**
 * Default {@link ApnsTransport}: a single lazily-(re)established `node:http2`
 * session to Apple's gateway. A session that errors / receives GOAWAY / closes is
 * dropped so the next request re-establishes it. Not exercised by unit tests (no
 * network) — tests inject a fake transport; the real path is validated out-of-band.
 */
function createHttp2Transport(host: string): ApnsTransport {
  let session: http2.ClientHttp2Session | null = null;

  function ensureSession(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    const s = http2.connect(host);
    // Drop a dead session so ensureSession recreates it on the next request.
    s.on('error', () => { if (session === s) session = null; });
    s.on('goaway', () => { s.destroy(); });
    s.on('close', () => { if (session === s) session = null; });
    session = s;
    return s;
  }

  async function request(req: ApnsRequest): Promise<ApnsResponse> {
    const s = ensureSession();
    return await new Promise<ApnsResponse>((resolve, reject) => {
      const stream = s.request({ ':method': 'POST', ':path': req.path, ...req.headers });
      const chunks: Buffer[] = [];
      let status = 0;
      stream.on('response', (headers) => { status = Number(headers[':status'] ?? 0); });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', (err) => reject(err));
      stream.end(req.body);
    });
  }

  async function close(): Promise<void> {
    const s = session;
    session = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  return { request, close };
}

/** Extract the APNs error `reason` field from a response body, if present. */
function apnsReason(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}
