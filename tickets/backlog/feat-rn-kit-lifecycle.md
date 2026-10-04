description: The React Native reference app's background/foreground handling moves into the shared kit beside the phone node, so every Sereus phone app hibernates its strands in the background and resumes cleanly, which sereus-chat and health do not do today.
prereq: rn-kit-phone-node
architecture: docs/reference-app-rn.md#node-local-persistence
files: packages/reference-app-rn/src/background-runner.ts, packages/reference-app-rn/src/app-state.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/test/background-runner.spec.ts, packages/cadre-rn/
----
# Share the lifecycle runner through `@serfab/cadre-rn`

`rn-kit-phone-node` moved the node bring-up into the kit. The reference app's lifecycle runner is
already kit-shaped: `AppStateLike` is injected, and the module imports nothing native. Neither
sereus-chat nor health has any AppState handling.

## Proposed API

`createBackgroundRunner` moves as it is (it already injects `AppStateLike` and imports nothing
native), with one change: it takes the `PhoneNode` instead of `getNode` + `ensureNode`.

```ts
export function createBackgroundRunner(deps: {
	phoneNode: PhoneNode;
	appState: AppStateLike;                // reactNativeAppState(AppState) below
	settleTimeoutMs?: number;              // default 15 s
}): BackgroundRunner;                      // unchanged: state, resuming, degraded, start, stop, onStateChange

/** react-native's `AppState`, passed in so this subpath does not import react-native. */
export function reactNativeAppState(appState: typeof AppState): AppStateLike;
```

When the app returns to the foreground and finds no node, the runner restarts it from
`loadSavedStart()` if `autoStart` is set. Before, the app supplied that as the `ensureNode` hook.

