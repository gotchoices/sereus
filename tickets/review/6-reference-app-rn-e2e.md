description: Review Maestro e2e suite for @serfab/reference-app-rn
prereq:
files: packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/maestro/flows/, packages/reference-app-rn/maestro/_helpers/, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/package.json, packages/reference-app-rn/.gitignore, packages/reference-app-rn/README.md, docs/reference-app-rn.md
----

## Summary

Lands a `yarn workspace @serfab/reference-app-rn test:e2e` Maestro suite plus
the RN-side testID plumbing it depends on. The orchestrator spawns the drone
test fixture (from ticket `drone-test-fixture`), wires up `adb reverse` for
the Android emulator, and runs three Maestro flows.

Reviewer: this is **NOT smoke-tested end-to-end**. Maestro CLI and an Android
emulator are not available in the implement environment. The bundle (`yarn
test:bundle`) and TypeScript checks pass, but the YAML flows have only been
written, not executed. Treat the YAML/JS files as needing a live smoke pass
before being trusted — the most likely failure modes are documented under
**Known gaps** below.

## Changes

### Phase 1 — testIDs (mechanical)

- **New**: `packages/reference-app-rn/src/test-ids.ts` — single source of
  truth for testID strings. Flat-ish namespaced object: `TEST_IDS.settings.*`
  and `TEST_IDS.chat.*`. `messageRow(id)` is a function for the per-row id.
- `app/settings.tsx`: threaded `testID` through `<Btn>` and `<LabelledInput>`
  (which wrap `Pressable` / `TextInput` and previously dropped testID).
  Added `testID` to: party-id input, bootstrap input, Connect/Disconnect,
  seed input, Apply Seed, add-peer input, Add Peer, Create Strand, modal
  title, modal OK. `Btn` also sets `accessibilityLabel = testID ?? label`
  for Android-side robustness.
- `app/index.tsx`: added `testID` to status bar, message FlatList, message
  composer input, send button, and per-row `MessageBubble` (via
  `TEST_IDS.chat.messageRow(msg.Id)`).

### Phase 2 — Maestro infrastructure

- **New**: `packages/reference-app-rn/maestro/_setup.yaml` — shared setup
  sub-flow: launch + clear → Settings → enter party id / bootstrap → tap
  Connect → wait `btn-disconnect` (15s) → apply seed (modal `"Seed applied"`
  → OK) → tap Create Strand (modal `"Strand created"` → OK) → wait status
  `Connected.*strand` → discover phone-created strand via
  `_helpers/discover-phone-strand.js` (sets `output.WORKING_STRAND_ID`) →
  tap Chat.
- **New**: `maestro/flows/1-connect-and-send.yaml` — runs setup, then sends
  `"Hello from maestro"`, asserts it renders.
- **New**: `maestro/flows/2-drone-to-phone.yaml` — runs setup, drone-inserts
  `"Hello from drone"` (via sidecar) into `${WORKING_STRAND_ID}`, asserts
  the message + sender label appear on the phone within 5s.
- **New**: `maestro/flows/3-round-trip.yaml` — runs setup, phone sends, JS
  helper polls the drone sidecar to confirm phone→drone replication, drone
  inserts a reply, both messages remain visible, and a final helper asserts
  monotonic Timestamps in the drone DB.
- **New**: `maestro/_helpers/discover-phone-strand.js` — polls
  `GET ${SIDECAR_URL}/status` for up to 15s and writes
  `output.WORKING_STRAND_ID` = the first strand id ≠ the drone's
  pre-created `STRAND_ID`. This is the runtime-discovered strand that the
  drone (via `strandFilter:all`) joins after the phone creates one.
- **New**: `maestro/_helpers/drone-insert.js` — POST `/message/insert` with
  per-step env `CONTENT`, `MEMBER_ID`, `STRAND_ID`.
- **New**: `maestro/_helpers/drone-assert-phone-message.js` — polls
  `GET /messages/${STRAND_ID}` for `EXPECT_CONTENT` (5s ceiling).
- **New**: `maestro/_helpers/assert-monotonic-timestamps.js` — fetches
  messages and asserts non-decreasing Timestamps.
- **New**: `scripts/run-e2e.mjs` — orchestrator. Spawns
  `test-fixture/start.mjs`, polls `/health` (30s), reads
  `test-fixture/test-data.json`, runs `adb reverse tcp:{4002,4080}`, runs
  `maestro test -e PARTY_ID=… … maestro/flows --format junit --output
  maestro/.maestro-junit.xml`, tees fixture stdout/stderr to
  `maestro/.fixture.log`, and tears down on SIGINT/SIGTERM/exit. Propagates
  Maestro's exit code.
