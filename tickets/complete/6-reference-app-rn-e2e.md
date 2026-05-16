description: Maestro e2e suite for @serfab/reference-app-rn
prereq:
files: packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/maestro/_setup.yaml, packages/reference-app-rn/maestro/flows/, packages/reference-app-rn/maestro/_helpers/, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/package.json, packages/reference-app-rn/.gitignore, packages/reference-app-rn/README.md, docs/reference-app-rn.md
----

## Summary

Lands `yarn workspace @serfab/reference-app-rn test:e2e`: an orchestrator
that spawns the drone test fixture, sets up `adb reverse`, and runs three
Maestro flows (connect+send / drone→phone / round-trip) against the local
Android emulator. RN side gets stable testIDs centralised in
`src/test-ids.ts`.

## Files

- `packages/reference-app-rn/app/index.tsx` — chat-screen testIDs
- `packages/reference-app-rn/app/settings.tsx` — settings testIDs, threaded
  through Btn/LabelledInput
- `packages/reference-app-rn/src/test-ids.ts` — new (single source of truth)
- `packages/reference-app-rn/maestro/_setup.yaml` — shared bootstrap
- `packages/reference-app-rn/maestro/flows/1-connect-and-send.yaml`
- `packages/reference-app-rn/maestro/flows/2-drone-to-phone.yaml`
- `packages/reference-app-rn/maestro/flows/3-round-trip.yaml`
- `packages/reference-app-rn/maestro/_helpers/discover-phone-strand.js`
- `packages/reference-app-rn/maestro/_helpers/drone-insert.js`
- `packages/reference-app-rn/maestro/_helpers/drone-assert-phone-message.js`
- `packages/reference-app-rn/maestro/_helpers/assert-monotonic-timestamps.js`
- `packages/reference-app-rn/scripts/run-e2e.mjs`
- `packages/reference-app-rn/package.json` — `test:e2e` script
- `packages/reference-app-rn/.gitignore` — Maestro artifacts
- `packages/reference-app-rn/README.md` — E2E section
- `docs/reference-app-rn.md` — Phase 2 testing strategy

## Review findings

### What was checked

- Diff in commit `acd5399` read cold before the implement-stage summary.
- Source files re-read in their post-implement state: `app/index.tsx`,
  `app/settings.tsx`, `src/test-ids.ts`, `app/_layout.tsx`,
  `test-fixture/start.mjs`, `test-fixture/sidecar.mjs`.
- Maestro YAML and JS helpers reviewed against the Maestro syntax docs
  (no live Maestro CLI available to run the flows — same limitation as
  implement stage).
