priority: 2
description: Specify mobile background service that keeps the cadre node connected for push-wake signals and strand activity
files: packages/reference-app-rn/app, packages/cadre-core/src
----
A cadre node on a mobile device must remain reachable (at least intermittently) even when the app is not in the foreground. This is how the node receives **push-wake** signals from other cadre members (see "Wake Mechanisms" in `docs/architecture.md`) and participates in strand activity while the user is not actively using the app.

Without a background service, the cadre node is only alive while the app is open, which defeats hibernation wake, delays control-network sync, and makes the mobile node unreliable as a cadre peer.

### Platform constraints

- **iOS**: No long-running background processes. The app must use declared background modes (e.g., `background-fetch`, `voip`, `remote-notification`) and cooperate with the OS scheduler. Socket connections are terminated when the app is suspended.
- **Android**: Foreground service with a persistent notification is the standard pattern for long-running work. Doze mode and App Standby throttle network usage for inactive apps.

These constraints mean the cadre node cannot assume a continuously-running event loop. The design must degrade gracefully: maintain presence when the OS permits, and re-establish state quickly when woken.

### Requirements

- A `BackgroundRunner` abstraction in the reference app (not in `cadre-core`, which stays platform-agnostic) that owns the `CadreNode` lifecycle across foreground/background transitions.
- On background entry: the node should enter hibernation for all non-`realtime` strands, maintain the control-network connection if feasible, and persist enough state that a cold wake is fast.
- On wake (scheduled fetch, push notification, foreground return): the node rehydrates, syncs the control network, and services any wake-pending strands.
- Push-wake path: an FCM/APNs notification delivered to the app triggers a background task that brings the node online long enough to pull pending strand activity via the control network, then hibernates again.

> **Depends on `hibernation-push-wake` (landed).** The core control-network push-wake *transport* now exists in `@serfab/cadre-core`: `WAKE_PROTOCOL` (`/sereus/strand-wake/1.0.0`), the `StrandWakeService` receiver (registered on the control node, membership-gated via `CadreNode.isMember`), and the `CadreNode.pushWake(targetPeerId, strandId, reason?)` sender (see `strand-wake-protocol.ts` and "Wake Mechanisms" in `docs/architecture.md`). What this ticket still owns and the push-wake ticket deliberately left out:
> - **Automatic trigger policy** — *who* decides to fan push-wakes to hibernating cadre peers (e.g. an always-on server detecting strand activity), and how it enumerates the hibernating peers to wake. `pushWake` is the mechanism; the trigger is integration policy.
> - **Mobile delivery / background entry point** — the FCM/APNs notification that wakes a *suspended* app's process, then drives a single "service the wake and return" cycle. A control-network libp2p dial cannot reach a phone whose process the OS has suspended, so on mobile the push-wake `WakeRequest` must arrive via the platform push channel and the background task then resumes the strand locally (it may call `pushWake` peer-to-peer when the device is foregrounded/connected).
- The cadre-core API must expose the hooks needed to drive this: pause/resume primitives, a "service wake signal and return" entry point, and observable readiness state. Identify whether current `start()`/`stop()` are sufficient or new primitives are required.

### Use cases

- User receives a message on an `interactive` strand while app is backgrounded: push notification → background task wakes node → strand activates → message delivered → node returns to hibernation.
- User opens app after hours: foreground transition triggers a full resume; UI shows sync progress until control network is caught up.
- Low-power / Doze mode: node accepts that it will be offline for extended periods; on next OS-granted wake, it performs a single catch-up cycle rather than repeatedly retrying.

## TODO
- [ ] Survey RN background patterns: `expo-task-manager`, `expo-background-fetch`, headless JS (Android), `react-native-background-fetch`, notifee foreground services
- [ ] Specify the `BackgroundRunner` state machine (foreground / background-connected / background-hibernating / terminated)
- [ ] Identify cadre-core API gaps for pause/resume and wake handling
- [ ] Specify push-wake notification payload and routing (who sends it, which cadre node)
- [ ] Document iOS background modes required and App Store review considerations
- [ ] Document Android foreground-service notification UX and battery-optimization opt-out request
