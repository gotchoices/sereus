description: Maestro e2e target for @serfab/reference-app-ns — a run-e2e orchestrator that reuses the RN drone fixture + sidecar + flows verbatim (only MAESTRO_APP_ID differs), test IDs already on the NS UI, and the docs deliverables (docs/reference-app-ns.md + architecture cross-ref + README expansion). Agent gates green; the actual device Maestro run + Maestro-Studio id verification are out-of-band.
files: packages/reference-app-ns/scripts/run-e2e.mjs, packages/reference-app-ns/maestro/README.md, packages/reference-app-ns/package.json, packages/reference-app-ns/.gitignore, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-ns/app/chat/chat-page.xml, packages/reference-app-ns/app/settings/settings-page.xml, docs/reference-app-ns.md, docs/architecture.md, packages/reference-app-ns/README.md, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/test-fixture/, packages/reference-app-rn/maestro/
----

## What landed

An automated Maestro e2e target for `@serfab/reference-app-ns` at parity with the
RN suite, built on **maximum reuse** of the RN assets, plus the documentation
deliverables.

### New / changed

- **`scripts/run-e2e.mjs`** — the NS sibling of `reference-app-rn/scripts/run-e2e.mjs`.
  Spawns `../reference-app-rn/test-fixture/start.mjs` (cwd = RN pkg, so its
  cadre-core/db-p2p/libp2p deps resolve), waits for `GET /health`, reads the RN
  `test-fixture/test-data.json`, sets up `adb reverse tcp:4002`/`tcp:4080`, runs
  `maestro test` over the **RN** `maestro/flows/` with `MAESTRO_APP_ID=org.gotchoices.sereus.chat.ns`
  + the test-data env vars, and tears down on exit. Output is teed live.
- **`maestro/README.md`** — documents why there are **no duplicate flow files**:
  the flows depend only on the shared test-id strings + tab labels, the fixture is
  RN-dependency-free, and the only per-app difference (`appId`) is already
  env-driven. Includes an "eject" recipe if NS ever needs to diverge.
- **`package.json`** — `test:e2e` → `node scripts/run-e2e.mjs`.
- **`.gitignore`** — NS-local Maestro artifacts (`maestro/.fixture.log`,
  `maestro/.maestro-junit.xml`, `maestro/.maestro/`).
- **`docs/reference-app-ns.md`** (new) — mirrors `docs/reference-app-rn.md`:
  topology, the **re-audited V8/JSC polyfill table** (native-vs-polyfilled,
  contrasted with Hermes), the webpack resolver config (conditionNames, node
  shims, `node:` strip, `@libp2p/crypto` browser rewrite, esbuild downlevel,
  `exportsPresence:'warn'`), the startup order, and the testing strategy.
- **`docs/architecture.md`** — NS row added to the reference-apps table (now three
  apps) + a prose cross-reference.
- **`README.md`** — added "Two-node drone start", "Automated e2e (Maestro)" with
  prerequisites, and a top cross-link to `docs/reference-app-ns.md`.

### Key design decision — reference, don't copy (DRY)

The ticket allowed "copy or reference" for the maestro assets and explicitly
required referencing for the fixture. Both are referenced: zero duplication of the
3 flows + `_setup.yaml` + 4 helpers + fixture + sidecar. The single behavioral
delta between an RN run and an NS run is `MAESTRO_APP_ID`, which every flow already
reads as `${MAESTRO_APP_ID}`. Verified parity before relying on reuse:

- NS `src/test-ids.ts` string values == RN's (NS additionally has
  `value-peer-id`, which is harmless — a superset).
- `automationText` is set on **every** interactive element the flows touch
  (settings: `input-party-id`/`input-bootstrap-addr`/`btn-connect`/`btn-disconnect`/
  `input-seed`/`btn-apply-seed`/`input-add-peer`/`btn-add-peer`/`btn-create-strand`/
  `value-peer-id`/`modal-title`/`btn-modal-ok`; chat: `status-bar`/`input-message`/
  `btn-send`/`message-list`/`message-row-<id>`). (Phase 1 landed with the chat ticket.)
- NS modal text matches what `_setup.yaml` asserts: "Seed applied" + "Strand created".
- NS `TabView` tab titles ("Chat"/"Settings") match the RN tab labels the
  `_setup.yaml` taps by visible text.

## What was actually run (agent gates — all green)

```
yarn workspace @serfab/reference-app-ns typecheck    # exit 0
yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app   # 0 problems
yarn workspace @serfab/reference-app-ns test:bundle  # exit 0 — 0 errors, 22 warnings
node --check packages/reference-app-ns/scripts/run-e2e.mjs   # parses
# package.json validated as JSON
```

