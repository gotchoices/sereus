----
description: Add a React test harness to reference-app-rn and cover use-cadre's BackgroundRunner wiring at runtime (effect lifecycle, cold-start re-sync, state propagation)
files: packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/background-runner.ts, packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/package.json
----

`packages/reference-app-rn` gained a node-environment vitest runner with the `mobile-background-runner`
ticket, but it has **no React renderer**. The `BackgroundRunner` core (`background-runner.ts`) is unit
tested in plain node, but the *hook that wires it into React* (`use-cadre.ts`) is only type-checked —
its runtime behavior has no test. The gaps that matter:

- The `useEffect([node, ensureNode])` that creates/starts the runner once the node exists and tears it
  down (`unsubscribe()` then `runner.stop()`) on unmount.
- The `ensureNode` cold-start callback: on a foreground return after the OS killed the node it re-runs
  `startPhoneNode(optsRef.current)` and re-syncs React state (`setNode`/`setPeerId`/`setStrands`).
- The **cold-start ↔ effect-recreate interaction**: `ensureNode`'s `setNode` changes the `node` dep, so
  the runner effect tears down and recreates the runner *mid-resume*. This is reasoned to converge (the
  old runner's in-flight `handleForeground` aborts via the `epoch` bump from `stop()`, the fresh runner
  re-enters `foreground`), but is not exercised — `resuming` flicker / settle-restart should be observed.
- Propagation of `runnerState` / `resuming` / `degraded` from the runner's `onStateChange` into React
  state and out through `UseCadreResult`, and into the `app/index.tsx` status bar.
- A latent edge: `optsRef.current` is only set by `start()`. If the app mounts with `getPhoneNode()`
  already returning a running node (so `node` is non-null at mount) but `start()` was never called this
  session, `ensureNode` no-ops and a later cold-start cannot re-run `startPhoneNode`. Confirm whether
  this is reachable (the singleton is normally null on a fresh JS context) and, if so, persist opts.

## Use case / expectation

A `renderHook`-style test (e.g. `@testing-library/react-native` or `react-test-renderer`, in a second
vitest project/config with a jsdom-or-RN environment, kept separate from the node-only `vitest.config.ts`
so `background-runner.ts` stays RN-free) drives `useCadreInternal` with a fake AppState + mock node and
asserts: runner created on node-start and stopped on unmount; cold-start re-sync; no stuck `resuming`
across the effect-recreate; degraded reaching the status bar.
