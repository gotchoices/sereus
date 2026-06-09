import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { STRAND_WAKE_TYPE } from '../src/strand-wake-payload.js';
import type { StrandWakePayload } from '../src/strand-wake-payload.js';
import type { ApnsCredentials, FcmCredentials } from '../src/types.js';
import { createPushNotifier } from '../src/push-notifier.js';
import { createFcmPushNotifier, type FcmFetch, type FcmResponseLike } from '../src/push-notifier-fcm.js';
import {
  createApnsPushNotifier,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from '../src/push-notifier-apns.js';

// ── Test credentials (real keys so node:crypto signing succeeds) ──────────────

const { privateKey: RSA_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const { privateKey: EC_PEM } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const FCM_CREDS: FcmCredentials = {
  projectId: 'demo-project',
  clientEmail: 'sa@demo-project.iam.gserviceaccount.com',
  privateKey: RSA_PEM,
};

const APNS_CREDS: ApnsCredentials = {
  keyId: 'ABC123KEYID',
  teamId: 'TEAM123456',
  bundleId: 'com.example.app',
  privateKey: EC_PEM,
  production: true,
};

const PAYLOAD: StrandWakePayload = { type: STRAND_WAKE_TYPE, strandId: 'strand-7', reason: 'activity' };
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://fcm.googleapis.com/v1/projects/demo-project/messages:send';

// ── FCM transport fake ────────────────────────────────────────────────────────

/** Build a `FcmResponseLike` from a status + (string or JSON) body. */
function fcmRes(status: number, body: unknown): FcmResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

/**
 * A fake FCM `fetch` that returns a fixed token-endpoint response and a queue of
 * send-endpoint responses (last one repeats). Records every call for assertions.
 */
function fakeFcmFetch(opts: {
  token?: { status: number; body: unknown };
  send: Array<{ status: number; body: unknown }>;
}): { fetch: FcmFetch; calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }>; tokenCalls: number } {
  const token = opts.token ?? { status: 200, body: { access_token: 'access-tok-1', expires_in: 3600 } };
  const sendQueue = [...opts.send];
  const state = { tokenCalls: 0 };
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetch: FcmFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_ENDPOINT) {
      state.tokenCalls++;
      return fcmRes(token.status, token.body);
    }
    const next = sendQueue.length > 1 ? sendQueue.shift()! : sendQueue[0];
    return fcmRes(next.status, next.body);
  };
  return { fetch, calls, get tokenCalls() { return state.tokenCalls; } };
}

// ── APNs transport fake ───────────────────────────────────────────────────────

/**
 * A fake `ApnsTransport` whose `request` returns a queue of responses (last
 * repeats), or — when an entry is an `Error` — throws it (simulating session
 * death). Records every request for assertions.
 */
