priority: 3
description: Platform push delivery for cadre-core — a PushNotifier abstraction with FCM (HTTP v1) and APNs (HTTP/2) implementations, credential config surface, the shared strand-wake payload contract re-homed into core, and unregistered-token detection
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/push-notifier.ts (new), packages/cadre-core/src/push-notifier-fcm.ts (new), packages/cadre-core/src/push-notifier-apns.ts (new), packages/cadre-core/src/strand-wake-payload.ts (new), packages/cadre-core/test/push-notifier.spec.ts (new), packages/reference-app-rn/src/push-wake.ts, docs/architecture.md, docs/STATUS.md
----

This is the **delivery** half of server-side push-wake: given a resolved mobile peer token, send the `strand-wake` data message over the right platform channel (FCM for Android, APNs for iOS). It owns no policy — *who* to wake and *when* is the fan-out ticket (`cadre-push-fanout`, which depends on this). Keeping delivery a standalone, transport-injected module lets it be unit-tested with no network and no node, exactly as `device-token.ts` is.

## Why this lives in cadre-core (placement decision, resolved)

The always-on node that participates in strands and will host the fan-out is a **`cadre-cli` child process** (`HostProcessOrchestrator` spawns `cadre-cli start …`; cadre-host/cadre-provider never run a `CadreNode` in-process — they orchestrate child node processes and talk to them over the admin channel). So the push sender must live where the participating `CadreNode` lives: **cadre-core**, credential-injected via `CadreNodeConfig`. cadre-host/provider's only role is provisioning credentials into the spawned node's config (`cadre-host-push-credentials`). A `PushNotifier` abstraction (credentials injected, transport injected) is the reusable unit; the fan-out ticket constructs it inside `CadreNode.start()` when push credentials are configured.

## The shared payload contract moves into core

`STRAND_WAKE_TYPE` + `StrandWakePayload` currently live in `packages/reference-app-rn/src/push-wake.ts` (the receive side, which declared itself "the single source of truth"). The sender must not depend on the RN app, and core is the natural home for a wire contract. **Move** the `STRAND_WAKE_TYPE` constant and `StrandWakePayload` interface into a new `packages/cadre-core/src/strand-wake-payload.ts`, export them from `cadre-core`'s `index.ts`, and have the RN `push-wake.ts` import them from `@serfab/cadre-core` and re-export for its own callers/tests (the defensive `parseStrandWakePayload` parser stays in the RN app — it is receive-side). This de-dups the contract across the send/receive boundary, as the receive ticket anticipated ("the sender imports this type rather than re-declaring it").

## Interfaces

```ts
// strand-wake-payload.ts (canonical contract, send + receive agree on this)
export const STRAND_WAKE_TYPE = 'strand-wake';
export interface StrandWakePayload {
  type: typeof STRAND_WAKE_TYPE;
  strandId: string;
  reason: string;
}

// push-notifier.ts
export interface PushMessage {
  /** The resolved DeviceToken.token for the target peer. */
  token: string;
  /** Which channel — selects FCM vs APNs. */
  platform: PushPlatform;          // existing type: 'fcm' | 'apns'
  payload: StrandWakePayload;      // { type:'strand-wake', strandId, reason }
}

export type PushSendResult =
  | { ok: true }
  | { ok: false; unregistered: boolean; error: string };

/**
 * Sends one strand-wake data message to one device. `unregistered: true` means
 * the platform reported the token is permanently invalid (FCM 404 UNREGISTERED /
 * 400 INVALID_ARGUMENT on the token; APNs 410 Unregistered / 400 BadDeviceToken)
 * — the caller (fan-out) should expire the stale DeviceToken. Any other failure
 * is `unregistered: false` and is treated as best-effort/transient (no retry storm).
 * `send` never throws for a delivery failure — failures are values, mirroring
 * `ServiceWakeResult`/`resolveDeviceToken`'s no-throw conventions.
 */
export interface PushNotifier {
  send(msg: PushMessage): Promise<PushSendResult>;
  /** Release transport resources (e.g. the APNs HTTP/2 session). */
  close(): Promise<void>;
}
```

