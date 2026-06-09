/**
 * app-state.ts — production {@link AppStateLike} backed by react-native's
 * `AppState`.
 *
 * Kept separate from `background-runner.ts` so that module (and its unit tests)
 * stay free of a `react-native` import: the runner depends only on the
 * {@link AppStateLike} interface, tests inject a fake, and this thin adapter is
 * the single place the real native module is referenced.
 */

import { AppState } from 'react-native';
import type { AppStateLike, AppStateSubscription, AppStateValue } from './background-runner';

/**
 * Wrap react-native's `AppState` as an {@link AppStateLike}. `AppState.addEventListener`
 * already returns a `{ remove() }` subscription on RN 0.65+, so this is a near
 * pass-through that just narrows the status type.
 */
export function createReactNativeAppState(): AppStateLike {
  return {
    addEventListener(
      type: 'change',
      handler: (status: AppStateValue) => void,
    ): AppStateSubscription {
      return AppState.addEventListener(type, handler);
    },
  };
}
