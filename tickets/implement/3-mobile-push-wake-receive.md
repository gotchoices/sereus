----
description: Mobile push-wake receive path — register device token, handle FCM/APNs background notifications, drive a single serviceWake cycle, and configure iOS/Android background execution
prereq: mobile-background-runner, cadre-device-token-registry
files: packages/reference-app-rn/package.json, packages/reference-app-rn/app.json, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/background-runner.ts, packages/reference-app-rn/src/push-wake.ts (new), packages/reference-app-rn/android/app/src/main/AndroidManifest.xml, packages/reference-app-rn/index.js
effort: high
----

This is the mobile delivery half of push-wake. The control-network transport (`pushWake`/`StrandWakeService`) cannot reach a suspended app, so the wake must arrive over the platform push channel (FCM/APNs). When such a notification is delivered, a background task brings the node online just long enough to service the wake (`CadreNode.serviceWake`, from `cadre-background-primitives`) and then returns to hibernation.

This ticket owns the **receiver and platform configuration**. The **sender** (server activity-detection fan-out) is a separate effort (`cadre-server-push-fanout`); this ticket can be validated end-to-end by sending a test data-message from the Firebase/Expo console or a manual script.

### Library choice (resolved)

The app is **managed Expo SDK 53 with `expo-dev-client`**. Use Expo's first-party modules — they fit the managed workflow, support config-plugin native setup, and avoid a bare-RN eject:

- **`expo-notifications`** — receive FCM (Android) / APNs (iOS) notifications, obtain the device push token (`getDevicePushTokenAsync` → the raw FCM/APNs token to publish into `DeviceToken`; this is the platform token, not the Expo push token), and register a background handler.
- **`expo-task-manager`** + **`expo-notifications`' background notification task** (`registerTaskAsync`) for the Android data-message wake path / headless execution.

Rationale over alternatives: `react-native-background-fetch` and raw headless JS require bare native wiring that fights the managed workflow; `notifee` is heavier than needed for a single wake-and-return. `expo-notifications` covers token acquisition + background delivery on both platforms with config-plugin native setup. Document this tradeoff in the ticket's review handoff.

### Payload & routing

The notification is a **data-only message** (no user-visible alert by default; on iOS use `content-available` / background push) carrying:

```jsonc
{ "type": "strand-wake", "strandId": "<uuid>", "reason": "activity" }
```

Routing: the server peer that detects strand activity resolves the target phone's token via `DeviceToken` (from `cadre-device-token-registry`) and sends the data message addressed to that token. The phone's background handler reads `strandId`, calls `node.serviceWake(strandId, { windowMs })`, and lets the node re-hibernate. (Who sends — the activity-detection fan-out — is `cadre-server-push-fanout`; this ticket only consumes the payload shape, which both tickets must agree on. Define the payload type in `src/push-wake.ts` as the shared contract.)

### Receive flow

```
FCM/APNs data message ──► OS wakes app (background task / content-available)
       │
       ▼
 expo-notifications background task handler (push-wake.ts)
       │  parse {type:'strand-wake', strandId, reason}
       ▼
 ensure node started (cold start: startPhoneNode)  ──► await controlConnected (bounded)
       │
       ▼
 node.serviceWake(strandId, { windowMs })   ── pulls pending strand activity
       │
       ▼
 re-hibernate (serviceWake handles it) ──► task returns; OS re-suspends
```

Token registration: on app start / permission grant, call `getDevicePushTokenAsync`, then `node.registerDeviceToken(platform, token)` (from `cadre-device-token-registry`). Re-register on token rotation (`addPushTokenListener`). Clear on logout (`node.clearDeviceToken`).

### Platform configuration

**iOS** (`app.json` → `ios.infoPlist.UIBackgroundModes`):
- `remote-notification` (required for content-available background push) — primary path.
- Optionally `processing`/`fetch` for opportunistic catch-up; `voip` is **not** appropriate (App Store rejects non-VoIP use). Document App Store review note: background push must do real work and return quickly; silent pushes are rate-limited by APNs and not guaranteed — design for "best-effort wake," consistent with the Doze use case.
- APNs requires a paid Apple Developer account + push capability; note as a human/infra prerequisite (cannot be done in-agent).

