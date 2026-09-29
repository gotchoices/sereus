description: The React Native phone app now remembers the group id and server addresses it last connected with, reconnects by itself on relaunch, and can start from a push notification after the phone killed it.
architecture: docs/reference-app-rn.md#start-options-app-private-leveldb
files: packages/reference-app-rn/src/start-options.ts, packages/reference-app-rn/test/start-options.spec.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/push-wake-native.ts, packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/src/relay-config.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/README.md, docs/reference-app-rn.md, docs/architecture.md, docs/reference-app-ns.md, tickets/blocked/rn-host-node-request-device-run.md, tickets/backlog/debt-rn-cadre-phone-lifecycle-untested.md
----

# React Native: remember the node's start options

## What landed

The phone's start options (party id, bootstrap addresses, relay addresses, Noise crypto mode) and an `autoStart` flag are saved as one record under the key `start-options` in the app-private `sereus-node-local` LevelDB. The record is not party-scoped, because it is what selects the party. Before this change, every launch began with blank Settings fields, so a solo phone founded a new party on each relaunch, and the party-scoped node-local records (trusted-owner anchor, dial hints, enrolled-machine count, strand peer book) were written but never read back.

- `src/start-options.ts` (native-free) serializes and parses the record `{ version: 1, partyId, bootstrapAddrs, relayAddrs, noiseCryptoMode?, autoStart }`. An unusable record (not JSON, not an object, unknown version, blank party id) counts as absent and is logged. A malformed optional field falls back to its default.
- `src/cadre-phone.ts`:
  - `startPhoneNode` is single-flight: overlapping callers share the start in flight.
  - A successful start saves the options as the node ran with them, with `autoStart: true`.
  - `stopPhoneNode` waits for an in-flight start, then saves `autoStart: false` before teardown.
  - `loadSavedStartOptions()` reads the record, and a read fault propagates to the caller.
- `src/use-cadre.ts` reads the record once at launch and exposes it as `savedStartOptions`. When `autoStart` is true it starts through the hook's own `start`.
- `app/settings.tsx` prefills the disconnected form from the saved options. Bootstrap is now a comma-separated list.
- `src/push-wake-native.ts` supplies `ensureNode`, so a wake into a killed process starts from the saved options when `autoStart` is true.
- `NOISE_CRYPTO_MODES` and `isNoiseCryptoMode` moved to the native-free `phone-node-config.ts`.
- Docs updated: `docs/reference-app-rn.md` has a new "Start options (app-private LevelDB)" subsection. `docs/architecture.md`, `docs/reference-app-ns.md`, the README and the blocked device-run ticket were updated to match.

Implementation commit: `ticket(implement): rn-persist-node-start-options`.

## Review findings

**Checked:** the implement diff read first. Then every touched source file in full around the changed regions: `use-cadre.ts` (launch effect, `start`, `stop`, runner wiring), `cadre-phone.ts` (start/stop/handle), `background-runner.ts` (`handleForeground` → `ensureNode`), `push-wake.ts` (`ensureLiveNode`) and `push-wake-native.ts` (token registration idempotence). I also read the four touched docs and the NS follow-up ticket to confirm it is unaffected (the NativeScript app has no push wake and no background runner). `yarn workspace @serfab/reference-app-rn typecheck` passed. `yarn workspace @serfab/reference-app-rn test` passed: 21 files, 301 tests. `yarn lint` was clean.

**Found and fixed: a push-wake start that is still running (or just finished) at UI mount was not adopted by the hook.** The launch effect skipped `start()` when `getPhoneNode()?.isRunning` was true, but the hook reads its initial state from the singleton only once, at first render. If a push wake's cold start was still running at first render (`node` is set before `CadreNode.start()` resolves) or finished before the launch read resolved, the hook stayed at `idle` with `node: null`. Then no background runner, relay polling or strand-event subscription was attached to a running node, and the token-rotation listener was never subscribed in that runtime. Fix: the launch effect now always calls `start(saved.options)`. `startPhoneNode` hands back the running node or joins the start in flight, so this never builds a second node. It also removes the "no device-token registration on launch into a wake-started node" difference that the implement handoff listed. I verified the fix with the new test `adopts a node a push wake started while the saved options were being read`: it fails against the implement-stage `use-cadre.ts` (`node` received `null`) and passes with the fix. The implementer's test `cold-starts a node that was already running at mount from the saved options` asserted the old skip. That branch no longer exists, and what remained of the test was the mock's own idempotence, so I removed it.

**Found and fixed: the runner's resume during Disconnect could restart the node on a handle about to be closed.** `stopPhoneNode` sets the singleton to null before its teardown. A foreground return in that window made the runner's `handleForeground` see no node and call `ensureNode`, which re-ran `startPhoneNode` with the old options. That built a node on the LevelDB handle the stop's `finally` then closes, and after this ticket it also saved `autoStart: true` over the Disconnect. This path existed before the ticket, and the ticket made it worse. Fix: `use-cadre`'s `stop` clears `optsRef` first, so the runner's `ensureNode` does nothing. No test added: reproducing it needs the real `stopPhoneNode` timing, which the hook suite mocks away. The remaining start-during-teardown path is recorded under Tripwires.

**Tripwires recorded:**
- A `startPhoneNode` that arrives during `stopPhoneNode`'s teardown. With the fix above, only a push wake that read the record milliseconds before Disconnect's save can reach this. Parked as a `NOTE:` above the teardown in `cadre-phone.ts` `stopPhoneNode`.

**Considered, no change:**
- *Settings edits made before the launch read resolves are overwritten by the prefill effect.* The window is one LevelDB read at launch. Accepted as the implementer described.
- *Settings remounted later in a session prefills from the launch-time record, not the latest Connect.* The form only shows while disconnected, and a Connect in the same session leaves the screen's own state holding what was typed, so this matters only if the screen unmounts. Not worth another state channel.
- *A failed start leaves no way to clear `autoStart`.* Disconnect is not offered in the `error` status, so the next launch retries the last good options. That is the intended behaviour (a typo never replaces a working configuration), and a successful Connect overwrites the record.
- *Device token not cleared on Disconnect during a runner cold start* (implement handoff gap). This existed before the ticket, and the fix above makes it rarer, because the runner no longer cold-starts during Disconnect.
- *`initializeFormationResponder` throwing after `node.start()` leaves a running node that was never saved.* This existed before the ticket and is unchanged. It is already the subject of the lifecycle debt ticket's arms.
- *Type safety and parser:* `parseSavedStartOptions` validates every field it keeps. `isNoiseCryptoMode(unknown)` is a real type guard. The serializer omits an undefined mode. No `any`.
- *Resource cleanup:* `nodeLocalDbHandle()` reuses an open handle. A handle opened by a launch read after Disconnect stays open until the next stop, which the plan accepted and the docs state.
- *Docs:* all four touched docs, the README and the blocked device-run ticket match the code after the fixes. The "Overlapping starts" bullet still holds, because the launch path now goes through the same single-flight start.
- *Tests:* `start-options.spec.ts` (3 tests) covers the parser's discard-versus-default branches, which have real branching; kept. The two `autoStart` launch tests are kept (one per branch).

**Not done (unchanged from implement):** no device run. The relaunch reconnect, the push-wake cold start and the borrowed-node reconnect are unobserved on hardware; the validation steps are in `tickets/blocked/rn-host-node-request-device-run.md` and `docs/reference-app-rn.md`. `cadre-phone.ts` still has no Node test; its new ordering rules are recorded as an arm of `debt-rn-cadre-phone-lifecycle-untested`.