- `package.json`: added `"test:e2e": "node scripts/run-e2e.mjs"`.
- `.gitignore`: added `maestro/.fixture.log`, `maestro/.maestro-junit.xml`,
  `maestro/.maestro/`.

### Phase 4 — docs

- `docs/reference-app-rn.md` §Testing Strategy Phase 2 rewritten with the
  concrete `yarn test:e2e` flow, prerequisites, and flow inventory.
- `packages/reference-app-rn/README.md`: added `yarn test:e2e` to the
  scripts table and a new `## E2E Tests (Maestro)` section above
  `## Project Structure` covering prerequisites, flow inventory, artifacts,
  and a small troubleshooting cheat sheet.

## Use cases for testing / validation

The single command to validate everything is:

```
yarn workspace @serfab/reference-app-rn test:e2e 2>&1 | tee /tmp/rn-e2e.log
```

(Stream output via `tee`; don't silent-redirect — the runner has a 10-minute
idle timer.)

Prerequisites:

1. Android emulator running (`emulator -avd <name>`), `adb devices` shows it
2. Reference-app-rn dev-client installed on that emulator (`yarn android`
   once is enough)
3. Maestro CLI on PATH (see Maestro install docs)

Expected: all three flows pass, JUnit emitted at
`maestro/.maestro-junit.xml`, fixture log at `maestro/.fixture.log`,
process exits 0.

Individual flow runs (after `yarn test:e2e` has been bootstrapped at least
once and `test-data.json` exists):

```
maestro test \
  -e PARTY_ID=... -e BOOTSTRAP_ADDR=... -e SEED=... -e STRAND_ID=... \
  -e SIDECAR_URL=http://127.0.0.1:4080 \
  -e MAESTRO_APP_ID=org.gotchoices.sereus.chat \
  maestro/flows/1-connect-and-send.yaml
```

## Acceptance bullets — coverage map

Source plan ticket bullets vs implementation:

