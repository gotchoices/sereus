# reference-app-ns Maestro e2e

This package's automated e2e suite **reuses reference-app-rn's Maestro assets
verbatim** rather than copying them. There are intentionally no flow `.yaml`
files here — only run artifacts and this note.

## Why reuse, not copy

Maestro is black-box and app-agnostic: it drives a NativeScript-built APK/IPA the
same way it drives the RN app. The flows depend only on the **shared test-id
strings** (`src/test-ids.ts`, surfaced on the NS UI via `automationText` and on the
RN UI via `testID`) and on the visible tab labels ("Chat" / "Settings"), both of
which are identical across the two apps. The drone fixture + HTTP sidecar
(`reference-app-rn/test-fixture/`) are plain Node.js with no RN dependency. The
**only** thing that differs between an RN run and an NS run is `MAESTRO_APP_ID`,
which is already env-driven in every flow (`appId: ${MAESTRO_APP_ID}`).

So `scripts/run-e2e.mjs` points Maestro at:

- flows  → `../reference-app-rn/maestro/flows/` (with `_setup.yaml` + `_helpers/*`
  resolved relative within that tree)
- fixture → `../reference-app-rn/test-fixture/start.mjs`

and overrides `MAESTRO_APP_ID` → `org.gotchoices.sereus.chat.ns`.

Keeping a single source of truth (DRY) means flow improvements land for both apps
at once. See [`docs/reference-app-ns.md`](../../../docs/reference-app-ns.md)
§ Testing strategy and [`docs/reference-app-rn.md`](../../../docs/reference-app-rn.md)
§ Testing strategy for the flow inventory.

## Running

```
yarn workspace @serfab/reference-app-ns test:e2e
```

Prerequisites (out-of-band — not agent-runnable): a built NS APK installed on a
running Android emulator, `adb` on PATH, and the Maestro CLI on PATH. See the
package [README](../README.md) § "Automated e2e".

## Ejecting (if NS ever needs its own flows)

If device validation reveals an NS-specific divergence the env-driven `appId`
can't cover (the most likely candidate is the `_setup.yaml` `status-bar`
visibility step across the TabView — see `docs/reference-app-ns.md` § Testing
strategy), copy `reference-app-rn/maestro/{_setup.yaml,_helpers,flows}` into this
dir and repoint `FLOWS_DIR` in `scripts/run-e2e.mjs` at the local copy. Until then,
reuse keeps the suites in lockstep.

## Artifacts (gitignored)

- `.fixture.log` — drone fixture stdout/stderr (teed live during the run)
- `.maestro-junit.xml` — Maestro JUnit report
