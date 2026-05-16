description: Maestro e2e suite for @serfab/reference-app-rn — connect/seed/strand, drone→phone delivery, round-trip
prereq: drone-test-fixture
files: packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/maestro/, packages/reference-app-rn/scripts/, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/reference-app-rn/package.json, packages/reference-app-rn/.gitignore, docs/reference-app-rn.md
----

## Goal

Land an executable `yarn workspace @serfab/reference-app-rn test:e2e` Maestro suite that runs the three flows specified in the source plan ticket (`tickets/complete/6-reference-app-rn-e2e.md` after this lands) against a locally-started drone test fixture, and exits zero.

## Runner choice — Maestro

Picked over Detox for these reasons; the source ticket explicitly leaves the choice to planning, this is the recorded rationale:

- **No local native tooling.** The app's stated invariant (`docs/reference-app-rn.md` Goals §3) is "no Xcode / Android Studio required locally." Detox needs a Detox-enabled native build (`detox build`), which forces local Gradle / `prebuild`. Maestro drives an existing APK/AAB installed via `adb install` or `expo install` against a Maestro-instrumented build is *not* required — Maestro talks to the device through UIAutomator/XCUITest, no app-side instrumentation.
- **Sidecar HTTP fits Maestro's `runScript`.** All drone-side actions in the three flows are HTTP calls to `localhost:4080`. Maestro YAML `runScript` blocks can shell out to `curl` (or a tiny Node helper), so flows stay declarative without dropping into JS.
- **Cloud CI path is established.** `docs/reference-app-rn.md` §Testing Strategy already names Maestro Cloud as the CI target.
- **Small surface area.** Three flows + one shared setup is the sweet spot for YAML; Detox's full programmatic power is overkill here.

Detox can be revisited if/when (a) we add convergence/property tests that need fine-grained timing control, (b) we want JS-level assertions on internal state beyond the UI surface, or (c) Maestro Cloud pricing becomes a blocker. None apply today.

## Architecture

```
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ yarn workspace …rn test:e2e  │        │ test-fixture/start.mjs         │
│  └─ scripts/run-e2e.mjs      │──spawn─▶│  CadreNode + HTTP sidecar      │
│      • start drone fixture   │        │  writes test-data.json          │
│      • wait for /health      │        │  port 4080 sidecar, 4002 WS    │
│      • launch maestro test   │        └────────────────────────────────┘
│      • teardown on exit      │
└──────────────────────────────┘                     ▲
              │                                       │ POST /message/insert
              ▼                                       │ GET  /messages/:id
┌──────────────────────────────┐                     │ (via maestro runScript)
│ Android emulator (dev client)│                     │
│  @serfab/reference-app-rn    │                     │
│   ◀── adb reverse :4002 :4080──────────────────────┘
│                              │
│  Maestro driver:             │
│   maestro/flows/             │
│     1-connect-and-send.yaml  │
│     2-drone-to-phone.yaml    │
│     3-round-trip.yaml        │
│   maestro/_setup.yaml        │  (shared sub-flow)
│   maestro/_helpers/load-test-data.sh
└──────────────────────────────┘
```

### Process orchestration (`scripts/run-e2e.mjs`)

Single Node entry point so the workspace script is one command. Responsibilities:

1. Spawn `node test-fixture/start.mjs` as a child process with `stdio: ['ignore', 'pipe', 'pipe']`; tee both streams to stdout *and* `packages/reference-app-rn/maestro/.fixture.log`.
2. Poll `GET http://127.0.0.1:${DRONE_HTTP_PORT}/health` for up to 30 s; bail if it never goes 200.
3. Verify `test-fixture/test-data.json` exists (start.mjs writes it after sidecar bind).
4. Run `adb reverse tcp:4002 tcp:4002` and `adb reverse tcp:4080 tcp:4080` so the emulator can reach the host-bound sidecar and WS listener. (Skip cleanly if `adb` is missing or no device — surface a useful message.)
5. Spawn `maestro test maestro/flows --format junit --output maestro/.maestro-junit.xml` (or whatever flag is current; pin a version in §Dependencies).
6. On any exit signal (SIGINT/SIGTERM/normal/exception) tear down the fixture child via `SIGTERM` → 3 s grace → `SIGKILL`, and `adb reverse --remove-all`.
7. Propagate maestro's exit code as the script's exit code.

