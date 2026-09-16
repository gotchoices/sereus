description: A phone can now be given a forwarding server (a "relay") to route through, which finally gives it an address other people can dial — so it can invite someone into a private chat. Without one it still works normally and simply says it cannot invite.
files: packages/reference-app-rn/src/relay-config.ts (new), packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/connection-status.ts, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/app/index.tsx, packages/cadre-core/src/index.ts, packages/reference-app-rn/test/relay-config.spec.ts (new), packages/reference-app-rn/test/phone-node-config.spec.ts, packages/reference-app-rn/test/solo-founding.spec.ts, packages/reference-app-rn/test/connection-status.spec.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, docs/reference-app-rn.md, packages/reference-app-rn/README.md
difficulty: medium
----

# A phone with an address other people can dial

## Terms

- **Relay** (circuit relay) — a public libp2p node that forwards traffic for a node that cannot accept incoming connections. The forwarded-for node holds a **reservation** on it; the `/p2p-circuit` address that reservation produces is the only address a phone ever has.
- **Formation** — the cross-party handshake behind "create a closed strand and invite someone". The **invitee dials the inviter**, first its control node and then its strand nodes.

## What changed

The phone node now takes a list of relay multiaddrs and puts it in `network.relayAddrs`, at the `requireRelay: false` posture that `relay-can-be-optional-at-startup` added. cadre-core turns that into a bare `/p2p-circuit` search listener plus one reservation supervisor per relay, on the control node **and** on every strand node — which is why the config field is used rather than `CadreNode.reserveRelays()`, whose effect stops at the control node while formation needs the invitee to dial the strand nodes too.

Where the address comes from:

- **New `src/relay-config.ts`** — `resolveRelayAddrs(explicit?)`: an explicit non-empty list wins, otherwise `EXPO_PUBLIC_RELAY_ADDR` split on commas, trimmed, blanks dropped; `[]` when nothing is configured. `splitRelayAddrs(raw)` is exported alongside it so the Settings field and the env var parse a list the same way. Framework-free, no validation (cadre-core owns that), never throws. No `localStorage` branch — React Native has none, the same omission `ice-config.ts` documents.
- **Settings gained a "Relay" field**, prefilled from `resolveRelayAddrs()` so a build shipping `EXPO_PUBLIC_RELAY_ADDR` needs no typing, editable so a device can be pointed elsewhere, and `autoCapitalize="none"` / `autoCorrect={false}` like every other address field. `handleConnect` passes `resolveRelayAddrs(splitRelayAddrs(typed))`, so a typed value wins and an emptied field falls back to the build default.
- **`PhoneNodeOptions` gained `relayAddrs: string[]`** (required — every call site threads it). Nothing persists start options, same as `partyId` and `bootstrapAddrs`, so it is retyped each launch (backlog `feat-rn-persist-node-start-options`).

Telling the user:

- **`cadre-phone.ts` → `getRelayState()`**, a live read mirroring the web app's, returning a `none` posture before the node starts rather than throwing (unlike `getConnectionPaths` beside it — the banner renders in every lifecycle state).
- **`use-cadre.ts`** exposes `relayStatus`, polled every 5 s while the app is in the foreground. The invite guard is unchanged in *what* it checks — `getMultiaddrs().length === 0`, the precondition `createOpenInvitation` really has — but its message is now built from a **live** `getRelayState()` read at the moment of the tap: "no relay configured" names the Settings field, `retrying`/`error` names the status and the recorded error.
- **`connection-status.ts`** appends a reachability clause to the connected line ("no relay — can't invite", "reserving relay…", "relay offline — can't invite"). Colour is deliberately **not** changed: the banner's three colours mean connection health, a relay-less phone is connected and fully usable for everything but inviting, and no-relay is the default posture, so amber would be permanent and quickly read as noise. Settings also shows a **Reachable** row on the connected Node card.

Also changed, outside the app: `packages/cadre-core/src/index.ts` now exports `resolveListenAddrs` and `strandNodeAddrs` (+ `StrandNodeAddrs`), so the phone's spec can assert on the node shape cadre-core actually derives instead of on the field names this app happens to set. Additive only.

## How to exercise it

**Headless, no relay server needed** (all covered by tests below):

- Build the config with and without relays and check what cadre-core derives from it.
- Start a node against an **unreachable** relay address and confirm it comes up, founds a strand, and reports a "still trying" posture.

