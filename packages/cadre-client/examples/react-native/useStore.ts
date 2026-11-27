/**
 * Binding a cadre-client store in React (React Native or web): `useSyncExternalStore` over the
 * store's `subscribe` and `get`. A store returns the same object until its value changes, so this
 * re-renders only on a change.
 */
import { useSyncExternalStore } from 'react';
import type { Readable } from '@serfab/cadre-client';

export function useStore<T>(store: Readable<T>): T {
	return useSyncExternalStore(store.subscribe as (onChange: () => void) => () => void, store.get, store.get);
}