The script must **not** swallow fixture stderr — drone-side errors during a flow are the most common debugging signal. Stream-tee, don't redirect.

### Fixture configuration

The fixture already writes `packages/reference-app-rn/test-fixture/test-data.json` with `{ partyId, droneBootstrapAddr, seed, strandId }`. The Maestro flows source this file via a tiny helper script (`maestro/_helpers/load-test-data.sh`) so flows reference fields by name, not magic strings.

Env vars consumed (with defaults):

| Var | Default | Purpose |
|-----|---------|---------|
| `DRONE_WS_PORT` | `4002` | Pass through to start.mjs |
| `DRONE_HTTP_PORT` | `4080` | Pass through to start.mjs; also where Maestro flows curl |
| `TEST_DATA_PATH` | `packages/reference-app-rn/test-fixture/test-data.json` | Where the helper reads test data from |
| `SIDECAR_URL` | `http://127.0.0.1:4080` | What the helper / flows curl against |
| `MAESTRO_APP_ID` | `com.serfab.referenceapprn` | Maestro `appId` for `launchApp` (verify against `app.json` during impl) |

### Test accessibility — testIDs

Mechanical edit on the RN side. No behaviour changes. Add `testID` props per the inventory below. Keep one source of truth: define the IDs as exported string constants in a new `src/test-ids.ts` so both the components and any future programmatic consumers reference the same names.

| Element                | testID                       | Screen   | File:line(s) (approx)               |
|------------------------|------------------------------|----------|-------------------------------------|
| Party ID input         | `input-party-id`             | Settings | `settings.tsx` party-id `<LabelledInput>` |
| Bootstrap addr input   | `input-bootstrap-addr`       | Settings | `settings.tsx` bootstrap `<LabelledInput>` |
| Connect button         | `btn-connect`                | Settings | `settings.tsx` Connect `<Btn>`      |
| Disconnect button      | `btn-disconnect`             | Settings | `settings.tsx` Disconnect `<Btn>`   |
| Seed input             | `input-seed`                 | Settings | `settings.tsx` seed `<LabelledInput>` |
| Apply Seed button      | `btn-apply-seed`             | Settings | `settings.tsx` Apply Seed `<Btn>`   |
| Add Peer input         | `input-add-peer`             | Settings | `settings.tsx` peer `<LabelledInput>` |
| Add Peer button        | `btn-add-peer`               | Settings | `settings.tsx` Dial Peer `<Btn>`    |
| Create Strand button   | `btn-create-strand`          | Settings | `settings.tsx` Create Chat Strand `<Btn>` |
| Status bar             | `status-bar`                 | Chat     | `index.tsx` status `<View>`         |
| Message input          | `input-message`              | Chat     | `index.tsx` composer `<TextInput>`  |
| Send button            | `btn-send`                   | Chat     | `index.tsx` send `<Pressable>`      |
| Message list           | `message-list`               | Chat     | `index.tsx` `<FlatList>`            |
| Message row            | `message-row-<id>`           | Chat     | `index.tsx` `renderItem` outer `<View>` |
| Modal title (alert)    | `modal-title`                | Settings | `settings.tsx` modal `<Text>`       |
| Modal OK button        | `btn-modal-ok`               | Settings | `settings.tsx` modal `<Btn>`        |

Per-row testID — pass `testID={\`message-row-\${item.Id}\`}` on `MessageBubble`'s outer `View`. The `<Btn>` wrapper does not currently accept `testID`; thread it through (and same for `<LabelledInput>`).

