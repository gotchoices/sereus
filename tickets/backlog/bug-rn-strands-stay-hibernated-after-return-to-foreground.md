description: When the phone app is sent to the background and brought back, its conversations stay shut down, so the chat appears to stop updating and sending fails until a push notification arrives or the app is restarted.
architecture: docs/strands/hibernation.md#hibernating-and-waking-on-request
files: packages/cadre-rn/src/lifecycle/background-runner.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/use-chat.ts, packages/reference-app-rn/src/chat-operations.ts, packages/reference-app-rn/src/push-wake.ts, packages/cadre-rn/README.md, docs/platforms/react-native.md
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: This was read from the code and never seen on a device, and the kit's documents say waking is the app's job, so a maintainer may treat it as a gap in the sample app only and fold the check into the next device session instead of changing the kit.
----

# Strands the lifecycle runner hibernated stay down after the app returns to the foreground

## Background

`@serfab/cadre-rn/lifecycle` provides `createBackgroundRunner`, which follows React Native's `AppState`. When the app goes to the background it calls `CadreNode.hibernateAll`, which stops the network node and closes the database of every strand that is not `realtime`. `hibernateAll` goes through `HibernationManager.forceHibernate`, which cancels the strand's timers and arms no periodic check-in, so by design the strand stays down until something calls `wakeStrand` or `serviceWake`.

## The defect

Nothing calls either when the app comes back.

- **The runner.** `handleBackground` calls `node.hibernateAll()` and discards the list of strand ids it returns. `handleForeground` starts the node again if the operating system stopped it, waits a bounded time for the control network, and sets its state to `foreground`. It does not wake a strand.
- **The React Native reference app.** Its only `wakeStrand` call is in `createPushWakeHandler` (`push-wake.ts`), on the branch taken when a push notification arrives while the app is in the foreground. `use-cadre.ts` builds the runner and reacts to its state only to poll relay status.

The reference app's chat strand has `latencyHint: 'interactive'` (`getChatSAppConfig`), so `hibernateAll` hibernates it. A hibernating strand has no `StrandInstance.database`. In the app that means:

- `use-chat.ts` returns early from its refresh and its polling effect when `strand.database` is unset, so the message list stops updating;
- `getDb` in `chat-operations.ts` throws `Strand … database not available (status: hibernating)`, so sending fails.

`use-cadre.ts` subscribes to `strand:started`, `strand:stopped`, `strand:error`, `strand:writable` and `strand:discovered`. It does not subscribe to `strand:hibernating` or `strand:waking`, so the screen is not re-rendered on either transition. A wake rebuilds the strand's database as a new object, so a fix in the app has to refresh on wake as well as wake.

The app recovers when the operating system kills the process (the runner's `ensureNode` then starts everything fresh), when a push wake arrives in the foreground, or when the user disconnects and connects.

## Expected behaviour

After a background and foreground cycle with the process still alive, the strands that were up before are up again and the chat reads and sends, without a push and without a restart.

Which side owns the wake is the open point. The runner hibernated the strands and is handed their ids, so it can wake exactly those. The documents currently assign it to the app: `docs/strands/hibernation.md` says the runner "does not wake the strands it hibernated: the app calls `wakeStrand` for each strand it needs". If that stays the contract, the reference app does not meet it and the kit README's Lifecycle section should say so where it describes `active`.

## Evidence and confirmation

Read from the code, not run. The runner's spec (`packages/cadre-rn/test/lifecycle/background-runner.spec.ts`) and `use-cadre.spec.ts` use a fake node that only counts `hibernateAll` calls, so neither shows the strand's state after the return.

To confirm on a device or emulator: connect, create a chat strand, send a message, press Home, wait about ten seconds, return to the app and send again. The expected result today is the "database not available (status: hibernating)" error and a message list that no longer refreshes. A headless confirmation is a kit spec that drives the runner against a real `CadreNode` with one `interactive` strand and reads `getStrand(id).status` after the `active` event.

## Related

`bug-activity-recorded-with-hibernation-timers-off-is-dropped` is a separate site in cadre-core. It concerns what keeps a strand up during a push-wake window, not what brings it back on return.