The 22 bundle warnings are the **pre-existing, documented** upstream skew (4
missing exports: `StrictSign`/`StrictNoSign`/`TopicValidatorResult` from
`@libp2p/interface`, `streamMessage` from `protons-runtime`), tracked in
`tickets/backlog/optimystic-db-p2p-libp2p-dep-skew.md`. This ticket added no source
under `src/`/`app/` (Phase 1 was already complete), so it introduced no new
warnings. No `.pre-existing-error.md` written — nothing failed.

Note: ESLint's flat config ignores `**/scripts/**` and `packages/reference-app-rn/maestro/**`
(Maestro's helpers run in GraalJS with injected globals), so `run-e2e.mjs` is
intentionally not linted; it's plain Node and was parse-checked instead.

## NOT run by the agent — deferred to device / CI (the real gate)

`test:e2e` is **not agent-runnable**: it needs a built NS APK on a running Android
emulator, `adb`, and the Maestro CLI — native tooling whose device build + Maestro
wall-clock exceed the 10-min idle budget. The following are code-complete but
**never executed**:

1. **The full Maestro run** (`yarn workspace @serfab/reference-app-ns test:e2e`) —
   all three flows against a live NS build + the spawned RN drone fixture.
2. **The headline NS risk — test-id resolution.** Whether Maestro's `id:` matcher
   resolves NS `automationText` (Android `contentDescription` / iOS
   `accessibilityIdentifier`) is **unproven**. Phase 3 is: build the APK, use
   Maestro Studio to confirm `id:` resolves each value; if unworkable, switch to
   **Appium** and document the rationale in `docs/reference-app-ns.md`. Maestro is
   tried first for maximum reuse.
3. **`_setup.yaml` status-bar visibility step** (`extendedWaitUntil visible id:status-bar text:"Connected.*strand"`).
   This asserts the **Chat**-screen status bar right after Create-Strand while the
   UI is still on the **Settings** tab. Whether the NS `TabView` keeps the inactive
   tab's view "visible" to Maestro is the most likely flow-portability snag; if it
   fails, eject the flows into the NS `maestro/` dir (recipe in `maestro/README.md`)
   and switch to the Chat tab before that assertion. Documented in
   `docs/reference-app-ns.md` § Testing strategy.
4. **Runtime behaviors carried over from the chat-ticket review** (still
   device-only, owned here): poll-loop `ListView` re-render flicker, stale-strand
   after disconnect/reconnect, TabView poll start/stop on tab switch, plain-Label
   (non-scrollable) modal, and the unverified live connect-to-drone /
   apply-seed / dial / bidirectional replication path on V8/JSC + native plugins.

## How to validate (reviewer)

Agent-reachable (re-confirm green):
```
yarn workspace @serfab/reference-app-ns typecheck
yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app
yarn workspace @serfab/reference-app-ns test:bundle
node --check packages/reference-app-ns/scripts/run-e2e.mjs
```

Adversarial read targets:
- **`run-e2e.mjs` path math** — `rnPkgRoot = resolve(pkgRoot, '..', 'reference-app-rn')`;
  `FLOWS_DIR`/`TEST_DATA_PATH`/`FIXTURE_START` point into the RN tree; artifacts
  (`FIXTURE_LOG_PATH`/`JUNIT_PATH`) stay under the NS `maestro/` so an NS run does
  not clobber an RN run. The two `existsSync` guards fail fast with a clear message
  if the RN assets are missing.
- **Reuse coupling risk** — the NS e2e hard-depends on `reference-app-rn`'s
  `test-fixture/` + `maestro/` existing at the sibling relative path. Confirm this
  is acceptable (it mirrors the ticket's explicit "spawn the RN fixture directly"
  directive) vs. a self-contained copy. The eject recipe is the escape hatch.
- **Doc accuracy** — spot-check the V8/JSC polyfill table in
  `docs/reference-app-ns.md` against `src/polyfills/*.ts` (native vs polyfilled
  claims) and the webpack section against `webpack.config.js`. Anchor links into
  `reference-app-rn.md` (`#node-topology`, `#seed-bootstrap-flow`,
  `#two-node-startup-sequence`, `#metro-configuration`) and the README's anchor
  into `reference-app-ns.md` resolve.

Device/CI (the real gate — out-of-band): `ns build android` → install on emulator
→ `yarn workspace @serfab/reference-app-ns test:e2e`. Expect all three flows green
and drone↔app round-trip both directions. First do the Maestro-Studio `id:`
verification (item 2 above).

## Disposition

Implement-complete and green on every agent-reachable gate. The deliverable is the
**harness + docs**; the actual device execution and the one genuine NS-specific
unknown (Maestro `id:` ↔ `automationText`) are structurally out of agent reach and
are explicitly flagged for the device/CI pass. Treat the reuse-coupling and the
`_setup.yaml` status-bar step as the highest-value review/device targets.