`createPushNotifier(creds, deps?)` returns a router that dispatches by `msg.platform` to an `FcmPushNotifier` and/or `ApnsPushNotifier`, constructing only the implementations whose credentials are present. A `send` for a platform with no configured credentials returns `{ ok: false, unregistered: false, error: 'no <platform> credentials' }` (best-effort, not a throw).

### Credential config surface (added to `CadreNodeConfig`)

```ts
export interface PushCredentials {
  fcm?: FcmCredentials;
  apns?: ApnsCredentials;
}

/** Google service-account fields needed for FCM HTTP v1 OAuth2. */
export interface FcmCredentials {
  projectId: string;     // → POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
  clientEmail: string;   // service-account email (JWT iss/sub)
  privateKey: string;    // service-account RSA private key, PEM
}

/** Apple APNs auth-key (.p8) fields. */
export interface ApnsCredentials {
  keyId: string;         // APNs key id (JWT header kid)
  teamId: string;        // Apple team id (JWT iss)
  bundleId: string;      // app bundle id → apns-topic header
  privateKey: string;    // .p8 ES256 private key, PEM
  production?: boolean;  // true → api.push.apple.com, false/undefined → api.sandbox.push.apple.com
}
```

Add `push?: PushCredentials` to `CadreNodeConfig`. cadre-cli already loads `cadre.json` into a `CadreNodeConfig`, so a `push` block in that file flows through with no cadre-cli change; `cadre-host-push-credentials` writes that block. **No secret is logged** (treat `privateKey` like the existing startup/seed tokens).

## FCM implementation (HTTP v1)

The legacy server-key/`fcm.googleapis.com/fcm/send` API is deprecated; use **HTTP v1**:

- **Auth**: mint a Google OAuth2 access token. Sign a JWT (RS256, `crypto.sign('RSA-SHA256', …, privateKey)`) with `iss=clientEmail`, `aud=https://oauth2.googleapis.com/token`, `scope=https://www.googleapis.com/auth/firebase.messaging`, `iat`/`exp` (≤1h). Exchange it at `https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`). **Cache** the access token until shortly before `expires_in`; re-mint on demand.
- **Send**: `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`, bearer the access token, body `{ message: { token, data: { type, strandId, reason }, android: { priority: 'high' } } }`. FCM `data` values are strings already (the payload fields are strings) — high priority so Doze delivers it.
- **Result mapping**: 200 → `{ ok: true }`. 404 (`UNREGISTERED`) or 400 whose error names the registration token (`INVALID_ARGUMENT`/`registration-token-not-registered`) → `{ ok:false, unregistered:true }`. Everything else → `{ ok:false, unregistered:false, error }`.

## APNs implementation (HTTP/2)

- **Transport**: `node:http2` session to `https://api.push.apple.com:443` (or `…sandbox…` when `!production`). Keep one session open; re-establish on `goaway`/error. `close()` ends the session.
- **Auth**: provider JWT (ES256). Sign with `crypto.sign('SHA256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })` so the signature is JOSE (raw r‖s), not DER. Header `{ alg:'ES256', kid:keyId }`, claims `{ iss:teamId, iat }`. Apple requires the token be 20–60 min old; **cache** and refresh on a ~45-min cadence.
- **Send**: `POST /3/device/{token}` with headers `authorization: bearer <jwt>`, `apns-topic: bundleId`, `apns-push-type: background`, `apns-priority: 5` (background pushes **must** be 5; 10 is rejected), `apns-expiration: 0`. Body `{ aps: { 'content-available': 1 }, type, strandId, reason }`.
- **Result mapping**: `:status` 200 → `{ ok:true }`. 410 (`Unregistered`) or 400 `BadDeviceToken` → `{ ok:false, unregistered:true }`. Else → `{ ok:false, unregistered:false, error: reason }`.

## Transport injection (for tests)

