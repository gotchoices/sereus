----
description: Review the new React test harness for the RN reference app that exercises how the BackgroundRunner is wired into React (effect lifecycle, cold-start recovery, status propagation).
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/test/react/setup.ts, packages/reference-app-rn/src/connection-status.ts, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/package.json, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/background-runner.ts
----

# Review: React test harness for `useCadreInternal` ↔ `BackgroundRunner` wiring

## What was built

`packages/reference-app-rn` previously had a node-only vitest runner. The `BackgroundRunner`
core was unit-tested in plain node, but the hook that wires it into React
(`use-cadre.ts`) was only type-checked. This ticket adds a **second vitest project** with a
React renderer so the hook's runtime behavior is exercised.

Changes:

- **`vitest.config.ts`** — replaced the single config with `test.projects`:
  - `node` — the existing plain-node tests (`test/**/*.spec.ts`, **excluding** `test/react/**`). Unchanged behavior; `background-runner.ts` stays RN-free because nothing imports it at runtime.
  - `react` — `test/react/**/*.spec.ts`, node environment, with `test/react/setup.ts` (sets `IS_REACT_ACT_ENVIRONMENT`).
- **`react-test-renderer@19.0.0` + `@types/react-test-renderer`** added as devDeps (exact match to the pinned `react@19.0.0`; no DOM/jsdom needed for hook tests).
- **`src/connection-status.ts`** (new) — extracted the status-bar color/text derivation out of `app/index.tsx` into a pure `connectionBanner(...)` function. `app/index.tsx` now calls it (behavior preserved verbatim — same strings/colors). This is what lets a test assert that `degraded` reaches the bar without rendering the full RN screen.
- **`test/react/use-cadre.spec.ts`** — the harness. Mounts the **real** hook with `react-test-renderer`, mocking only the modules that would drag in react-native/expo/libp2p (`cadre-phone`, `app-state`, `push-wake-native`, `chat-strand`, `@serfab/cadre-core`). The `BackgroundRunner` under test is the real one, driven via a fake `AppState` + a mock node singleton.

## Use cases covered (the tests)

- **Runner created on node-start, torn down on unmount** — proxied by the shared fake AppState's add/remove counts and the mock node's `control:*` listener counts (the real `createBackgroundRunner` is not spied, so lifecycle is asserted through its observable subscriptions).
- **Background hibernate** — `AppState 'background'` → `node.hibernateAll()` once, state `background-connected`.
- **Cold-start re-sync + effect-recreate** — background, then null the singleton (OS kill), then `'active'`: `ensureNode` re-runs `startPhoneNode` (a *fresh* node), React state re-syncs (`peerId` `peer-1`→`peer-2`), the `node`-dep change recreates the runner (addCount 2 / removeCount 1, listeners move n1→n2), and `resuming` converges to **false** (not wedged).
- **Degraded resume reaches the status banner** — fake timers; control never reconnects; after the 15s settle `degraded` is true and the real `connectionBanner` renders `Offline — reconnecting…` / `#f44336`. This test also asserts the committed `resuming === true` mid-resume (`Resuming — syncing…`).
- **`stop()`** drops the node and the runner unsubscribes.
- **Documented latent edge** (see below).

## How to validate

```
cd packages/reference-app-rn
yarn vitest run --project react   # the new harness (6 tests)
yarn test                         # both projects (90 tests)
yarn typecheck
```
Root: `yarn lint` (clean). All pass at handoff.

## Honest gaps / where to look hard (your tests are a floor, not a ceiling)

- **The mock node is a thin stub.** Only the surface the hook + runner touch is implemented (`on/off/emit`, `hibernateAll`, `getStrands`, `peerId`, `isRunning`/`running`, `controlConnected`). The runner is real; the node, AppState, and `cadre-phone` are mocked. These tests do **not** exercise a real `CadreNode`, control network, or strand sync.

- **Resume "flicker" is only weakly observed in the cold-start test.** The cold-start path completes within one `act()` flush, so React batches away the intermediate `resuming === true` commit — the cold-start test asserts only convergence to `false`. The *committed* `resuming === true` observation lives in the degraded test instead. If the reviewer wants the flicker asserted on the cold-start path specifically, it would need an artificial deferral in the `startPhoneNode` mock; I judged that not worth the contrivance.

- **The latent edge is DOCUMENTED, not fixed.** The ticket flagged: if the node singleton is already running at mount but `start()` was never called this session, `optsRef.current` stays null and a later cold-start can't re-run `startPhoneNode` (the dead node is never recovered). My analysis: this is only reachable when the module singleton survives a remount (**dev Fast Refresh**); a production fresh JS context starts with a null singleton, so `start()` always runs first and populates `optsRef`. I therefore did **not** add opts-persistence (avoiding speculative complexity per repo guidance) and instead pinned the current behavior in a test (`documents: a warm node at mount …`). **Reviewer decision:** if you consider the dev-only failure worth hardening (e.g. persist last opts in `cadre-phone` module scope or secure store, and have `ensureNode` fall back to it), spin a `fix/` ticket — the pinned test will then need flipping to assert recovery.

- **`react-test-renderer` is deprecated in React 19** (prints a one-line console warning on import; tests pass). Chosen for zero DOM deps and an exact version match with `react@19.0.0`. A future migration to `@testing-library/react-native` (RN env) or `react-dom`+jsdom is possible if the team prefers; the harness is small and self-contained.

- **Status-bar coverage is via the extracted pure function, not the rendered RN tree.** `app/index.tsx` now renders `<Text>{banner.text}</Text>`, and the test renders `connectionBanner(...)` driven by the real hook state. The actual `<View>/<Text>` styling and Maestro test-IDs are unchanged and remain e2e territory (`scripts/run-e2e.mjs`). Confirm the `index.tsx` refactor is behavior-preserving (diff the old ternaries vs `connection-status.ts`).

- **Hook surface not covered here:** `applySeed`, `authorityKeysFromInvite`, `dialPeer`, `createStrand`, the closed-strand consent flow (`createClosedStrandWithInvite`/`joinViaInvite`), and the `strand:discovered` auto-join effect. These are out of scope for this ticket (runner/lifecycle wiring only); `chat-strand` is mocked. Candidate for a follow-up if broader hook coverage is wanted.