function fakeApnsTransport(responses: Array<ApnsResponse | Error>): {
  transport: ApnsTransport;
  requests: ApnsRequest[];
  closed: number;
} {
  const queue = [...responses];
  const requests: ApnsRequest[] = [];
  const state = { closed: 0 };
  const transport: ApnsTransport = {
    request: async (req) => {
      requests.push(req);
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    close: async () => { state.closed++; },
  };
  return { transport, requests, get closed() { return state.closed; } };
}

// ── FCM ───────────────────────────────────────────────────────────────────────

describe('FcmPushNotifier', () => {
  it('happy path: posts the v1 message with bearer auth, high priority, and data fields', async () => {
    const fake = fakeFcmFetch({ send: [{ status: 200, body: { name: 'projects/demo/messages/1' } }] });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch, now: () => 1_000_000 });

    const result = await notifier.send({ token: 'device-token-android-xyz', platform: 'fcm', payload: PAYLOAD });
    expect(result).toEqual({ ok: true });

    const sendCall = fake.calls.find((c) => c.url === SEND_URL);
    expect(sendCall).toBeDefined();
    expect(sendCall!.init.headers.authorization).toBe('Bearer access-tok-1');
    const body = JSON.parse(sendCall!.init.body) as {
      message: { token: string; data: Record<string, string>; android: { priority: string } };
    };
    expect(body.message.token).toBe('device-token-android-xyz');
    expect(body.message.data).toEqual({ type: 'strand-wake', strandId: 'strand-7', reason: 'activity' });
    expect(body.message.android.priority).toBe('high');
  });

  it('maps 404 UNREGISTERED to unregistered:true', async () => {
    const fake = fakeFcmFetch({
      send: [{ status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }],
    });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch });
    const result = await notifier.send({ token: 'dead-token', platform: 'fcm', payload: PAYLOAD });
    expect(result).toEqual({ ok: false, unregistered: true, error: expect.stringContaining('404') });
  });

  it('maps 400 INVALID_ARGUMENT naming the registration token to unregistered:true', async () => {
    const fake = fakeFcmFetch({
      send: [{
        status: 400,
        body: {
          error: {
            status: 'INVALID_ARGUMENT',
            message: 'The registration token is not a valid FCM registration token',
            details: [{ errorCode: 'INVALID_ARGUMENT' }],
          },
        },
      }],
    });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch });
    const result = await notifier.send({ token: 'bad-token', platform: 'fcm', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: true });
  });

  it('does NOT mark a generic 400 (malformed message) as unregistered', async () => {
    const fake = fakeFcmFetch({
      send: [{ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.android' } } }],
    });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch });
    const result = await notifier.send({ token: 'tok', platform: 'fcm', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: false });
  });

  it('maps a transient 500 to unregistered:false (no throw)', async () => {
    const fake = fakeFcmFetch({ send: [{ status: 500, body: { error: { status: 'INTERNAL' } } }] });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch });
    const result = await notifier.send({ token: 'tok', platform: 'fcm', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: false });
  });

  it('caches the access token across sends (mints once)', async () => {
    const fake = fakeFcmFetch({ send: [{ status: 200, body: {} }] });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch, now: () => 5_000_000 });
    await notifier.send({ token: 't1', platform: 'fcm', payload: PAYLOAD });
    await notifier.send({ token: 't2', platform: 'fcm', payload: PAYLOAD });
    expect(fake.tokenCalls).toBe(1);
  });

  it('re-mints once on a 401 and retries the single send', async () => {
    const fake = fakeFcmFetch({ send: [{ status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }, { status: 200, body: {} }] });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch });
    const result = await notifier.send({ token: 't', platform: 'fcm', payload: PAYLOAD });
    expect(result).toEqual({ ok: true });
    expect(fake.tokenCalls).toBe(2); // initial mint + one re-mint
  });

  it('returns a transient failure (no throw) when the OAuth token endpoint fails', async () => {
    const fake = fakeFcmFetch({ token: { status: 500, body: { error: 'backend' } }, send: [{ status: 200, body: {} }] });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch });
    const result = await notifier.send({ token: 't', platform: 'fcm', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: false, error: expect.stringContaining('oauth') });
  });
});

// ── APNs ────────────────────────────────────────────────────────────────────

