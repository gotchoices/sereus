/**
 * app-state.ts — production {@link AppStateLike} backed by react-native's
 * `AppState`.
 *
 * The kit's runner (`@serfab/cadre-rn/lifecycle`) takes any {@link AppStateLike}.
 * This module is the one place the app references the native `AppState`, so
 * `use-cadre.ts`'s spec can replace it with a fake.
 */

import { AppState } from 'react-native';
import type { AppStateLike } from '@serfab/cadre-rn/lifecycle';

/** react-native's `AppState`, which is already an {@link AppStateLike}. */
export function createReactNativeAppState(): AppStateLike {
  return AppState;
}
