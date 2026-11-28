/**
 * `@serfab/cadre-client/lifecycle` — hibernate a device's node when the app goes to the background
 * and resume it, bounded, when it returns (`createBackgroundRunner`).
 *
 * Platform-neutral: the app passes its platform's app-state events in (`AppStateLike`; React
 * Native's `AppState` is one) and the node hooks. On React Native, `@serfab/cadre-rn/lifecycle`
 * adds `phoneNodeLifecycle`, the hooks over a `PhoneNode`.
 */
export {
	createBackgroundRunner,
	type AppStateLike,
	type AppStateSubscription,
	type AppStateValue,
	type BackgroundRunner,
	type BackgroundRunnerDeps,
	type RunnerState,
} from './background-runner.js';