describe('ApnsPushNotifier', () => {
  it('happy path: POSTs /3/device/{token} with the background headers and content-available', async () => {
    const fake = fakeApnsTransport([{ status: 200, body: '' }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport, now: () => 1_000_000 });

    const result = await notifier.send({ token: 'device-token-ios-abc', platform: 'apns', payload: PAYLOAD });
    expect(result).toEqual({ ok: true });

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0];
    expect(req.path).toBe('/3/device/device-token-ios-abc');
    expect(req.headers.authorization).toMatch(/^bearer /);
    expect(req.headers['apns-topic']).toBe('com.example.app');
    expect(req.headers['apns-push-type']).toBe('background');
    expect(req.headers['apns-priority']).toBe('5');
    expect(req.headers['apns-expiration']).toBe('0');
    const body = JSON.parse(req.body) as { aps: Record<string, number>; type: string; strandId: string; reason: string };
    expect(body.aps['content-available']).toBe(1);
    expect(body).toMatchObject({ type: 'strand-wake', strandId: 'strand-7', reason: 'activity' });
  });

  it('maps 410 Unregistered to unregistered:true', async () => {
    const fake = fakeApnsTransport([{ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    const result = await notifier.send({ token: 'dead', platform: 'apns', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: true });
  });

  it('maps 400 BadDeviceToken to unregistered:true', async () => {
    const fake = fakeApnsTransport([{ status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    const result = await notifier.send({ token: 'bad', platform: 'apns', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: true });
  });

  it('maps a non-token 400 (e.g. BadTopic) to unregistered:false', async () => {
    const fake = fakeApnsTransport([{ status: 400, body: JSON.stringify({ reason: 'BadTopic' }) }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    const result = await notifier.send({ token: 'tok', platform: 'apns', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: false });
  });

  it('maps a transient 500 to unregistered:false', async () => {
    const fake = fakeApnsTransport([{ status: 500, body: '' }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    const result = await notifier.send({ token: 'tok', platform: 'apns', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: false });
  });

  it('refreshes the provider JWT on 403 ExpiredProviderToken and retries once', async () => {
    let clock = 1_000_000;
    const fake = fakeApnsTransport([
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
      { status: 200, body: '' },
    ]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport, now: () => (clock += 1000) });
    const result = await notifier.send({ token: 'tok', platform: 'apns', payload: PAYLOAD });
    expect(result).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(2);
    // The retry rode a freshly-minted JWT (clock advanced ⇒ different iat).
    expect(fake.requests[0].headers.authorization).not.toBe(fake.requests[1].headers.authorization);
  });

  it('re-establishes once on a thrown session error (GOAWAY) and retries', async () => {
    const fake = fakeApnsTransport([new Error('GOAWAY: session destroyed'), { status: 200, body: '' }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    const result = await notifier.send({ token: 'tok', platform: 'apns', payload: PAYLOAD });
    expect(result).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(2);
  });

  it('returns a transient failure when the transport throws twice', async () => {
    const fake = fakeApnsTransport([new Error('dead'), new Error('still dead')]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    const result = await notifier.send({ token: 'tok', platform: 'apns', payload: PAYLOAD });
    expect(result).toMatchObject({ ok: false, unregistered: false });
  });

  it('close() tears down the transport session', async () => {
    const fake = fakeApnsTransport([{ status: 200, body: '' }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport });
    await notifier.close();
    expect(fake.closed).toBe(1);
  });
});

// ── Router dispatch ───────────────────────────────────────────────────────────

describe('createPushNotifier (router)', () => {
  it('dispatches fcm vs apns to the matching backing implementation', async () => {
    const fcm = fakeFcmFetch({ send: [{ status: 200, body: {} }] });
    const apns = fakeApnsTransport([{ status: 200, body: '' }]);
    const notifier = createPushNotifier(
      { fcm: FCM_CREDS, apns: APNS_CREDS },
      { fcm: { fetch: fcm.fetch }, apns: { transport: apns.transport } },
    );

    await notifier.send({ token: 'a', platform: 'fcm', payload: PAYLOAD });
    expect(fcm.calls.some((c) => c.url === SEND_URL)).toBe(true);
    expect(apns.requests).toHaveLength(0);

    await notifier.send({ token: 'b', platform: 'apns', payload: PAYLOAD });
    expect(apns.requests).toHaveLength(1);
  });

  it('returns a best-effort no-op for a platform with no configured credentials', async () => {
    const fcm = fakeFcmFetch({ send: [{ status: 200, body: {} }] });
    const notifier = createPushNotifier({ fcm: FCM_CREDS }, { fcm: { fetch: fcm.fetch } });
    const result = await notifier.send({ token: 'b', platform: 'apns', payload: PAYLOAD });
    expect(result).toEqual({ ok: false, unregistered: false, error: 'no apns credentials' });
  });

  it('close() releases all configured platform transports', async () => {
    const fcm = fakeFcmFetch({ send: [{ status: 200, body: {} }] });
    const apns = fakeApnsTransport([{ status: 200, body: '' }]);
    const notifier = createPushNotifier(
      { fcm: FCM_CREDS, apns: APNS_CREDS },
      { fcm: { fetch: fcm.fetch }, apns: { transport: apns.transport } },
    );
    await notifier.close();
    expect(apns.closed).toBe(1);
  });
});

// ── Secret hygiene ────────────────────────────────────────────────────────────

describe('no secret appears in emitted logs', () => {
  it('FCM failure logs carry neither the full device token nor the private key', async () => {
    const lines: string[] = [];
    const fake = fakeFcmFetch({ send: [{ status: 500, body: { error: { status: 'INTERNAL' } } }] });
    const notifier = createFcmPushNotifier(FCM_CREDS, { fetch: fake.fetch, log: (l) => lines.push(l) });
    await notifier.send({ token: 'super-secret-fcm-device-token-0001', platform: 'fcm', payload: PAYLOAD });

    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    expect(joined).not.toContain('super-secret-fcm-device-token-0001');
    expect(joined).not.toContain(RSA_PEM);
    expect(joined).not.toContain('PRIVATE KEY');
  });

  it('APNs failure logs carry neither the full device token nor the private key', async () => {
    const lines: string[] = [];
    const fake = fakeApnsTransport([{ status: 500, body: '' }]);
    const notifier = createApnsPushNotifier(APNS_CREDS, { transport: fake.transport, log: (l) => lines.push(l) });
    await notifier.send({ token: 'super-secret-apns-device-token-0002', platform: 'apns', payload: PAYLOAD });

    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    expect(joined).not.toContain('super-secret-apns-device-token-0002');
    expect(joined).not.toContain(EC_PEM);
    expect(joined).not.toContain('PRIVATE KEY');
  });
});