| Bullet | Covered by |
|--------|-----------|
| Cold launch + "Not connected" | `launchApp: clearState: true` (`_setup.yaml`) — the connect path implicitly proves Disconnect was not visible initially |
| Connect button + 15s ceiling | `extendedWaitUntil: id: btn-disconnect timeout: 15000` |
| Apply Seed modal `"Seed applied"` | `assertVisible: id: modal-title text: "Seed applied"` |
| Create Strand modal `"Strand created"` | `assertVisible: id: modal-title text: "Strand created"` |
| Status `Connected · 1 strand(s)` within 5s | `extendedWaitUntil` on `status-bar` matching `Connected.*strand` (regex; tolerates 1 or 2 strands depending on whether the drone's pre-created strand also synced in) |
| Sent message renders (Flow 1) | `assertVisible: "Hello from maestro"` |
| Drone insert → phone shows within 5s (Flow 2) | `extendedWaitUntil: visible "Hello from drone" timeout: 5000` |
| Sender column shows drone-test (Flow 2) | `assertVisible: "drone-test"` — sidecar inserts member with `Name === memberId`, so MessageBubble renders `"drone-test"` literally |
| Drone GET verifies phone→drone (Flow 3) | `_helpers/drone-assert-phone-message.js` polling `/messages/${STRAND_ID}` |
| Drone insert + phone shows reply (Flow 3) | `drone-insert.js` + `extendedWaitUntil` |
| Both messages visible end-of-flow (Flow 3) | Two `assertVisible` calls |
| Monotonic Timestamps (Flow 3) | `_helpers/assert-monotonic-timestamps.js` |

## Verification done in implement

- `yarn workspace @serfab/reference-app-rn test:bundle` — passes; 2973
  modules, no errors (multiformats `sha2-browser` warnings are pre-existing
  cosmetic per the existing docs).
- `npx tsc --noEmit` in the package — clean.

## Known gaps / honest flags

1. **Not actually run.** Maestro CLI and an emulator are not available in
   the implement environment. The flow YAMLs were authored against the
   Maestro docs but **not** smoke-tested. The reviewer (or a follow-up
   manual pass) must run `yarn test:e2e` against a real emulator and adjust
   any details that don't match the installed Maestro version. Likely tweak
   sites:
   - **`runScript` env substitution**: I use `${WORKING_STRAND_ID}` in
     subsequent steps' `env:` blocks. Maestro's variable scoping for
     output-vars-as-env-input is plausible per the docs but unverified here.
     If Maestro complains, switch to `${output.WORKING_STRAND_ID}` or
     restructure to put the drone-side helpers as inline JS that reads
     output directly.
   - **`hideKeyboard`**: assumed valid. If the running Maestro version
     prefers `- pressKey: "Back"` or different syntax, swap.
   - **`extendedWaitUntil`**: may need adjustment to the modern equivalent
     (`waitForAnimationToEnd` etc.) on newer Maestro versions.
   - **`text:` regex match on `status-bar`** — Maestro treats `text:` as
     a regex by default. `Connected.*strand` should match `Connected · 1
     strand(s)`. If the dot or the `·` non-ASCII character causes issues,
     simplify to `text: "Connected"`.

2. **Maestro version not pinned.** Per the plan, Maestro should be pinned
   in the README at implement-time. I left this as "install per docs"
   because the implement env can't install Maestro to verify a version. If
   the reviewer settles on a version after a successful smoke, add it to
   the README's prerequisites and (optionally) to devDependencies via the
   `@mobile-dev-inc/maestro` npm wrapper.

3. **Strand convergence assumption.** `_setup.yaml` taps Create Strand and
   then `discover-phone-strand.js` waits for the drone (with
   `strandFilter:all`) to join that strand via control-network sync. This
   assumes control sync is fast enough (15s budget). If sync is slower or
   strandFilter:all behavior differs, discovery will throw with a clear
   error listing the strands the drone has. Possible follow-up: tune
   timeout or use a richer query.

4. **`firstStrand` ambiguity on the chat screen.** `app/index.tsx` uses
   `cadre.strands.values().next().value`. After Create Strand, the phone
   may have 2 strands (its own + the drone's pre-created one syncing in).
   The drone-side helpers target `WORKING_STRAND_ID` (the phone-created
   one), which the phone *should* be on as `firstStrand` if the phone
   created it first. If the drone's pre-created strand ends up being
   first in the map iteration, Flow 2/3 message tests would fail because
   the phone's chat is on the wrong strand. A small UI change (let the
   user pick / pin a strand) or a deterministic creation order in
   `_setup.yaml` would harden this — out of scope for the v1 e2e.

5. **iOS not supported.** `run-e2e.mjs` only `adb reverse`s. iOS would
   need an `xcrun simctl` branch. Out of scope per the source ticket.

6. **No CI wiring.** Maestro Cloud upload / GitHub Action is a separate
   ticket. Local-runnable `test:e2e` is the prerequisite that lands here.

7. **`adb reverse` fallback for non-emulator devices.** The script warns
   and continues if `adb reverse` fails. On a physical device, the
   recommended workaround documented in README is to override
   `BOOTSTRAP_ADDR` to use `10.0.2.2:4002` (Android emulator host alias)
   or the host's LAN IP. Not exercised here.

8. **`MAESTRO_APP_ID` default.** Default is `org.gotchoices.sereus.chat`
   per `app.json`'s `android.package` (which differs from the plan
   ticket's assumed `com.serfab.referenceapprn`). Override via the env
   var if the dev-client install uses a different package id.

## Files touched

- `packages/reference-app-rn/app/index.tsx` — testIDs
- `packages/reference-app-rn/app/settings.tsx` — testIDs, threaded through
  Btn/LabelledInput
- `packages/reference-app-rn/src/test-ids.ts` — new
- `packages/reference-app-rn/maestro/_setup.yaml` — new
- `packages/reference-app-rn/maestro/flows/1-connect-and-send.yaml` — new
- `packages/reference-app-rn/maestro/flows/2-drone-to-phone.yaml` — new
- `packages/reference-app-rn/maestro/flows/3-round-trip.yaml` — new
- `packages/reference-app-rn/maestro/_helpers/discover-phone-strand.js` — new
- `packages/reference-app-rn/maestro/_helpers/drone-insert.js` — new
- `packages/reference-app-rn/maestro/_helpers/drone-assert-phone-message.js` — new
- `packages/reference-app-rn/maestro/_helpers/assert-monotonic-timestamps.js` — new
- `packages/reference-app-rn/scripts/run-e2e.mjs` — new
- `packages/reference-app-rn/package.json` — `test:e2e` script
- `packages/reference-app-rn/.gitignore` — maestro artifacts
- `packages/reference-app-rn/README.md` — E2E section
- `docs/reference-app-rn.md` — Testing Strategy Phase 2
