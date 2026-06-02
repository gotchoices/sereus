description: Maestro e2e target for @serfab/reference-app-ns — a run-e2e orchestrator that reuses the RN drone fixture + sidecar + flows verbatim (only MAESTRO_APP_ID differs), test IDs already on the NS UI, and the docs deliverables (docs/reference-app-ns.md + architecture cross-ref + README expansion). Reviewed and complete; the actual device Maestro run + Maestro-Studio id verification remain out-of-band.
files: packages/reference-app-ns/scripts/run-e2e.mjs, packages/reference-app-ns/maestro/README.md, packages/reference-app-ns/package.json, packages/reference-app-ns/.gitignore, docs/reference-app-ns.md, docs/architecture.md, packages/reference-app-ns/README.md, packages/reference-app-rn/scripts/run-e2e.mjs, packages/reference-app-rn/test-fixture/, packages/reference-app-rn/maestro/
----

## Summary

An automated Maestro e2e target for `@serfab/reference-app-ns` at parity with the
RN suite, built on **maximum reuse** of the RN assets, plus the documentation
deliverables. The single behavioral delta between an RN run and an NS run is
`MAESTRO_APP_ID`; zero duplication of the 3 flows + `_setup.yaml` + 4 helpers +
fixture + sidecar.

### Delivered

- **`scripts/run-e2e.mjs`** — the NS sibling of `reference-app-rn/scripts/run-e2e.mjs`.
  Spawns `../reference-app-rn/test-fixture/start.mjs` (cwd = RN pkg so its
  cadre-core/db-p2p/libp2p deps resolve), waits for `GET /health`, reads the RN
  `test-fixture/test-data.json`, sets up `adb reverse tcp:4002`/`tcp:4080`, runs
  `maestro test` over the **RN** `maestro/flows/` with
  `MAESTRO_APP_ID=org.gotchoices.sereus.chat.ns` + the test-data env vars, and
  tears down on exit. Artifacts (`.fixture.log`, `.maestro-junit.xml`) stay under
  the NS `maestro/` dir so an NS run never clobbers an RN run.
- **`maestro/README.md`** — documents the reference-don't-copy rationale + an
  "eject" recipe if NS ever needs to diverge.
- **`package.json`** — `test:e2e` → `node scripts/run-e2e.mjs`.
- **`.gitignore`** — NS-local Maestro artifacts.
- **`docs/reference-app-ns.md`** (new) — topology, the re-audited V8/JSC polyfill
  table, the webpack resolver config, the startup order, and the testing strategy.
- **`docs/architecture.md`** — NS row added to the reference-apps table (now three
  apps) + prose cross-reference.
- **`README.md`** — "Two-node drone start", "Automated e2e (Maestro)" with
  prerequisites, and a top cross-link to `docs/reference-app-ns.md`.

## Review findings

Adversarial pass over the implement diff (`b348d06`). Scope of this diff was the
e2e **harness + docs** — the NS `test-ids.ts`/XML/view-models referenced in the
handoff landed in the earlier `reference-app-ns-chat`/`-runtime` tickets, but their
parity claims were re-verified here because the whole reuse premise rests on them.

### What was checked

- **`run-e2e.mjs` vs the RN original** — diffed line-by-line against
  `packages/reference-app-rn/scripts/run-e2e.mjs`. It is a faithful port; the only
  intentional deltas are `rnPkgRoot` path math, `FIXTURE_START`/`TEST_DATA_PATH`/
  `FLOWS_DIR` pointing into the RN tree, the `MAESTRO_APP_ID` default, the two
  `existsSync` fail-fast guards, and artifact paths kept under the NS `maestro/`
  dir. Lifecycle (SIGINT/SIGTERM/uncaughtException → `shutdown`), teed fixture
  logging, `adb reverse` setup/teardown, and `waitForHealth` are identical.
  `ensureDir(dirname(FIXTURE_LOG_PATH))` covers `JUNIT_PATH` too (same dir).
- **Reuse-parity premise** — `src/test-ids.ts` string values are identical to RN's
  (NS adds `value-peer-id`, a harmless superset); `automationText` is present on
  every interactive element the flows touch; the chat row binds
  `rowId = TEST_IDS.chat.messageRow(message.Id)` → `message-row-<id>`; NS modal
  text ("Seed applied"/"Strand created") matches `_setup.yaml` assertions; the
  `TabView` titles ("Chat"/"Settings") match the labels the flows tap by text.
  Confirmed the flows themselves drive by visible text + input `id:` matchers and
  never assert `id:message-row-<id>` directly, so row-id parity is belt-and-braces.
