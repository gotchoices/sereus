description: End-to-end test flows for the RN reference chat app — connect, seed, strand creation, send, and bidirectional drone-phone sync
prereq: drone-test-fixture
files: packages/reference-app-rn/, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/test-fixture/, docs/reference-app-rn.md
----

## Context

`@serfab/reference-app-rn` is the phone-side validation surface for the Sereus cadre stack: a transaction-profile CadreNode dialing a storage-profile drone over WebSocket + circuit relay, sharing strands keyed by a Party ID, with `Member` and `Message` tables on Optimystic + Quereus. The web sibling is covered by `reference-app-web-e2e`; this is the RN counterpart.

The `drone-test-fixture` ticket landed a controllable drone process with an HTTP sidecar (`/message/insert`, `/messages/:strandId`, plus test-data emission) so tests can drive drone-side actions deterministically. This ticket is **framework-agnostic** — it specifies the flows, assertions, and accessibility hooks. The runner choice (Maestro, Detox, Appium, or a successor) is a planning concern.

## Scope

Three flows that exercise the full chat stack end-to-end against the drone fixture, plus the shared connection setup they all depend on.

### Flow 1 — Seed, create strand, send

**Preconditions**: drone fixture running, `test-data.json` (party ID, drone bootstrap multiaddr, seed) emitted by the fixture and readable by the runner.

Behavioural sequence:

- Cold launch → Chat tab visible, status reads "Not connected" (or equivalent idle state).
- Navigate to Settings.
- Enter party ID and bootstrap addr from `test-data.json`; tap **Connect**.
- Status transitions `idle → connecting → connected` within a bounded wait (15 s ceiling).
- Paste seed; tap **Apply Seed**; confirmation surfaces ("Seed applied" or equivalent).
- Tap **Create Chat Strand**; confirmation surfaces ("Strand created").
- Return to Chat tab; status bar shows "Connected · 1 strand(s)" within a bounded wait (5 s).
- Type "Hello from <runner>"; tap **Send**.
- Assert: the sent message renders in the message list with the local member as sender.

### Flow 2 — Drone → phone delivery

**Preconditions**: app connected with at least one strand (chain from Flow 1 or run the shared setup as a sub-flow).

Behavioural sequence:

- Drone-side: invoke the fixture sidecar `POST /message/insert` with `{ strandId, memberId: "drone-test", content: "Hello from drone" }`.
- Phone-side: within the poll window (≤ 5 s — current poll interval is 2 s), the message appears in the chat list.
- Sender column shows `drone-test` (or a deterministic truncation of the drone member id).

### Flow 3 — Round-trip

**Preconditions**: connected with a strand.

Behavioural sequence:

- Send "Phone says hi" from the phone UI.
- Drone-side: `GET /messages/:strandId` returns a list containing the phone-authored message (verifies the phone→drone direction independently of the next step).
- Drone-side: `POST /message/insert` with `"Drone replies"`.
- Phone-side: within 5 s, "Drone replies" appears in the chat list.
- Both messages are visible in the phone's chat list; ordering reflects send order (last-write-wins on equal timestamps is acceptable — assertion is set-membership plus a monotonic-timestamp check, not strict equality).

## Shared setup

The three flows all need: connect → apply seed → create strand → land on Chat. The runner should express this as a reusable sub-flow so individual flows declare it as a prerequisite rather than copy-pasting.

Inputs to the sub-flow are sourced from the fixture's `test-data.json` (path resolved via env var, e.g. `TEST_DATA_PATH`, with a sensible default at `packages/reference-app-rn/test-fixture/test-data.json`). The fixture sidecar URL is similarly env-configurable (e.g. `SIDECAR_URL`, default `http://localhost:4080`).

## Test accessibility

The app today uses `placeholder` and `label` props but no stable test hooks. Add React Native `testID` props before/during implementation — text-based locators are fragile across copy changes and i18n. Inventory (settle final names at implement time, but the surface area is fixed):

| Element                | testID                | Screen   |
|------------------------|-----------------------|----------|
| Party ID input         | `input-party-id`      | Settings |
| Bootstrap addr input   | `input-bootstrap-addr`| Settings |
| Connect button         | `btn-connect`         | Settings |
| Seed input             | `input-seed`          | Settings |
| Apply Seed button      | `btn-apply-seed`      | Settings |
| Create Strand button   | `btn-create-strand`   | Settings |
| Add Peer input/button  | `input-add-peer` / `btn-add-peer` | Settings |
| Status bar             | `status-bar`          | Chat     |
| Message input          | `input-message`       | Chat     |
| Send button            | `btn-send`            | Chat     |
| Message list           | `message-list`        | Chat     |
| Message row            | `message-row-<id>`    | Chat     |

Per-row testIDs let the drone→phone delivery assertion locate a specific message rather than fuzzy-matching across the list.

## Non-goals

- Multi-phone simulation. Phone↔phone convergence is implicit in the drone-mediated sync but not asserted directly here.
- iOS coverage if the chosen runner targets Android only. Cross-platform parity is a follow-up.
- Performance / load / soak.
- Visual regression / screenshot diffing.
- Tests that require a non-fixture cluster (real WAN drone, multi-storage-node cadre).

## Constraints & considerations

- **Runner-agnostic spec**: the planning stage picks the runner. Maestro (YAML flows + `runScript` for sidecar calls) and Detox (JS test files with full programmatic control) are the two realistic candidates today; the choice has consequences for CI image cost, debuggability, and how drone-side HTTP calls are invoked. Whichever lands, the flows above must be expressible without restructuring.
- **Drone-side actions need programmatic access**: every realistic RN e2e runner can shell out or `fetch()` from a test step. The sidecar HTTP API (from `drone-test-fixture`) is the contract; tests should not reach into the drone's process state directly.
- **Bounded waits, no fixed sleeps**: each "within N seconds" assertion uses a polling wait with a ceiling, not `sleep(N)`. The 2 s poll interval is the lower bound; 5 s is a safe upper bound for the message-arrival assertions; the connection wait is generous (15 s) because libp2p dial + relay reservation can be slow on first contact.
- **Emulator coupling**: Android emulator vs. real device vs. iOS simulator each have networking quirks (loopback vs. LAN IP, `adb reverse` for Metro, host.docker.internal in CI). The ticket assumes the chosen runner already documents emulator startup as part of `ci-pipeline-<runner>`; this ticket builds on top of that.
- **Idle-timeout discipline (per tess/agent-rules)**: stream test runner output (`yarn test:e2e 2>&1 | tee /tmp/rn-e2e.log`); don't silently redirect.
- **Storage layer**: the recent MMKV → LevelDB migration changed how messages persist locally. Tests should not assume the on-disk format — assert against the UI surface only.

## Acceptance

- A `yarn workspace @serfab/reference-app-rn test:e2e` (or equivalent) script runs all three flows end-to-end against the drone fixture and exits zero.
- Each flow's assertions cover every bullet under its **Behavioural sequence**.
- Stable `testID` hooks are present on every element listed in the inventory.
- `docs/reference-app-rn.md` (or the app's README) gains a short section on running the e2e suite locally — emulator setup, fixture startup, the env vars the runner reads.
- The test runner is picked at planning time; the flow specs above survive the choice.
