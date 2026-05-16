priority: 2
description: Specify battery-, network-, and memory-aware behavior for cadre nodes running on mobile devices
files: packages/cadre-core/src, packages/reference-app-rn/app
----
Mobile cadre nodes operate under resource constraints that do not apply to servers: battery budget, metered/cellular networks, limited memory. The node should observe these conditions and adapt — reducing sync frequency on low battery, preferring WiFi for bulk work, and capping the number of concurrently-active strand instances.

### Battery awareness

- Observe battery level and charging state via platform APIs (RN: `expo-battery` or equivalent).
- Reduce hibernation check-in frequency and defer non-urgent work when battery is low and device is not charging. Example policy: below 20% on battery, multiply check-in intervals by a configurable factor; stop all `background`/`archive` strand check-ins entirely.
- `realtime` and `interactive` strands are not deferred (user-facing responsiveness wins).
- The policy must be configurable per-app; some apps (e.g., safety/messaging) may opt out of deferral.

### Network awareness

- Observe connectivity type (WiFi, cellular, offline) and metered flag via `@react-native-community/netinfo` or equivalent.
- On metered/cellular: prefer to sync only control network and `realtime` strands; defer bulk strand catch-up until WiFi.
- On offline: hold state, suppress dial attempts, resume on reconnect.
- Initial bootstrap and seed application should prefer WiFi when available but not block indefinitely — document the timeout/fallback policy.

### Memory footprint

- Limit the number of concurrently-`active` strand instances on mobile (e.g., a configurable cap like 3–5). Strands beyond the cap stay `idle`/`hibernating` even if activity would normally activate them; LRU eviction when the cap is hit.
- The cap interacts with `strandFilter` — a mobile app typically uses `sAppId:<id>` so only a small number of strands are eligible at all, but users in apps that span many strands still need the cap.
- Storage quota on mobile is already covered by `storage.quotaBytes` in `CadreNodeConfig`; this ticket does not redesign quota, only notes that mobile defaults should be conservative.

### Requirements

- `cadre-core` exposes a pluggable `ResourceMonitor` interface (battery level, charging, network type, metered) that the reference app populates from RN APIs. Node.js default is a no-op monitor that reports "plugged in, unmetered" always.
- Hibernation and sync scheduling read from `ResourceMonitor` to adjust timing. The existing latency-hint table in `docs/architecture.md` is the baseline; resource state applies multipliers/gates on top.
- Concurrent-active-strand cap is enforced by `StrandInstanceManager` with a configurable limit, surfaced in `CadreNodeConfig`.
- All policies are configurable; defaults are conservative for mobile, permissive for servers.

### Use cases

- Phone on cellular, low battery: control network stays synced, `interactive` chat strand stays active, a `background` feed strand stops checking in until charging resumes.
- Phone connects to WiFi after long offline period: deferred catch-up work drains; previously-suppressed strand instances wake.
- App with many strands on a memory-constrained device: only the most-recently-used handful are `active`; others hibernate transparently.

## TODO
- [ ] Specify `ResourceMonitor` interface (observable battery %, charging, net type, metered)
- [ ] Specify the battery-aware policy (thresholds, multipliers, which latency hints are affected)
- [ ] Specify the network-aware policy (metered behavior, offline handling, WiFi-preferred bootstrap)
- [ ] Specify concurrent-active-strand cap semantics (default value, LRU vs explicit priority, interaction with `realtime`)
- [ ] Identify `StrandInstanceManager` and hibernation scheduler hooks required to read resource state
- [ ] Document default values for mobile vs server profiles