**On a device, with a real relay** (not covered by any test — see "Known gaps"):

1. Run a relay (`ops/` ships the container) and note its dial addr, ending `/p2p/<relayPeerId>`.
2. Settings → **Relay** → paste it → Connect. The Node card should show `Reachable: Yes — via relay` within ~10 s, and the chat banner should stop saying "no relay".
3. **Create Closed Strand + Invite.** The invitation should mint; its bootstrap addresses are `/p2p-circuit` addresses through that relay.
4. On a second party (another phone, or the web app, or a headless driver), redeem it with `formStrand`. Messages should replicate both ways.
5. Kill the relay mid-session. Within a poll the banner should say "relay offline"; Invite should refuse naming the status. Restart the relay; within the supervisor's backoff (2 s → 60 s) the banner and the button should recover **with no app restart**.
6. Type garbage into the Relay field and Connect: expect the "Connection failed" modal carrying cadre-core's `network.relayAddrs entry …` message. Correct the field, Connect again — no app restart needed.
7. Empty the Relay field and Connect: node starts, chat works, Invite refuses naming the Settings field, and **no strand is left behind**.
8. Request a node from a cadre-host while holding a relay reservation — both should coexist.

## Validation run

- `yarn workspace @serfab/reference-app-rn test` — **17 files, 274 tests, all passing** (~31 s warm).
- `yarn workspace @serfab/reference-app-rn typecheck` — clean.
- `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core build` — clean. Spot-ran cadre-core's `relay-addrs` + `listen-transport-options` specs (39 tests, passing); the full cadre-core suite was **not** run, on the grounds that the only change there is two added export statements.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Tests added

| file | what it pins |
| --- | --- |
| `test/relay-config.spec.ts` (new, 9 cases) | explicit list wins; env var split/trim/blank-filter; unset yields `[]`; empty env yields `[]`; never throws; a malformed entry passes through **on purpose** so cadre-core rejects it loudly |
| `test/phone-node-config.spec.ts` (+8) | `relayAddrs` carried verbatim, `requireRelay: false`, `listenAddrs` still `[]` — **and** cadre-core's own derivation: `resolveListenAddrs` yields the bare `/p2p-circuit` entry, `strandNodeAddrs` yields one search entry *and* one supervised relay **per relay**, both empty with no relay, and a malformed entry throws naming `network.relayAddrs` |
| `test/solo-founding.spec.ts` (+3) | a node built from `buildPhoneNodeConfig` with an unreachable relay starts, reports `retrying` with the relay recorded and no circuit addrs, has **no** dialable address, and still founds a chat strand |
| `test/connection-status.spec.ts` (+4) | each reachability suffix, silence once `reserved`, and that the relay never leaks into the not-connected / resuming lines |
| `test/react/use-cadre.spec.ts` (+3) | the refusal names the Settings field when no relay is configured; names the status **and** the recorded error when it is retrying; the guard reads the posture at the moment of the tap. Both refusal paths assert nothing was founded and no invitation minted |

## Known gaps — read before signing off

- **Nothing in this package proves a phone with a *working* relay is dialable.** `packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts` proves the behaviour for a node of this shape (`listenAddrs: []` + `relayAddrs`, two parties, one relay), and the specs above prove the phone's config resolves to that shape — but the two are joined **by inspection, not by a test**. A phone-config-shaped scenario in `packages/integration-tests` would close it; that is a separate ticket if anyone wants one, and was explicitly out of scope here.
- **No device run.** Every step in "On a device" above is unexercised. The Maestro flows were not run (they need a device/emulator) and were not changed — none of them touch the closed-strand invite, and all of them address widgets by test id, so the new field between "Bootstrap addr" and "Connect" should not disturb them. Worth a skim by anyone who has the harness up.
- **Accepted regression: ~10 s per strand launch while the relay is down.** Measured, not estimated: the new `solo-founding` founding test takes **10 061 ms** against an unreachable relay versus ~130 ms without one. `strand-instance-manager.ts` → `awaitFirstRelayAttempts` blocks `active` on each supervisor's first attempt, and a refused dial spends the whole `DEFAULT_RELAY_RESERVE_TIMEOUT_MS` (10 s) polling in case libp2p's own discovery lands a reservation anyway. `start()` pays the same once. **Accepted rather than shortened**, because there is no per-node knob for it: `startRelaySupervisors` passes only `beforeRedrive`, and `NetworkConfig` has no reserve-timeout field — shortening it would mean a cadre-core change, a wider blast radius than this ticket's. Founding never *fails*; it is slower, and `founding-progress.ts`'s slow hint surfaces it. Documented in `docs/reference-app-rn.md`.
- **The `reserved`-with-no-multiaddrs branch of `unreachableInviteMessage` is unreachable in practice** (a held reservation *is* a `/p2p-circuit` address) and therefore untested. It exists so the message is never confidently wrong.
- **Two relays are supported by the config but only one is exercised.** `strandNodeAddrs` with two relays is unit-tested; two *different* relays at the two ends of a formation is untested and out of scope (backlog `feat-scenario-two-relay-circuit`).
- **A relay that grants a reservation then refuses to forward** is out of scope, as the plan said: the posture reports `reserved` and the dial fails later.

