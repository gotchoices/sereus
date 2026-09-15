description: After the phone app restarts and connects to the same party, none of its strands come back — they are still in the control database, but the app never re-attaches them, so the chat list shows "0 strand(s)". The node announces each stored strand once, before the app has started listening, and never announces it again.
prereq: phone-control-storage-shared-across-parties
files:
  - packages/cadre-core/src/strand-watcher.ts (`start` defers the first poll 100 ms; `poll` marks a strand known before `onStrandAdded`)
  - packages/cadre-core/src/cadre-node.ts (`handleStrandAdded` ~3896: no sAppConfig → emit `strand:discovered` and return; `sAppConfigs` is in-memory only, cleared ~4029)
  - packages/reference-app-rn/src/cadre-phone.ts (`startPhoneNode`: `await node.start()` then `await runOwnerGenesis(node)` before returning, ~250-261)
  - packages/reference-app-rn/src/use-cadre.ts (`strand:discovered` subscription in a `useEffect` keyed on `node`, ~157-206)
repro: verified
----

# Stored strands stay dormant after the phone app restarts

## Symptom (device, 2026-09-15)

Galaxy Note 9, debug `reference-app-rn`, solo phone, party id `11111111-2222-4333-8444-555555555555` typed into Settings on both launches.

1. Connect, Create Chat Strand (`c7160779`, 3322 ms), send "before restart". Chat: `1 strand(s) · 1 member(s)`.
2. Force-stop, relaunch, type the same party id, Connect (node up in 3.0 s).
3. Chat shows `Connected · 0 strand(s) · 0 member(s)`, unchanged 25 s later.

Live state read through the debugger after step 3:

- Control `Strand` table: 10 rows, `c7160779` among them.
- `node.getStrands()`: empty.
- `strandWatcher.knownStrands`: all 10 ids. `failureStates`: empty. Filter `{ mode: 'all' }`.

## Cause

`sAppConfigs` lives in memory, so after a restart no strand has a config. The watcher's first poll (100 ms after `StrandWatcher.start()`, inside `node.start()`) calls `handleStrandAdded` for each row. That emits `strand:discovered` and returns normally, and the watcher records the strand as known, so it is never offered again.

The app only subscribes to `strand:discovered` in a React effect, and that effect runs after `startPhoneNode` resolves. `startPhoneNode` still awaits `runOwnerGenesis(node)` after `node.start()`, so every discovery event fires with no listener and is lost. `cadre-node.ts` ~4521 already names "the reference RN app's `strand:discovered` handler after a restart" as the path that re-attaches the app's own strands; that path never runs.

**Confirmed on the device:** deleting `c7160779` from `strandWatcher.knownStrands` and calling `forcePoll()` (listener now attached) re-attached it in 2157 ms, status `active`. The chat showed the pre-restart message, and a new message sent afterwards was accepted.

## Direction

The fix has to hold for any embedder, not only this app's timing. Options, roughly in order of preference:

- **cadre-core keeps unclaimed discoveries claimable.** A strand whose `handleStrandAdded` found no config stays discoverable: either the watcher does not count it as added (re-emit on later polls, with an in-flight guard against double joins), or the node exposes the unclaimed set (e.g. `getDiscoveredStrands()`) so a late subscriber can enumerate what it missed.
- **The app subscribes before the first poll.** For example, `startPhoneNode` accepts the discovery handler and attaches it before `node.start()`. This fixes only this app, and every other embedder can hit the same race.
- Persisting sAppConfigs per strand in cadre-core would make self-configured strands auto-launch without the event. This is a larger design change; decide it in a plan ticket if wanted.

Whichever lands, add a test that starts a node over a control database that already has strand rows, subscribes after `start()` resolves, and expects every open strand to be attached.

## Related

- **`prereq: phone-control-storage-shared-across-parties`, and the order matters for safety, not just tidiness.** On one device every party id shares one control store, so the `Strand` table holds other parties' rows — 10 of them on the test phone. The app auto-joins discovered open strands, and today this bug is what keeps that from happening: the discovery events are lost before anyone listens. Re-attaching stored strands without scoping the store first would make a phone join another party's open strands. Land the scoping first, and on this ticket assert that a restart re-attaches only the strands of the party the node started with.
- `backlog/feat-rn-persist-node-start-options`: the app does not remember its party id, so a restart usually starts a new party. This bug shows even when the party id is re-entered.
- Found during `blocked/rn-solo-founding-device-run`.
