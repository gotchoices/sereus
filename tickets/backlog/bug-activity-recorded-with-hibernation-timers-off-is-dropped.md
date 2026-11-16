description: On a phone or browser node, telling the node that a conversation is in use (or the node itself sending queued offline messages) is silently ignored, so a short wake-up triggered by a push notification always puts the conversation back to sleep, even in the middle of sending.
architecture: docs/strands/hibernation.md#what-counts-as-activity
files: packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/edge-node/config.ts, packages/reference-app-rn/src/push-wake.ts, docs/strands/hibernation.md, docs/strands/writes.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The only wake window on an edge node is the one a push notification opens, and none of this repo's always-on programs sends that push yet, so today this only delays an offline queue's drain for an app that runs its own push sender; nothing is lost, because an interrupted send is sent again at the next wake.
----

# Activity recorded while the hibernation timers are off is dropped

## Background

A strand that is hibernating can be brought up for a bounded window and then put back down unless something used it in the meantime. `CadreNode.serviceWake` does this on request (a phone calls it when a push notification arrives), and the timer-driven check-in does it periodically. Both end in `CadreNode.runWakeWindow`, which decides by one comparison: whether `StrandInstance.lastActivity` is a different `Date` object from the one read before the strand came up.

"Activity" reaches that field through `HibernationManager.recordActivity`. Its callers are `CadreNode.recordStrandActivity` (the app's public call), `CadreNode.handleOfflineStatus` (the offline queue sending a transaction), `CadreNode.handleStrandWritable` and `CadreNode.wakeHostStrandForFormation`.

The hibernation timers (idle, hibernate, check-in) are a node setting, `CadreNodeConfig.hibernation.enabled`. The edge node, which every phone and browser app runs, always sets it to `false` (`buildEdgeNodeConfig` in `edge-node/config.ts`): the app hibernates and wakes strands itself. A node with no `hibernation` block gets the same value.

## The defect

`HibernationManager.recordActivity` begins with `if (!this.config.enabled || !this.running) return;`, and the assignment to `instance.lastActivity` comes after it. With the timers off the method does nothing at all, including the one thing a wake window reads.

On an edge node this makes three callers ineffective:

- **The offline queue sending.** The comment on `handleOfflineStatus` says a send counts as activity "so a check-in window that finds the cohort reachable stays up while the queue drains". Offline mode is offered only on the edge node, where the call is a no-op. A `serviceWake` window therefore ends on schedule and quiesces the strand while its queue is still sending.
- **`recordStrandActivity` from the app.** The doc comment on `serviceWake` says the window lets "the app … pull pending activity, then re-hibernate if no activity was recorded". An app that reads new rows during the window and reports it has no effect on the outcome. For a strand that was hibernating when the call began, `ServiceWakeResult.hadActivity` can only be `true` after a `wakeStrand` call, a wake request from another machine, or a joiner's first sync completing (`StrandInstanceManager` stamps that one itself).
- **The React Native reference app's foreground push path** (`createPushWakeHandler` in `push-wake.ts`) calls `recordStrandActivity` after `wakeStrand` "so the strand … comes up and stays up". The second call adds nothing.

`wakeHostStrandForFormation` already allows for this: its comment says `recordActivity` may be a no-op with hibernation disabled, and it follows with an explicit `wakeStrand`. `handleOfflineStatus` and `recordStrandActivity` do not.

The reference app's background window is 3 seconds (`DEFAULT_BACKGROUND_WINDOW_MS`). A queue that needs longer than that to send keeps being cut off, one window per push. A send that the quiesce interrupts was journaled first and is sent again under the same action id at the next build, so the cost is delay, not loss.

## Expected behaviour

Activity recorded on a strand is visible to a wake window whether or not the timers are on: a `serviceWake` window during which the app called `recordStrandActivity`, or during which the offline queue sent a transaction, leaves the strand up and reports `hadActivity: true`.

Whether recorded activity should also *wake* a hibernating strand when the timers are off is a separate question and is not asked for here. It would let an offline queue or a stray report undo the `hibernateAll` an app made on going to the background; `handleOfflineStatus` already guards the quiescing case for that reason.

## Evidence and confirmation

Read from the code, not run. To confirm: in a cadre-core spec, start a node with `hibernation: { enabled: false }`, hibernate a strand with `hibernateStrand`, call `serviceWake`, and call `recordStrandActivity` during the window (`holdWakeWindow` is a separate method so that specs can stub the wait and inject activity). The result is expected to be `hadActivity: false` and the strand `hibernating` today.

`docs/strands/hibernation.md` ("When hibernation applies", "What counts as activity", "Limits and accepted tradeoffs") and `docs/strands/writes.md` ("Sending is activity") describe the current behaviour as a limit of the edge node. They change with the fix.

## Related

`bug-rn-strands-stay-hibernated-after-return-to-foreground` is a different site (the React Native lifecycle runner never wakes what it hibernated). Fixing this ticket does not fix that one: nothing in the app records activity on returning to the foreground.
