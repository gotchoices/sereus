/**
 * `@serfab/cadre-rn/lifecycle` — hibernate a phone's node when the app goes to the
 * background and resume it, bounded, when it returns. See the kit README's
 * "Lifecycle" section.
 */
import type { PhoneNode } from '../phone-node/index.js';
import type { BackgroundRunnerDeps } from './background-runner.js';

export {
	createBackgroundRunner,
	type AppStateLike,
	type AppStateSubscription,
	type AppStateValue,
	type BackgroundRunner,
	type BackgroundRunnerDeps,
	type RunnerState,
} from './background-runner.js';

/**
 * The runner's two node hooks over a `PhoneNode`: the running node, and a cold start
 * that starts it again from the saved start when a foreground return finds it gone —
 * only while `autoStart` is set, so a node the user stopped stays stopped.
 *
 * An app that must do more after a cold start (refresh its own state from the new node)
 * supplies its own `ensureNode` instead, or subscribes to `PhoneNode.onStatus`.
 */
export function phoneNodeLifecycle(phone: PhoneNode): Pick<BackgroundRunnerDeps, 'getNode' | 'ensureNode'> {
	return {
		getNode: () => phone.node,
		ensureNode: async () => {
			const saved = await phone.loadSavedStart();
			if (saved?.autoStart) await phone.start(saved.options);
		},
	};
}
