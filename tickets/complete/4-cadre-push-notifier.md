description: Platform push **delivery** for server-side push-wake — `PushNotifier` (FCM HTTP v1 + APNs HTTP/2), the `CadreNodeConfig.push` credential surface, and the strand-wake payload contract re-homed into cadre-core. Reviewed and completed.
files: packages/cadre-core/src/push-notifier.ts, packages/cadre-core/src/push-notifier-fcm.ts, packages/cadre-core/src/push-notifier-apns.ts, packages/cadre-core/src/push-notifier-shared.ts, packages/cadre-core/src/strand-wake-payload.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/push-notifier.spec.ts, packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/test/push-wake.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What shipped

The **delivery** half of server-side push-wake: given a resolved mobile peer token, send one
`strand-wake` data message over the right platform channel (FCM for Android, APNs for iOS). A
standalone, credential-injected, transport-injected module owning no policy — *who*/*when* to wake is
the downstream fan-out (`cadre-push-fanout`, ticket 4.1) and credential provisioning is
`cadre-host-push-credentials` (ticket 4.2), both already in `implement/`.

### Pieces

- **`strand-wake-payload.ts`** — canonical `STRAND_WAKE_TYPE` + `StrandWakePayload`, moved out of
  `reference-app-rn/src/push-wake.ts` into cadre-core so the sender no longer depends on the RN app.
  The RN receiver re-exports both from `@serfab/cadre-core`; the defensive `parseStrandWakePayload`
  parser stays receive-side. Exported from `index.ts` (`STRAND_WAKE_TYPE` value, `StrandWakePayload` type).
- **`push-notifier.ts`** — `PushMessage` / `PushSendResult` / `PushNotifier` and
  `createPushNotifier(creds, deps?)`: a router dispatching by `msg.platform`, constructing only the
  impls whose creds are present. An unconfigured platform returns `{ ok:false, unregistered:false,
  error:'no <platform> credentials' }` (never throws). `index.ts` re-exports **types only**, keeping
  the node-only impls out of the cross-platform graph.
- **`push-notifier-fcm.ts`** — HTTP v1: RS256 service-account JWT → cached OAuth2 access token
  (re-mint-once on 401), `POST …/v1/projects/{projectId}/messages:send`, high-priority `data` message.
  404 `UNREGISTERED` / 400 naming the registration token → `unregistered:true`; generic 400 / 5xx → transient.
- **`push-notifier-apns.ts`** — HTTP/2: cached ES256 provider JWT (JOSE r‖s via
  `dsaEncoding:'ieee-p1363'`, re-mint-once on 403 `ExpiredProviderToken`), one lazily-(re)established
  `node:http2` session (re-establish-once on GOAWAY/throw). `POST /3/device/{token}` with
  `apns-push-type:background` / `apns-priority:5` / `apns-expiration:0` / `content-available:1`.
  410 `Unregistered` / 400 `BadDeviceToken` → `unregistered:true`; else transient. `close()` ends the session.
- **`push-notifier-shared.ts`** *(added in review)* — `MAX_REASON_LEN`, `b64urlJson`, `errText`,
  `redact`, factored out of the two transport modules (see Review findings → DRY).
- **`types.ts`** — `PushCredentials` / `FcmCredentials` / `ApnsCredentials`; `push?: PushCredentials`
  on `CadreNodeConfig`. `privateKey` fields documented as secrets, never logged.

## Review findings

Reviewed adversarially against the implement diff (source `0c40d66` + docs/spec `96594c4`) read with
fresh eyes before the handoff. Aspect sweep: correctness, SPP/DRY/modularity, error handling, resource
cleanup, type safety, secret hygiene, test coverage, docs.

### Checked & green (no change)
- **Validation gate** — `@serfab/cadre-core` typecheck / lint / **build** all clean; full suite
  **416 passing** (31 files). RN `typecheck` clean and `reference-app-rn` push-wake suite **39 passing**
  (confirms the re-exported contract resolves at type + runtime). ESLint clean on every changed file.
- **Result-mapping correctness** — FCM `isUnregistered` (404, or 400 `INVALID_ARGUMENT` + a body regex
  naming the registration token) and APNs (`410` / `Unregistered` / `400 BadDeviceToken`) match the
  documented v1 / APNs error schemas; generic 400s correctly stay transient. Tests cover each branch.
- **JWT signing** — FCM RS256 and APNs ES256 with `dsaEncoding:'ieee-p1363'` (raw r‖s, the JOSE shape
  Apple requires — a DER signature would be silently rejected). Tests sign with real generated keys.
- **Token-cache lifecycle** — FCM `expiresAt = now + ttl − skew` with a `> now()` check; APNs 45-min TTL
  inside Apple's 20–60 min window. Re-mint-once-then-return-as-is — no retry storm. Covered by tests.
- **Secret hygiene** — every `log(...)` / `error:` string carries only a status + error code + redacted
  token prefix. The FCM oauth-failure path logs the *external* Google token-endpoint response body,
  which cannot contain our PEM, minted JWT, or device token. Two log-assertion tests confirm no PEM /
  `PRIVATE KEY` / full token leaks.
- **`createHttp2Transport` header ordering** — `s.request({ ':method', ':path', ...req.headers })`
  relies on `node:http2` accepting pseudo-headers ahead of regular headers in one object; object
  insertion order keeps the pseudo-headers first, which is the conventional and valid pattern.
- **`apns-expiration:0`** — intentional best-effort-now semantics (deliver-once, no store/redeliver);
  the check-in wake (hibernation mechanism 2) is the backstop. Not a defect.
- **`strandId` deliberately not length-capped** — correct: `reason` is free-form so it's bounded by
  `MAX_REASON_LEN`, but truncating `strandId` would corrupt the wake's routing key and target the wrong
  (or no) strand. Capping it would be a bug; leaving it uncapped is right. (Resolved the handoff's open
  question — no change.)
- **Unsynchronized token minting** — concurrent sends could mint a token twice (no mutex). Harmless for
  a low-rate, best-effort wake sender: minting is idempotent and a double-mint has no correctness impact.
  Not worth the lock complexity. Noted, no change.

### Found & fixed inline (minor)
- **DRY** — `b64urlJson`, `errText`, `redact`, and `MAX_REASON_LEN = 256` were byte-identical
  duplicates across `push-notifier-fcm.ts` and `push-notifier-apns.ts` (CLAUDE.md mandates DRY, and a
  single source for the security-relevant token-redaction helper is the safer factoring). Extracted to a
  new server-only `push-notifier-shared.ts` (not re-exported from the entry); both transports now import it.
- **Test coverage (error/regression paths)** — added 3 tests (22 → 25): FCM *persistent* 401 yields a
  transient failure after exactly one re-mint (no infinite re-mint loop); APNs 403 with a non-`ExpiredProviderToken`
  reason (`InvalidProviderToken`) does **not** trigger the re-mint+retry (the retry is gated on the
  reason, not the status); router with no credentials at all → every platform is a best-effort no-op and
  `close()` with no transports does not throw.

### Major findings (new tickets) — none
Downstream wiring is already ticketed and out of scope here: `cadre-push-fanout` (4.1 — *who*/*when* to
wake, constructing the notifier in `CadreNode`, expiring `unregistered` rows) and
`cadre-host-push-credentials` (4.2 — provisioning `CadreNodeConfig.push` per node) both sit in `implement/`.

### Known residual (out-of-agent, documented — not a gap in this ticket)
- **No real network is exercised.** Both default transports — FCM's `fetch` wrapper and APNs's
  `createHttp2Transport` (`node:http2` session, `error`/`goaway`/`close` handlers, stream plumbing) —
  are injected with fakes in every test. The retry/re-establish *logic* is covered at the notifier
  layer; the actual http2 session re-creation on GOAWAY, plus real FCM/APNs delivery, credential
  validity, and the on-device receive end, need paid APNs creds / `google-services.json` / a real device.
- **`fetch` availability** — FCM's default transport assumes a global `fetch`; valid on the modern Node
  the always-on `cadre-cli` child runs under. Inject `deps.fcm.fetch` for any runtime where it is absent.