Note: Maestro defaults to matching by accessibility label / visible text on RN. `testID` becomes the accessibility identifier on iOS automatically; on Android, RN forwards `testID` to `View.setTag` which Maestro reads via `viewTag` / `id`. For maximum portability also set `accessibilityLabel` to the same value on the buttons (the inputs already have visible labels). The implementer should verify on a real Android run — if Maestro's `id:` selector matches `testID` cleanly there's no need for the duplicate `accessibilityLabel`.

## Maestro flows

### Shared sub-flow: `maestro/_setup.yaml`

```yaml
appId: ${MAESTRO_APP_ID}
---
- runScript: _helpers/load-test-data.sh   # exports PARTY_ID, BOOTSTRAP_ADDR, SEED, STRAND_ID via maestro output
- launchApp:
    clearState: true
- tapOn: "Settings"
- tapOn:
    id: "input-party-id"
- inputText: ${output.PARTY_ID}
- tapOn:
    id: "input-bootstrap-addr"
- inputText: ${output.BOOTSTRAP_ADDR}
- tapOn:
    id: "btn-connect"
- extendedWaitUntil:
    visible:
      id: "btn-modal-ok"   # "Connection failed" surfaces as a modal — bail loud if it appears
    timeout: 0             # immediate check, no wait — only triggers on instant failure
    optional: true
- assertVisible:
    id: "btn-disconnect"   # presence flips when status === 'connected'
    timeout: 15000
- tapOn:
    id: "input-seed"
- inputText: ${output.SEED}
- tapOn:
    id: "btn-apply-seed"
- assertVisible:
    id: "modal-title"
    text: "Seed applied"
- tapOn:
    id: "btn-modal-ok"
- tapOn:
    id: "btn-create-strand"
- assertVisible:
    id: "modal-title"
    text: "Strand created"
- tapOn:
    id: "btn-modal-ok"
- tapOn: "Chat"
- assertVisible:
    id: "status-bar"
- extendedWaitUntil:
    visible:
      id: "status-bar"
      text: "Connected.*1 strand"
    timeout: 5000
```

> The `extendedWaitUntil` with `timeout: 0, optional: true` modal-detection trick is the standard Maestro way to fail fast on an unexpected error modal without blocking the happy path. Verify the exact flag name during implement against the Maestro version pinned in §Dependencies; rename if needed.

### Flow 1: `flows/1-connect-and-send.yaml`

```yaml
appId: ${MAESTRO_APP_ID}
---
- runFlow: ../_setup.yaml
- tapOn:
    id: "input-message"
- inputText: "Hello from maestro"
- tapOn:
    id: "btn-send"
- assertVisible:
    text: "Hello from maestro"
```

Per-bullet coverage against the source ticket:

- Cold launch + "Not connected" → covered by `clearState: true` and the `btn-disconnect`-not-visible precondition implicit in tapping Connect.
- Connect button + 15 s ceiling → `assertVisible: btn-disconnect timeout: 15000`.
- Apply Seed confirmation → modal text `"Seed applied"`.
- Create Strand confirmation → modal text `"Strand created"`.
- Status `Connected · 1 strand(s)` within 5 s → `extendedWaitUntil` on status-bar text.
- Sent message renders → `assertVisible: text: "Hello from maestro"`. (The message list polls + the optimistic update in `use-chat.ts:127` mean local echo is near-instant, but Maestro waits up to its default 7 s implicitly.)

### Flow 2: `flows/2-drone-to-phone.yaml`

```yaml
appId: ${MAESTRO_APP_ID}
---
- runFlow: ../_setup.yaml
- runScript: ../_helpers/drone-insert.sh
    env:
      CONTENT: "Hello from drone"
      MEMBER_ID: "drone-test"
- extendedWaitUntil:
    visible:
      text: "Hello from drone"
    timeout: 5000
- assertVisible:
    text: "drone-t"          # MessageBubble renders MemberName ?? MemberId.slice(-6) for non-own
```

