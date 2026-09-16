----
description: A phone can now be pointed at a forwarding server (a "relay"), which finally gives it an address other people can dial, so it can invite someone into a private chat. Without one it still works normally and says plainly that it cannot invite.
files: packages/reference-app-rn/src/relay-config.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/connection-status.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/maestro/_setup.yaml, packages/cadre-core/src/index.ts, packages/reference-app-rn/test/relay-config.spec.ts, packages/reference-app-rn/test/phone-node-config.spec.ts, packages/reference-app-rn/test/solo-founding.spec.ts, packages/reference-app-rn/test/connection-status.spec.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, docs/reference-app-rn.md, packages/reference-app-rn/README.md
----

# A phone with an address other people can dial

Implement commit `7cbf6c6`; review fixes in the commit carrying this ticket.

## What is true now

A **relay** is a public libp2p node that forwards traffic for a node which cannot accept incoming connections. React Native cannot open a listener, so the `/p2p-circuit` address a relay reservation earns is the only address a phone ever has — and an invitation embeds the inviter's own addresses, which is why inviting is the one thing a relay-less phone cannot do.

- **The phone takes a list of relay multiaddrs** and puts it in `network.relayAddrs` with `requireRelay: false`. cadre-core turns that into a bare `/p2p-circuit` search listener plus one reservation supervisor per relay, on the control node **and** on every strand node — the reason the config field is used rather than `CadreNode.reserveRelays()`, whose effect stops at the control node while formation has the invitee dial the strand nodes too.
- **Two sources, one parser** (`src/relay-config.ts`): an explicit list wins, otherwise `EXPO_PUBLIC_RELAY_ADDR` split on commas and trimmed. Settings gained a **Relay** field prefilled from that env var, so a build that ships one needs no typing. Clearing the field asks for the build default back, not for "no relay" — deliberate, tested, and stated in `docs/reference-app-rn.md`.
- **Never blocks startup.** A relay that is unreachable at launch is retried in the background; the node starts, founds strands and chats regardless.
- **The user is told.** The chat banner appends "no relay — can't invite" / "reserving relay…" / "relay offline — can't invite" to the connected line (colour unchanged — the banner's colours mean connection health, and a relay-less phone is healthy); Settings shows a **Reachable** row; and the invite guard reads the posture live at the moment of the tap, so its refusal names either the Settings field or the relay's actual status and error.
- **cadre-core** additionally exports `resolveListenAddrs` and `strandNodeAddrs` (+ `StrandNodeAddrs`), so the phone's spec asserts on the node shape cadre-core derives rather than on the field names this app happens to set. Additive only.

Still true after this pass: no test in the repo proves a phone with a *working* relay is dialable (see below), and nothing in the "On a device" list from the implement ticket has been run.

## Review findings

The implement diff (19 files) was read before the handoff summary.

### Fixed in this pass (minor)

- **A comment that contradicted its own code.** `settings.tsx` → `handleConnect` said "an emptied field means 'no relay'", while the code — `resolveRelayAddrs(splitRelayAddrs(typed))` — falls through to `EXPO_PUBLIC_RELAY_ADDR` when the field is empty. `docs/reference-app-rn.md` and `relay-config.spec.ts` both describe the fallback correctly, so the comment was the outlier and was corrected. The behaviour itself was weighed and kept (below).
- **Four claims that a bad relay address surfaces as a "Connection failed" modal.** It does not. `useCadreInternal.start` catches everything and records `status: 'error'` plus `cadre.error`; Settings renders that message in red directly under the Node card — which is the only section that renders while disconnected, so it is not below the fold — and the chat banner shows it as its text. The modal in `handleConnect`'s `catch` is unreachable because `start` never rejects. Corrected in `settings.tsx`, `src/phone-node-config.ts`, `src/relay-config.ts` and `test/relay-config.spec.ts`, and in the RN README's e2e troubleshooting bullet, which named the same modal (that one pre-existing). The unreachable `try/catch` itself was left in place — it is pre-existing, harmless, and deleting it would remove a net under a future change to `start`.
- **A docs table that dropped an app while being corrected.** The implement pass replaced the row "relay client reservation — the phone apps: never used" in `tickets/backlog/debt-docs-relay-support-reads-more-complete-than-it-is.md` with one row per reference app, but listed only web and React Native. `packages/reference-app-ns` (NativeScript) is a third phone app; it has no `relayAddrs` / `reserveRelays` anywhere and no invitation flow at all (verified by grep). Its row was added and the dated note corrected, so the table no longer reads as if every app is covered.

### Tests added (3, all mutation-checked)

A new `useCadreInternal — relay posture polling` block in `test/react/use-cadre.spec.ts`. The poll is the entire mechanism behind the documented claim that a relay coming back mid-session starts working with no app restart, and it had no test — `relayStatus` was never asserted, and the banner suffix was covered only at the pure-function level.

| test | what it pins |
| --- | --- |
| relay lands after start | the banner drops "no relay — can't invite" with no user action, and says "relay offline" again when the reservation is lost |
| backgrounded | no posture read at all across 60 s while backgrounded, and an immediate re-read on the way back to foreground |
| after `stop()` | the posture falls back to `none` and nothing keeps polling a dead node |

Mutation-checked rather than assumed: deleting the `runnerState !== 'foreground'` guard fails the background test, and deleting the `setInterval` fails the pickup test.

### Considered and deliberately not filed

- **"Nothing proves a phone with a working relay is dialable."** The implement ticket flags this as its largest gap. The ladder was already climbed: `phone-node-config.spec.ts` pins the phone's config against cadre-core's *own* derivations (`resolveListenAddrs`, `strandNodeAddrs`), and `packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts` proves that exact shape end to end over a real relay — closed strand, invitation, formation, bidirectional strand data, every connection asserted relayed. What remains is a scenario constructed literally from `buildPhoneNodeConfig`; the residual risk is cadre-core's derivation changing under the app, which cadre-core's own suite covers. A ticket here would queue work whose defect class is already guarded.
- **`resolveRelayAddrs([])` falling back to the env var.** Kept. Its only cost is that a build shipping `EXPO_PUBLIC_RELAY_ADDR` cannot be run relay-less, which the developer who set that variable resolves by not setting it. Making the field authoritative would leave `resolveRelayAddrs`'s `explicit` parameter unused in this app and split it from the web copy, for no user-visible gain.
- **The banner staying green with no relay.** Agreed with the implementer's argument at `connection-status.ts` → `reachabilitySuffix`: no-relay is the default posture, so amber would be permanent and quickly read as noise, and the phone genuinely is connected.
- **File sizes.** `use-cadre.ts` 603 lines, `settings.tsx` 504 (`wc -l`), of which this ticket added roughly 50 and 15. Neither is in the class of `debt-cadre-node-single-file-size`. No action.

### Parked as a tripwire, not a ticket

- `packages/reference-app-rn/maestro/_setup.yaml`, at the `btn-connect` tap — the Node section grew by a field and a three-line hint, and it is the only section that renders while disconnected. If that tap ever starts missing on a short screen the button has gone below the fold; the NOTE says to add a `scrollUntilVisible` there rather than trim the screen. Unverified either way: no device or emulator harness was available, so the Maestro flows were not run in this pass either.
- The implement pass's existing NOTE beside `relayAddrs` in `phone-node-config.ts` (reservation supervisor wakeups while backgrounded) was re-read and left as written.

### Appended to an existing ticket rather than filed fresh

- `tickets/backlog/debt-ice-config-two-hand-synced-copies.md` gained a short arm: `relay-config.ts` now exists as a hand-synced pair between the web and React Native apps, the same pattern that ticket already owns for `ice-config.ts`. It is about fifteen lines of shared logic and holds nothing security-sensitive, so it is recorded as evidence — so the eventual fix picks a shape that absorbs it — not as work of its own.

### Nothing found in

Resource cleanup (the poll interval is cleared by its effect's cleanup and the effect re-runs on every `node` / `runnerState` change), type safety (`RELAY_STATUS_LABEL` is a `Record` over the full status union; the two grouped `default:` arms are deliberate and each produces a safe message for a status cadre-core might add), error handling (nothing new swallows), and the `PhoneNodeOptions.relayAddrs` required-not-optional call — all three call sites thread it, per `AGENTS.md`'s no-backwards-compat rule.

## Validation

- `yarn workspace @serfab/reference-app-rn test` — **17 files, 277 tests, all passing** (274 before this pass).
- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `yarn lint` — clean.
- cadre-core: the change there is two added export statements, exercised at runtime by the RN specs that now import `resolveListenAddrs` and `strandNodeAddrs` from the built package. No test in cadre-core pins its export surface (`cadre-node-authorized-surface.spec.ts` is about membership, not exports), so its full suite was not re-run — same reasoning as the implement pass.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps carried forward

- **No device run.** Every step of the implement ticket's "On a device, with a real relay" walkthrough is still unexercised, including the relay-dies-and-returns recovery and the garbage-in-the-field path. The Maestro flows were not run.
- **Two relays at the two ends of a formation** is unit-tested in config but untested on a wire — backlog `feat-scenario-two-relay-circuit`.
- **A relay that grants a reservation then refuses to forward** reports `reserved` and fails at dial time; out of scope as planned.
- **Start options still do not persist**, so the relay must be retyped after a process relaunch before an outstanding invitation is redeemable — backlog `feat-rn-persist-node-start-options`, not new here.
- **~10 s per strand launch while a configured relay is down** (measured: 10 061 ms vs ~130 ms), accepted because shortening it needs a per-node reserve-timeout knob cadre-core does not have. Documented in `docs/reference-app-rn.md`.
- Relaying through the phone's own always-on cadre node remains backlog `feat-phone-relays-through-its-own-always-on-node`, blocked on two cadre-core relay defects. The app keeps `network.relayAddrs` whichever source fills it, so that work changes the input, not the shape.