**Android** (`AndroidManifest.xml` + config plugin):
- FCM requires `google-services.json` and an FCM project — human/infra prerequisite; document it.
- For the wake-and-return work, data messages wake the app; a **foreground service** with a persistent notification is only needed if work must continue beyond the brief data-message window. Recommended: rely on the data-message background task for the short serviceWake cycle; add an FGS (`notifee` or `expo-task-manager` foreground service) only if measurements show the cycle exceeds the allowed window. Document the FGS notification UX (persistent "Sereus is syncing" notification) and the **battery-optimization opt-out** request (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` / direct user to settings) as the path for more reliable wakes, with the tradeoff that Doze will still throttle.
- Add permissions as required by the chosen path: `POST_NOTIFICATIONS` (Android 13+), `WAKE_LOCK`, and `FOREGROUND_SERVICE` (+ typed `FOREGROUND_SERVICE_DATA_SYNC`) only if an FGS is used.

### Edge cases & interactions

- **Suspended-process cold start**: the background task may run with no live node — must call `startPhoneNode` and await control before `serviceWake`; bounded so the task returns within the OS budget (iOS ~30s, less under throttling).
- **iOS silent-push unreliability**: APNs drops/coalesces background pushes under low-power; treat wake as best-effort and lean on check-in wake (already implemented) as the backstop. Do not assume every sent push wakes the app.
- **Doze / App Standby (Android)**: data messages may be deferred; high-priority FCM messages get a brief allowance. Document that without battery-optimization opt-out, wakes are throttled — matches the parent ticket's Doze use case (single catch-up on next OS-granted wake, not retry storm).
- **Duplicate / replayed pushes**: same `strandId` delivered twice → `serviceWake` is idempotent/coalesced (cadre-core ticket), so a double wake is one runtime build. Verify no double-resume.
- **Unknown / non-participated strandId** in payload: `serviceWake` returns `{serviced:false}`; handler logs and returns without error.
- **Push arrives while app is foreground**: route to a normal `wakeStrand`/`recordStrandActivity` rather than the suspend-return path; don't re-hibernate a strand the user is viewing (BackgroundRunner state gates this).
- **Token not yet registered / no membership**: `registerDeviceToken` requires the node started and the peer in `CadrePeer`; defer registration until after node start + membership, retry on next start.
- **Permission denied** (user declines notifications): degrade to check-in-wake-only; surface state; do not crash.
- **Task budget overrun**: if `serviceWake`'s window exceeds the OS background budget, the OS kills the task mid-cycle; cadre-core's re-hibernate-on-error must leave consistent state for the next wake. Keep `windowMs` conservative for background (smaller than the interactive check-in window).
- **Interaction with BackgroundRunner**: the push handler and the AppState runner both drive lifecycle; they must share the single node singleton and not issue contradictory hibernate/resume. The handler operates only while backgrounded; on foreground the runner owns transitions.

### Validation (manual — requires device + FCM/APNs creds)

- Send a test `strand-wake` data message (Firebase console / Expo push tool / manual APNs) to a backgrounded dev build → app wakes, `serviceWake` runs, pending strand activity pulled, app re-hibernates. Capture logs.
- Token registration round-trip: install build → `DeviceToken` row appears resolvable from another cadre node via `resolveDeviceToken`.
- These cannot run in CI/agent (need physical device + provisioned push creds); document as manual steps and gate the agent work on `typecheck` + unit tests of the payload parser/handler with a mock node.

### Key tests (agent-runnable)

- Payload parser: valid `strand-wake` → `{strandId, reason}`; malformed/missing type → ignored (no throw).
- Handler with mock node: valid payload → `serviceWake(strandId)` called once; unknown strand (`serviced:false`) → no error; foreground state → routes to `wakeStrand` not the re-hibernate path.
- Token registration: on token event → `registerDeviceToken(platform, token)` called with the raw device token; on rotation → re-called; on logout → `clearDeviceToken`.

## TODO

- [ ] Add `expo-notifications` + `expo-task-manager` deps and config plugins
- [ ] `src/push-wake.ts`: shared payload type, parser, and the background task handler (parse → ensure node → `serviceWake` → return)
- [ ] Register the background notification task (`registerTaskAsync`) in `index.js` / app entry
- [ ] Device-token registration: acquire raw FCM/APNs token, `registerDeviceToken`; listen for rotation; `clearDeviceToken` on logout
- [ ] Foreground-vs-background routing (coordinate with BackgroundRunner state)
- [ ] `app.json`: iOS `UIBackgroundModes` (`remote-notification`), Android FCM config plugin hook; document `google-services.json` / APNs as human prerequisites
- [ ] `AndroidManifest.xml`: `POST_NOTIFICATIONS`, `WAKE_LOCK` (+ FGS perms only if FGS adopted)
- [ ] Document iOS App Store review notes, Android FGS notification UX + battery-optimization opt-out
- [ ] Unit tests (parser, handler, token registration) with mock node
- [ ] `yarn workspace @serfab/reference-app-rn typecheck` green; manual device validation steps recorded in the review handoff
- [ ] Update `docs/architecture.md` Wake Mechanisms (mobile delivery now wired) and `docs/STATUS.md`