## Points a reviewer may want to push on

- **The banner stays green when there is no relay.** Argued above and in a comment at `connection-status.ts` → `reachabilitySuffix`. If you disagree, the change is one line, but please weigh the permanent-amber problem.
- **Polling, not events.** `CadreNode` exposes the posture only as a live read, so the banner polls every 5 s in the foreground and not at all in the background. The guard never uses the polled value.
- **`PhoneNodeOptions.relayAddrs` is required, not optional.** Per `AGENTS.md`'s "no backwards compat yet" — it forces every call site to decide. Three call sites updated (Settings and two specs).
- **`resolveRelayAddrs([])` falls back to the env var.** So clearing a prefilled field asks for the build default back, not for "no relay" — on a build that ships the env var, there is then no way to run with no relay at all. Pinned by a test with the reasoning in it; say so if you think an emptied field should mean "none".
- **The cadre-core export addition.** Two lines in `index.ts`. The alternative was asserting on this app's own field names, which proves a spelling rather than a reachability shape.

## Backgrounding and resume — verified, no extra work needed

`background-runner.ts` hibernates strands on background and never calls `node.stop()`, so the control node's reservation supervisor survives; it is stopped only by `stop()` or a later `reserveRelays`. On an OS kill, the runner's cold start re-runs `startPhoneNode(optsRef.current)` — which carries `relayAddrs` — so a fresh drive and a fresh formation responder come up with it. Each strand's supervisors are rebuilt when its runtime is.

**An outstanding invitation needs nothing beyond that**, with one caveat that predates this ticket: the peer id is stable (secure enclave) and the relay is the same, so the circuit addresses the invitation carried still resolve after a resume. But a full **process relaunch** loses `optsRef` entirely — nothing persists start options — so the user must retype the party id *and* the relay before an outstanding invitation is redeemable again. That is `feat-rn-persist-node-start-options`, not new here.

## Tripwires parked in code (not tickets)

- `packages/reference-app-rn/src/phone-node-config.ts`, beside `relayAddrs` — `NOTE:` on the reservation supervisor running while backgrounded: a 5 s local read while the reservation holds (no network), a dial every backoff interval (2 s → 60 s) while it does not. If background battery use ever becomes a complaint, raise `checkMs`/`maxBackoffMs` in cadre-core rather than stopping the supervisor here, which would mean a phone that silently stopped being invitable.

## Docs

- `docs/reference-app-rn.md` — the phone `network` block now shows `relayAddrs` / `requireRelay`, and a new **"Reachability: configuring a relay"** section covers the two sources, a can/cannot table, the never-blocks-startup posture, the ~10 s cost, and the one-relay-per-phone limit.
- `packages/reference-app-rn/README.md` — the trust-model section now opens with a callout that inviting requires a relay (joining does not), and pillar 2's "requires the host reachable" is spelled out for a phone.
- `tickets/backlog/debt-docs-relay-support-reads-more-complete-than-it-is.md` — **still owns the cross-document matrix**; its "the phone apps — never used" row had become false and was corrected in place (split into one row per reference app), with a dated note saying what that ticket still owns. Its `cadre-host.md` link fixes are untouched.

## Not done, deliberately

Relaying through the phone's own always-on cadre node instead of third-party infrastructure — `backlog/feat-phone-relays-through-its-own-always-on-node`, blocked on `backlog/bug-party-run-relay-caps-every-relayed-connection` and `backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it`. The app keeps `network.relayAddrs` whichever source later fills it, so that work is a change of input, not of shape.
