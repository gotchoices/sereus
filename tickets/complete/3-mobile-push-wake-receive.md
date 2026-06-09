description: Mobile push-wake RECEIVE path (FCM/APNs data-message receiver, serviceWake drive, device-token registration, iOS/Android background config) in the RN reference app — reviewed and completed
files: packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/src/push-wake-native.ts, packages/reference-app-rn/test/push-wake.spec.ts, packages/reference-app-rn/index.js, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app.json, packages/reference-app-rn/android/app/src/main/AndroidManifest.xml, packages/reference-app-rn/package.json, docs/architecture.md, docs/STATUS.md
----

# Mobile push-wake receive — completed

Receiver + platform-configuration half of mobile push-wake landed in the RN reference app. The
sender (server activity-detection fan-out, `cadre-server-push-fanout`) remains a separate effort that
consumes the shared `StrandWakePayload` contract defined here.

A suspended app keeps no network up, so a wake for a hibernating phone arrives over the platform push
channel (FCM/APNs) instead of the control-network `pushWake`. A data-only push triggers a short
background task that brings the node online just long enough to run one `serviceWake` cycle, then lets
it re-hibernate. Foreground pushes route to `wakeStrand`+`recordStrandActivity` instead (the user is
viewing — the AppState `BackgroundRunner` owns lifecycle).

## What shipped

- `src/push-wake.ts` — platform-agnostic, fully unit-tested core: `StrandWakePayload`/`STRAND_WAKE_TYPE`
  shared contract, defensive `parseStrandWakePayload`, `extractPushData` (Android `dataString` JSON / iOS
  direct keys), `createPushWakeHandler` (parse → foreground-vs-background route → cold-start `ensureNode` →
  bounded `awaitControlConnected` → `serviceWake`), `createDeviceTokenRegistrar` (deferred-retry), and
  `pushPlatformFromTokenType`. Type-only `@serfab/cadre-core` import; no react-native coupling.
- `src/push-wake-native.ts` — the only RN/expo-coupled module: defines + registers the
  `expo-notifications`/`expo-task-manager` background task, acquires/re-publishes/clears the raw device token.
- `index.js` — `registerStrandWakeTask()` at entry-module scope (expo re-evaluates the entry module to run
  the background task).
- `src/use-cadre.ts` — `acquireAndRegisterDeviceToken()` on node start, `clearDeviceTokenRegistration()` on stop.
- Config: `app.json` iOS `UIBackgroundModes:[remote-notification]` + `expo-notifications` plugin; Android
  `POST_NOTIFICATIONS`/`WAKE_LOCK` permissions (source of truth for the gitignored, prebuild-regenerated
  Android manifest). Deps `expo-notifications@~0.31.5`, `expo-task-manager@~13.1.6`.
- Docs: `docs/architecture.md` (new wake mechanism 5) + `docs/STATUS.md` updated to reflect the shipped
  receive path and its honest best-effort/cold-start caveats.

## Review findings

Adversarial pass over commit `c5b6f13` (the implement diff), read before the handoff summary.

**Verified correct (no change):**
- **API surface against cadre-core.** Every consumed member exists with the assumed signature:
  `serviceWake(strandId, {windowMs}) → ServiceWakeResult`, `wakeStrand`, `recordStrandActivity`, `running`
  / `controlConnected` getters, `registerDeviceToken`/`clearDeviceToken`, the typed `control:connected`
  event (`cadre-node.ts:200/210/725/836/1355/1365/1454`, `types.ts` `ServiceWakeResult` + `PushPlatform`).
  Typecheck green confirms it.
- **Shared-contract drift.** No other module re-declares `StrandWakePayload` / the `'strand-wake'` literal;
  the pending `cadre-server-push-fanout` sender will import this type as intended. No duplication to reconcile.
- **`awaitControlConnected` correctness.** Initial-connected fast path skips subscription (no listener leak);
  the post-subscribe re-check closes the subscribe race; `finish` is idempotent and always removes listener +
  timer. TDZ-safe (`finish` only invoked after `onConnected`/`timer` are bound).
- **Logging convention.** `console.warn('[push-wake] …')` matches the established RN-app prefix style
  (`background-runner`, `cadre-phone`). cadre-core's `log()` debug util is library-only — correctly not used here.
