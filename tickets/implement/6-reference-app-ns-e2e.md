description: Add the @serfab/reference-app-ns e2e suite (Maestro flows reusing the RN drone fixture + sidecar), centralised test IDs on the NativeScript UI, a run-e2e orchestrator, and the docs/reference-app-ns.md + README + architecture cross-reference.
prereq: reference-app-ns-chat
files: packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/test-fixture/start.mjs, packages/reference-app-rn/test-fixture/sidecar.mjs, packages/reference-app-rn/test-fixture/drone.fixture.yaml, packages/reference-app-rn/maestro/, packages/reference-app-rn/src/test-ids.ts, docs/reference-app-rn.md, docs/architecture.md
----

## Goal

Give `@serfab/reference-app-ns` an automated e2e target at parity with the RN app's Maestro
suite, **reusing the RN drone fixture + HTTP sidecar verbatim** (only the client-driving layer
is new), plus the documentation deliverables.

## Resolved design decisions (from the plan stage)

### E2E driver → Maestro (Appium documented fallback)

Maestro is black-box and app-agnostic; it drives a NativeScript-built APK/IPA the same way it
drives the RN app — the `appId` matches the `id` in `nativescript.config.ts`. The Maestro flows
and helpers depend only on **test IDs**, not on the runtime, so the RN `maestro/flows/*.yaml`,
`maestro/_setup.yaml`, and `maestro/_helpers/*.js` are reusable with at most an `appId` change.

**Test-ID mechanism (the one real NS-specific risk).** RN sets `testID`; NativeScript has no
`testID`. On NativeScript Core, set **`automationText`** (legacy → maps to Android
`contentDescription` / iOS `accessibilityIdentifier`) and/or **`accessibilityIdentifier`** on each
interactive element, using the **exact same string values** as RN's `src/test-ids.ts`
(`input-party-id`, `input-bootstrap-addr`, `btn-connect`, `btn-disconnect`, `input-seed`,
`btn-apply-seed`, `input-add-peer`, `btn-add-peer`, `btn-create-strand`, `modal-title`,
`btn-modal-ok`, `status-bar`, `input-message`, `btn-send`, `message-list`,
`message-row-<id>`). Then verify Maestro's `id:` matcher resolves them (use Maestro Studio to
confirm what `automationText` surfaces as on each platform). If `id:` matching proves unworkable
on NS builds, fall back to **Appium** and document why — but try Maestro first for maximum reuse.

### Fixture reuse → import the RN fixture, don't reinvent

`packages/reference-app-rn/test-fixture/start.mjs` (in-memory drone: `MemoryRawStorage`, profile
`storage`, WS listener on 4002, `enableRelay`, `strandFilter:all`, `initializeSeedBootstrap`,
pre-created chat strand) and `sidecar.mjs` (HTTP API on 4080: `/health`, `/status`,
`/message/insert`, `/messages/{strandId}`, `/members/{strandId}`, `/seed/create`,
`/strand/create`) are pure Node.js with **no RN dependency**. The NS `run-e2e.mjs` should spawn
the RN fixture directly (relative path) rather than copying it. The RN orchestrator's
`adb reverse tcp:4002` / `tcp:4080` host-loopback forwarding works for any Android app — reuse
that shape; only `MAESTRO_APP_ID` changes (to the NS app id).

### Build/CI → device build + Maestro is out-of-band

`run-e2e.mjs` requires a built NS APK on an emulator, `adb`, and the Maestro CLI on PATH —
**not agent-runnable** (device build + Maestro wall-clock exceed the 10-min idle budget and need
native tooling). The agent-runnable gate remains `test:bundle` (from the runtime ticket). Make
`run-e2e.mjs` local/CI-runnable and document the prerequisites, mirroring the RN README.

## Flows (reuse RN's)

| Flow | Coverage |
|------|----------|
| `flows/1-connect-and-send.yaml` | cold launch → connect → seed → create strand → send → local echo |
| `flows/2-drone-to-phone.yaml` | drone-side HTTP insert appears in app within ~5s |
| `flows/3-round-trip.yaml` | bidirectional: app→drone and drone→app both visible (+ monotonic timestamps) |

All share `_setup.yaml` and the `_helpers/*.js` (`discover-phone-strand.js`, `drone-insert.js`,
`drone-assert-phone-message.js`, `assert-monotonic-timestamps.js`). The app-created strand syncs
to the drone via `strandFilter:all`; `discover-phone-strand.js` polls the sidecar `/status` to
find it so both sides reference the same DB.

## Documentation deliverables

- **`docs/reference-app-ns.md`** mirroring `docs/reference-app-rn.md`: architecture/topology
  (phone-NS + drone, control + strand networks), **runtime-specific polyfills** (the re-audited
  NS table from the runtime ticket — what V8/JSC provides natively vs polyfilled, contrasted with
  Hermes), the webpack resolver config (Node shims, `conditionNames`, `@libp2p/crypto` browser
  rewrite), startup sequence (entry import order: polyfills + WebSocket plugin first), and the
  testing strategy (bundle smoke + Maestro e2e + fixture reuse).
- **`docs/architecture.md`** cross-reference to the new app alongside reference-app-rn/-web.
- Package **`README.md`** (expand the runtime-ticket stub): drone start, build multiaddr, connect,
  create strand, chat, and the e2e prerequisites.

## Key tests / expected outputs (TDD intent)

- `yarn workspace @serfab/reference-app-ns test:e2e` (local, with emulator + APK + Maestro):
  spawns the RN fixture, waits for `GET /health` 200, reads fixture test-data, sets up
  `adb reverse`, runs the three flows, tears down. Expected: all flows pass; drone↔app round-trip
  visible both directions.
- Maestro `id:` matchers resolve every element in `_setup.yaml` and the flows against the NS build
  (verified once via Maestro Studio).

## TODO

### Phase 1 — test IDs on the UI
- Add `src/test-ids.ts` mirroring the RN constants (same string values).
- Set `automationText` / `accessibilityIdentifier` on every interactive element in the chat +
  settings screens from those constants.

### Phase 2 — e2e harness (reuse RN fixture)
- Add `scripts/run-e2e.mjs` adapted from RN: spawn `../reference-app-rn/test-fixture/start.mjs`,
  poll `/health`, read test-data, `adb reverse tcp:4002`/`tcp:4080`, run Maestro with
  `MAESTRO_APP_ID=<ns app id>` + test-data env vars, teardown. Stream output (`| tee`).
- Add a `maestro/` dir that reuses the RN flows + `_setup.yaml` + `_helpers/` (copy or reference);
  change only `appId`.
- Add `test:e2e` script to `package.json`.

### Phase 3 — verify test-ID matching
- Build the NS APK (out-of-band) and use Maestro Studio to confirm `id:` resolves the
  `automationText`/`accessibilityIdentifier` values on Android (and iOS if available). If
  unworkable, switch to Appium and document the rationale in `docs/reference-app-ns.md`.

### Phase 4 — docs
- Write `docs/reference-app-ns.md` (mirror the RN doc; carry over the re-audited polyfill table,
  webpack config, startup order, testing strategy).
- Cross-reference it from `docs/architecture.md`.
- Expand the package `README.md`.

### Phase 5 — validate
- `test:bundle` still green. Typecheck clean. No `any`, lowercase SQL, tabs.
- In the review handoff, be explicit about what was actually run by the agent (bundle smoke,
  typecheck) vs deferred to a device/CI (full Maestro e2e, Maestro-Studio id verification).
