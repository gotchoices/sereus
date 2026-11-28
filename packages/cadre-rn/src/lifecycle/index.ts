/**
 * `@serfab/cadre-rn/lifecycle` — the background runner's hooks over a `PhoneNode`
 * (`phoneNodeLifecycle`). The runner is `@serfab/cadre-client/lifecycle`'s. See the kit README's
 * "Lifecycle" section.
 */
import type { BackgroundRunnerDeps } from '@serfab/cadre-client/lifecycle';
import type { PhoneNode } from '../phone-node/index.js';

/**
 * The runner itself is platform-neutral and lives in `@serfab/cadre-client/lifecycle`; it is
 * re-exported here for apps that import it from the kit.
 *
 * @deprecated Import `createBackgroundRunner` and its types from `@serfab/cadre-client/lifecycle`.
 */
export {
	createBackgroundRunner,
	type AppStateLike,
	type AppStateSubscription,
	type AppStateValue,
	type BackgroundRunner,
	type BackgroundRunnerDeps,
	type RunnerState,
} from '@serfab/cadre-client/lifecycle';

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