Both implementations take their network call behind a tiny injected seam so unit tests assert request shape and map every documented response code without real network or credentials:
- FCM: an injected `fetch`-like `(url, init) => Promise<{ status, json(), text() }>` (default: global `fetch`).
- APNs: an injected `Http2Requester` interface `(opts) => Promise<{ status:number; body:string }>` wrapping the http2 request (default: a real-session implementation). Tests supply a fake returning canned `(status, body)` pairs.

Keep each module single-purpose and small (router / fcm / apns / payload-contract are four files), DRY the JWT-sign helpers only if both reach for the same shape (they do not — RS256 vs ES256/JOSE differ; a shared `signJwt(header, claims, key, alg)` is acceptable if it stays honest about the two algs).

## Edge cases & interactions

- **No credentials for the target platform** → `{ ok:false, unregistered:false, error }`, never a throw; fan-out treats it as a no-op delivery.
- **Token rotated between resolve and send** → platform returns unregistered; surface `unregistered:true` so fan-out can expire the row. Do not retry.
- **OAuth2 / JWT mint failure** (bad PEM, clock skew, token endpoint 5xx) → `{ ok:false, unregistered:false }`; logged once, not retried in a loop.
- **Cached access/provider token expiry mid-flight** (FCM 401 / APNs 403 `ExpiredProviderToken`) → invalidate the cache and re-mint **once**, then retry the single send; a second failure is returned as-is (no storm).
- **APNs HTTP/2 session death / GOAWAY** mid-send → re-establish the session once and retry the single request; a second failure returns `{ ok:false }`.
- **Payload field with delimiter/unicode** — `strandId`/`reason` ride as structured JSON values (FCM `data`, APNs top-level keys), not a delimited string, so no escaping concern; still cap `reason` length defensively.
- **Cross-platform build** — cadre-core targets node/browser/RN. `node:http2`/`node:crypto` are node-only; the FCM/APNs modules are server-only by construction. Confirm the imports do not break the RN/browser bundle: either keep them out of the RN entry path (the RN app imports only the payload contract + types) or guard with the same Node-only pattern `strand-instance-manager.ts` uses. Verify `@serfab/reference-app-rn` typecheck/bundle still passes after the contract move.
- **Secret hygiene** — never log `privateKey`, the minted JWTs, or full tokens; redact tokens to a short prefix in any debug line (mirror `container-token-redaction`).

## TODO

- [ ] Add `strand-wake-payload.ts` (canonical `STRAND_WAKE_TYPE` + `StrandWakePayload`); export from `index.ts`. Update RN `push-wake.ts` to import + re-export from `@serfab/cadre-core` (keep `parseStrandWakePayload` in RN). Run `@serfab/reference-app-rn` typecheck.
- [ ] Add `PushCredentials`/`FcmCredentials`/`ApnsCredentials` to `types.ts` and `push?: PushCredentials` to `CadreNodeConfig`; export the types.
- [ ] Implement `push-notifier.ts` (interface, `PushSendResult`, `createPushNotifier` router, transport-injection seams).
- [ ] Implement `push-notifier-fcm.ts` (OAuth2 JWT mint + cache, HTTP v1 send, result mapping).
- [ ] Implement `push-notifier-apns.ts` (ES256 JWT mint + cache, HTTP/2 send, result mapping, session lifecycle + `close()`).
- [ ] `push-notifier.spec.ts`: with fake transports — FCM happy path (asserts URL/body/priority + bearer), FCM unregistered (404/400), FCM transient (500) no-throw, access-token cache reuse + 401 re-mint-once; APNs happy path (asserts `:path`, `apns-*` headers, `content-available`), APNs 410/400 unregistered, APNs transient, provider-JWT refresh + GOAWAY re-establish-once; router dispatch by platform + missing-credentials no-op. Assert **no secret** appears in emitted logs.
- [ ] `yarn workspace @serfab/cadre-core typecheck && yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/notifier.log`; `yarn lint` on changed files.
- [ ] Docs: `architecture.md` Wake Mechanism #5 — note the sender's FCM-HTTP-v1 / APNs-HTTP-2 delivery is implemented in cadre-core (`PushNotifier`), payload contract now homed in core; `STATUS.md` push-wake sender bullet partially checked (delivery done; fan-out/trigger pending).