- **Doc accuracy** — every cross-reference anchor resolves: the four into
  `reference-app-rn.md` (`#node-topology`, `#seed-bootstrap-flow`,
  `#metro-configuration`, `#two-node-startup-sequence`) all match real headings,
  and the README/maestro-README anchor into `reference-app-ns.md`
  (`#maestro-e2e-device--ci--out-of-band`) matches GitHub's slug for the
  "Maestro e2e (device / CI — out-of-band)" heading. The V8/JSC polyfill table was
  spot-checked against `src/polyfills/hermes.ts` (digest-only `crypto.subtle` shim
  preserving native `generateKey/sign/verify`; UTF-8-only `TextDecoder`;
  `structuredClone`), and the node-shim claims against `node-os.ts` (no
  `react-native` import — verified) and `node-crypto.ts` (`createHash` SHA-256/512
  only, key gen/sign/verify intentionally absent — verified). All relative doc
  links (`../packages/...`, `../../docs/...`, `../../../docs/...`) resolve.

### Findings

- **Major:** none. No new tickets filed.
- **Minor (fixed inline):** none required — the harness is a clean port, the docs
  are accurate, and every agent-reachable gate is green.
- **Reviewed and accepted (not a defect):** the reuse-coupling — the NS e2e
  hard-depends on `reference-app-rn`'s `test-fixture/` + `maestro/` at the sibling
  relative path. This is the ticket's explicit "spawn the RN fixture directly"
  directive; the two `existsSync` guards fail fast with a clear message if the RN
  assets move, and `maestro/README.md` documents the eject recipe as the escape
  hatch. DRY single-source-of-truth was preferred over a self-contained copy.

### Gates run (all green)

```
node --check packages/reference-app-ns/scripts/run-e2e.mjs        # parses
# package.json validated as JSON
yarn workspace @serfab/reference-app-ns typecheck                 # exit 0
yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app   # exit 0
yarn workspace @serfab/reference-app-ns test:bundle               # exit 0 — 0 errors, 22 warnings
```

The 22 bundle warnings are the pre-existing, documented upstream dep skew (4
missing exports: `StrictSign`/`StrictNoSign`/`TopicValidatorResult` from
`@libp2p/interface`, `streamMessage` from `protons-runtime`), tracked in
`tickets/backlog/optimystic-db-p2p-libp2p-dep-skew.md`. This ticket added no source
under `src/`/`app/`, so it introduced no new warnings. No `.pre-existing-error.md`
written — nothing failed. `run-e2e.mjs` is intentionally not linted (eslint flat
config ignores `**/scripts/**`); it is plain Node and was parse-checked instead.

## NOT run by the agent — deferred to device / CI (the real gate)

`test:e2e` is **not agent-runnable**: it needs a built NS APK on a running Android
emulator, `adb`, and the Maestro CLI — native tooling whose device build + Maestro
wall-clock exceed the 10-min idle budget. The following are code-complete but
**never executed**, and are the highest-value device targets:

1. **The full Maestro run** — all three flows against a live NS build + the spawned
   RN drone fixture.
2. **The headline NS risk — test-id resolution.** Whether Maestro's `id:` matcher
   resolves NS `automationText` (Android `contentDescription` / iOS
   `accessibilityIdentifier`) is unproven. Build the APK, use Maestro Studio to
   confirm `id:` resolves each value; if unworkable, switch to **Appium** and
   document the rationale in `docs/reference-app-ns.md`. Maestro is tried first for
   maximum reuse.
3. **`_setup.yaml` status-bar visibility step**
   (`extendedWaitUntil visible id:status-bar text:"Connected.*strand"`). This
   asserts the Chat-screen status bar right after Create-Strand while the UI is
   still on the Settings tab. Whether the NS `TabView` keeps the inactive tab's
   view "visible" to Maestro is the most likely flow-portability snag; if it fails,
   eject the flows (recipe in `maestro/README.md`) and switch to the Chat tab
   before that assertion.
4. **Runtime behaviors carried over from the chat-ticket review** (still
   device-only): poll-loop `ListView` re-render flicker, stale-strand after
   disconnect/reconnect, TabView poll start/stop on tab switch, plain-Label
   (non-scrollable) modal, and the live connect-to-drone / apply-seed / dial /
   bidirectional replication path on V8/JSC + native plugins.

Device/CI (out-of-band): `ns build android` → install on emulator →
`yarn workspace @serfab/reference-app-ns test:e2e`. Expect all three flows green
and drone↔app round-trip both directions; do the Maestro-Studio `id:` verification
(item 2) first.