- **BackgroundRunner interaction.** Background handler force-runs `serviceWake` (wake → window → re-hibernate)
  only while backgrounded; the runner owns foreground transitions. `HibernationManager` coalescing means a
  push racing a check-in shares one runtime build — no double-resume guard needed. No contradiction.
- **AndroidManifest gitignore note is accurate.** `android/` is gitignored; the manifest edit is *not* in the
  commit, and `app.json` `android.permissions` is the committed source of truth (regenerated on prebuild).
- **Docs reflect reality.** Only `architecture.md` + `STATUS.md` mention push-wake; both updated accurately,
  including best-effort delivery, the un-wired cold-start-into-killed-process gap, and human/infra prerequisites.

**Minor — fixed in this pass:**
- **Edge-case test coverage strengthened** (`test/push-wake.spec.ts`, 48 → 52 tests). Added: foreground-with-
  no-node → `no-node` no-op; foreground `wakeStrand` rejection swallowed → still `handled` with no
  `recordStrandActivity`/`serviceWake`; cold-start of an existing-but-*not-running* node via `ensureNode`
  (exercises the `!node.running` branch of `ensureLiveNode`, previously only the null-node branch was covered);
  background `ensureNode` that fails to produce a running node → `no-node`. All 52 pass.

**Minor — reviewed, deliberately not changed (rationale recorded):**
- **`awaitControlConnected` duplication.** A ~12-line near-twin exists in `background-runner.ts:210`. The two
  differ in lifecycle ownership: the runner's copy registers each timer/settle in instance `pendingTimers`/
  `pendingSettles` sets so `stop()` can abort an in-flight settle; the push-wake copy is standalone and
  exported precisely so a push can be serviced with **no runner mounted**. Extracting a shared helper would
  re-open the already-completed background-runner and thread optional teardown hooks through it for marginal
  gain. Left as deliberate, documented duplication.

**Known gaps carried forward (not regressions — design boundaries, honestly flagged in the handoff):**
- **Cold-start into a fully OS-killed process is not wired.** `ensureNode` is intentionally omitted in
  `push-wake-native.ts` because the node's start options (`partyId`/`bootstrapAddrs`) are entered in Settings
  and not persisted (no AsyncStorage). A wake into a killed process degrades to a `no-node` no-op; the common
  backgrounded-but-alive case is fully served. The handler core already accepts `ensureNode` — only persistence
  + native plumbing is missing. **Candidate follow-up** (`plan/` or `fix/`) if true cold-start wake is required;
  not filed here because the degradation is graceful and the check-in wake is the backstop.
- **No on-device validation.** Requires a physical device + provisioned push creds (`google-services.json` for
  FCM; paid Apple Developer account + APNs key for iOS) — human/infra prerequisites, out of agent. The
  highest-risk untested assumption is the exact runtime shape `expo-notifications` hands a *data-only* message
  to the background task (`extractPushData`'s `payload.data` / `data.dataString` assumption). Manual steps
  (send a `strand-wake` data message to a backgrounded build; confirm wake → `serviceWake` → re-hibernate; and
  a `DeviceToken` round-trip via `resolveDeviceToken`) recorded for whoever provisions creds.
- **Best-effort delivery by design.** iOS silent push is APNs-rate-limited/coalesced under low power; Android
  Doze defers data messages without a battery-optimization opt-out (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` /
  settings deep-link — not implemented). No foreground service (the wake-and-return cycle is expected to fit
  the data-message window; adopt an FGS only if on-device measurement shows `serviceWake` overruns the budget).
  `DEFAULT_BACKGROUND_WINDOW_MS = 3_000` is conservative and not tuned against real network latency.

No **major** findings — nothing warranting a new `fix`/`plan`/`backlog` ticket. The cold-start-persistence
item is the only plausible future ticket and is a deliberate scope boundary, left to a human/product call
rather than auto-filed.

## Validation (this review)

- `yarn test` (reference-app-rn, vitest) — **52 pass** (17 background-runner + 35 push-wake; +4 added this pass).
- `yarn workspace @serfab/reference-app-rn typecheck` (`tsc --noEmit`) — green (exit 0).
- `yarn eslint` on all changed `.ts`/`.js` — green.
- No pre-existing failures surfaced.