`drone-insert.sh` curls `POST $SIDECAR_URL/message/insert` with `{ strandId: $STRAND_ID, memberId: $MEMBER_ID, content: $CONTENT }`. Reads `STRAND_ID` from `TEST_DATA_PATH` if not already in env.

Per-bullet:
- Within poll window (≤ 5 s) → `extendedWaitUntil timeout: 5000`. The poll interval is 2000 ms (`use-chat.ts:50`), so one full poll fits inside 5 s with margin.
- Sender column shows drone-test / truncation → asserted via the last 6 chars (`drone-t…`, since `'drone-test'.slice(-6) === 'e-test'` — adjust the assertion text to the actual slice during implement, or assert on the full `drone-test` if `MemberName` is set; the sidecar's `insertMessage` does `insert or ignore into Member (Id, Name) values (?, ?)` with `memberId` as both, so `MemberName === 'drone-test'` and the bubble renders `'drone-test'` literally).

### Flow 3: `flows/3-round-trip.yaml`

```yaml
appId: ${MAESTRO_APP_ID}
---
- runFlow: ../_setup.yaml
- tapOn:
    id: "input-message"
- inputText: "Phone says hi"
- tapOn:
    id: "btn-send"
- assertVisible: "Phone says hi"
- runScript: ../_helpers/drone-assert-phone-message.sh
    env:
      EXPECT_CONTENT: "Phone says hi"
- runScript: ../_helpers/drone-insert.sh
    env:
      CONTENT: "Drone replies"
      MEMBER_ID: "drone-test"
- extendedWaitUntil:
    visible:
      text: "Drone replies"
    timeout: 5000
- assertVisible: "Phone says hi"   # still there → both visible
```

`drone-assert-phone-message.sh` curls `GET $SIDECAR_URL/messages/$STRAND_ID`, jq-greps for `EXPECT_CONTENT` in the returned `messages[].Content`, exits 0 if found within a short poll loop (up to 5 s — same convergence ceiling), nonzero with diagnostic otherwise.

Per-bullet:
- Drone GET verifies phone→drone direction → `drone-assert-phone-message.sh`.
- Drone insert + phone shows within 5 s → covered.
- Both messages visible in chat list + monotonic ordering — strict order assertion is brittle (last-write-wins on equal timestamps is allowed per source ticket); the two `assertVisible` calls cover set-membership. For the monotonicity check, add a `runScript` step after the final assert that hits `GET /messages/:strandId` and verifies `Timestamp` is non-decreasing across the two seeded contents. Keep this in the drone-side helper, not in YAML — jq does it in one line.

## TODO

### Phase 1 — testID plumbing

- Create `packages/reference-app-rn/src/test-ids.ts` exporting the table above as constants (`TEST_IDS.input.partyId` etc., or flat — pick one and stay consistent).
- Thread `testID` through `<Btn>` and `<LabelledInput>` in `app/settings.tsx` (these wrap `Pressable` / `TextInput` and currently drop testID props).
- Add `testID` to every element in the inventory in `app/index.tsx` and `app/settings.tsx`, sourced from the new constants module.
- Add `accessibilityLabel` matching `testID` on the buttons (belt-and-suspenders for Android — remove if implement run shows it's redundant).
- `expo export --platform android` (`yarn test:bundle`) passes — sanity check that the props don't break the bundle.

### Phase 2 — Maestro infra

- Add `maestro` (CLI) to devDependencies — pin to a current stable (e.g. `^1.39` as of writing; confirm latest at implement time and pin exactly). Maestro is distributed as a JVM binary; the npm package `@mobile-dev-inc/maestro` is a wrapper. If npm wrapper feels brittle prefer a check-shellscript-and-fail-loud approach in `run-e2e.mjs` ("install maestro: …").
- Create `packages/reference-app-rn/maestro/` with the three flow YAMLs, `_setup.yaml`, and `_helpers/` shell scripts described above.
- Create `packages/reference-app-rn/scripts/run-e2e.mjs` per §Process orchestration.
- Add `test:e2e` script to `package.json`: `"test:e2e": "node scripts/run-e2e.mjs"`.
- `.gitignore`: `maestro/.fixture.log`, `maestro/.maestro-junit.xml`, `maestro/.maestro/` (Maestro cache), and `test-fixture/test-data.json` (already?  verify; if not, add).

### Phase 3 — Local smoke

- With an Android emulator running and the dev client APK installed, run `yarn workspace @serfab/reference-app-rn test:e2e` and confirm all three flows pass.
- Stream output via `tee` (`yarn workspace @serfab/reference-app-rn test:e2e 2>&1 | tee /tmp/rn-e2e.log`) — never silent redirect (idle-timeout rule).
- If any flow times out on the connection step (15 s), the failure mode is almost certainly libp2p dial failure to `127.0.0.1` via `adb reverse` — check the fixture log for an inbound connection attempt; if the emulator can't reach the host loopback that way the fallback is `10.0.2.2` (Android emulator's host alias) which means rewriting `droneBootstrapAddr` before injecting into the app. Note this in the README only if it bites.

### Phase 4 — Docs

- Update `docs/reference-app-rn.md` §Testing Strategy / Phase 2: replace "use Maestro (or Detox) flows to:" with concrete: pointer to `yarn test:e2e`, env vars, prerequisites (emulator running, dev-client APK installed, Maestro CLI installed). Drop the "or Detox" alt now that the choice is locked.
- Add a short README section to the RN package: how to run, what gets started, where logs land.

### Phase 5 — Acceptance

- `yarn workspace @serfab/reference-app-rn test:e2e` exits 0 with all three flows green against a clean emulator and fresh dev-client install.
- Every behavioural bullet from the source plan ticket is covered by an explicit assertion (cross-check during implement; produce a small mapping in the review handoff).
- `yarn test:bundle` still passes (no testID prop typing regression).
- README / docs updated.

## Out of scope (re-affirmed from the source ticket)

- iOS coverage. Maestro supports it but adds an `xcrun simctl` orchestration branch in `run-e2e.mjs` — defer to a follow-up.
- Multi-phone simulation, performance, visual regression, non-fixture clusters.
- CI wiring (Maestro Cloud upload, GitHub Action). The local-runnable `test:e2e` script is the prerequisite; CI is a separate ticket.

## Risks / open questions noted, not blockers

- **adb reverse for the WS dial.** The Android emulator can reach the host via `10.0.2.2`; `adb reverse` is more conventional for inbound device→host traffic and is what RN/Metro uses. The drone's listen-addr is `/ip4/127.0.0.1/tcp/4002/ws`, which on the device will resolve to the device's own loopback (i.e. nothing). Two valid fixes: (1) `adb reverse tcp:4002 tcp:4002` so the device's `127.0.0.1:4002` tunnels to host; (2) rewrite the `droneBootstrapAddr` in `test-data.json` from `127.0.0.1` to `10.0.2.2` before injecting. The plan picks (1) because it survives unmodified test-data and keeps the multiaddr stable across runner types. If (1) fails on a real device (not emulator), document the (2) fallback in README.
- **Maestro version pin.** Maestro YAML schema has moved over the last year (`extendedWaitUntil` vs `waitForAnimationToEnd` etc.). Pin exactly at implement time and note the version in the README so flows don't silently break on a CLI upgrade.
- **Sidecar binding.** `start.mjs` already binds the sidecar to `0.0.0.0:4080`, which is correct for `adb reverse`. The WS listener is `127.0.0.1:4002`, which is fine for the *libp2p dial path* because `adb reverse` tunnels regardless of bind addr on the device side. No fixture changes anticipated; flag any if implementation reveals otherwise.
