priority: 3
description: Review the platform push **delivery** half of server-side push-wake — the `PushNotifier` abstraction (FCM HTTP v1 + APNs HTTP/2), the credential config surface on `CadreNodeConfig`, and the strand-wake payload contract re-homed from the RN app into cadre-core.
files: packages/cadre-core/src/push-notifier.ts, packages/cadre-core/src/push-notifier-fcm.ts, packages/cadre-core/src/push-notifier-apns.ts, packages/cadre-core/src/strand-wake-payload.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/push-notifier.spec.ts, packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/test/push-wake.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What landed

The **delivery** half of server-side push-wake: given a resolved mobile peer token, send one `strand-wake` data message over the right platform channel (FCM for Android, APNs for iOS). It owns no policy — *who*/*when* to wake is the downstream fan-out (`cadre-push-fanout`, which has `prereq: cadre-push-notifier`). Delivery is a standalone, credential-injected, transport-injected module unit-tested with no network and no node, exactly as `device-token.ts` is.

Note: the prior agent run was interrupted mid-ticket; the runner committed the partial work with the resume note (commit `0c40d66`). All source, types, index exports, the RN contract move, and the spec were already on disk. This resume completed the remaining items: **validation** (typecheck/test/lint, RN typecheck + RN receive-test), one **lint fix** (removed an unused `vi` import in the spec), the **cadre-core build** (so the RN app's `dist`-resolved import of the moved contract typechecks), and the **docs**.

### Pieces

- **`strand-wake-payload.ts`** (new, dependency-free) — canonical `STRAND_WAKE_TYPE` + `StrandWakePayload`, **moved out of** `reference-app-rn/src/push-wake.ts`. The RN module now imports both from `@serfab/cadre-core` and re-exports them for its own callers/tests; the defensive `parseStrandWakePayload` parser stays receive-side. Exported from `index.ts` (`STRAND_WAKE_TYPE` as a value, `StrandWakePayload` as a type).
- **`push-notifier.ts`** (new) — `PushMessage` / `PushSendResult` / `PushNotifier` interfaces and `createPushNotifier(creds, deps?)`: a router dispatching by `msg.platform` to FCM/APNs, constructing only the implementations whose creds are present. A `send` for an unconfigured platform returns `{ ok:false, unregistered:false, error:'no <platform> credentials' }` (never throws). `index.ts` re-exports **types only** (`PushNotifier`/`PushMessage`/`PushSendResult`), keeping the node-only impls out of the cross-platform graph.
- **`push-notifier-fcm.ts`** (new) — HTTP v1: RS256 service-account JWT → cached OAuth2 access token (re-mint-once on 401), `POST …/v1/projects/{projectId}/messages:send`, high-priority `data` message. Result mapping: 200→ok; 404 `UNREGISTERED` / 400 naming the registration token → `unregistered:true`; generic 400 / 5xx → transient.
- **`push-notifier-apns.ts`** (new) — HTTP/2: cached ES256 provider JWT (JOSE r‖s via `dsaEncoding:'ieee-p1363'`, re-mint-once on 403 `ExpiredProviderToken`), one lazily-(re)established `node:http2` session (re-establish-once on GOAWAY/throw). `POST /3/device/{token}` with `apns-push-type:background` / `apns-priority:5` / `apns-expiration:0` / `content-available:1`. Result mapping: 200→ok; 410 `Unregistered` / 400 `BadDeviceToken` → `unregistered:true`; else transient. `close()` ends the session.
- **`types.ts`** — `PushCredentials` / `FcmCredentials` / `ApnsCredentials` added; `push?: PushCredentials` added to `CadreNodeConfig`. cadre-cli loads `cadre.json` into a `CadreNodeConfig` unchanged, so a `push` block flows through with no cadre-cli edit. `privateKey` fields documented as secrets (never logged).

## Validation performed (this is the floor, not the ceiling)

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core build` — clean (needed so the RN app, which resolves `@serfab/cadre-core` to its built `dist/`, sees the moved contract export).
- `yarn workspace @serfab/cadre-core test` — **413 passed** (31 files), including the new **22** in `push-notifier.spec.ts`.
- `yarn workspace @serfab/reference-app-rn typecheck` — clean (fails *before* the cadre-core build with `TS2305: no exported member STRAND_WAKE_TYPE`; passes after — see "watch-outs").
- `yarn workspace @serfab/reference-app-rn test push-wake` — **39 passed**; confirms the receive-side re-export resolves at runtime, not just at type level.
- `eslint` on all changed files — clean (after removing an unused `vi` import).

### Test coverage map (`push-notifier.spec.ts`, fake transports)

- FCM: happy path (asserts `SEND_URL`, `Bearer` auth, `data` fields, `android.priority:'high'`); 404 `UNREGISTERED`→unregistered; 400 `INVALID_ARGUMENT` naming the token→unregistered; generic 400→**not** unregistered; transient 500 (no throw); access-token cache reuse (mints once across two sends); 401 re-mint-once; OAuth token-endpoint 500→transient no-throw.
- APNs: happy path (asserts `:path`, `apns-*` headers, `content-available`); 410 `Unregistered`→unregistered; 400 `BadDeviceToken`→unregistered; non-token 400 (`BadTopic`)→not unregistered; transient 500; 403 `ExpiredProviderToken` refresh+retry (asserts the retry rode a different JWT); GOAWAY thrown-error re-establish+retry; transport throws twice→transient; `close()` tears down the transport.
- Router: dispatch fcm-vs-apns to the matching impl; missing-credentials no-op; `close()` releases all configured transports.
- Secret hygiene: FCM and APNs failure-log lines contain neither the full device token nor the PEM / `PRIVATE KEY`.

## Known gaps / what the reviewer should scrutinize

- **No real network is exercised anywhere.** Both default transports — FCM's `(url, init) => fetch(url, init)` and APNs's `createHttp2Transport` (`node:http2` session: `ensureSession`, the `error`/`goaway`/`close` handlers, real stream plumbing) — are **untested**: every test injects a fake. The retry/re-establish *logic* is covered at the notifier layer (fake throws), but the actual http2 session re-creation on GOAWAY is not. Real FCM/APNs delivery, credential validity, and the on-device receive end remain **out-of-agent** validation (paid APNs creds, `google-services.json`, a real device).
- **`createHttp2Transport` request header ordering** — `s.request({ ':method', ':path', ...req.headers })` relies on `node:http2` tolerating pseudo-headers mixed with regular headers in one object. This is the conventional node:http2 pattern but is worth a second look since it's the one path with no test.
- **Wiring is not done here.** Nothing constructs a `PushNotifier` yet — `createPushNotifier` is imported by no runtime caller. Constructing it inside `CadreNode.start()` when `config.push` is present, expiring `unregistered` rows, and the trigger/fan-out policy are all owned by `cadre-push-fanout` (downstream, `prereq: cadre-push-notifier`). Don't treat the absence of `CadreNode` integration as a gap in *this* ticket.
- **`fetch` availability** — FCM's default transport assumes a global `fetch`. Fine on the Node version cadre-core runs under (the always-on node is a `cadre-cli` child process on modern Node), but confirm there's no supported runtime where the FCM default would be `undefined`.
- **`MAX_REASON_LEN = 256`** caps `reason` defensively in both impls (FCM `data.reason`, APNs top-level `reason`). `strandId` is **not** capped — it's a server-generated id, but a reviewer may want a sanity bound there too.
- **Contract-move blast radius** — `STRAND_WAKE_TYPE`/`StrandWakePayload` now have a single home in cadre-core. Grep confirms the only importers are the RN receiver (re-exporting), the push spec, and `index.ts`. The RN `dist`-resolution coupling means **any future change to the contract requires rebuilding cadre-core before the RN typecheck reflects it** — a stale `dist/` is what made the first RN typecheck fail here.

## Suggested review focus

1. Result-mapping correctness against the *real* FCM v1 / APNs error schemas — especially the FCM `unregistered` heuristic (`isUnregistered`: the 400 `INVALID_ARGUMENT` + regex on the body naming the registration token). Is the regex (`/registration[ -]token|not a valid fcm registration/i`) tight enough to avoid false-positive token expiry on an unrelated 400, and loose enough to catch the real one?
2. JWT signing details: FCM RS256 (`sign('RSA-SHA256', …)`) and APNs ES256 with `dsaEncoding:'ieee-p1363'` (JOSE raw r‖s, **not** DER) — a DER signature would be silently rejected by Apple. The tests sign with real generated keys but never verify the signature shape against a JOSE verifier.
3. Token-cache lifecycle: FCM `TOKEN_REFRESH_SKEW_MS`/`DEFAULT_TOKEN_TTL_MS` and APNs `PROVIDER_TOKEN_TTL_MS` (45 min, inside Apple's 20–60 min window) — confirm the refresh cadence and the re-mint-once-then-return-as-is no-storm semantics.
4. Secret hygiene beyond the two log-assertion tests — eyeball every `log(...)` / `error:` string for a path that could leak the PEM, a minted JWT, or a full device token.