- Cross-checked behaviour against `src/cadre-phone.ts:103` (phone's
  `strandFilter: { mode: 'all' }`) and `test-fixture/start.mjs:70`
  (drone's).
- Architecture, code quality, type safety, resource cleanup, error
  handling, accessibility.
- Validation: `npx tsc --noEmit` clean; `yarn test:bundle` exports the
  Android bundle successfully (the trailing `rm -rf dist` fails on
  Windows — that's a pre-existing Windows-only issue in the script,
  unrelated to this ticket). No project ESLint config to run against
  this package.

### Findings + dispositions

- **MINOR (fixed inline) — accessibility regression on buttons.**
  `Btn` in `app/settings.tsx` was setting
  `accessibilityLabel={testID ?? label}`, and the chat send button in
  `app/index.tsx` was setting `accessibilityLabel={TEST_IDS.chat.sendBtn}`.
  This replaces the human-readable label ("Connect", "Send", …) with the
  raw test id ("btn-connect", "btn-send"), which screen readers would
  read aloud. Maestro's `id:` selector matches RN's `testID` directly on
  both platforms, so the accessibilityLabel override is unnecessary.
  Removed the override in both places — the `<Text>` child supplies the
  default accessibility label.

- **MAJOR (filed follow-up) — non-deterministic strand selection on chat.**
  `app/index.tsx:23` picks the chat strand by Map iteration order
  (`cadre.strands.values().next().value`). Once both phone-created strand
  A and drone-pre-created strand B are present (and they will be — both
  sides run `strandFilter:{mode:'all'}`), iteration order depends on a
  race between local `createStrand` and inbound control-sync of the
  drone's strand. Empirically the seed-modal interactions in
  `_setup.yaml` give control sync time to land B first, so the phone is
  almost certainly on strand B at the moment the test sends/asserts,
  while `discover-phone-strand.js` resolves `WORKING_STRAND_ID` to A and
  the drone-side helpers target A. Flows 2 and 3 would silently miss.
  Implementer flagged this as Known Gap #4. Filed
  `tickets/backlog/reference-app-rn-strand-selection.md` with three
  candidate fixes (strand picker UI, drop Create-Strand from e2e, or
  deterministic ordering at the cadre/UI layer).

- **MINOR (noted, not fixed) — `tapOn: "Settings"` ambiguity on launch.**
  Cold-launch chat screen shows `"Not connected — go to Settings"` in
  the status bar; Maestro's shorthand text matcher can resolve "Settings"
  to either the status text or the tab. Maestro normally prefers
  tappable elements so this typically works, but it's fragile. Not
  fixing because (a) it's a tap on the tab label, which Maestro handles
  correctly in practice, and (b) the safest fix (adding testIDs to tab
  bar items) requires touching the Expo Router `_layout.tsx` tab config,
  which is best handled together with the strand-selection ticket. If
  flake materializes, the fix is `tapOn: { text: "^Settings$" }` or a
  proper tab testID.

- **MINOR (noted) — Maestro version not pinned.** Per the implementer's
  Known Gap #2: Maestro CLI version isn't pinned in `README.md` or
  `devDependencies`. Implement env couldn't install Maestro to verify a
  version. Resolution: pin after a successful local smoke run; this is
  a one-line README + (optional) package.json change that doesn't
  warrant its own ticket — leaving for the first person to run the
  suite locally.

- **MINOR (noted) — flow execution not smoke-tested.** The YAMLs were
  authored against Maestro docs but never run against a real emulator,
  same as implement-stage. The "likely tweak sites" the implementer
  enumerated (`hideKeyboard` syntax, `extendedWaitUntil` shape, `text:`
  regex on the status bar, `${WORKING_STRAND_ID}` output-var
  substitution into per-step `env:` blocks) all look correct against
  current Maestro syntax docs but cannot be verified here. The
  reviewer (or first local runner) must `yarn test:e2e` once and patch
  whatever the YAML interpreter disagrees with. This is an inherent
  limitation of the environment, not a defect of the work.

- **NIT (not fixing) — busy-wait in `discover-phone-strand.js`.**
  The helper spins on `while (Date.now() < spinUntil)` because Maestro's
  GraalJS sandbox has no `setTimeout`. Burns a CPU core for 500ms between
  HTTP polls. Implementer commented on the constraint. Acceptable given
  the runtime environment.

- **NIT (not fixing) — `node spawn('adb', …)` on Windows.** Works fine
  because `adb.exe` resolves without `shell:true`. If a future Windows
  user reports a spawn failure, swap to `spawn('adb', …, { shell: true })`.

- **VERIFIED OK — JS helpers' error reporting.** All four helpers
  (`discover-phone-strand`, `drone-insert`, `drone-assert-phone-message`,
  `assert-monotonic-timestamps`) throw with descriptive messages
  including the last-seen HTTP status / body / strand list when they
  fail, which is exactly what a Maestro report needs to be debuggable.

- **VERIFIED OK — orchestrator teardown.** `run-e2e.mjs` handles SIGINT,
  SIGTERM, uncaughtException, unexpected-fixture-exit, and
  not-on-PATH-maestro. Sends SIGTERM with 3s grace then SIGKILL. Flushes
  the fixture log stream. Runs `adb reverse --remove-all` last. Exit
  code propagated from Maestro. No leaked child processes expected.

- **VERIFIED OK — test-ids centralisation.** `src/test-ids.ts` is the
  single source of truth; both `app/index.tsx` and `app/settings.tsx`
  import from it. `LabelledInput` and `Btn` correctly thread `testID`
  through to the underlying `TextInput`/`Pressable`. The per-row
  message helper `messageRow(id)` is a function for the dynamic id —
  fine since flows don't currently match individual row ids, but it's
  there if needed.

- **VERIFIED OK — docs.** `docs/reference-app-rn.md` §Testing Strategy
  Phase 2 and `packages/reference-app-rn/README.md` cover prerequisites,
  flow inventory, artifacts, troubleshooting. No stale references to
  the old "Maestro Cloud only" phrasing.

- **NOT TOUCHED — categories with no findings:**
  - Resource cleanup: orchestrator teardown is thorough (see above).
  - SQL injection / input validation: sidecar isn't part of this
    ticket's diff; pre-existing.
  - Type safety: `tsc --noEmit` clean; no `any`s added.
  - DRY: setup factored into `_setup.yaml`; helpers in `_helpers/`.

### Validation

- `npx tsc --noEmit` in `packages/reference-app-rn` — clean.
- `yarn test:bundle` — bundle exports successfully (2973 modules); the
  `rm -rf dist` cleanup at the tail of the script fails on Windows but
  that's a pre-existing platform issue, not introduced here.
- Maestro CLI not runnable in review env (same as implement); flows
  remain unsmoked end-to-end.

## Follow-ups filed

- `tickets/backlog/reference-app-rn-strand-selection.md` — deterministic
  strand selection on chat screen (covers the Major finding above).
